/**
 * **대화별 글자당 토큰** — 이력 예산을 글자가 아니라 모델 창(토큰)에 맞추는 재료 (2026-09-30, 압축 후 업무 연속성).
 *
 * ★왜: 이력 상한이 글자 20만으로 고정돼 모델 창(27.2만 토큰)의 약 3분의 1만 썼고, 도구를 많이 쓰는 턴마다 접어 캐시가 매 턴 깨졌다.
 *  그렇다고 글자 상한만 올리면 한국어가 빽빽한 대화(실측 하위 10%: 글자당 1.4)는 창을 넘는다. 글자당 토큰은 **내용마다 다르다**
 *  (개발 인스턴스 실측: 도구 결과 2.3 · 발화 2.0 · 하위 10% 1.4~1.9) — 그래서 추측하지 않고 **그 대화의 실제 요청**에서 잰다.
 * ★재료는 이미 있다 — 어댑터가 매 요청 보낸 글자 수를 알고, 백엔드가 입력 토큰 수를 돌려준다. 여기는 그 둘을 한 행으로 남길 뿐이다.
 *  재시작 뒤에도 남긴다: 없으면 첫 요청이 보수값으로 예산을 줄여 멀쩡한 이력을 한 번 접고 캐시를 깬다(개발 데몬은 재시작이 잦다).
 * ★믿을 수 없는 값은 버린다 — 글자당 0.5 미만·8 초과는 사용량 보고가 이상한 것이다(가짜 응답·계측 누락). 그 값으로 예산을 키우면 창을 넘는다.
 * ★재는 쪽(Codex)이 아닌 어댑터가 턴을 끝내면 그 턴이 늘린 글자를 **보수값으로 섞는다**(`blendTokenDensity`) — Codex 가 코드 위주 턴에서
 *  잰 2.3 이 Claude 로 한국어 대화를 오래 한 뒤에도 그대로면 돌아온 첫 요청부터 창이 찬다(적대 검토 P3). 처음엔 **지웠는데**, 그러면 Codex
 *  실패 → Claude 폴백 한 턴만으로 멀쩡한 20만 자 이력이 보수값 취급을 받아 다음 요청에 3패스 접혔다(적대 재검토 P3). 섞으면 영향이 새로
 *  들어온 양에 비례한다 — 짧은 폴백 한 턴은 거의 그대로, 긴 대화는 보수값 쪽으로 내려간다.
 */
import { getDb } from "./sessions.js";

/** 실측이 없을 때의 글자당 토큰 — 한국어가 빽빽한 하위 구간(실측 1.4~1.9 의 아래). 섞기도 이 값으로 한다. */
export const FALLBACK_CHARS_PER_TOKEN = 1.4;
const MIN_CHARS_PER_TOKEN = 0.5;
const MAX_CHARS_PER_TOKEN = 8;

/** 마지막 요청의 크기와 입력 토큰을 남긴다. 믿을 수 없는 값은 남기지 않는다(직전 값 유지). */
export const recordTokenDensity = (threadKey: string, chars: number, tokens: number): void => {
  if (!(chars > 0) || !(tokens > 0)) return;
  const r = chars / tokens;
  if (r < MIN_CHARS_PER_TOKEN || r > MAX_CHARS_PER_TOKEN) return;
  getDb()
    .prepare(
      `INSERT INTO thread_token_density (thread_key, chars, tokens, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_key) DO UPDATE SET chars = excluded.chars, tokens = excluded.tokens, updated_at = excluded.updated_at`,
    )
    .run(threadKey, Math.round(chars), Math.round(tokens), Date.now());
};

/** 이 대화의 글자당 토큰(마지막 요청 실측). 없으면 undefined — 호출자가 보수값을 쓴다. */
export const tokenDensityOf = (threadKey: string): number | undefined => {
  const row = getDb().prepare(`SELECT chars, tokens FROM thread_token_density WHERE thread_key = ?`).get(threadKey) as
    | { chars: number; tokens: number }
    | undefined;
  return row === undefined || row.tokens <= 0 ? undefined : row.chars / row.tokens;
};

/** 재지 않은 어댑터의 턴이 늘린 글자를 보수값 비율로 섞는다 — 실측 행이 없으면 할 일이 없다(다음 요청은 어차피 보수값). */
export const blendTokenDensity = (threadKey: string, addedChars: number): void => {
  if (!(addedChars > 0)) return;
  getDb()
    .prepare(`UPDATE thread_token_density SET chars = chars + ?, tokens = tokens + ?, updated_at = ? WHERE thread_key = ?`)
    .run(Math.round(addedChars), Math.round(addedChars / FALLBACK_CHARS_PER_TOKEN), Date.now(), threadKey);
};
