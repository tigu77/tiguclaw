/**
 * 회귀: **예고만 하고 사라지는 턴** (2026-07-29).
 *
 * "확인하겠습니다" 를 뱉고 읽기 도구 몇 개 부른 뒤 다음 응답을 비워 턴을 끝내면, 사용자에게는
 * 예고문만 남고 작업도 결과 보고도 없다. 종전 판정(`finalText === ""`)은 예고문 한 줄 때문에
 * 이걸 정상 종료로 봤다. 실측: dev 2026-07-29 14:07:10 예고 + Read×3·project_capabilities×2
 * → 14:07:12 turn_done(2초). 회사 인스턴스 동일 패턴, 사용자 신고 2회.
 *
 * 판정 규칙 자체를 검사한다 — 어댑터 전체를 돌리지 않고(네트워크 0) 결정적으로.
 */
import { needsClosingReport } from "../../core/llm-runtime/adapters/_turn-completion.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * ★배선 확인 — 순수 함수만 검사하면 **카운터 배선을 지워도 초록**이다(감사 실측: 회귀
 *  81/81 통과 + tsc 0 에러). 그러면 원 사고가 그대로 복귀한다. worker-steering·
 *  timeout-layering 과 같은 방식(배포본엔 .ts 가 없어 오탐 0).
 */
const adapterWired = async (): Promise<boolean> => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url);
  try {
    const src = await readFile(url, "utf8");
    return /toolCallsSinceText\s*\+=/.test(src) && /needsClosingReport\(/.test(src);
  } catch {
    return true;
  }
};

export const check: RegressionCheck = {
  name: "codex-early-stop",
  guards: "예고문만 남기고 작업 없이 끝나던 턴(조기 중단)을 정상 종료로 오인하던 것",
  run: async (): Promise<Assertion[]> => [
    assert(
      "★예고 뒤 도구만 돌고 보고 없음 → 마무리 요구",
      needsClosingReport({ text: "", finalText: "네, 진행하겠습니다.", toolCallsSinceText: 5 }),
      "실제 사고 형태",
    ),
    assert(
      "턴 전체가 무텍스트 → 마무리 요구(기존 빈 응답 경로 유지)",
      needsClosingReport({ text: "", finalText: "", toolCallsSinceText: 0 }),
      "빈 응답",
    ),
    assert(
      "보고 후 도구 없이 종료 → 그대로 끝냄(과도 재요청 0)",
      !needsClosingReport({ text: "", finalText: "완료했습니다.", toolCallsSinceText: 0 }),
      "정상 종료",
    ),
    assert(
      "이번 iteration 이 보고를 냈으면 끝냄",
      !needsClosingReport({ text: "요약입니다.", finalText: "이전", toolCallsSinceText: 3 }),
      "이번에 보고함",
    ),
    assert(
      "설계상 종료 도구(prompt_options)만 돌았으면 끝냄 — 도구가 '턴을 마치라' 지시한다",
      !needsClosingReport({
        text: "",
        finalText: "골라주세요",
        toolCallsSinceText: 1,
        toolNamesSinceText: ["prompt_options"],
      }),
      "의도된 종료",
    ),
    assert(
      "★어댑터 배선이 존재한다(카운터 누적 + 판정 호출)",
      await adapterWired(),
      "openai-codex-oauth.ts",
    ),
  ],
};
