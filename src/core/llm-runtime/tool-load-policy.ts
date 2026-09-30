/**
 * **도구 노출 정책 — 소비 경계에서 한 번** (2026-08-15).
 *
 * SDK 기본값은 MCP 도구를 접고(`defer_loading`) `ToolSearch` 로 열게 한다. 우리는 그걸 끈다.
 * 근거는 실측이다:
 *  · 관측된 `ToolSearch` 호출이 **전부 `select:` 형태**였다 — 이름을 이미 아는 도구
 *    (`Bash` 450회·`invoke_skill`·`read_memory`)의 스키마를 여는 **왕복**이지 탐색이 아니다.
 *  · 도구 48개 전체가 22,525자(codex 실측)인데 **매 호출 동일**해 프리픽스 캐시에 들어간다.
 *    반면 왕복은 캐시로 회수되지 않는 실비다.
 *  · ★그리고 **codex 는 같은 도구를 전부 펼친 채 잘 돈다.** 같은 집합인데 claude 만 접혀
 *    있었다 — 접는 게 필요한 능력이라는 근거가 없다(어댑터 비대칭 자체가 신호다).
 *
 * ★**왜 생성 시점이 아니라 여기인가** (적대 검토 지적, 2026-08-15).
 *  처음엔 우리 서버 20곳을 `createOurMcpServer` 로 바꿔 생성 때 표식을 붙였다. 그건
 *  **"손으로 관리하는 목록" 의 변형**이었다 — 레포 안 20곳은 닫히지만 **레포 밖 생산자**는
 *  원리적으로 못 닫는다:
 *    ①`<home>/plugins` 의 사용자 플러그인이 SDK 문서대로 `createSdkMcpServer` 를 쓰면
 *      그 도구는 조용히 접힌다(없애려던 비대칭이 확장점에서 되살아난다).
 *    ②`mcp.json`/`.mcp.json` 의 `alwaysLoad` 는 아무 검증 없이 SDK 로 들어간다 — 켜지면
 *      **turn 마다 최대 5초** 연결 대기로 막힌다(옵션을 매 턴 새로 조립하므로 부팅 1회가 아니다).
 *  소비 경계(어댑터가 `mcpServers` 를 조립하는 이 지점)에서 한 번 처리하면 셋이 동시에
 *  닫히고, 생성부를 한 곳도 안 건드려도 된다.
 *
 * 두 방향으로 다르게 다룬다 — **우리 것은 펼치고, 남의 것은 건드리지 않는다**:
 *  · in-process SDK 서버(`type: "sdk"`) = 우리 것 + 사용자 플러그인 → **표식을 찍는다**.
 *    연결이 즉시라 펼쳐도 대가가 없다.
 *  · 외부 서버(stdio/sse/http) → `alwaysLoad` 를 **떼어낸다**. 켜면 매 턴 연결까지 블로킹된다.
 */

/** SDK 가 도구를 "접지 말라" 고 표시하는 자리(`tool({alwaysLoad})` 와 같은 효과). */
const ALWAYS_LOAD_META = "anthropic/alwaysLoad";
/** SDK 의 검색 힌트 자리(`tool({searchHint})` 와 같은 곳) — 우리는 «접어도 된다» 는 선언으로도 읽는다. */
const SEARCH_HINT_META = "anthropic/searchHint";

/**
 * **드물게 쓰는 도구는 접는다 — 정의가 선언한다** (2026-09-30 정태님 «능력·정체성 손실 없이 줄이자»).
 *
 * ★위 «우리 것은 펼친다» 의 근거(08-15)는 **자주 쓰는 도구**의 왕복이었다(Bash 450회를 매번 `select:` 로 열었다).
 *  드문 도구는 반대다 — dev 실측(08-19~09-30, 활동 9,143건): 등록·삭제·관리류 22개가 6주간 합쳐 스무 번 남짓인데,
 *  **매 호출** 8K 토큰(도구 검색 켜진 운영 요청 49.1K → 41.1K, count_tokens)을 싣고 있었다.
 * ★접어도 잃는 것이 없다 — 이름은 SDK 가 목록으로 싣고(«이런 걸 할 수 있다» 를 안다), 쓸 때 ToolSearch 로 스키마를
 *  한 번 연다. `find_capabilities` 도 그대로 안내한다. codex·openai 는 접기가 없어 그대로 펼친다(이 표시는 무해).
 * ★멈추는 도구(`cancel_worker`·`KillShell`)는 드물어도 급할 때 쓰므로 접지 않는다 — 판단은 각 정의 파일에서.
 * @param names 접을 도구 이름(이 배열 안의 것) — 생략하면 전부. 없는 이름은 무시된다(접히지 않는 쪽 = 안전).
 */
export const onDemand = <T extends { name: string; description: string; _meta?: Record<string, unknown> }>(
  tools: T[],
  names?: readonly string[],
): T[] => {
  for (const t of tools) {
    if (names !== undefined && !names.includes(t.name)) continue;
    const hint = t.description.split(/(?<=[.。!?])\s|\n/)[0]!.slice(0, 120);
    t._meta = { ...(t._meta ?? {}), [SEARCH_HINT_META]: hint };
  }
  return tools;
};

/** in-process SDK 서버인가 — 그 안의 도구는 우리가 표식을 찍을 수 있다. */
const isSdkServer = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  (v as { type?: unknown }).type === "sdk" &&
  typeof (v as { instance?: unknown }).instance === "object";

/**
 * 등록된 도구에 표식을 찍는다. **SDK 내부 구조를 만지므로** 실패해도 조용히 넘어간다 —
 * 표식이 없으면 도구가 접힐 뿐이고(느려질 뿐 기능 손실 0), 여기서 throw 하면 턴이 죽는다.
 * SDK 가 구조를 바꾸면 회귀(`tools-are-not-deferred`)가 먼저 빨간불이 된다.
 */
const stampSdkServer = (server: unknown): void => {
  try {
    const inst = (server as { instance: Record<string, unknown> }).instance;
    const reg = inst._registeredTools as Record<string, Record<string, unknown>> | undefined;
    if (reg === undefined) return;
    for (const t of Object.values(reg)) {
      const meta = (t._meta ?? {}) as Record<string, unknown>;
      if (meta[ALWAYS_LOAD_META] === true) continue;
      // 정의가 «검색으로 찾게» 선언한 도구(`onDemand`)는 접힌 채 둔다 — 이름은 목록에 남고, 쓸 때 스키마를 연다.
      if (typeof meta[SEARCH_HINT_META] === "string") continue;
      t._meta = { ...meta, [ALWAYS_LOAD_META]: true };
    }
  } catch {
    // SDK 내부 구조 변경 — 표식만 못 찍는다(기능 손실 0).
  }
};

/**
 * 어댑터가 조립한 `mcpServers` 맵에 정책을 적용해 **그대로 돌려준다**(제자리 변경 없음).
 * 호출은 한 곳 — 그래서 새 서버·새 확장점이 생겨도 자동으로 정책을 탄다.
 */
export const applyToolLoadPolicy = <T extends Record<string, unknown>>(servers: T): T => {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (isSdkServer(server)) {
      stampSdkServer(server);
      out[name] = server;
      continue;
    }
    // 외부 서버 — `alwaysLoad` 가 있으면 떼어낸다(매 턴 연결 대기 방지).
    if (
      typeof server === "object" &&
      server !== null &&
      "alwaysLoad" in (server as Record<string, unknown>)
    ) {
      const { alwaysLoad: _dropped, ...rest } = server as Record<string, unknown>;
      console.warn(
        `[mcp] 외부 서버 '${name}' 의 alwaysLoad 를 무시합니다 — 켜면 매 턴 연결까지 대기(최대 5초)합니다.`,
      );
      out[name] = rest;
      continue;
    }
    out[name] = server;
  }
  return out as T;
};
