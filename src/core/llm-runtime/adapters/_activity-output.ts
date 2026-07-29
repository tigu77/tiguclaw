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

/**
 * 출력 프리뷰를 **붙이지 않는** 도구 (2026-07-29 반전).
 *
 * ★왜 화이트리스트를 버렸나: 원래는 `Bash/Read/Grep/Glob/BashOutput/WebFetch/WebSearch`
 *  7개만 허용했다. 그 목록이 만들어질 당시엔 file-ops 밖에 없었고, 이후 늘어난 **MCP 도구
 *  (read_memory·search_code·search_graph·project_capabilities·invoke_skill…)는 아무도
 *  목록에 넣지 않았다.** 그래서 그 카드들은 160자짜리 detail 한 줄뿐이라 **펼칠 게 없었고**,
 *  사용자에겐 "MCP 도구는 눌러도 안 열린다" 로 보였다(신고 2026-07-29).
 *  이름 목록은 새 도구가 생길 때마다 사람이 기억해야 해서 반드시 드리프트한다 — 오늘
 *  아침 고친 MCP 도구명 이중 하드코딩과 **같은 부류의 결함**이다.
 *
 * 그래서 판정 기준을 이름이 아니라 **"그 결과가 다른 블록과 중복되는가"** 로 바꾼다.
 * 기본은 붙인다(도구 결과는 대개 그 도구를 부른 이유 자체다). 아래만 뺀다:
 *  - Edit/Write — 정보는 diff 쪽. 결과는 "Wrote N chars" 류 노이즈.
 *  - ExitPlanMode — 계획 블록이 전문을 이미 보여준다.
 *  - prompt_options — 선택지 카드가 따로 렌더된다.
 *  - TodoWrite/update_todos — detail 이 곧 내용(확인성 에코).
 *  - KillShell — "killed" 류 단답.
 * 출력은 모델 컨텍스트로 재주입되지 않으므로(표시 전용) 토큰 비용은 0, 캡(40줄·4000자)이
 * 페이로드를 묶는다.
 */
const OUTPUT_EXCLUDED_TOOLS = new Set([
  "Edit",
  "Write",
  "ExitPlanMode",
  "prompt_options",
  "TodoWrite",
  "update_todos",
  "KillShell",
]);

/** 프리뷰 줄 수 상한(초과 시 컷 + truncated). diff(60)보다 작게 — 출력은 보조. */
const MAX_LINES = 40;
/** 총 문자 상한. */
const MAX_CHARS = 4000;
/** 한 줄 폭 상한(초과 컷). */
const LINE_MAX = 400;

/**
 * 도구 결과 텍스트 → 출력 프리뷰 (제외 목록/빈 결과면 undefined).
 * best-effort — 어떤 예외도 undefined(턴 무영향, 원칙 #3).
 */
export function buildActivityOutput(
  toolName: string,
  text: string | undefined | null,
  isError?: boolean,
): ActivityOutput | undefined {
  if (OUTPUT_EXCLUDED_TOOLS.has(toolName)) return undefined;
  if (typeof text !== "string" || text === "") return undefined;
  try {
    // isError: 명시 플래그(claude tool_result.is_error·codex callTool throw) OR 내용 휴리스틱.
    // ★file-ops 도구는 에러를 throw/플래그 아니라 `Error: ...` *텍스트*로 반환(errText) → 세
    // 어댑터 모두 명시 플래그를 못 받는다. 접두 매칭으로 LLM-agnostic(#2) 동일 감지(붉은 틴트).
    const err = isError === true || /^Error:\s/.test(text.trimStart());
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
      ...(err ? { isError: true } : {}),
    };
  } catch {
    return undefined;
  }
}
