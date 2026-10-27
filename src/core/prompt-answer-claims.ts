/**
 * **선택지 발급 대장** — 한 질문의 답은 한 번만 처리한다 (2026-10-26, 설계 `docs/decisions/2026-10-26-prompt-options-observation-and-telegram-session-label.md` §A3).
 *
 * ★왜 필요한가: 같은 질문이 텔레그램 버튼과 대시보드 버튼에 **동시에** 산다(대시보드에서 시작한 턴의 egress 질문은 2026-08-12부터,
 *  텔레그램에서 시작한 턴은 이번에 대시보드 관측을 붙이면서). 종전 소비 수명은 채널마다 따로였다 — 텔레그램은 **보기 id**
 *  단위 1회용(같은 질문의 다른 보기는 또 눌린다), 대시보드는 **브라우저** 단위 표시뿐(다른 기기·텔레그램 답을 모른다).
 *  그래서 한 질문에 답이 두 번 들어갈 수 있었다.
 *
 * ★수명 규칙은 텔레그램 보기 맵과 같다 — 프로세스 메모리 · 상한 500 · 넘으면 오래된 것부터 빠진다. 빠진 것과 재시작 뒤의 id 는
 *  **만료**다(처음 보는 질문으로 다시 받지 않는다 — 받으면 상한 퇴출이 곧 중복 처리가 된다, 설계 R1-3).
 * ★발급 id 가 없는 답(슬래시 선택지·이 변경 전 기록·직접 친 글)은 이 대장을 거치지 않는다 — 종전 그대로.
 */
import { randomUUID } from "node:crypto";

/** 텔레그램 `PROMPT_OPTION_CAP` 과 같은 크기 — 같은 이유(콜백 맵 상한)로 같은 수명이어야 두 채널의 «만료» 가 갈리지 않는다. */
export const PROMPT_ID_CAP = 500;

/** id → 닫혔나. 삽입 순서 = 발급 순서(오래된 것부터 뺀다). */
const ledger = new Map<string, { closed: boolean; replyToSession?: string }>();

/** 새 질문 id 를 발급해 «열림» 으로 둔다. */
export const issuePromptId = (replyToSession?: string): string => {
  const id = randomUUID();
  ledger.set(id, { closed: false, replyToSession });
  while (ledger.size > PROMPT_ID_CAP) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
  return id;
};

export type PromptClaim = "ok" | "answered" | "expired";

/** 이 질문의 답을 처리해도 되나 — 처음이면 닫고 `ok`, 이미 닫혔으면 `answered`, 대장에 없으면 `expired`. */
export const claimPromptAnswer = (id: string): PromptClaim => {
  const entry = ledger.get(id);
  if (entry === undefined) return "expired";
  if (entry.closed) return "answered";
  entry.closed = true;
  return "ok";
};

/** 답을 처리할 세션은 발급자가 정한다 — 표시 탭·클라이언트가 바꾸지 못한다. */
export const promptReplySession = (id: string): string | undefined => ledger.get(id)?.replyToSession;

/** 검사용 — 대장을 비운다. */
export const __resetPromptClaimsForTest = (): void => ledger.clear();
