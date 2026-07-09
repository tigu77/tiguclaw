/**
 * 영역 A 어댑터 공유 — `llm.activity` 의 도구 출력 프리뷰(`ActivityOutput`) 빌더.
 *
 * 진실 소스: `docs/decisions/2026-07-09-dashboard-tool-rich-render.md` (슬라이스 2/3).
 *
 * diff(`_activity-diff.ts`)가 도구 *입력*(phase:start)에서 나오는 것과 달리, 출력은 도구
 * *결과*(tool_result, phase:end)에서 나온다. Bash 출력·Read 내용·Grep/Glob 결과 프리뷰.
 *
 * ★LLM-agnostic 하드게이트(원칙 #2): claude·codex·openai 세 어댑터가 결과 텍스트를 동일
 * 빌더로 프리뷰화. ★캡처/렌더 분리(ADR): 여기선 프리뷰 텍스트만, 초록/붉은 뷰는 대시보드.
 */

import type { ActivityOutput } from "../types.js";

/** 출력 프리뷰를 붙이는 도구 화이트리스트. 결과가 곧 정보가치인 도구만(Edit/Write 제외 —
 *  그쪽은 diff 가 정보, 결과는 "Wrote N chars" 류라 노이즈). */
const OUTPUT_TOOLS = new Set(["Bash", "Read", "Grep", "Glob"]);

/** 프리뷰 줄 수 상한(초과 시 컷 + truncated). diff(60)보다 작게 — 출력은 보조. */
const MAX_LINES = 40;
/** 총 문자 상한. */
const MAX_CHARS = 4000;
/** 한 줄 폭 상한(초과 컷). */
const LINE_MAX = 400;

/**
 * 도구 결과 텍스트 → 출력 프리뷰 (화이트리스트 밖/빈 결과면 undefined).
 * best-effort — 어떤 예외도 undefined(턴 무영향, 원칙 #3).
 */
export function buildActivityOutput(
  toolName: string,
  text: string | undefined | null,
  isError?: boolean,
): ActivityOutput | undefined {
  if (!OUTPUT_TOOLS.has(toolName)) return undefined;
  if (typeof text !== "string" || text === "") return undefined;
  try {
    const lines = text.split("\n");
    const out: string[] = [];
    let truncated = false;
    let chars = 0;
    for (const raw of lines) {
      if (out.length >= MAX_LINES || chars >= MAX_CHARS) {
        truncated = true;
        break;
      }
      const l = raw.length > LINE_MAX ? raw.slice(0, LINE_MAX - 1) + "…" : raw;
      out.push(l);
      chars += l.length + 1;
    }
    // 꼬리 빈 줄 정리(파일 끝 개행 등).
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    if (out.length === 0 && !truncated) return undefined;
    return {
      text: out.join("\n"),
      ...(truncated ? { truncated: true } : {}),
      ...(isError ? { isError: true } : {}),
    };
  } catch {
    return undefined;
  }
}
