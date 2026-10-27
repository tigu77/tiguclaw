/**
 * **트리거를 만든 대화 안에서 처리한다** — 파일 감시·스케줄(타이머) 공용 (2026-10-20).
 *
 * 설계: docs/decisions/2026-10-20-watch-origin-session-design.md · docs/decisions/2026-10-20-schedule-timers-design.md.
 * ★두 플러그인이 각자 짜면 같은 판단이 두 벌이 된다 — 처음엔 감시 파사드 안에 있었고(`27b9b8c5`), 스케줄이 같은 일을 하게 되면서 여기로 옮겼다.
 *
 * 하는 일:
 *  - 만든 대화의 **줄**에 합성 턴을 넣는다(`mainMessageHandler()` — 매니저 완료 재주입과 같은 문). 그 대화의 맥락으로 판단하고, 띄운 매니저·자식·완료
 *    보고가 그 대화 소유가 된다. ★여기서 줄을 또 서지 않는다(핸들러가 세운다 — 이중 줄 교착).
 *  - 실행 좌표 = **그 대화 자신의** 마지막 채널·주소 · 결과 좌표 = `dest`(→ `notifyDest` + 답 배달). 둘을 섞지 않는다(레드팀 P-2).
 *  - 차례가 왔을 때 다시 묻는다(`beforeTurn`): 넣은 쪽의 판정(`atTurn`) + 대화가 살아 있나(보관 아님). 대화가 없으면 **전용 세션 폴백 없이** 실패.
 *    ★그 판정이 **지금의 지시·목적지**를 준다 — 줄에서 기다리는 사이 바뀐 프롬프트·목적지가 이 턴의 글·답·파일·선택지·통지 좌표에 한꺼번에 쓰인다
 *     (아스트라 10-20 P1: 넣을 때의 값으로 돌아 옛 지시를 실행하고 옛 목적지로 답했다). 정하는 건 차례가 온 그 순간 한 번 — 실행 중간에 수신자를 바꾸지 않는다.
 *  - 답은 목적지로 물리 발송만(관측은 핸들러가 그 대화에 한 번) · 못 보내면 던진다.
 *  - 이력에 남는 글 머리에 출처 표식(`〔… 실행 — 사용자가 쓴 말이 아니다〕`) — 다음 턴부터 사용자 말로 읽히지 않게(레드팀 P-4).
 */
import type { ChannelName, IncomingMessage, TurnOrigin } from "../channels/types.js";
import type { TriggerRun } from "./llm-runtime/types.js";
import { attachmentSenderFor, deliverOutbound, optionsPresenterFor } from "./outbound.js";
import { mainMessageHandler, jobSessionLabel } from "./worker-jobs.js";
import { getSessionChannelMeta, isConversationLive, SESSION_STORAGE_CHANNEL } from "../store/sessions.js";

export interface TriggerInSessionInput {
  /** 만든 대화 키(서버가 적은 값). */
  origin: string;
  /** 글 머리 출처 표식의 내용 — 예 «파일 감시 #3 실행 · change /w/a.json». */
  marker: string;
  /** 맥락 줄의 트리거 표식 — 이 함수가 `inOrigin` 을 붙인다. */
  triggerRun: TriggerRun;
  /** 배달 로그 라벨. */
  label: string;
  turnOrigin: TurnOrigin;
  /**
   * 넣은 쪽의 판정 — 문자열 = 건너뛸 사유(그대로 결과의 `skipped` 로) · 아니면 **지금의** 지시(치환된 프롬프트)와 목적지.
   *  넣을 때 한 번(줄에 세울 값), 차례가 왔을 때 한 번(실제로 쓸 값) 불린다.
   */
  atTurn: () => string | TriggerTurnSpec;
}

/** 이 실행이 지금 쓸 것 — 지시와 결과 목적지. */
export interface TriggerTurnSpec {
  text: string;
  dest: { channel: string; target: string | null };
}

export type TriggerInSessionResult =
  | { skipped: string }
  /** `dest` = 이 실행이 **실제로 쓴** 목적지(차례에서 확정한 값) — 기록·로그는 이걸 쓴다. 끝난 뒤 DB 를 다시 읽으면 그새 또 바뀐 값과 섞인다(아스트라 재검토 10-20). */
  | { replied: number; failed?: string; dest: TriggerTurnSpec["dest"] };

/** 부팅 중엔 메인 핸들러가 아직 없다 — 플러그인 시작부터 핸들러 등록까지의 창에 시각이 오면 기다린다(적대 검토 10-20 #3: 실패로 끝나 타이머가 지워졌다). */
const HANDLER_WAIT_MS = 60_000;
const waitForHandler = async (): Promise<ReturnType<typeof mainMessageHandler>> => {
  const end = Date.now() + HANDLER_WAIT_MS;
  for (let h = mainMessageHandler(); ; h = mainMessageHandler()) {
    if (h !== undefined || Date.now() >= end) return h;
    await new Promise((r) => setTimeout(r, 100));
  }
};

export const runTriggerInSession = async (i: TriggerInSessionInput): Promise<TriggerInSessionResult> => {
  const handler = await waitForHandler();
  if (handler === undefined) throw new Error("메인 핸들러가 아직 없습니다(부팅 중) — 만든 대화에 넣지 못했습니다");
  // 넣기 전에 — 대화가 이미 없거나 넣은 쪽이 무효라 하면 줄에 서지도 않는다.
  if (!isConversationLive(i.origin)) return { skipped: "origin-gone" };
  const first = i.atTurn();
  if (typeof first === "string") return { skipped: first };
  const own = getSessionChannelMeta(SESSION_STORAGE_CHANNEL, i.origin);
  const turnChannel = own?.lastChannel ?? SESSION_STORAGE_CHANNEL;
  const address = own?.lastChannelTarget ?? i.origin;
  let skipped: string | undefined;
  // 차례가 실제로 왔나 — 종료 중엔 핸들러가 합성 메시지를 **조용히** 끝낸다(`refuseWhileClosing`). 그걸 «답 0자 성공» 으로 세면 타이머가 안 돈 채 지워진다(적대 검토 #4).
  let reached = false;
  let replied = 0;
  let failed: string | undefined;
  let dest = first.dest;
  // 대화 안 트리거의 결과·선택지·파일은 «자동 알림» — 만든 대화의 세션 라벨(기본 세션 포함, 2026-10-26 확정 기준).
  const label = jobSessionLabel(i.origin);
  const run: TriggerRun = { ...i.triggerRun, inOrigin: true };
  const textOf = (spec: TriggerTurnSpec): string => `〔${i.marker} — 사용자가 쓴 말이 아니다〕\n${spec.text}`;
  const msg: IncomingMessage = {
    channel: turnChannel,
    channelUserId: i.label,
    threadKey: i.origin,
    channelAddress: address,
    // 세션을 **지정**한다 — 채널 바인딩이 어디를 가리키든 이 턴은 만든 대화로 간다(가지 결론 보내기와 같은 형).
    session: { explicitSessionId: i.origin, channelAddress: address },
    synthetic: true,
    turnOrigin: i.turnOrigin,
    receivedAt: Date.now(),
    text: textOf(first),
    triggerRun: run,
    beforeTurn: () => {
      reached = true;
      const now = i.atTurn();
      if (typeof now === "string") skipped = now;
      else if (!isConversationLive(i.origin)) skipped = "origin-gone";
      else {
        // ★지금의 값으로 이 턴을 확정한다 — 핸들러는 이 뒤에 글·좌표·통로를 읽는다(`src/index.ts` 줄: beforeTurn → handler).
        msg.text = textOf(now);
        bindDest(now.dest);
      }
      return skipped === undefined ? null : `${i.marker}: ${skipped}`;
    },
    reply: async (text, opts) => {
      if (opts?.turnFailed === true) failed = text;
      else replied += text.length;
      const r = await deliverOutbound({ channel: dest.channel, target: dest.target, text, label: i.label, observe: false, originThreadKey: i.origin, ...label });
      if (r.delivered === false) throw new Error(`배달 실패 — ${r.reason}`);
    },
  };
  // 목적지에 묶이는 것 전부 — 통지 좌표·답의 실제 좌표(egress fan-out 이 같은 곳에 또 보내지 않게)·파일·선택지 통로. 한 함수라 하나만 바뀌는 일이 없다.
  const bindDest = (d: TriggerTurnSpec["dest"]): void => {
    dest = d;
    const ch = d.channel as ChannelName;
    msg.notifyDest = { channel: ch, target: d.target };
    msg.replyTarget = { channel: ch, target: d.target };
    const sendAttachment = attachmentSenderFor(ch, d.target, i.origin, label.labelSession);
    const presentOptions = optionsPresenterFor(ch, d.target, i.origin, label.labelSession);
    if (sendAttachment !== undefined) msg.sendAttachment = sendAttachment; else delete msg.sendAttachment;
    if (presentOptions !== undefined) msg.presentOptions = presentOptions; else delete msg.presentOptions;
  };
  bindDest(first.dest);
  await handler(msg);
  if (skipped !== undefined) return { skipped };
  if (!reached) return { skipped: "not-run" };
  return { replied, ...(failed !== undefined ? { failed } : {}), dest };
};
