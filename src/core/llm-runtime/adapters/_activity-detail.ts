/**
 * 영역 A 어댑터 공유 — `llm.activity` 의 중립 `detail` 요약 빌더.
 *
 * 진실 소스: `docs/decisions/2026-06-25-dashboard-chat-cc-parity.md` §4
 * (축3 사이드바 상세 — payload `detail` 확장).
 *
 * ★LLM-agnostic 하드게이트(원칙 #2): claude·codex·openai-agents 세 어댑터가
 * 도구 인자(tool input)에서 *동일 의미*의 사람이 읽을 1줄 요약을 만든다. 이 함수를
 * 셋이 공유하면 같은 입력 → 같은 detail 이 코드 차원에서 강제된다(parity DRY).
 *
 * 입력은 어댑터별 raw 표현이 다르므로(claude = input 객체, codex = arguments JSON
 * 문자열) 각 어댑터가 *객체로 정규화*해 넘긴다. 이 함수는 raw SDK 구조를 토해내지
 * 않고 핵심 인자 몇 개만 중립 직렬화한다("path=..., cmd: ...").
 */

/** detail 길이 상한 — 사이드바 1줄 요약. 길면 컷. */
const DETAIL_MAX = 160;

/**
 * 도구 인자 중 사람이 가장 알고 싶어 하는 키 우선순위(중립).
 * 어느 어댑터든 동일 도구는 동일 인자명을 쓰므로(MCP 도구 정의 공유) parity 성립.
 */
const PREFERRED_KEYS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
  "name",
  "question",
];

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > DETAIL_MAX ? t.slice(0, DETAIL_MAX - 1) + "…" : t;
}

/**
 * 정규화된 tool input 객체 → 중립 detail 문자열(없으면 undefined).
 *
 * 규칙(양 어댑터 동일):
 *  - 우선순위 키(path/command/pattern/url…)를 만나면 `key=value` 로 1~2개 요약.
 *  - 우선순위 키가 없으면 첫 1~2개 스칼라 인자를 `key=value` 로.
 *  - 값이 객체/배열이면 JSON.stringify 후 컷(raw 덤프 방지 위해 짧게).
 *  - 인자가 전혀 없으면 undefined(= detail 생략).
 */
export function buildActivityDetail(
  input: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return undefined;

  const fmt = (k: string, v: unknown): string => {
    let val: string;
    if (typeof v === "string") val = v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else {
      try {
        val = JSON.stringify(v);
      } catch {
        val = String(v);
      }
    }
    return `${k}=${val}`;
  };

  // 우선순위 키 먼저, 없으면 입력 순서.
  const ordered = [
    ...PREFERRED_KEYS.flatMap((k) => {
      const hit = entries.find(([ek]) => ek === k);
      return hit ? [hit] : [];
    }),
    ...entries.filter(([ek]) => !PREFERRED_KEYS.includes(ek)),
  ];

  const parts: string[] = [];
  for (const [k, v] of ordered) {
    parts.push(fmt(k, v));
    if (parts.length >= 2) break; // 최대 2개 인자 — 1줄 요약 유지.
  }
  if (parts.length === 0) return undefined;
  return clip(parts.join(", "));
}

/**
 * JSON 문자열 형태의 인자(codex function_call arguments)를 파싱해 detail 로.
 * 파싱 실패(부분/비JSON)면 원문을 그대로 컷해 반환(정보 보존, raw 구조 아님 — 문자열).
 */
export function buildActivityDetailFromJson(
  argsJson: string | undefined | null,
): string | undefined {
  if (!argsJson || argsJson.trim() === "" || argsJson.trim() === "{}") return undefined;
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return buildActivityDetail(parsed as Record<string, unknown>);
    }
  } catch {
    // 부분 JSON / 비객체 — 원문 요약(중립 문자열).
  }
  return clip(argsJson);
}
