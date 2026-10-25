/**
 * **답글 표시** — 답글로 보낸 사용자 메시지 카드 위에 «무엇에 단 답글인지»(`↩ 원문 앞부분…`)를 그리는 재료를 만드는 **유일한 자리** (2026-10-23).
 *
 * ★모델에 가는 인용(`reply-quote.ts`)과는 **질문이 다르다** — 저건 «비서가 무엇을 읽나», 이건 «화면이 무엇을 보여 주고 어디로 옮기나».
 *  그래서 따로 둔다. 이 값은 채널 인입 이벤트(`channel.message.in`)에 실려 화면과 대화 기록(`chat_log.data.replyTo`)에만 가고,
 *  프롬프트·이력 재주입에는 실리지 않는다.
 * ★원문은 **앞부분만** 남긴다(대화 기록 비대 방지 — 원문 전체는 이미 원문 행에 있다). ★자르기 **전에** 비밀을 가린다 — 화면·SSE 의 가림은
 *  값 전체 일치라, 먼저 자르면 잘린 비밀 앞부분이 가림을 빠져나간다(R1 검토).
 * ★이동 좌표(`ts`)는 화면의 이동(`jumpToMessageTs`)이 쓰는 시각이다. 정하는 순서는 하나다:
 *  ①답글 대상 **행 id** 가 있으면 그 행의 시각(서버가 대화 기록에서 확인한 값) ②없으면 대시보드가 보낸 **말풍선 시각**
 *  (도구를 쓴 턴의 답 말풍선은 행 id 가 없다 — 그 말풍선의 시각이 곧 화면 좌표다) ③둘 다 없으면 앞부분만(이동 없음 — 옛 텔레그램 메시지 등).
 *  화면은 이 좌표로 **정확히** 찾는다(행 id → 완료 턴 id → 같은 시각, `history-render.js` `replyTargetPick`) — 가까운 다른 메시지를 원문으로 치지 않는다.
 */
import { redactSecrets } from "./outbound-sanitize.js";

/** 저장·표시하는 원문 앞부분 상한(자). 화면은 한 줄로 줄여 보여 준다. */
export const REPLY_PREVIEW_MAX_CHARS = 200;

/** 카드 위 답글 표시 — `text` 는 앞부분, `ts` 가 있으면 누르면 그 시각의 메시지로 옮긴다. */
export interface ReplyPreview {
  text: string;
  /** 답글 대상 대화 기록 행 id(확인된 경우만). */
  id?: number;
  /** 이동 좌표(화면 시각). 없으면 누를 수 없다. */
  ts?: number;
  /** 답글 대상 행의 완료 턴 id — 화면에 행 id·행 시각 없이 그려지는 답(도구를 쓴 턴)을 `data-turn` 으로 짚는다. */
  turn?: string;
}

const finiteTs = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** 공백을 한 칸으로 접고 앞부분만 — 서로게이트 쌍을 쪼개지 않는다. 잘랐으면 «…». */
const headOf = (raw: string): string => {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= REPLY_PREVIEW_MAX_CHARS) return flat;
  const n = /[\uD800-\uDBFF]/.test(flat.charAt(REPLY_PREVIEW_MAX_CHARS - 1)) ? REPLY_PREVIEW_MAX_CHARS - 1 : REPLY_PREVIEW_MAX_CHARS;
  return `${flat.slice(0, n).trimEnd()}…`;
};

/**
 * 인입 메시지 → 답글 표시(답글이 아니면 undefined).
 * @param rowOf 행 id → 그 행의 시각·완료 턴 id(그 대화 범위에서). 조회가 던져도 **발행을 막지 않는다** — 인입 경로라 여기서 던지면 메시지 처리가 깨진다.
 */
export const replyPreviewOf = (
  msg: { replyToText?: string; replyToRef?: { id: number }; replyToAt?: number },
  rowOf: (id: number) => { ts: number; turnId?: string } | undefined,
): ReplyPreview | undefined => {
  const raw = (msg.replyToText ?? "").trim();
  if (raw === "") return undefined;
  const text = headOf(redactSecrets(raw));
  if (text === "") return undefined;
  const id = msg.replyToRef !== undefined && Number.isInteger(msg.replyToRef.id) && msg.replyToRef.id > 0 ? msg.replyToRef.id : undefined;
  let row: { ts: number; turnId?: string } | undefined;
  if (id !== undefined) {
    try {
      row = rowOf(id);
    } catch (e) {
      console.warn(`[reply-preview] 답글 대상 좌표 조회 실패 — 말풍선 시각으로 갑니다: ${e instanceof Error ? e.message : String(e)} (id=${id})`);
    }
  }
  const fromRow = finiteTs(row?.ts);
  const ts = fromRow ?? finiteTs(msg.replyToAt);
  const turn = fromRow !== undefined && typeof row?.turnId === "string" && row.turnId !== "" ? row.turnId : undefined;
  return { text, ...(fromRow !== undefined ? { id } : {}), ...(ts !== undefined ? { ts } : {}), ...(turn !== undefined ? { turn } : {}) };
};

/** 이벤트 페이로드의 `replyTo` → 저장할 값(모양이 틀리면 undefined). 적재 경계에서만 쓴다. */
export const replyPreviewFromPayload = (v: unknown): ReplyPreview | undefined => {
  if (v === null || typeof v !== "object") return undefined;
  const r = v as { text?: unknown; id?: unknown; ts?: unknown; turn?: unknown };
  if (typeof r.text !== "string" || r.text === "") return undefined;
  const ts = finiteTs(r.ts);
  const id = typeof r.id === "number" && Number.isInteger(r.id) && r.id > 0 ? r.id : undefined;
  const turn = typeof r.turn === "string" && r.turn !== "" ? r.turn.slice(0, 200) : undefined;
  return {
    text: r.text.slice(0, REPLY_PREVIEW_MAX_CHARS + 1),
    ...(id !== undefined ? { id } : {}), ...(ts !== undefined ? { ts } : {}), ...(turn !== undefined ? { turn } : {}),
  };
};
