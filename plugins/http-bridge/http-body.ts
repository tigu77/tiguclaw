/**
 * **요청 본문 읽기** — JSON 과 raw 두 가지. 상한을 넘기면 거절한다.
 *
 * ★`index.ts` 에서 떼어냈다 (2026-08-30). 라우트 절반이 부른다 — 작아서 남겨두면
 *  "어디 있더라" 를 매번 묻게 되는 부류라 자리부터 정했다.
 */
import http from "node:http";
import type { IncomingMessage } from "../../src/channels/types.js";
import { runRegionA } from "../../src/core/llm-runtime/index.js";
import { ATTACH_MAX_FILE_BYTES, ATTACH_MAX_TOTAL_BYTES } from "./attachments.js";

/**
 * **본문 상한 — 숫자를 정하지 않고 «이미 집행되는 계약» 에서 유도한다** (2026-09-14).
 *
 * ★종전엔 이 파일 머리말이 *"상한을 넘기면 거절한다"* 고 적혀 있었는데 **상한이 없었다.**
 *  글이 코드보다 세게 말하는 자리였다.
 *
 * ★그런데 «얼마로 할까» 는 재지 않고 정하면 안 된다(1 MiB 를 박으면 첨부가 조용히 막힌다).
 *  실측: base64 를 받는 경로는 **정확히 셋**이고, 셋 다 **이미 디코드 기준 상한을 집행**한다.
 *  그러니 HTTP 상한은 그 상한의 **base64 표현 + 프레이밍 여유**다 — 손으로 고른 수가 아니라
 *  **파생값**이라, 첨부 계약이 바뀌면 여기가 저절로 따라온다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * | 경로 | 집행되는 디코드 상한 | 여기서 쓰는 와이어 상한 |
 * |---|---|---|
 * | `/messages`(채팅 첨부) · `/v1/chat/completions`(image_url) | 합계 25 MiB | base64(25 MiB) + 1 MiB |
 * | `/transcribe`(오디오) | 파일 10 MiB | base64(10 MiB) + 256 KiB |
 * | 그 밖 전부(설정·세션·프로젝트…) | — (실측 최대 수 KB) | 1 MiB |
 *
 * ★일반 경로가 1 MiB 인 근거도 실측이다 — 가장 큰 것이 `settings.json` 3,179B, 테마 3.5KB 로
 *  **KB 단위**다. 300배 여유라 정상 사용을 막지 않는다.
 */
const MiB = 1024 * 1024;
/** base64 는 3바이트를 4자로 늘린다(패딩 포함). */
const base64WireBytes = (decoded: number): number => Math.ceil(decoded / 3) * 4;

export const BODY_LIMIT_DEFAULT = 1 * MiB;
export const BODY_LIMIT_ATTACHMENTS = base64WireBytes(ATTACH_MAX_TOTAL_BYTES) + 1 * MiB;
export const BODY_LIMIT_AUDIO = base64WireBytes(ATTACH_MAX_FILE_BYTES) + 256 * 1024;

/** 본문이 상한을 넘었다 — 호출부가 **413** 으로 닫는다(형식 오류 400 과 구분). */
export class BodyTooLargeError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`요청 본문이 한도(${Math.floor(limitBytes / MiB)}MiB)를 초과했습니다.`);
    this.name = "BodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * 상한을 지키며 본문을 모은다.
 *
 * ★**`Content-Length` 를 믿되 그것만 믿지 않는다** — 헤더가 없거나(chunked) 실제와 달라도
 *  **수신한 바이트를 세어** 막는다. 헤더가 크면 한 바이트도 안 받고 조기 거절한다.
 * ★초과분은 **보관하지 않는다**(메모리 보호가 목적인데 다 받아놓고 거절하면 의미가 없다).
 *  그리고 남은 요청을 **무제한으로 흘려보내지도 않는다** — 읽기를 멈춘다(`pause`).
 * ★★**소켓을 죽이지 않는다** (2026-09-14, 회귀가 잡았다). `destroy()` 로 끊었더니 응답을
 *  쓰기 전에 연결이 죽어 클라이언트가 **413 이 아니라 connection reset** 을 봤다 — 그러면
 *  «본문이 크다» 를 알 길이 없어 상한을 둔 의미가 절반 사라진다. 읽기만 멈추고 응답은
 *  호출부가 정상적으로 쓴다. 남은 인바운드는 `Connection: close` 로 닫힌다.
 */
const readBodyBounded = async (
  req: http.IncomingMessage,
  limitBytes: number,
): Promise<Buffer> => {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > limitBytes) {
    req.pause(); // 한 바이트도 안 받는다 — 그래도 응답은 쓸 수 있어야 한다.
    throw new BodyTooLargeError(limitBytes);
  }
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    seen += buf.length;
    if (seen > limitBytes) {
      req.pause(); // 초과분을 쌓지도, 끝까지 흘려보내지도 않는다(소켓은 살린다).
      throw new BodyTooLargeError(limitBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
};

export const readJsonBody = async (
  req: http.IncomingMessage,
  limitBytes: number = BODY_LIMIT_DEFAULT,
): Promise<Record<string, unknown>> => {
  const text = (await readBodyBounded(req, limitBytes)).toString("utf8");
  if (text.length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

/**
 * 본문 오류의 **상태 코드는 한 곳에서 정한다** — 초과는 413, 그 밖(형식 오류)은 400.
 *
 * ★라우트마다 `catch` 안에서 각자 고르면 스무 곳이 갈린다. 이 레포엔 중앙 `catch` 가 없고
 *  (일부러 걷어냈다 — `index.ts` 주석), 그래서 «판정만» 한 곳에 둔다.
 */
export const bodyErrorStatus = (e: unknown): 400 | 413 =>
  e instanceof BodyTooLargeError ? 413 : 400;

/**
 * **요청 처리가 던졌을 때 무엇을 응답할까** — 판정을 순수 함수로 둔다 (2026-09-14).
 *
 * ★최상위 `catch` 안에 인라인으로 두면 **검사할 방법이 소스 grep 뿐**이고, grep 은 «413 을
 *  고르는가» 같은 판단을 못 지킨다([[feedback_simple_composable_no_duplication]] —
 *  "검사가 껄끄러우면 코드가 잘못 놓인 것"). 제품과 검사가 **같은 함수**를 지나야 한다.
 * ★이미 응답했으면 **아무것도 안 한다** — 이중 응답은 `ERR_HTTP_HEADERS_SENT` 로 다시
 *  던져 같은 사고(요청 하나가 데몬을 죽임)를 재발시킨다.
 */
export const respondToRequestFailure = (
  res: http.ServerResponse,
  e: unknown,
): { status: number; wrote: boolean } => {
  const tooLarge = e instanceof BodyTooLargeError;
  const status = tooLarge ? 413 : 500;
  if (res.headersSent || res.writableEnded) return { status, wrote: false };
  try {
    const payload = JSON.stringify(
      tooLarge ? { error: e.message } : { error: "internal error" },
    );
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      // 본문 초과는 소켓에 미수신분이 남는다 — keep-alive 로 재사용하면 다음 요청이 깨진다.
      ...(tooLarge ? { Connection: "close" } : {}),
    });
    res.end(payload);
    return { status, wrote: true };
  } catch {
    try { res.end(); } catch { /* 이미 죽은 소켓 */ }
    return { status, wrote: false };
  }
};

// 커스텀 엔드포인트 $BODY 치환용 raw body(파싱 안 함 — 모델이 읽음, §3). GET 은 빈 문자열.
export const readRawBody = async (
  req: http.IncomingMessage,
  limitBytes: number = BODY_LIMIT_DEFAULT,
): Promise<string> => (await readBodyBounded(req, limitBytes)).toString("utf8");



// ── 게이트웨이 런타임 설정 해석(2026-07-26) — **settings.json `gateway:{}` 우선, env 레거시 폴백**.
//   settings 는 매 요청 fresh read(캐시 0)라 켜기/끄기·모델·동시성 변경이 **재시작 불요**.
//   settings 에 gateway 섹션이 없으면 종전 env 경로 그대로(= 토큰 존재만으로 활성) → 회귀 0.
//   토큰은 언제나 env 에서만 읽는다(D5 — raw 토큰을 settings 파일에 두지 않음).
