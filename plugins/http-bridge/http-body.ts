/**
 * **요청 본문 읽기** — JSON 과 raw 두 가지. 상한을 넘기면 거절한다.
 *
 * ★`index.ts` 에서 떼어냈다 (2026-08-30). 32줄인데 라우트 절반이 부른다 — 작아서 남겨두면
 *  "어디 있더라" 를 매번 묻게 되는 부류라 자리부터 정했다.
 */
import http from "node:http";
import type { IncomingMessage } from "../../src/channels/types.js";
import { runRegionA } from "../../src/core/llm-runtime/index.js";

export const readJsonBody = async (
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

// 커스텀 엔드포인트 $BODY 치환용 raw body(파싱 안 함 — 모델이 읽음, §3). GET 은 빈 문자열.
export const readRawBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};



// ── 게이트웨이 런타임 설정 해석(2026-07-26) — **settings.json `gateway:{}` 우선, env 레거시 폴백**.
//   settings 는 매 요청 fresh read(캐시 0)라 켜기/끄기·모델·동시성 변경이 **재시작 불요**.
//   settings 에 gateway 섹션이 없으면 종전 env 경로 그대로(= 토큰 존재만으로 활성) → 회귀 0.
//   토큰은 언제나 env 에서만 읽는다(D5 — raw 토큰을 settings 파일에 두지 않음).
