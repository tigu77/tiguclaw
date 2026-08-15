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
