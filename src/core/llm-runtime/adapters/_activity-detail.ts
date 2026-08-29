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
/**
 * ★1줄 요약의 답은 **"무엇을/누구를"** 이다 — 그래서 **식별자가 먼저**다 (2026-08-20).
 *
 * 사고: `spawn_agent(name, path, prompt)` 의 요약이 `path=…, prompt=…` 로 나와
 * **누구를 소환했는지가 안 보였다**(사용자 신고). 원인은 두 규칙이 겹친 것 —
 *  ①이 목록이 손으로 관리되는데 `name` 이 `path`·`prompt` 뒤였고,
 *  ②아래 요약이 **2개에서 끊는다**. 그래서 `name` 이 조용히 접혔다.
 * 배경 서브에이전트가 들어와 인자 조합이 바뀌자 드러났다 — 목록은 그대로인데
 * 지나가는 것이 바뀐 것이라, 아무도 이 목록을 다시 안 봤다.
 *
 * ★그래서 순위를 **질문 종류**로 나눈다:
 *  - IDENTITY: 무엇을 부르나 — 짧고 정보밀도가 가장 높다. 항상 먼저.
 *  - TARGET:   무엇에 하나 — 경로·명령·패턴.
 *  - CONTENT:  본문 — 길어서 잘리면 남는 정보가 거의 없다. 그래서 **맨 뒤**.
 *   (종전엔 `prompt` 가 `name` 보다 앞이었다. 잘린 프롬프트 한 조각이 에이전트
 *    이름을 밀어낸 셈이라, 정보량 순서가 정확히 거꾸로였다.)
 */
const IDENTITY_KEYS = ["name", "agent", "skill", "label"];
const TARGET_KEYS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
];
// 본문 안에서도 **짧은 것 먼저** — claude `Task` 의 `description`(한 줄)이 `prompt`(본문)
// 보다 답에 가깝다. 종전 순서는 긴 것이 앞이라 짧은 요약을 밀어냈다.
const CONTENT_KEYS = ["description", "question", "prompt"];
const PREFERRED_KEYS = [...IDENTITY_KEYS, ...TARGET_KEYS, ...CONTENT_KEYS];

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

  // ★할일 목록은 **세어서** 요약한다 (2026-08-14, 사용자 제안). 일반 규칙(`key=value` 2개)을
  //  타면 `todos=[{"content":"명세와 스텁, frozen…` 처럼 **JSON 조각**이 접힌 줄에 뜬다 —
  //  카드를 펼치지 않으면 몇 개 중 몇 개인지도, 지금 뭘 하는지도 안 보인다.
  //
  //  ★왜 여기냐: 이 함수 하나가 codex·openai 양쪽 어댑터의 detail 을 만들고, 그 detail 이
  //   메인 채팅 카드·매니저/에이전트 잡 카드 스텝에 **똑같이** 실린다. 즉 한 곳을 고치면
  //   누가 세운 계획이든(메인·매니저·에이전트) 각자 자리에서 같은 요약으로 보인다.
  //   따로 화면을 만들면 그 커버리지를 잃는다(메인 세션만 보이던 패널을 그래서 뺐다).
  const todos = input.todos;
  if (Array.isArray(todos) && todos.length > 0) {
    const rows = todos.filter(
      (t): t is Record<string, unknown> => t !== null && typeof t === "object",
    );
    if (rows.length > 0) {
      const done = rows.filter((t) => t.status === "completed").length;
      const cur = rows.find((t) => t.status === "in_progress");
      // 진행 중 항목은 진행형(activeForm)이 있으면 그걸 — "지금 뭘 하나" 가 이 줄의 질문이다.
      const curText =
        cur === undefined
          ? ""
          : String(
              (typeof cur.activeForm === "string" && cur.activeForm !== ""
                ? cur.activeForm
                : cur.content) ?? "",
            );
      return clip(
        `할일 ${done}/${rows.length}${curText !== "" ? ` · 지금: ${curText}` : ""}`,
      );
    }
  }

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
    // ★본문(CONTENT)은 **자리가 남을 때만** 실린다 — 길어서 한 줄을 통째로 먹는다.
    //  식별자·대상이 이미 둘 있으면 본문은 아예 넣지 않는다(요약의 답은 이미 나왔다).
    if (parts.length >= 2 && CONTENT_KEYS.includes(k)) break;
    parts.push(fmt(k, v));
    if (parts.length >= 3) break; // 상한 — 1줄 유지.
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
