/**
 * 회귀: **조립 프리픽스가 히스토리로 되돌아오지 않는다** (2026-07-29).
 *
 * 사고: claude 어댑터는 SDK jsonl 을 색인하는데, 그 "user 메시지" 는 우리가 query() 에
 * 넘긴 **조립 프롬프트 전문**(SYSTEM.md 헌법 + 메모리·스킬·에이전트 인덱스)이다. 그래서
 * 사용자가 `진행해`(3자)를 쳐도 히스토리엔 22,562자가 쌓였다. 같은 대화가 codex 로 돌면
 * 262자다(원문만 INSERT) — **어댑터에 따라 81배 차이**(실측: claude 124턴 263만자 vs
 * codex 68턴 1.8만자). 그 결과 한 스레드가 2,838,563자까지 부풀어 요약 압축이 매 턴
 * 실패했고(oldest-drop 폴백) 모델이 하던 작업의 맥락을 잃었다.
 *
 * 프리픽스는 매 턴 새로 조립돼 주입되므로 히스토리에 실을 이유가 없다(순수 중복).
 * 수정 후 실측: 히스토리 2,853,784자 → 888,954자, user 턴 평균 21,258 → 3,604자.
 */
import { stripAssembledPrefix } from "../../store/memory.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REAL = `<system-reminder>\n# SYSTEM.md — 비서 작동 헌법 (변경 금지)\n${"본문 ".repeat(4000)}\n</system-reminder>\n\n오늘은 여기까지 하자\n`;

export const check: RegressionCheck = {
  name: "history-prefix-strip",
  guards: "조립 프롬프트가 히스토리로 쌓여 컨텍스트를 81배로 부풀리던 것",
  run: async (): Promise<Assertion[]> => {
    const stripped = stripAssembledPrefix(REAL);
    return [
      assert(
        "★조립 프리픽스를 걷어내고 사용자 원문만 남긴다",
        stripped === "오늘은 여기까지 하자",
        `${REAL.length}자 → ${stripped.length}자`,
      ),
      assert(
        "프리픽스 없는 평범한 발화는 그대로 (codex 경로 회귀 0)",
        stripAssembledPrefix("진행해") === "진행해",
        "원문 보존",
      ),
      assert(
        // 보수적 판정 — 사용자가 본문에 그 문자열을 쓴 경우를 잘라먹지 않는다.
        "발화 중간에 태그가 있어도 시작이 아니면 안 건드린다",
        stripAssembledPrefix("이거 </system-reminder> 왜 나와?") ===
          "이거 </system-reminder> 왜 나와?",
        "오탐 0",
      ),
      assert(
        "본문 없이 프리픽스만이면 원본 유지(빈 턴 생성 금지)",
        stripAssembledPrefix("<system-reminder>x</system-reminder>") ===
          "<system-reminder>x</system-reminder>",
        "빈 턴 방지",
      ),
      assert(
        "이어받기 요약처럼 프리픽스가 아닌 큰 본문은 보존",
        stripAssembledPrefix("This session is being continued…").startsWith("This session"),
        "진짜 내용 보존",
      ),
    ];
  },
};
