/**
 * 텔레그램으로 파일 하나 보내기 — **판단은 여기 한 곳** (2026-09-30).
 * 인입 턴의 `send_file`(ctx 가 있다)과 좌표만 있는 발송(`outbound.deliverAttachment` — 매니저 완료 보고처럼 인입
 * 메시지가 없는 턴)이 같은 함수를 쓴다. 멱등은 호출자(send_file 도구의 턴별 sentPaths)가 보장한다 — 여기선 1회
 * 전송만. 실패는 던지지 않고 사유로 돌려준다. 봇 토큰은 grammY 안에만 있다(노출 0).
 * ★별도 모듈인 이유: 회귀가 봇 없이 **실행해서** 지키게(채널 인스턴스는 토큰이 있어야 뜬다).
 *
 * ★**파일도 글 답장과 같은 세션 정보를 싣는다** (2026-09-30 정태님 — «파일 전송에도 세션 정보를 넣고 메시지도 같이»):
 *  ①보낸 메시지 id 를 세션에 묶는다(`recordOutboundMessage`) — 파일에 답글을 달면 그 파일을 보낸 세션으로 간다.
 *   종전엔 id 를 버려 «발원 세션을 못 찾았습니다» 로 지금 묶인 세션에 떨어졌다(글 답장은 09-04 에 고친 것).
 *  ②다른 세션의 것이면 캡션 앞에 `[세션명]` — 글에 붙는 표시와 같은 판정(`egressSourcePrefix`).
 *  ③설명은 캡션으로 **파일과 한 메시지**. 캡션 한도(1,024자)를 넘으면 앞부분은 캡션, 나머지는 바로 뒤 글 메시지
 *   (그 메시지도 세션에 묶는다).
 */
import { InputFile, type Context } from "grammy";
import { egressSourcePrefix } from "../../src/core/egress-targets.js";
import { recordOutboundMessage } from "../../src/store/outbound-messages.js";
import { getThreadName } from "../../src/store/sessions.js";

type Api = Pick<Context["api"], "sendDocument" | "sendMessage">;

/** 텔레그램 캡션 한도(Bot API `caption` 0-1024자). */
export const CAPTION_MAX = 1024;
/** 텔레그램 글 한도. */
const TEXT_MAX = 4096;

export interface DocumentSession {
  caption?: string;
  /** 이 파일을 낸 세션 — 보낸 메시지 id 를 여기 묶는다(답글 라우팅). */
  recordSession?: string;
  /** 표시할 세션 — 글 답장과 같은 규칙으로 호출부가 정한다(인입=답장으로 바뀐 세션 · 좌표 발송=발원 세션). */
  labelSession?: string | null;
}

/** 한도 안에서 자른다 — 가능하면 줄·공백 경계에서(단어 중간을 끊지 않게). */
const cut = (s: string, max: number): [string, string] => {
  if (s.length <= max) return [s, ""];
  const head = s.slice(0, max);
  const at = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
  const n = at > max / 2 ? at : max;
  return [s.slice(0, n).trimEnd(), s.slice(n).trimStart()];
};

const labelFor = (session: string | null | undefined): string => {
  if (session === undefined || session === null || session === "") return "";
  try {
    return egressSourcePrefix(session, getThreadName(session));
  } catch {
    return ""; // 이름을 못 읽으면 표시 없이 간다 — 표시 때문에 전송이 죽으면 그게 더 나쁘다.
  }
};

export const sendDocumentTo = async (
  api: Api,
  chatId: string | number,
  filePath: string,
  opts?: DocumentSession,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const full = labelFor(opts?.labelSession) + (opts?.caption ?? "");
  const [caption, rest] = cut(full, CAPTION_MAX);
  const ids: number[] = [];
  try {
    const m = await api.sendDocument(chatId, new InputFile(filePath), caption !== "" ? { caption } : undefined);
    if (typeof (m as { message_id?: unknown })?.message_id === "number") ids.push((m as { message_id: number }).message_id);
    for (let left = rest; left !== ""; ) {
      const [chunk, more] = cut(left, TEXT_MAX);
      const t = await api.sendMessage(chatId, chunk);
      if (typeof (t as { message_id?: unknown })?.message_id === "number") ids.push((t as { message_id: number }).message_id);
      left = more;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    // 보낸 만큼은 묶는다(뒤 조각이 실패해도 파일 자체엔 답글이 걸리게).
    const sid = opts?.recordSession;
    if (sid !== undefined && sid !== "") {
      const now = Date.now();
      for (const id of ids) recordOutboundMessage("telegram", String(chatId), id, sid, now);
    }
  }
  return { ok: true };
};

/** 좌표만으로 — 좌표가 없거나 봇이 안 떴으면 다시 해도 안 된다(`unavailable`). */
export const deliverDocument = async (
  api: Api | undefined,
  target: string | null,
  filePath: string,
  opts?: { caption?: string; originThreadKey?: string },
): Promise<{ ok: true } | { ok: false; error: string; unavailable?: true }> => {
  if (target === null || target.trim() === "") {
    return { ok: false, error: "telegram target required (chatId)", unavailable: true };
  }
  if (api === undefined) return { ok: false, error: "telegram bot not started", unavailable: true };
  return sendDocumentTo(api, target, filePath, {
    ...(opts?.caption !== undefined ? { caption: opts.caption } : {}),
    ...(opts?.originThreadKey !== undefined
      ? { recordSession: opts.originThreadKey, labelSession: opts.originThreadKey }
      : {}),
  });
};
