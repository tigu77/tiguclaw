// src/core/llm-runtime/capability-reach.ts
/**
 * **도구 노출 사다리 — 어디까지 닿나** (2026-08-28).
 *
 * 정태님: *"메인은 무조건 주어지는 거고, 그다음 매니저까지고, 그다음은 전부인 거고."*
 * 그 사다리를 값 하나로 적는 자리다.
 *
 * ★**왜 생겼나**: 이 판정이 세 어댑터의 조건식 **24곳**에 손으로 복사돼 있었다
 * (`depth === 0 && (input.workerDepth ?? 0) === 0`). 주석마다 *"worker 와 동일 가드"* 라고
 * 적혀 있었는데, 그건 규칙이 아니라 **관례**다 — 새 도구를 더하는 사람이 기억해야 한다.
 * 실제로 같은 모양의 형제 사다리가 한 번 뚫렸다: `http-bridge` 의 role 게이트에서
 * `/set-session-profile` 이 빠져 **read 토큰이 쓰기를 했다**(2026-07-28, 그 파일에 흔적이
 * 남아 있다). 손으로 유지하는 게이트는 이 레포에서 이미 실패한 형태다
 * ([[feedback_hand_maintained_lists]]).
 *
 * ★**권한이 아니다.** 이름을 일부러 `permission` 으로 안 지었다 — 이 레포엔 이미 그 이름이
 * 둘 있다(`src/auth/permissions.ts` = *"이 행위를 해도 되나"* · 플러그인 `needs` = 선언한
 * 능력). 여기가 묻는 건 다른 질문이다: ***"이 턴이 이 도구를 받나."***
 * `configure_home` 을 매니저에게 안 주는 건 위험해서가 아니라 **그 턴이 할 일이 아니라서**고,
 * `spawn_agent` 을 서브에이전트에게 안 주는 건 **재귀 팬아웃 차단**이다. 허락의 문제가
 * 아니라 구조의 문제라서, 권한이라 부르면 *"주면 되잖아"* 라는 잘못된 조작 가능성을 암시한다.
 *
 * ★**숫자를 밖으로 내보내지 않는다.** 순서는 아래 `ORDER` 한 곳에만 산다. 값으로 0·1·2 를
 * 쓰면 **작은 쪽이 더 제한적**이라 다음 사람이 뒤집어 읽고(보안 등급은 보통 클수록 엄격하다),
 * 그 실수는 **아무 에러도 안 낸다** — 도구가 조용히 더 넓게 나갈 뿐이다. 이름은 틀리면
 * 컴파일이 멈춘다.
 */

/** 턴의 종류 — 사다리의 칸이기도 하다. */
export type TurnKind = "main" | "manager" | "subagent";

/** 도구가 닿는 **가장 깊은 칸**. 생략하면 `subagent`(전부)로 본다. */
export type Reach = TurnKind;

/**
 * 사다리. ★**여기가 순서의 유일한 정의점**이다.
 * 칸이 하나 늘어도 숫자를 다시 매기는 게 아니라 줄을 하나 더한다.
 */
const ORDER: Readonly<Record<TurnKind, number>> = {
  main: 0,
  manager: 1,
  subagent: 2,
};

/**
 * 지금 턴이 어느 칸인가 — 어댑터가 들고 있는 두 카운터에서 **한 번** 도출한다.
 *
 * ★`workerDepth` 라는 식별자는 그대로 둔다(개명은 UI·모델 대면 면만 — DB `worker_jobs`·
 *  이벤트 `worker.*` 와 같은 규칙, [[project_manager_agent_naming]]). 사람이 읽는 값만
 *  `manager` 다.
 * ★서브에이전트가 먼저다: `depth ≥ 1` 이면 그 턴은 자식이고, 매니저가 띄운 자식이든
 *  메인이 띄운 자식이든 **같은 칸**이다.
 */
export const turnKindOf = (input: {
  readonly subagentDepth?: number;
  readonly workerDepth?: number;
}): TurnKind => {
  if ((input.subagentDepth ?? 0) > 0) return "subagent";
  if ((input.workerDepth ?? 0) > 0) return "manager";
  return "main";
};

/**
 * **이 도구는 어디까지 닿나** — 판정의 유일한 표.
 *
 * ★새 능력을 더하면서 여기 안 적으면 **컴파일이 멈춘다**(`reaches` 가 이 표의 키만 받는다).
 *  그게 이 파일의 존재 이유다 — 빠뜨림이 조용하지 않게 하는 것.
 * ★적을 때 묻는 것은 하나다: *"위임받아 도는 턴이 이걸 써야 하나."*
 */
export const REACH = {
  // ── 전부 — 일하는 데 필요한 것들. 위임받은 쪽도 똑같이 필요하다 ──
  memory: "subagent",
  projects: "subagent",
  maintenance: "subagent",
  skills: "subagent",
  "reply-intent": "subagent",
  "session-tools": "subagent",
  "send-file": "subagent",
  "prompt-options": "subagent",
  /**
   * 플러그인이 낸 도구(`extraMcpServers`).
   * ★**오늘의 답을 명시로 적어 둔다** — 종전엔 조건 없는 spread 라 "전부" 가 *생략*으로
   *  표현돼 있었고, 그러면 그게 결정인지 빠뜨림인지 코드만 봐선 모른다. 매니페스트에
   *  `reach` 를 열어줄 자리가 생기면 여기가 그 기본값이 된다.
   */
  plugins: "subagent",

  // ── 매니저까지 — 서브에이전트만 제외 ──
  /**
   * `spawn_agent`. ★재귀 팬아웃 차단: 자식(depth ≥ 1)은 또 자식을 못 낳는다.
   * ★**매니저는 받는다** — 종전 코드가 `depth === 0` 한 조건만 써서 그렇게 돼 있었는데,
   *  그게 의도인지 조건을 하나만 쓴 것인지 알 수 없었다. 여기 적음으로써 **결정이 된다**
   *  (매니저가 자식을 못 띄우면 위임 층이 반쪽이 되므로 그대로 둔다).
   */
  agents: "manager",

  // ── 메인만 — 데몬의 능력·구성을 바꾸거나, 재귀를 낳는 것 ──
  /** 매니저를 띄운다 — 매니저가 매니저를 띄우면 무한 팬아웃. */
  workers: "main",
  /** 엔드포인트가 또 엔드포인트를 만드는 재귀 차단. */
  endpoints: "main",
  commands: "main",
  /** 데몬을 재시작한다 — 위임된 턴이 트리거할 일이 아니다. */
  "update-self": "main",
  /** 데몬이 붙는 외부 서버를 바꾼다. */
  "mcp-admin": "main",
  /** `settings.json` 을 쓴다. */
  "model-settings": "main",
  /** 홈 화면 배치 — 사용자와 대화하는 자리의 일이다(위젯 플랫폼 §J.5). */
  "home-widgets": "main",
  /**
   * `<home>/mcp.json` 외부 서버 **실연결** 브리지.
   * ★여기엔 사다리로 못 적는 **예외가 하나** 붙는다 — 프로젝트 스코프 위임
   *  (`isProjectMcpCwd`)이면 서브·매니저도 그 프로젝트의 `.mcp.json` 을 받는다.
   *  예외를 표에 우겨넣지 않고 **호출부에 남겨 둔다**: 표는 사다리만 말하고, 사다리로
   *  안 되는 것은 눈에 보이는 게 낫다(숨기면 다음 사람이 표만 보고 틀린 결론을 낸다).
   */
  "external-mcp": "main",
} as const satisfies Record<string, Reach>;

export type CapabilityName = keyof typeof REACH;

/**
 * 이 턴이 이 능력을 받나. ★조건식을 어댑터에 다시 쓰지 마라 — 그게 24곳이 된 경위다.
 *
 * @param name `REACH` 의 키만 받는다. 없는 이름은 **타입 에러**다(빠뜨림이 조용하지 않게).
 */
export const reaches = (name: CapabilityName, turn: TurnKind): boolean =>
  ORDER[turn] <= ORDER[REACH[name]];

/** 진단·검사용 — 이 칸이 받는 능력 전부. */
export const capabilitiesFor = (turn: TurnKind): CapabilityName[] =>
  (Object.keys(REACH) as CapabilityName[]).filter((n) => reaches(n, turn)).sort();
