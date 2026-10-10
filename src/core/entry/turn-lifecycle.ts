// src/core/entry/turn-lifecycle.ts
/**
 * 턴의 **입구와 출구** — 진입점(index.ts)의 클로저에서 뽑았다 (2026-10-09 전체 적대 검토).
 *
 * ★왜 따로 있나: 둘 다 index.ts 안의 익명 클로저였고 **그물이 0** 이었다 — 끝난 턴의 in-flight 해제와 남은
 *  끼워넣기 재주입은 «부팅해서 모델 턴을 돌려야만» 잴 수 있는 자리라, 회귀가 소스를 grep 하는 것 말고 할 게
 *  없었다. 검사가 껄끄러우면 코드가 잘못 놓인 것이다 — 판정을 여기 두고 index.ts 는 부르기만 한다.
 */
import type { IncomingMessage, MessageHandler } from "../../channels/types.js";
import { translate } from "../i18n.js";
import { reinjectUnlessStopped, stoppedByUser, type SteeringChannel } from "../steering.js";
import { replyCommand } from "./reply-command.js";

/**
 * **종료 중엔 새 턴을 열지 않는다** (2026-10-09 적대 검토 P2~3).
 *
 * ★사고: 종료가 시작된 뒤(진행 턴 통지·자식 정리·채널 stop 사이)에 도착한 메시지가 그대로 직렬 큐로 들어가
 *  **새 턴을 열었다** — 셸을 띄우고 잡을 만들다 곧바로 force-exit 에 잘렸고, 종료 통지는 이미 지나가 그 턴은
 *  아무에게도 «중단» 을 말하지 못했다. 사용자는 답 없는 메시지만 남는다.
 * ★입구 맨 앞에서 거절하고 **분명히 말한다**(완료 알림 뒤 다시 보내 달라). 합성 메시지(매니저 완료 재주입)는
 *  사람이 아니라 답할 상대가 없다 — 로그만 남긴다(그 잡의 기록은 DB 에 있다).
 */
export const refuseWhileClosing = (isClosing: () => boolean, inner: MessageHandler): MessageHandler => (msg) => {
  if (!isClosing()) return inner(msg);
  console.log(
    `daemon: 종료 중 — 새 메시지를 받지 않음 channel=${msg.channel} thread=${msg.threadKey}${msg.synthetic === true ? " (합성)" : ""}`,
  );
  if (msg.synthetic === true) return Promise.resolve();
  return replyCommand(msg, translate("srv.restart.refusedWhileClosing"));
};

/**
 * 턴 출구 — in-flight 등록 해제 + 끼워넣기 채널 닫기 + **남은 끼워넣기 재주입**. 핸들러 `finally` 가 부른다.
 *
 * - in-flight 해제: 그 사이 새 턴이 덮어썼으면(직렬 큐라 이론상 없지만 방어) 건드리지 않는다. 안 지우면 `/stop`·
 *   `/health`·종료 통지가 **끝난 턴**을 진행 중으로 본다.
 * - 끼워넣기: close 를 **먼저** — 이후 도착 push 는 false 를 받아 개입점이 새 턴으로 흘린다(손실 0).
 * - ★미소비 재주입(2026-07-25 라이브 실측 스킵 버그): 턴의 마지막 model-call *이후*·close *이전* 창에 push 된 입력은
 *   소비할 경계가 없어 buffer 에 남는다. push 가 true 였으므로 개입점은 새 턴도 안 만들었다 → 그대로 두면 사용자
 *   메시지가 조용히 스킵된다. close *후* drain 해 새 턴으로 재주입한다(원문 그대로 — `buildReinjectMessage`).
 *   claude 는 stream 이 꺼내간 입력을 턴 종료 후 push 로 되돌려 놓아 같은 전제를 지킨다(`steering-leftover-recovered`).
 * - `/stop` 으로 끝났으면 다시 태우지 않는다(건수는 /stop 답이 알렸다).
 */
export const endTurn = <E>(t: {
  msg: IncomingMessage;
  entry: E;
  inflight: Map<string, E>;
  steering: SteeringChannel | undefined;
  steeringChannels: Map<string, SteeringChannel>;
  signal: AbortSignal;
  /** 재주입 통로 — 직렬 큐 합류(이 턴 finally 뒤 실행)를 위해 진입점의 serializedHandler 를 준다. */
  reinject: (m: IncomingMessage) => unknown;
}): void => {
  const key = t.msg.threadKey;
  if (t.inflight.get(key) === t.entry) t.inflight.delete(key);
  const ch = t.steering;
  if (ch === undefined) return;
  ch.close();
  if (t.steeringChannels.get(key) === ch) t.steeringChannels.delete(key);
  const leftover = ch.drain();
  if (leftover.length === 0) return;
  const again = reinjectUnlessStopped(t.signal, t.msg, leftover);
  if (again === null) {
    if (stoppedByUser(t.signal)) {
      console.log(`[steer] /stop — 이 턴에 남은 끼워넣기 ${leftover.length}건은 다시 태우지 않고 버린다 thread=${key}`);
    }
    return;
  }
  // 재주입 시점엔 이 채널이 이미 close+삭제라 재-steer 안 됨(새 턴으로 처리).
  //  ★동기로 부른다 — 이 턴이 큐를 놓기 **전에** 같은 스레드 큐 뒤에 줄 서야 다른 메시지가 끼어들지 않는다.
  const fail = (e: unknown): void => {
    console.error("steering re-inject failed:", e instanceof Error ? e.message : String(e));
  };
  try {
    void Promise.resolve(t.reinject(again)).catch(fail);
  } catch (e) {
    fail(e);
  }
};
