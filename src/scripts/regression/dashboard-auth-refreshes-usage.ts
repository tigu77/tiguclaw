/**
 * 회귀: **구독 인증이 끝나면 그 provider 의 한도 게이지가 새로고침 없이 다시 그려진다** (2026-11-19 정태님 «구독 플러그인들에서
 * 인증이 완료되면 한도 게이지도 갱신하는게 좋겠는데»).
 *
 * 사고: 플러그인 화면은 provider 마다 한도를 **페이지가 사는 동안 한 번만** 물었다(`usageState`). 그래서
 *  - 화면 붙여넣기로 다시 인증해도 옛 계정·인증 전 숫자가 남았고,
 *  - 화면 밖에서 끝나는 인증(codex 자동 콜백 — 콜백 페이지가 «곧 인증됨으로 바뀐다» 고 말한다 · claude 발급기 창 · 터미널)은
 *    이 화면이 알 길이 없어 상태도 한도도 그대로였다.
 *
 * 지키는 것(진짜 view-plugins.js 를 vm 에 싣고, 서버 응답·시계를 손으로 정한다):
 *  ① 붙여넣기 재인증 성공 → 그 provider 만 한 번 다시 묻고(GET) 새 숫자 — 다른 provider 는 다시 안 묻는다
 *     (자격 표지를 주는 provider · 안 주는 provider 둘 다)
 *  ② 붙여넣기 실패 → 다시 묻지 않고 옛 숫자 유지
 *  ③ 화면 밖 인증 — 미인증 → 인증, 그리고 **이미 인증된 상태의 재인증**(자격 표지 변화) — 로그인 칸이 열린 동안의 감시가 잡아
 *     상태·게이지를 그린다(한 번만 묻는다) · 그 뒤 감시는 멈춘다
 *  ④ 감시는 칸이 사라지면 멈추고 10분이 지나면 느려진다 · 로그인을 안 열었으면 감시하지 않는다
 *  ⑤ 늦게 온 옛 목록 응답이 새 인증 상태를 덮지 않는다(감시와 붙여넣기가 겹칠 때)
 *  ⑥ 감시가 먼저 잡고 붙여넣기 성공 응답이 늦게 와도 한도는 한 번만 묻는다
 *  ⑦ 옛 자격으로 돌던 한도 조회의 답이 늦게 와도 새 자격의 숫자를 덮지 않는다
 *  ⑧ 인증 성공 직후 목록 읽기가 실패해도(던짐·502 오류 응답) 다른 provider 가 «모름» 이 되지 않고, 그 provider 는 새로 묻는다
 *  ⑨ 첫 인증 성공 직후 목록 읽기가 실패해도 마무리 응답의 «인증됨» 으로 게이지를 그린다 · 다음 목록이 한 번 더 묻게 하지 않는다
 *  ⑩ 로그인 칸이 열린 동안 토큰 자동 갱신으로 표지가 바뀌어도 칸을 닫지 않는다(그 provider 한도만 다시) — 그 뒤 진짜 완료도 잡는다
 *  ⑪ 마무리 응답이 그 provider 의 확정 상태다 — 그보다 먼저 시작한 감시 목록이 늦게 와도 «미인증» 으로 되돌리지 않는다(목록 실패와 겹쳐도)
 *  ⑫ 마무리(목록 실패) 뒤 다시 로그인을 열고 곧바로 화면 밖에서 다른 계정으로 인증해도 잡는다(마무리가 기준을 남긴다)
 *  ⑬ 감시가 먼저 본 자동 갱신이 뒤이은 다른 계정 붙여넣기의 재조회를 «이미 했다» 로 삼키지 않는다(목록 실패와 겹쳐도)
 *  ⑭ 늦게 온 마무리 응답이 그사이 감시가 본 더 새 자격을 덮지 않는다(목록 실패와 겹쳐도)
 *  ⑮ 인증이 바뀌어 다시 묻는 조회에만 «인증 직후» 표시가 붙는다 — 화면을 여는 보통 조회·🔄 는 종전 그대로(표시 없음)
 *  ⑯ 붙여넣기 저장 전에 감시가 다른 자격(자동 갱신)을 먼저 보고 마무리 뒤 목록도 실패하면 칸·감시를 남겨 다음 확인이 새 자격을 그린다
 *     (목록이 읽히면 그 목록이 새 자격을 «인증 직후» 로 묻고 칸을 닫는다)
 *  ⑰ 붙여넣기 성공 직후 목록 응답이 늦어도 그 provider 한도는 바로 다시 묻는다
 *  ⑱ 칸이 열린 채 10분이 지나도 감시는 (느리게) 이어져 그 뒤의 화면 밖 인증도 잡는다
 *  ⑲ 화면을 떠난 사이 바뀐 자격은 화면을 다시 열 때 보통 조회로 묻는다(«인증 직후» 표시 없음)
 *  ⑳ 같은 토큰을 다시 붙여넣어 성공해도(표지 그대로) 그 provider 한도를 한 번 다시 묻는다
 *  ㉑ «인증 직후» 는 응답을 적용하는 순간 **바뀐 provider 자신의** 로그인 칸이 열려 있나로 정한다 — 두 칸이 함께 열려도 같고(㉑),
 *     응답을 기다리는 사이 칸이 사라졌으면 붙지 않는다(㉒)
 *  ㉓ 붙여넣기 마무리의 «보낸 뒤 이미 잊었나» 는 잊은 횟수로 가른다 — 감시가 잊은 같은 밀리초에 보낸 붙여넣기도 한 번 다시 묻고(㉓),
 *     기다리는 사이 감시가 A→B→A 를 보고 이미 다시 물었으면 또 묻지 않는다(㉕)
 *  ㉔ 붙여넣기 응답을 기다리는 사이 칸이 사라졌으면 그 재조회는 보통 조회다(«인증 직후» 는 칸이 있을 때만) — 응답을 직접 반영할 때도,
 *     감시가 먼저 다른 자격을 봐 후속 목록만이 새 자격을 확정할 때도(㉖)
 *
 * 등급: **동작**(네트워크 0 · 실제 로그인·자격 파일 0).
 */
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

type Server = {
  auth: Record<string, boolean>;
  /** provider 의 자격 표지 — 없으면(undefined) 목록에 안 싣는다(표지를 안 주는 provider). */
  cred: Record<string, string | undefined>;
  pct: Record<string, number>;
  finishOk: boolean;
  usageCalls: { provider: string; method: string; afterAuth: boolean }[];
  authCalls: number;
  /** 설정하면 다음 목록 요청 하나를 붙잡아 둔다 — 요청 시점의 상태로 나중에 답한다. */
  holdNextAuth: boolean;
  /** 설정하면 다음 목록 요청 하나를 실패시킨다 — "throw" 는 연결 실패, "502" 는 프록시의 오류 응답(`{error}`). */
  failNextAuth: false | "throw" | "502";
  /** 설정하면 다음 한도 요청 하나를 붙잡아 둔다 — 요청 시점의 숫자로 나중에 답한다. */
  holdNextUsage: boolean;
  /** 설정하면 마무리 요청의 응답을 붙잡아 둔다(서버 쪽 인증 변경은 요청 시점에 일어난다). */
  holdFinish: boolean;
  /** `holdFinish` 와 함께 — 서버가 자격을 **응답을 풀 때** 저장한다(저장 전에 감시가 다른 자격을 볼 수 있게). */
  saveOnRelease: boolean;
  /** 마무리가 자격 표지를 바꾸지 않는다 — 같은 토큰을 다시 붙여넣었다. */
  keepCred: boolean;
  held: (() => void)[];
};

const boot = (server: Server) => {
  const clock = makeClock();
  // 감시 상한(10분)과 «이번 로그인에서 이미 잊었나» 는 `Date.now()` 로 잰다 — 검사의 시계를 따르게 한다.
  const base = Date.UTC(2026, 10, 21);
  class FakeDate extends Date {
    static override now(): number {
      return base + clock.now();
    }
  }
  const snapshot = () => ({
    providers: Object.entries(server.auth).map(([provider, authenticated]) => ({
      provider,
      authenticated,
      ...(server.cred[provider] === undefined ? {} : { credential: server.cred[provider] }),
      hasUsage: true,
      login: { label: "login", canFinish: true },
    })),
  });
  const hold = <T>(v: T): Promise<T> => new Promise((resolve) => server.held.push(() => resolve(v)));
  const dash = bootDashboard({
    clock,
    i18n: i18nForContext,
    ids: ["plugins-list", "plugins-count", "plugins-search"],
    extra: { Date: FakeDate },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      if (url.startsWith("/api/plugins"))
        return jsonResponse({
          items: [{ name: "sub-auth", enabled: true, needsFacts: [{ kind: "auth", value: "codex,claude-subscription" }] }],
        });
      if (url.startsWith("/api/auth-providers")) {
        server.authCalls += 1;
        if (server.failNextAuth !== false) {
          const how = server.failNextAuth;
          server.failNextAuth = false;
          if (how === "throw") throw new Error("network");
          return jsonResponse({ error: "bridge unreachable" }, 502);
        }
        const body = snapshot(); // 요청 시점의 상태 — 붙잡아도 그때의 답이다
        if (server.holdNextAuth) {
          server.holdNextAuth = false;
          return hold(jsonResponse(body));
        }
        return jsonResponse(body);
      }
      if (url.startsWith("/api/auth-usage")) {
        const provider = new URL(url, "http://x").searchParams.get("provider") ?? "";
        server.usageCalls.push({ provider, method: init?.method ?? "GET", afterAuth: new URL(url, "http://x").searchParams.get("after") === "auth" });
        const body = jsonResponse({ usage: { windows: [{ windowSeconds: 18_000, remainingPercent: server.pct[provider] ?? 0 }] } });
        if (server.holdNextUsage) {
          server.holdNextUsage = false;
          return hold(body);
        }
        return body;
      }
      if (url.startsWith("/api/auth-login-begin"))
        return jsonResponse({ ok: true, plan: { summary: "s", openUrl: "https://login.example/", pasteHint: "paste" } });
      if (url.startsWith("/api/auth-login-finish")) {
        const b = JSON.parse(init?.body ?? "{}") as { provider?: string };
        const save = (): void => {
          if (server.finishOk && b.provider) {
            server.auth[b.provider] = true;
            if (server.cred[b.provider] !== undefined && !server.keepCred) server.cred[b.provider] = `${server.cred[b.provider]}'`; // 새 자격
          }
        };
        // 실제 라우트처럼 마무리 직후의 «인증됐나» 를 싣는다(`routes-auth.ts` handleAuthLoginFinish).
        const bodyNow = () =>
          jsonResponse({
            ok: server.finishOk,
            message: server.finishOk ? "ok" : "no",
            authenticated: b.provider ? server.auth[b.provider] : null,
            ...(b.provider && server.cred[b.provider] !== undefined ? { credential: server.cred[b.provider] } : {}),
          });
        if (server.holdFinish && server.saveOnRelease)
          return new Promise((resolve) => server.held.push(() => { save(); resolve(bodyNow()); }));
        save();
        const body = bodyNow();
        return server.holdFinish ? hold(body) : body;
      }
      return jsonResponse({}, 404);
    },
    stubs: "const setChatPanel = () => {};",
  });
  dash.window.open = () => null;
  const root = dash.document.getElementById("detail-panel") as MElement;
  const box = (id: string): MElement | null => root.querySelector(`.plugin-auth[data-provider="${id}"]`);
  const usageOf = (id: string): string => box(id)?.querySelector(".plugin-auth-usage")?.textContent ?? "";
  const stateOf = (id: string): string => box(id)?.querySelector(".plugin-auth-state")?.textContent ?? "";
  const calls = (id: string): string[] => server.usageCalls.filter((c) => c.provider === id).map((c) => c.method);
  /** 그 provider 조회마다 «인증 직후» 표시가 붙었나 — 화면을 여는 보통 조회·🔄 엔 안 붙고, 인증이 바뀌어 다시 묻는 조회에만 붙는다. */
  const afterAuthFlags = (id: string): boolean[] => server.usageCalls.filter((c) => c.provider === id).map((c) => c.afterAuth);
  const openLogin = async (id: string): Promise<MElement | null> => {
    box(id)?.querySelector(".plugin-auth-btn")?.click();
    await clock.advance(1);
    return box(id)?.querySelector(".plugin-auth-panel") ?? null;
  };
  const paste = async (id: string): Promise<void> => {
    const p = box(id)?.querySelector(".plugin-auth-panel");
    const input = p?.querySelector("input") as MElement | null;
    if (input) input.value = "pasted-code";
    (p?.querySelector("button") as MElement | null)?.click();
    await clock.advance(1);
  };
  const releaseHeld = async (): Promise<void> => {
    for (const r of server.held.splice(0)) r();
    await clock.advance(10);
  };
  const panelOpen = (id: string): boolean => {
    const p = box(id)?.querySelector(".plugin-auth-panel") as MElement | null | undefined;
    return p !== null && p !== undefined && p.hidden === false;
  };
  return { clock, dash, root, usageOf, stateOf, calls, afterAuthFlags, openLogin, paste, releaseHeld, panelOpen };
};

const fresh = (auth: Record<string, boolean>, cred: Record<string, string | undefined> = {}): Server => ({
  auth,
  cred,
  pct: { codex: 63, "claude-subscription": 50 },
  finishOk: true,
  usageCalls: [],
  authCalls: 0,
  holdNextAuth: false,
  failNextAuth: false as Server["failNextAuth"],
  holdNextUsage: false,
  holdFinish: false,
  saveOnRelease: false,
  keepCred: false,
  held: [],
});
const BOTH_ON = { codex: true, "claude-subscription": true };

export const check: RegressionCheck = {
  name: "dashboard-auth-refreshes-usage",
  guards:
    "구독 인증(붙여넣기·자동 콜백 등 화면 밖 완료·이미 인증된 상태의 재인증)이 끝나도 플러그인 화면의 한도 게이지가 새로고침 전까지 인증 전·옛 계정 값으로 남던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 붙여넣기 재인증 성공(표지 없는 provider · 표지 있는 provider) ───────
    for (const withCred of [false, true]) {
      const tag = withCred ? "표지 있음" : "표지 없음";
      const s = fresh({ ...BOTH_ON }, withCred ? { codex: "c1", "claude-subscription": "k1" } : {});
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      const before = t.usageOf("codex");
      await t.openLogin("codex");
      s.pct.codex = 41;
      await t.paste("codex");
      await t.clock.advance(10);
      out.push(
        assert(
          `★★① (${tag}) 붙여넣기로 다시 인증하면(«인증됨» 그대로) 그 provider 한도만 **한 번 GET 으로** 다시 물어 새 숫자를 그린다`,
          before.includes("63") &&
            t.usageOf("codex").includes("41") &&
            t.calls("codex").join(",") === "GET,GET" &&
            t.calls("claude-subscription").length === 1 &&
            t.usageOf("claude-subscription").includes("50"),
          { 전: before, 후: t.usageOf("codex"), codex호출: t.calls("codex"), claude호출: t.calls("claude-subscription") },
        ),
      );
      const authAfter = s.authCalls;
      await t.clock.advance(30_000);
      out.push(
        assert(
          `① (${tag}) 끝난 뒤엔 감시가 멈춘다 — 목록·한도 추가 요청 0 · 던진 것 0`,
          s.authCalls === authAfter && t.calls("codex").length === 2 && t.clock.errors.length === 0,
          { 목록: s.authCalls - authAfter, codex호출: t.calls("codex"), 예외: t.clock.errors },
        ),
      );
    }

    // ── ② 붙여넣기 실패 ─────────────────────────────────────────────────
    {
      const s = fresh({ ...BOTH_ON });
      s.finishOk = false;
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.pct.codex = 41;
      await t.paste("codex");
      await t.clock.advance(10);
      out.push(
        assert(
          "★② 붙여넣기가 실패하면 다시 묻지 않고 옛 숫자를 그대로 둔다",
          t.calls("codex").length === 1 && t.usageOf("codex").includes("63"),
          { 게이지: t.usageOf("codex"), codex호출: t.calls("codex") },
        ),
      );
    }

    // ── ③ 화면 밖 인증 — 미인증 → 인증 ───────────────────────────────────
    {
      const s = fresh({ codex: false, "claude-subscription": true });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      const pre = { 상태: t.stateOf("codex"), 게이지: t.usageOf("codex"), 호출: t.calls("codex").length };
      await t.openLogin("codex");
      await t.clock.advance(3_100);
      const stillOff = { 상태: t.stateOf("codex"), 호출: t.calls("codex").length };
      // 다른 탭에서 로그인이 끝났다 — 서버 상태만 바뀐다(이 화면엔 아무 알림 없음).
      s.auth.codex = true;
      s.pct.codex = 55;
      await t.clock.advance(3_100);
      const on = { 상태: t.stateOf("codex"), 게이지: t.usageOf("codex"), 호출: t.calls("codex"), 칸: t.panelOpen("codex") };
      await t.clock.advance(60_000);
      out.push(
        assert(
          "전제 — 미인증이면 한도를 묻지 않고, 로그인 칸을 열어도 인증 전엔 묻지 않는다",
          pre.상태 === "미인증" && pre.호출 === 0 && stillOff.상태 === "미인증" && stillOff.호출 === 0,
          { pre, stillOff },
        ),
      );
      out.push(
        assert(
          "★★③ 화면 밖에서 인증이 끝나면 새로고침 없이 «인증됨» 과 새 게이지가 그려진다(한 번 GET) · 열어 둔 로그인 칸은 그대로 · 1분 더 봐도 한도 추가 조회 0",
          on.상태 === "인증됨" && on.게이지.includes("55") && on.호출.join(",") === "GET" && on.칸 && t.calls("codex").length === 1 && t.clock.errors.length === 0,
          { ...on, 그뒤: t.calls("codex"), 예외: t.clock.errors },
        ),
      );
    }

    // ── ③' 화면 밖 재인증 — 이미 인증된 상태에서 계정을 바꾼다 ───────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      await t.clock.advance(3_100);
      const mid = t.calls("codex").length;
      s.cred.codex = "c2"; // 자동 콜백이 새 토큰을 저장했다 — «인증됐나» 는 그대로 true
      s.pct.codex = 22;
      await t.clock.advance(3_100);
      out.push(
        assert(
          "★★③' 이미 인증된 provider 를 화면 밖에서 다시 인증해도(«인증됨» 그대로) 자격 표지 변화로 잡아 새 숫자를 한 번 묻는다 — 다른 provider 는 안 묻는다",
          mid === 1 && t.usageOf("codex").includes("22") && t.calls("codex").join(",") === "GET,GET" && t.calls("claude-subscription").length === 1,
          { 게이지: t.usageOf("codex"), codex호출: t.calls("codex"), claude호출: t.calls("claude-subscription") },
        ),
      );
    }

    // ── ④ 감시 수명 ─────────────────────────────────────────────────────
    {
      const s = fresh({ codex: false, "claude-subscription": true });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      const idle = s.authCalls;
      await t.clock.advance(60_000);
      const idleDelta = s.authCalls - idle;
      await t.openLogin("codex");
      await t.clock.advance(10 * 60_000 + 10_000);
      const at = s.authCalls;
      await t.clock.advance(5 * 60_000);
      const afterLimit = s.authCalls - at;
      out.push(assert("④ 로그인을 열지 않았으면 목록을 다시 읽지 않는다(배경 폴링 0)", idleDelta === 0, { 목록: idleDelta }));
      out.push(
        assert("★④ 인증이 안 끝나도 10분이 지나면 감시가 느려진다(30초마다 — 칸이 열린 동안 이어진다)", at - idle > 150 && afterLimit >= 9 && afterLimit <= 11, {
          감시중목록: at - idle,
          상한뒤목록: afterLimit,
        }),
      );

      const s2 = fresh({ codex: false, "claude-subscription": true });
      const t2 = boot(s2);
      t2.dash.run("showPlugins()");
      await t2.clock.advance(10);
      await t2.openLogin("codex");
      await t2.clock.advance(3_100);
      t2.dash.run("renderPluginsView()"); // 칸을 지우는 다시 그리기(다른 조작)
      const at2 = s2.authCalls;
      await t2.clock.advance(60_000);
      out.push(assert("★④ 로그인 칸이 화면에서 사라지면 감시가 멈춘다", s2.authCalls === at2, { 목록: s2.authCalls - at2 }));
    }

    // ── ⑤ 늦게 온 옛 목록 응답 ──────────────────────────────────────────
    {
      const s = fresh({ codex: false, "claude-subscription": true });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.holdNextAuth = true; // 감시의 다음 목록 요청을 붙잡는다 — «미인증» 시점의 답이다.
      await t.clock.advance(3_100);
      const heldCount = s.held.length;
      await t.paste("codex"); // 그 사이 붙여넣기로 인증이 끝난다 → 화면이 새 목록을 읽고 그린다
      await t.clock.advance(10);
      const mid = { 상태: t.stateOf("codex"), 게이지: t.usageOf("codex") };
      await t.releaseHeld(); // 이제야 옛 응답이 도착한다
      t.dash.run("renderPluginsView()"); // 다른 조작으로 다시 그린다 — 화면은 지금 상태를 읽는다
      await t.clock.advance(10);
      const fin = { 상태: t.stateOf("codex"), 게이지: t.usageOf("codex"), 호출: t.calls("codex") };
      out.push(
        assert(
          "★★⑤ 늦게 온 옛 «미인증» 목록 응답이 새 인증 상태를 덮지 않는다 — 다시 그려도 «인증됨» + 게이지 · 한도 조회는 한 번",
          heldCount === 1 && mid.상태 === "인증됨" && fin.상태 === "인증됨" && fin.게이지.includes("63") && fin.호출.join(",") === "GET",
          { heldCount, mid, fin },
        ),
      );
    }

    // ── ⑥ 감시가 먼저 잡고 마무리 응답이 늦게 온다 ──────────────────────────
    {
      const s = fresh({ codex: false, "claude-subscription": true }, { codex: "", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.holdFinish = true; // 서버는 저장을 끝냈는데 마무리 응답만 늦다
      await t.paste("codex");
      await t.clock.advance(3_100); // 그 사이 감시가 «인증됨» 을 먼저 본다
      const byWatch = t.calls("codex").join(",");
      await t.releaseHeld();
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑥ 감시가 먼저 인증을 잡고 붙여넣기 성공 응답이 늦게 와도 한도는 **한 번만** 묻는다",
          byWatch === "GET" && t.calls("codex").join(",") === "GET" && t.usageOf("codex").includes("63") && t.clock.errors.length === 0,
          { 감시뒤: byWatch, 최종: t.calls("codex"), 게이지: t.usageOf("codex"), 예외: t.clock.errors },
        ),
      );
    }

    // ── ⑦ 옛 자격의 한도 답이 늦게 온다 ─────────────────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      s.holdNextUsage = true; // 카드를 열 때의 codex 조회(옛 자격, 63)를 붙잡는다
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.pct.codex = 41;
      await t.paste("codex"); // 새 자격 → 다시 묻는다(41)
      await t.clock.advance(10);
      const fresh41 = t.usageOf("codex");
      await t.releaseHeld(); // 옛 답(63)이 이제 도착
      out.push(
        assert(
          "★★⑦ 옛 자격으로 돌던 한도 조회의 답이 늦게 와도 새 자격의 숫자를 덮지 않는다",
          fresh41.includes("41") && t.usageOf("codex").includes("41") && !t.usageOf("codex").includes("63") && t.calls("codex").length === 2,
          { 새답뒤: fresh41, 옛답뒤: t.usageOf("codex"), codex호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑧ 인증 성공 직후 목록 읽기 실패(재인증) ─────────────────────────────
    for (const how of ["throw", "502"] as const) {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.pct.codex = 41;
      s.failNextAuth = how; // 마무리 직후의 목록 읽기 한 번이 실패한다
      await t.paste("codex"); // 감시 첫 확인(3초) 전에 낸다
      await t.clock.advance(10);
      const mid = { claude: t.stateOf("claude-subscription"), codex: t.usageOf("codex"), codex호출: t.calls("codex").join(",") };
      t.dash.run("showPlugins()"); // 다음에 목록이 읽힌다(화면을 다시 연다)
      await t.clock.advance(10);
      out.push(
        assert(
          `★⑧ (${how}) 인증 성공 직후 목록 읽기가 실패해도 다른 provider 는 «인증됨»·게이지를 지키고 그 provider 는 한 번 새로 묻는다 · 다음 목록이 또 묻게 하지 않는다`,
          mid.claude === "인증됨" &&
            mid.codex.includes("41") &&
            mid.codex호출 === "GET,GET" &&
            t.stateOf("claude-subscription") === "인증됨" &&
            t.usageOf("claude-subscription").includes("50") &&
            t.usageOf("codex").includes("41") &&
            t.calls("codex").join(",") === "GET,GET" &&
            t.calls("claude-subscription").length === 1,
          { mid, claude: [t.stateOf("claude-subscription"), t.usageOf("claude-subscription")], codex: t.usageOf("codex"), codex호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑧' 감시 중 목록 읽기 한 번 실패 → 다른 조작으로 다시 그린다 ──────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.failNextAuth = "502";
      await t.clock.advance(3_100); // 감시의 목록 읽기가 실패한다
      t.dash.run("renderPluginsView()"); // 그 직후 다른 조작으로 화면을 다시 그린다
      await t.clock.advance(10);
      out.push(
        assert(
          "★⑧' 감시의 목록 읽기 한 번이 실패한 뒤 다시 그려도 인증 상태·게이지가 «모름» 으로 바뀌지 않는다(읽기 실패는 상태 변화가 아니다)",
          t.stateOf("codex") === "인증됨" && t.stateOf("claude-subscription") === "인증됨" && t.usageOf("claude-subscription").includes("50") && t.calls("codex").length === 1,
          { codex: t.stateOf("codex"), claude: [t.stateOf("claude-subscription"), t.usageOf("claude-subscription")], codex호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑨ 첫 인증 성공 직후 목록 읽기 실패 ──────────────────────────────────
    {
      const s = fresh({ codex: false, "claude-subscription": true });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.failNextAuth = "throw";
      await t.paste("codex");
      await t.clock.advance(10);
      const mid = { 상태: t.stateOf("codex"), 게이지: t.usageOf("codex"), 호출: t.calls("codex").join(",") };
      t.dash.run("showPlugins()"); // 다음 목록(정상) — 기준이 없으니 «바뀜» 으로 읽어 또 묻지 않아야 한다
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑨ 첫 인증 성공 직후 목록 읽기가 실패해도 마무리 응답의 «인증됨» 으로 상태·게이지를 그린다(한 번 GET) · 다음 목록이 또 묻게 하지 않는다",
          mid.상태 === "인증됨" && mid.게이지.includes("63") && mid.호출 === "GET" && t.stateOf("codex") === "인증됨" && t.calls("codex").join(",") === "GET",
          { mid, 상태: t.stateOf("codex"), 호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑩ 로그인 중 토큰 자동 갱신 · 데몬 재시작 ─────────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.cred.codex = "c1-refreshed"; // 기존 자격으로 모델을 쓰다 토큰이 자동 갱신됐다 — 로그인은 아직
      s.pct.codex = 30;
      await t.clock.advance(3_100);
      const refreshed = { 칸: t.panelOpen("codex"), 게이지: t.usageOf("codex"), 호출: t.calls("codex").length };
      s.cred.codex = "c2"; // 이제 자동 콜백이 진짜 로그인을 끝냈다
      s.pct.codex = 20;
      await t.clock.advance(3_100);
      const done = { 칸: t.panelOpen("codex"), 게이지: t.usageOf("codex"), 호출: t.calls("codex").length };
      out.push(
        assert(
          "★★⑩ 로그인 칸이 열린 동안 토큰 자동 갱신으로 표지가 바뀌면 칸은 그대로 두고 그 provider 한도만 다시 묻는다 — 그 뒤 진짜 완료도 잡는다",
          refreshed.칸 && refreshed.게이지.includes("30") && refreshed.호출 === 2 && done.칸 && done.게이지.includes("20") && done.호출 === 3,
          { refreshed, done },
        ),
      );
      out.push(
        assert(
          "⑩ 그동안 다른 provider 는 다시 묻지 않는다 · 던진 것 0",
          t.calls("claude-subscription").length === 1 && t.clock.errors.length === 0,
          { claude호출: t.calls("claude-subscription"), 예외: t.clock.errors },
        ),
      );
    }
    // ── ⑪ 먼저 시작한 감시 목록이 마무리 뒤에 온다 ─────────────────────────────
    {
      const s = fresh({ codex: false, "claude-subscription": true }, { codex: "", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.holdNextAuth = true; // 감시의 목록 요청(«미인증» 시점)을 붙잡는다
      await t.clock.advance(3_100);
      const heldCount = s.held.length;
      s.failNextAuth = "502"; // 마무리 직후 목록은 실패
      await t.paste("codex");
      await t.clock.advance(10);
      const mid = { 상태: t.stateOf("codex"), 호출: t.calls("codex").join(",") };
      await t.releaseHeld(); // 옛 «미인증» 목록이 이제 온다
      t.dash.run("renderPluginsView()");
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑪ 마무리 응답이 그 provider 의 확정 상태다 — 그보다 먼저 시작한 감시 목록이 늦게 와도 «미인증» 으로 되돌리지 않는다",
          heldCount === 1 && mid.상태 === "인증됨" && mid.호출 === "GET" && t.stateOf("codex") === "인증됨" && t.calls("codex").join(",") === "GET",
          { heldCount, mid, 상태: t.stateOf("codex"), 호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑫ 마무리(목록 실패) 뒤 다시 열고 곧바로 화면 밖 재인증 ───────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.pct.codex = 41;
      s.failNextAuth = "502";
      await t.paste("codex"); // A 로 다시 인증(목록 실패) → 게이지 41
      await t.clock.advance(10);
      const afterA = { 게이지: t.usageOf("codex"), 호출: t.calls("codex").length };
      await t.openLogin("codex"); // 같은 화면에서 다시 연다
      s.cred.codex = "c-B"; // 곧바로(첫 감시 전) 발급기·터미널에서 B 인증
      s.pct.codex = 22;
      await t.clock.advance(3_100);
      out.push(
        assert(
          "★★⑫ 마무리(목록 실패) 뒤 다시 열고 첫 감시 전에 화면 밖에서 다른 계정으로 인증해도 잡는다 — 마무리가 기준을 남긴다",
          afterA.게이지.includes("41") && afterA.호출 === 2 && t.usageOf("codex").includes("22") && t.calls("codex").length === 3,
          { afterA, 게이지: t.usageOf("codex"), 호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑬ 자동 갱신을 먼저 본 뒤 다른 계정 붙여넣기(목록 실패) ───────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.cred.codex = "c1-refreshed"; // 칸을 연 뒤 A 토큰 자동 갱신
      s.pct.codex = 30;
      await t.clock.advance(3_100); // 감시가 먼저 보고 A 를 다시 묻는다
      const refreshed = t.usageOf("codex");
      s.pct.codex = 41;
      s.failNextAuth = "502";
      await t.paste("codex"); // 이제 B 를 붙여넣어 성공(마무리 응답의 표지는 새 자격)
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑬ 감시가 먼저 본 자동 갱신이 뒤이은 다른 계정 붙여넣기의 재조회를 삼키지 않는다 — 새 숫자를 묻는다",
          refreshed.includes("30") && t.usageOf("codex").includes("41") && t.calls("codex").length === 3,
          { 갱신뒤: refreshed, 게이지: t.usageOf("codex"), 호출: t.calls("codex") },
        ),
      );
    }
    // ── ⑭ 늦게 온 마무리 응답 vs 더 새 관측 ─────────────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.holdFinish = true; // 서버는 A 붙여넣기를 끝냈는데(표지 c1') 응답 전달이 늦다
      s.pct.codex = 41;
      await t.paste("codex");
      s.cred.codex = "c-B"; // 그사이 터미널에서 B 인증
      s.pct.codex = 22;
      await t.clock.advance(3_100); // 감시가 B 를 본다 → B 게이지
      const byWatch = { 게이지: t.usageOf("codex"), 호출: t.calls("codex").length };
      s.failNextAuth = "502"; // 마무리 뒤 목록은 실패
      await t.releaseHeld(); // 이제야 A 의 마무리 응답이 온다
      await t.clock.advance(10);
      t.dash.run("showPlugins()"); // 다음 목록(B) — 기준이 B 로 남아 있으면 또 묻지 않는다
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑭ 늦게 온 마무리 응답이 그사이 감시가 본 더 새 자격(B)을 덮지 않는다 — B 게이지 유지 · 다음 목록에서 또 묻지 않음",
          byWatch.게이지.includes("22") && byWatch.호출 === 2 && t.usageOf("codex").includes("22") && t.calls("codex").length === 2,
          { byWatch, 게이지: t.usageOf("codex"), 호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑮ «인증 직후» 표시는 인증 변화로 다시 묻는 조회에만 ─────────────────────
    {
      const s = fresh({ codex: false, "claude-subscription": true }, { codex: "", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      const opening = t.afterAuthFlags("claude-subscription").slice();
      await t.openLogin("codex");
      s.auth.codex = true; // 화면 밖 인증
      s.cred.codex = "c-new";
      await t.clock.advance(3_100);
      const afterAuth = t.afterAuthFlags("codex").slice();
      // 🔄 — 수동 새로고침은 종전대로(표시 없음, POST)
      await t.clock.advance(6_000); // 🔄 잠금(연타 하한)이 풀린 뒤
      const rf = t.root.querySelector('.usage-refresh[data-provider="codex"]') as MElement | null;
      rf?.click();
      await t.clock.advance(10);
      out.push(
        assert(
          "★⑮ 인증이 바뀌어 다시 묻는 조회에만 «인증 직후» 표시가 붙고, 화면을 여는 보통 조회·🔄 는 종전 그대로다",
          opening.join(",") === "false" && afterAuth.join(",") === "true" && t.calls("codex").join(",") === "GET,POST" && t.afterAuthFlags("codex").join(",") === "true,false",
          { 열기: opening, 인증뒤: afterAuth, codex호출: t.calls("codex"), 표시: t.afterAuthFlags("codex") },
        ),
      );
    }
    // ── ⑯ 저장 전에 감시가 자동 갱신을 보고, 마무리 뒤 목록은 실패 ─────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.holdFinish = true;
      s.saveOnRelease = true; // 서버는 응답을 풀 때 B 를 저장한다
      await t.paste("codex");
      s.cred.codex = "c1-refreshed"; // 저장 전 A 토큰 자동 갱신(A′)
      s.pct.codex = 30;
      await t.clock.advance(3_100); // 감시가 A′ 를 먼저 본다
      const byWatch = t.usageOf("codex");
      s.pct.codex = 41;
      s.failNextAuth = "502"; // 마무리 뒤 목록은 실패
      await t.releaseHeld(); // 이제 B 저장 + 성공 응답
      await t.clock.advance(10);
      const mid = { 칸: t.panelOpen("codex"), 게이지: t.usageOf("codex") };
      await t.clock.advance(3_100); // 다음 확인
      out.push(
        assert(
          "★★⑯ 붙여넣기 저장 전에 감시가 자동 갱신(A′)을 먼저 보고 마무리 뒤 목록도 실패하면 칸·감시를 남긴다 — 다음 확인이 B 게이지를 그린다",
          byWatch.includes("30") && mid.칸 && t.usageOf("codex").includes("41") && t.afterAuthFlags("codex").join(",") === "false,true,true" && t.clock.errors.length === 0,
          { byWatch, mid, 게이지: t.usageOf("codex"), 표시: t.afterAuthFlags("codex"), 예외: t.clock.errors },
        ),
      );
    }
    // ⑯' 같은 순서인데 마무리 뒤 목록은 성공 — 그 목록이 B 를 «인증 직후» 로 묻고 칸을 닫는다
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.holdFinish = true;
      s.saveOnRelease = true;
      await t.paste("codex");
      s.cred.codex = "c1-refreshed";
      s.pct.codex = 30;
      await t.clock.advance(3_100);
      s.pct.codex = 41;
      await t.releaseHeld();
      await t.clock.advance(10);
      out.push(
        assert(
          "★⑯' 같은 순서에서 마무리 뒤 목록이 읽히면 그 목록이 B 를 «인증 직후» 로 다시 묻고 칸을 닫는다",
          !t.panelOpen("codex") && t.usageOf("codex").includes("41") && t.afterAuthFlags("codex").join(",") === "false,true,true",
          { 칸: t.panelOpen("codex"), 게이지: t.usageOf("codex"), 표시: t.afterAuthFlags("codex") },
        ),
      );
    }

    // ── ⑰ 붙여넣기 성공 직후 목록 응답이 늦다 ─────────────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.pct.codex = 41;
      s.holdNextAuth = true; // 마무리 뒤 목록을 붙잡는다(감시 첫 확인 전)
      await t.paste("codex");
      await t.clock.advance(10);
      const mid = { 게이지: t.usageOf("codex"), 호출: t.calls("codex").join(",") };
      await t.releaseHeld();
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑰ 붙여넣기 성공 직후 목록 응답이 늦어도 그 provider 한도는 바로 다시 물어 새 숫자를 그린다 · 목록이 와도 또 묻지 않는다",
          mid.게이지.includes("41") && mid.호출 === "GET,GET" && t.usageOf("codex").includes("41") && t.calls("codex").join(",") === "GET,GET",
          { mid, 게이지: t.usageOf("codex"), 호출: t.calls("codex") },
        ),
      );
    }

    // ── ⑱ 칸을 연 채 10분 뒤 화면 밖 인증 ───────────────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("claude-subscription");
      await t.clock.advance(11 * 60_000);
      s.cred["claude-subscription"] = "k-B"; // 다른 프로세스(터미널 발급)에서 B 인증
      s.pct["claude-subscription"] = 12;
      await t.clock.advance(31_000);
      out.push(
        assert(
          "★★⑱ 로그인 칸을 연 채 10분이 지나도 감시가 이어져 그 뒤의 화면 밖 인증을 잡는다",
          t.panelOpen("claude-subscription") && t.usageOf("claude-subscription").includes("12") && t.calls("claude-subscription").length === 2,
          { 게이지: t.usageOf("claude-subscription"), 호출: t.calls("claude-subscription") },
        ),
      );
    }

    // ── ⑲ 화면을 떠난 사이 자격이 바뀌고 다시 연다 ──────────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      s.cred.codex = "c2"; // 화면 밖에서(로그인 칸 없이) 바뀌었다
      s.pct.codex = 22;
      t.dash.run("showPlugins()"); // 다시 연다
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑲ 로그인 칸 없이 화면 밖에서 바뀐 자격은 화면을 다시 열 때 **보통 조회**로 묻는다(«인증 직후» 표시 없음)",
          t.usageOf("codex").includes("22") && t.calls("codex").join(",") === "GET,GET" && t.afterAuthFlags("codex").join(",") === "false,false",
          { 게이지: t.usageOf("codex"), 호출: t.calls("codex"), 표시: t.afterAuthFlags("codex") },
        ),
      );
    }

    // ── ⑳ 같은 토큰을 다시 붙여넣는다 ──────────────────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      s.keepCred = true;
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("claude-subscription");
      s.pct["claude-subscription"] = 44;
      await t.paste("claude-subscription");
      await t.clock.advance(10);
      out.push(
        assert(
          "★★⑳ 같은 토큰을 다시 붙여넣어 성공해도(표지 그대로) 그 provider 한도를 «인증 직후» 로 한 번 다시 묻는다 — 다른 provider 는 안 묻는다",
          t.usageOf("claude-subscription").includes("44") &&
            t.calls("claude-subscription").join(",") === "GET,GET" &&
            t.afterAuthFlags("claude-subscription").join(",") === "false,true" &&
            t.calls("codex").length === 1,
          { 게이지: t.usageOf("claude-subscription"), 호출: t.calls("claude-subscription"), 표시: t.afterAuthFlags("claude-subscription"), codex: t.calls("codex") },
        ),
      );
    }

    // ── ㉑ 두 provider 의 로그인 칸이 함께 열려 있다 — 다른 칸의 감시가 먼저 읽는다(G6) ─────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex"); // codex 감시가 먼저 돈다
      await t.openLogin("claude-subscription");
      const both = t.panelOpen("codex") && t.panelOpen("claude-subscription");
      s.cred["claude-subscription"] = "k-B"; // claude 칸의 화면 밖 인증
      s.pct["claude-subscription"] = 12;
      await t.clock.advance(3_100);
      out.push(
        assert(
          "★★㉑ 두 로그인 칸이 함께 열려 있어도 바뀐 provider 자신의 칸이 열려 있으면 «인증 직후» 로 다시 묻는다(먼저 읽은 감시가 다른 칸 것이어도)",
          both && t.usageOf("claude-subscription").includes("12") && t.afterAuthFlags("claude-subscription").join(",") === "false,true" && t.calls("codex").length === 1,
          { 두칸: both, 게이지: t.usageOf("claude-subscription"), 표시: t.afterAuthFlags("claude-subscription"), codex: t.calls("codex") },
        ),
      );
    }

    // ── ㉒ 감시 목록 응답을 기다리는 사이 칸이 사라진다(G7) ──────────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("claude-subscription");
      s.cred["claude-subscription"] = "k-B";
      s.pct["claude-subscription"] = 12;
      s.holdNextAuth = true;
      await t.clock.advance(3_100); // 감시의 목록 요청이 붙잡힌다
      const held = s.held.length === 1;
      t.dash.run("renderPluginsView()"); // 다른 조작으로 칸이 사라진다
      await t.clock.advance(10);
      const gone = !t.panelOpen("claude-subscription");
      await t.releaseHeld();
      await t.clock.advance(10);
      out.push(
        assert(
          "★★㉒ 감시 목록이 늦게 오는 사이 칸이 사라졌으면 그 변화는 «인증 직후» 가 아니다 — 보통 조회로 새 숫자를 그린다",
          held && gone && t.usageOf("claude-subscription").includes("12") && t.afterAuthFlags("claude-subscription").join(",") === "false,false",
          { 붙잡음: held, 칸사라짐: gone, 게이지: t.usageOf("claude-subscription"), 표시: t.afterAuthFlags("claude-subscription") },
        ),
      );
    }

    // ── ㉓ 감시가 잊은 같은 밀리초에 같은 토큰을 붙여넣는다(G8) ─────────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      s.keepCred = true; // 마무리는 표지를 바꾸지 않는다 — 감시가 본 k-B 그대로
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("claude-subscription");
      s.cred["claude-subscription"] = "k-B"; // 화면 밖(자동 갱신 등) — 감시가 잡아 잊는다
      s.pct["claude-subscription"] = 30;
      let steps = 0;
      while (t.calls("claude-subscription").length < 2 && steps < 5_000) {
        await t.clock.advance(1);
        steps += 1;
      }
      const watchedAt = t.clock.now();
      s.pct["claude-subscription"] = 44;
      // 같은 밀리초에 붙여넣기 — 감시가 잊은 것은 이 마무리를 보내기 **전**이다
      const p = t.root.querySelector('.plugin-auth[data-provider="claude-subscription"] .plugin-auth-panel');
      const input = p?.querySelector("input") as MElement | null;
      if (input) input.value = "pasted-code";
      (p?.querySelector("button") as MElement | null)?.click();
      const sameMs = t.clock.now() === watchedAt;
      await t.clock.advance(10);
      out.push(
        assert(
          "★㉓ 감시가 잊은 같은 밀리초에 보낸 붙여넣기도 성공하면 그 provider 한도를 한 번 다시 묻는다(시각이 아니라 잊은 횟수로 가른다)",
          sameMs && t.usageOf("claude-subscription").includes("44") && t.calls("claude-subscription").length === 3 && t.afterAuthFlags("claude-subscription").join(",") === "false,true,true",
          { 같은밀리초: sameMs, 게이지: t.usageOf("claude-subscription"), 표시: t.afterAuthFlags("claude-subscription") },
        ),
      );
    }

    // ── ㉔ 붙여넣기 응답을 기다리는 사이 칸이 사라진다(집중 검토 후속 #4) ──────────────────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      s.keepCred = true;
      s.holdFinish = true;
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("claude-subscription");
      s.pct["claude-subscription"] = 44;
      await t.paste("claude-subscription"); // 응답이 붙잡힌다
      t.dash.run("renderPluginsView()"); // 다른 조작으로 칸이 사라진다
      await t.clock.advance(10);
      const gone = !t.panelOpen("claude-subscription");
      await t.releaseHeld();
      await t.clock.advance(10);
      out.push(
        assert(
          "★㉔ 붙여넣기 응답을 기다리는 사이 칸이 사라졌으면 한 번 다시 묻되 «인증 직후» 가 아닌 보통 조회로",
          gone && t.usageOf("claude-subscription").includes("44") && t.afterAuthFlags("claude-subscription").join(",") === "false,false",
          { 칸사라짐: gone, 게이지: t.usageOf("claude-subscription"), 표시: t.afterAuthFlags("claude-subscription") },
        ),
      );
    }

    // ── ㉕ 붙여넣기 응답을 기다리는 사이 감시가 A→B→A 를 보고 이미 다시 물었다(집중 검토 후속 #5) ─────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      s.keepCred = true; // 마무리 응답은 k1 그대로
      s.holdFinish = true;
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("claude-subscription");
      await t.paste("claude-subscription"); // 응답이 붙잡힌다(그때의 표지 k1)
      s.cred["claude-subscription"] = "k-B";
      await t.clock.advance(3_100); // 감시가 B 를 보고 다시 묻는다
      s.cred["claude-subscription"] = "k1";
      s.pct["claude-subscription"] = 44;
      await t.clock.advance(3_100); // 감시가 다시 A 를 보고 다시 묻는다
      const byWatch = t.calls("claude-subscription").length;
      await t.releaseHeld();
      await t.clock.advance(10);
      out.push(
        assert(
          "★㉕ 기다리는 사이 감시가 A→B→A 를 보고 이미 다시 물었으면 같은 표지의 마무리 응답이 또 묻지 않는다",
          byWatch === 3 && t.calls("claude-subscription").length === 3 && t.usageOf("claude-subscription").includes("44"),
          { 감시까지: byWatch, 호출: t.calls("claude-subscription"), 게이지: t.usageOf("claude-subscription") },
        ),
      );
    }
    // ── ㉖ ⑯' 순서에서 마무리 응답을 기다리는 사이 칸이 사라진다 — 후속 목록만이 B 를 확정한다(집중 검토 후속 재검토) ─────
    {
      const s = fresh({ ...BOTH_ON }, { codex: "c1", "claude-subscription": "k1" });
      const t = boot(s);
      t.dash.run("showPlugins()");
      await t.clock.advance(10);
      await t.openLogin("codex");
      s.holdFinish = true;
      s.saveOnRelease = true;
      await t.paste("codex");
      s.cred.codex = "c1-refreshed"; // 저장 전 A′ — 감시가 먼저 본다(마무리 응답은 확정으로 못 쓴다)
      s.pct.codex = 30;
      await t.clock.advance(3_100);
      t.dash.run("renderPluginsView()"); // 다른 조작으로 칸이 사라진다
      await t.clock.advance(10);
      const gone = !t.panelOpen("codex");
      const claudeBefore = t.calls("claude-subscription").length;
      s.pct.codex = 41;
      await t.releaseHeld(); // B 저장 + 성공 응답 → 후속 목록이 B 를 본다
      await t.clock.advance(10);
      out.push(
        assert(
          "★㉖ 마무리 응답을 기다리는 사이 칸이 사라졌으면 후속 목록이 B 를 그리되 «인증 직후» 가 아닌 보통 조회로 · 다른 provider 는 다시 묻지 않는다",
          gone && t.usageOf("codex").includes("41") && t.afterAuthFlags("codex").join(",") === "false,true,false" && t.calls("claude-subscription").length === claudeBefore,
          { 칸사라짐: gone, 게이지: t.usageOf("codex"), 표시: t.afterAuthFlags("codex"), claude: [claudeBefore, t.calls("claude-subscription").length] },
        ),
      );
    }
    return out;
  },
};

export default check;
