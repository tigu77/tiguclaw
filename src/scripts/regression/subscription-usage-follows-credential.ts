/**
 * 회귀: **구독 한도 캐시는 그 답을 얻은 자격에 묶인다** — 다시 인증하면 접는 창 안이어도 새로 묻는다 (2026-11-19 정태님 «구독
 * 플러그인들에서 인증이 완료되면 한도 게이지도 갱신하는게 좋겠는데»).
 *
 * 사고: 화면이 인증 직후 한도를 다시 물어도 플러그인이 자격과 무관하게 접어 둔 답을 돌려줬다 — codex 는 30초 캐시(인증 전
 *  «대기» 또는 옛 계정 숫자), claude 는 30초 중복 접기·마지막 성공값(재시작 너머 파일 캐시 포함). 진행 중이던 옛 자격의 조회도
 *  새 요청과 나눠 썼다.
 *
 * 지키는 것(실제 플러그인 코드 · 가짜 fetch · 가짜 CLI — 네트워크·자격 파일 0):
 *  codex  ① 같은 토큰이면 30초 안 재조회는 캐시 ② 토큰이 바뀌면 새로 묻는다 ③ 인증 전 «대기» 뒤 인증되면 바로 묻는다
 *         ④ 답은 실제로 보낸 토큰에 묶인다(받는 사이 갱신·자격 엇갈림) ⑤ 등록된 `getUsage`(제품 배선) · `credentialTag` · 인증 직후 자동
 *         조회는 토큰 갱신을 일으키지 않고 일반 조회는 종전대로 갱신 ⑥ 옛 자격의 진행 중 조회를 새 요청이 나눠 쓰지도 기다리지도 않는다
 *  claude ⑦ 같은 토큰이면 접는다 · 동시 요청은 CLI 한 번 ⑧ 토큰이 바뀌면 새로 묻는다 ⑨ 옛 토큰의 진행 중 조회를 나눠 쓰지 않고
 *         늦은 옛 답이 새 성공값이 되지 않는다 ⑩ 재시작 때 다른 토큰의 파일 캐시 숫자를 쓰지 않는다(같은 토큰이면 쓴다)
 *         ⑪ 바뀐 직후라도 코어가 준 턴 사용률(지금 토큰의 것)은 쓴다 · `credentialTag` 는 토큰 값이 아니다
 *         ⑫ 제품이 쓴 파일 캐시를 같은 토큰으로 재기동하면 그대로 쓰고, 다른 토큰·표지 없는 옛 파일이면 숫자는 버리되 서버 시계는 지킨다
 *         ⑬ 다른 자격의 엔드포인트 조회가 겹쳐도 늦게 온 짧은 429 가 서버가 정한 더 긴 대기를 줄이지 않고, 대기 전에 보낸 요청의
 *            거절을 «기다렸다 거절» 로 세지 않는다
 *         ⑭ 토큰과 CLI 로그인을 함께 바꾸면 CLI 계정 대조를 옛 메모로 하지 않는다 · 바뀌기 전에 시작한 조직 조회가 새 메모를 덮지 않는다
 *         ⑯ 옛 자격의 CLI 실패(없음)가 늦게 와도 새 자격에서 성공한 CLI 를 «없음» 으로 만들지 않는다
 *         ⑰ 옛 자격의 CLI 실패가 먼저 끝났어도 재인증 뒤 자동 조회는 CLI 를 다시 묻는다
 *         ⑱ CLI 를 기다리던 옛 조회는 자격이 바뀌었으면 멈춘다(새 토큰으로 엔드포인트까지 가지 않는다)
 *         ⑲ 재인증 앞뒤 어디서도 CLI 숫자를 첫 조회·이후 보통 조회·🔄 에 보이거나 담지 않는다 — 조직이 같다고 답해도(계정 식별자 없는
 *            숫자라 확인할 수 없다) · 지금 토큰의 턴 값은 쓴다(2026-11-21 정태님 «이후에도 확인된 값만 쓰자»)
 *         ⑳ CLI 만 다른 계정으로 다시 로그인해도 그 숫자를 쓰지 않는다 — 그 주기(10분) 안엔 CLI 를 띄우지 않고 확인된 값(턴)으로 답한다
 *            · 엔드포인트를 새로 두드리지 않는다
 *         ㉑ 조직 확인을 기다리는 사이 도착한 지금 토큰의 턴 값을 쓴다(조직을 모를 때도 · 같을 때도)
 *         ㉒ 조직 확인을 기다리는 사이 자격이 바뀌면 옛 요청은 멈춘다(새 토큰의 턴 값을 옛 요청의 답으로 내지 않는다)
 *         ㉓ 같은 토큰 표지라도 «엔드포인트 값» 표식이 없는 파일의 숫자는 되살리지 않는다(CLI 숫자였을 수 있다)
 *         ㉔ CLI 주기(10분)는 재시작 너머로 — 재시작 직후 조회·🔄 가 CLI 를 다시 띄우지 않는다
 *         ㉕ 같은 조직 CLI 응답 뒤에도 지금 토큰의 엔드포인트 성공값을 그대로 쓴다
 *         ㉖ 첫 CLI 가 «확인 불가» 였어도 그 뒤 도착한 **같은 자격의 턴 값**은 🔄 로 바로 보인다 — CLI 를 더 띄우지 않고(주기 10분 그대로),
 *            🔄 는 연타 하한 뒤 열린다 · 이전 자격의 값은 거절(2026-11-25 아스트라 종합 인계 1-1). 실제 답을 실제 화면(mini-DOM)에 넣어 버튼·표시까지 본다
 *  core   ⑮ 턴 한도 이벤트는 **그 질의를 띄운 자격**에 붙고, 지금 자격이 아니면 기록하지 않는다 — 늦은 옛 이벤트가 새 계정 값이 되거나
 *            지우지 않는다(`rate-limit-view.ts`)
 *
 * 등급: **동작**.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";

const cpCjs = createRequire(import.meta.url)("node:child_process") as { spawn: (...a: unknown[]) => unknown };
const realSpawn = cpCjs.spawn;
let cliSpawnsUsage = 0;
let cliUsedPct = 30;
/** 켜 두면 `/usage` CLI 출력을 붙잡는다(출력 숫자는 띄운 순간의 값). */
let holdCli = false;
/** CLI 가 없는 기계 — `claude` 실행만 ENOENT. */
let cliMissing = false;
/** `claude auth status` 가 말하는 CLI 로그인 조직. */
let cliOrg = "org-same";
/** 켜 두면 `auth status` 출력을 붙잡는다(조직은 띄운 순간의 값). */
let holdAuth = false;
const heldAuth: (() => void)[] = [];
const heldCli: (() => void)[] = [];
const fakeCli = (): void => {
  cpCjs.spawn = (...a: unknown[]) => {
    if (!/claude(\.exe)?$/.test(String(a[0]))) return realSpawn(...a);
    const args = (a[1] as string[]) ?? [];
    const isUsage = args[0] !== "auth";
    const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
    p.stdout = new EventEmitter();
    p.kill = () => {};
    if (cliMissing) {
      const fail = (): void => void p.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
      if (isUsage && holdCli) heldCli.push(fail);
      else setImmediate(fail);
      return p;
    }
    if (isUsage) cliSpawnsUsage += 1;
    const out = isUsage
      ? JSON.stringify({
          result: `Current session: ${cliUsedPct}% used · resets Oct 10 at 7:40pm (Asia/Seoul)\nCurrent week (all models): 50% used · resets Oct 14 at 8pm (Asia/Seoul)`,
        })
      : JSON.stringify({ loggedIn: true, orgId: cliOrg });
    const emit = (): void => {
      p.stdout.emit("data", out);
      p.emit("close", 0);
    };
    if (isUsage && holdCli) heldCli.push(emit);
    else if (!isUsage && holdAuth) heldAuth.push(emit);
    else setImmediate(emit);
    return p;
  };
  syncBuiltinESMExports();
};
const restoreCli = (): void => {
  cpCjs.spawn = realSpawn;
  syncBuiltinESMExports();
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
/** 붙잡을 요청이 **실제로 붙잡힐 때까지** 기다린다(최대 2초) — 고정 지연이면 첫 import 가 느릴 때 붙잡기 전에 풀어 재현이 안 된다. */
const heldOne = async (q: unknown[]): Promise<boolean> => {
  for (let i = 0; i < 100 && q.length === 0; i += 1) await tick();
  return q.length > 0;
};
/** 붙잡힌 옛 조회를 나눠 쓰면 영영 안 끝난다 — 검사가 멈추지 않게 시한을 두고 «나눠 씀» 으로 판정한다. */
const JOINED_OLD = Symbol("joined-old");
const within = <T>(p: Promise<T>): Promise<T | typeof JOINED_OLD> =>
  Promise.race([p, new Promise<typeof JOINED_OLD>((r) => setTimeout(() => r(JOINED_OLD), 500))]);
const pct = (u: unknown): number | string | undefined => (u === JOINED_OLD ? "옛 조회를 나눠 씀" : first(u as Usage | undefined));

type Usage = { windows?: { windowSeconds?: number; remainingPercent?: number; resetAt?: number }[]; measuredAt?: number; retryAt?: number };
const first = (u: Usage | undefined): number | undefined => u?.windows?.[0]?.remainingPercent;
/** «확인할 수 없다» — 숫자 없이(2026-11-21 정태님 «확인된 값만» — CLI 숫자는 계정 식별자가 없어 쓰지 않는다). */
const unv = (u: unknown): boolean =>
  u !== JOINED_OLD && ((u as Usage | undefined)?.windows ?? []).length === 0 && (u as { unavailable?: boolean } | undefined)?.unavailable === true && /확인할 수 없어/.test(String((u as { reason?: string } | undefined)?.reason));
const keyOf = (t: string): string => createHash("sha256").update(t).digest("hex").slice(0, 12);

export const check: RegressionCheck = {
  name: "subscription-usage-follows-credential",
  guards:
    "다시 인증한 뒤 한도를 새로 물어도 codex·claude 구독 플러그인이 이전 자격(인증 전 대기·옛 계정·재시작 전 파일·진행 중 조회)의 답을 돌려주던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const realFetch = globalThis.fetch;
    const usageMod = new URL("../../../plugins/codex-subscription-auth/usage.ts", import.meta.url).href;
    type CodexMod = {
      setUsageLogSink: (f: (m: string) => void) => void;
      fetchCodexUsage: (g: () => Promise<string>, force?: boolean, cred?: () => unknown) => Promise<Usage | undefined>;
    };
    const codexMod = async (tag: string): Promise<CodexMod> => {
      const m = (await import(`${usageMod}?${tag}-${Date.now()}`)) as CodexMod;
      m.setUsageLogSink(() => {});
      return m;
    };

    // ── codex ────────────────────────────────────────────────────────────
    // 답은 **실제로 요청에 실은 토큰**에 묶인다 — 세 번째 인자는 «지금 쥔 토큰»(갱신 없이).
    let calls = 0;
    let used = 10;
    let holdFetch = false;
    const heldFetch: (() => void)[] = [];
    let tokenPosts = 0;
    let lastBearer = "";
    globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes("/oauth/token")) {
        tokenPosts += 1; // 토큰 갱신 — 일반 조회는 종전대로 할 수 있고, 인증 직후 자동 조회는 하면 안 된다
        return { ok: true, status: 200, json: async () => ({ access_token: `refreshed-${tokenPosts}`, refresh_token: `rt-new-${tokenPosts}`, expires_in: 3600 }), text: async () => "" };
      }
      calls += 1;
      lastBearer = String(init?.headers?.Authorization ?? "");
      const pct = used; // 요청 시점의 값
      const res = {
        ok: true,
        status: 200,
        json: async () => ({ rate_limit: { primary_window: { used_percent: pct, limit_window_seconds: 18_000 } } }),
      };
      if (holdFetch) return new Promise((resolve) => heldFetch.push(() => resolve(res)));
      return res;
    }) as never;
    const envKeys = ["OPENAI_CODEX_OAUTH_TOKEN", "OPENAI_CODEX_OAUTH_REFRESH", "OPENAI_CODEX_OAUTH_EXPIRES"] as const;
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    try {
      // ①②
      {
        const m = await codexMod("cred");
        let cur = "tok-A";
        const tok = async () => cur;
        const a = await m.fetchCodexUsage(tok, false, () => cur);
        used = 40;
        const b = await m.fetchCodexUsage(tok, false, () => cur);
        const callsSame = calls;
        cur = "tok-B";
        const c = await m.fetchCodexUsage(tok, false, () => cur);
        out.push(assert("codex ① 같은 토큰이면 30초 안 재조회는 캐시 — 외부 요청 0", first(a) === 90 && first(b) === 90 && callsSame === 1, { a: first(a), b: first(b), 요청: callsSame }));
        out.push(assert("★★codex ② 토큰이 바뀌면 30초 안이어도 새로 묻고 새 숫자", calls === 2 && first(c) === 60, { c: first(c), 요청: calls }));
      }
      // ③
      {
        const m = await codexMod("pre");
        let cur: string | undefined = undefined;
        const before = calls;
        const pend = await m.fetchCodexUsage(async () => {
          throw new Error("no token");
        }, false, () => cur);
        cur = "tok-C";
        used = 25;
        const after = await m.fetchCodexUsage(async () => "tok-C", false, () => cur);
        out.push(
          assert(
            "★codex ③ 인증 전 «대기» 답 뒤 인증되면 30초 캐시를 기다리지 않고 바로 묻는다",
            (pend?.windows ?? []).length === 0 && typeof pend?.retryAt === "number" && first(after) === 75 && calls === before + 1,
            { 인증전: pend, 인증후: first(after), 요청: calls - before },
          ),
        );
      }
      // ④ 받는 사이 갱신 — 보낸 토큰으로 담는다
      {
        const m = await codexMod("refresh");
        let cur = "tok-D";
        const before = calls;
        await m.fetchCodexUsage(async () => {
          cur = "tok-D2"; // ensureFreshAccessToken 이 만료 임박 토큰을 갈았다
          return "tok-D2";
        }, false, () => cur);
        await m.fetchCodexUsage(async () => cur, false, () => cur);
        out.push(assert("codex ④ 토큰을 받으며 갱신됐으면 그 토큰으로 담는다 — 바로 다음 조회는 캐시(요청 1)", calls === before + 1, { 요청: calls - before }));
      }
      // ④' 보낸 토큰과 지금 자격이 엇갈림 — 옛 갱신 토큰(A′)으로 물은 답을 새 자격(B)의 캐시로 쓰지 않는다
      {
        const m = await codexMod("mismatch");
        let cur = "tok-A";
        used = 70; // A′ 의 답 = 30
        const before = calls;
        const old = await m.fetchCodexUsage(async () => {
          cur = "tok-B"; // 갱신 저장을 기다리는 사이 B 로그인이 메모리를 먼저 바꿨다
          return "tok-A-refreshed";
        }, false, () => cur);
        used = 5; // B 의 답 = 95
        const b = await m.fetchCodexUsage(async () => cur, false, () => cur);
        out.push(
          assert(
            "★★codex ④' 받는 사이 자격이 바뀌어 옛 토큰으로 물은 답은 새 자격의 캐시가 되지 않는다 — 새 자격은 새로 묻는다",
            first(old) === 30 && first(b) === 95 && calls - before === 2 && lastBearer === "Bearer tok-B",
            { 옛: first(old), 새: first(b), 요청: calls - before },
          ),
        );
      }
      // ⑤ 제품 배선 — 등록된 getUsage · credentialTag · 인증 직후 자동 조회는 갱신하지 않음
      {
        const idx = (await import(`${new URL("../../../plugins/codex-subscription-auth/index.ts", import.meta.url).href}?reg-${Date.now()}`)).default as new () => {
          startService: (b: unknown, h: unknown) => Promise<void>;
        };
        const h = {
          locale: "ko",
          log: () => {},
          captured: undefined as Record<string, unknown> | undefined,
          registerAuthProvider: (pp: Record<string, unknown>) => {
            h.captured = pp;
            return { ok: true as const };
          },
        };
        await new idx().startService(null, h);
        const getUsage = h.captured?.getUsage as (f?: boolean, o?: { afterAuth?: boolean }) => Promise<Usage | undefined>;
        const tagOf = h.captured?.credentialTag as (() => string) | undefined;
        delete process.env.OPENAI_CODEX_OAUTH_REFRESH;
        process.env.OPENAI_CODEX_OAUTH_TOKEN = "access-old";
        process.env.OPENAI_CODEX_OAUTH_EXPIRES = String(Date.now() + 9 * 86_400_000);
        const tag1 = tagOf?.();
        const before = calls;
        used = 15;
        const a = await getUsage(false);
        used = 35;
        const b = await getUsage(false);
        const mid = calls - before;
        process.env.OPENAI_CODEX_OAUTH_TOKEN = "access-new"; // 다시 로그인
        const tag2 = tagOf?.();
        const c = await getUsage(false, { afterAuth: true });
        out.push(
          assert(
            "★★codex ⑤ 등록된 getUsage(제품 배선)도 같은 토큰은 접고, 다시 로그인하면 접는 창 안이어도 새로 묻는다",
            first(a) === 85 && first(b) === 85 && mid === 1 && first(c) === 65 && calls - before === 2,
            { a: first(a), b: first(b), c: first(c), 요청: calls - before },
          ),
        );
        out.push(
          assert(
            "codex ⑤ `credentialTag` 는 자격마다 다르고 토큰 값을 담지 않는다",
            typeof tag1 === "string" && tag1 !== "" && tag1 !== tag2 && !String(tag1).includes("access") && !String(tag2).includes("access"),
            { tag1, tag2 },
          ),
        );
        // 만료 임박 토큰 — 인증 직후 자동 조회는 갱신(=자격 저장)을 일으키지 않고, 일반 조회는 종전대로 갱신한다.
        process.env.OPENAI_CODEX_OAUTH_TOKEN = "access-expiring";
        process.env.OPENAI_CODEX_OAUTH_REFRESH = "rt-expiring";
        process.env.OPENAI_CODEX_OAUTH_EXPIRES = String(Date.now() + 60_000);
        tokenPosts = 0;
        const usageBefore = calls;
        const auto = await getUsage(false, { afterAuth: true });
        const autoPosts = tokenPosts;
        const autoUsage = calls - usageBefore;
        const normal = await getUsage(false);
        out.push(
          assert(
            "★★codex ⑤' 인증 직후 자동 조회는 만료 임박 토큰이어도 갱신하지 않는다(«대기») · 일반 조회는 종전대로 갱신해서 묻는다",
            autoPosts === 0 && autoUsage === 0 && (auto?.windows ?? []).length === 0 && typeof auto?.retryAt === "number" && tokenPosts === 1 && (normal?.windows ?? []).length === 1,
            { 자동갱신: autoPosts, 자동조회: autoUsage, 일반갱신: tokenPosts, 일반: normal?.windows?.length },
          ),
        );
      }
      // ⑥ 진행 중 조회 — 다른 자격은 나눠 쓰지도 기다리지도 않는다
      {
        const m = await codexMod("inflight");
        let cur = "tok-old";
        const before = calls;
        used = 70; // 옛 자격의 답 = 30
        holdFetch = true;
        const pOld = m.fetchCodexUsage(async () => "tok-old", false, () => cur);
        const heldOld = await heldOne(heldFetch);
        cur = "tok-new";
        used = 5; // 새 자격의 답 = 95
        holdFetch = false;
        const pNew = await within(m.fetchCodexUsage(async () => "tok-new", false, () => cur));
        for (const r of heldFetch.splice(0)) r();
        const old = await pOld;
        const again = await m.fetchCodexUsage(async () => "tok-new", false, () => cur);
        out.push(
          assert(
            "★★codex ⑥ 옛 자격으로 돌던 조회가 붙잡혀 있어도 새 자격의 요청은 기다리지 않고 새로 묻고, 늦게 끝난 옛 답이 새 캐시를 덮지 않는다",
            heldOld && pct(pNew) === 95 && first(old) === 30 && first(again) === 95 && calls - before === 2,
            { 붙잡음: heldOld, 새: pct(pNew), 옛: first(old), 다음: first(again), 요청: calls - before },
          ),
        );
      }
    } finally {
      globalThis.fetch = realFetch;
      holdFetch = false;
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
    }

    // ── claude ───────────────────────────────────────────────────────────
    const modUrl = new URL("../../../plugins/claude-subscription-auth/index.mjs", import.meta.url).href;
    const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const dirs: string[] = [];
    fakeCli();
    /** 토큰 → 조직(모델 목록 응답 머리). 없으면 "org-same" · `null` 이면 머리가 안 온다(모름). */
    const tokenOrgs: Record<string, string | null> = {};
    /** 엔드포인트(`/api/oauth/usage`) 응답 — 429 의 retry-after(초)와 붙잡기. */
    let endpointCalls = 0;
    let endpointRetryAfter = 60;
    let holdEndpoint = false;
    const heldEndpoint: (() => void)[] = [];
    /** 켜 두면 엔드포인트가 200 으로 이 사용률(0~1)을 준다 — 지금 토큰으로 물은 확인된 값(성공값·파일 캐시에 담기는 유일한 숫자). */
    let endpointOkUsed: number | undefined;
    /** 성공값을 안 줄 때의 상태 — 기본 429(retry-after 와 함께) · 200 이면 창 없는 빈 응답. */
    let endpointFailStatus = 429;
    globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
      if (String(url).includes("/api/oauth/usage")) {
        endpointCalls += 1;
        const ra = String(endpointRetryAfter); // 보낸 순간의 값
        const okUsed = endpointOkUsed;
        const failStatus = endpointFailStatus;
        const res =
          okUsed !== undefined
            ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ five_hour: { utilization: okUsed, resets_at: new Date(Date.now() + 3_600_000).toISOString() } }) }
            : failStatus === 200
              ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }
              : { ok: false, status: failStatus, headers: { get: (k: string) => (failStatus === 429 && k.toLowerCase() === "retry-after" ? ra : null) }, json: async () => ({}) };
        if (holdEndpoint) return new Promise((resolve) => heldEndpoint.push(() => resolve(res)));
        return res;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (String(url).includes("/v1/models") && k.toLowerCase() === "anthropic-organization-id" ? (tokenOrgs[auth] === null ? null : (tokenOrgs[auth] ?? "org-same")) : null) },
        json: async () => ({}),
        text: async () => "",
      };
    }) as never;
    let turns: Usage | undefined;
    /** 턴 값을 읽는 n 번째 순간에 한 번 끼어든다(㉙ — 옛 요청이 답을 정하는 그 순간에 다른 자격의 조회가 시작된 경우). */
    let turnsHook: { at: number; run: () => void } | undefined;
    let turnsReads = 0;
    const startClaude = async (tag: string, cache?: Record<string, unknown>, reuseDir?: string) => {
      const dir = reuseDir ?? (await fsp.mkdtemp(`${os.tmpdir()}/usage-cred-`));
      if (reuseDir === undefined) dirs.push(dir);
      if (cache !== undefined) await fsp.writeFile(`${dir}/usage-cache.json`, JSON.stringify(cache));
      const P = (await import(`${modUrl}?${tag}-${Date.now()}`)).default as new () => { startService: (b: unknown, h: unknown) => Promise<void> };
      const h = {
        dataDir: dir,
        locale: "ko",
        log: () => {},
        captured: undefined as Record<string, unknown> | undefined,
        registerAuthProvider: (pp: Record<string, unknown>) => {
          h.captured = pp;
          return { ok: true as const };
        },
        claudeUsageFromTurns: () => {
          turnsReads += 1;
          if (turnsHook !== undefined && turnsReads === turnsHook.at) {
            const run = turnsHook.run;
            turnsHook = undefined;
            run();
          }
          return turns;
        },
      };
      await new P().startService(null, h);
      return { dir, getUsage: h.captured?.getUsage as (f?: boolean) => Promise<Usage | undefined>, tagOf: h.captured?.credentialTag as (() => string) | undefined };
    };
    try {
      // ⑦⑧
      {
        // 숫자를 담는 길은 지금 토큰으로 묻는 엔드포인트뿐이다(CLI 숫자는 쓰지 않는다) — CLI 없는 기계 + 엔드포인트 200 으로 본다.
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-old";
        turns = undefined;
        cliMissing = true;
        endpointCalls = 0;
        endpointOkUsed = 0.3;
        const { getUsage, tagOf } = await startClaude("basic");
        holdEndpoint = true;
        const ps = [getUsage(false), getUsage(false), getUsage(false)];
        await heldOne(heldEndpoint);
        await tick();
        holdEndpoint = false;
        for (const r of heldEndpoint.splice(0)) r();
        const [a] = await Promise.all(ps);
        endpointOkUsed = 0.8;
        const b = await getUsage(false);
        const callsSame = endpointCalls;
        const tag1 = tagOf?.();
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-new"; // 화면 붙여넣기·발급기가 바꾼 것과 같다
        const c = await getUsage(false);
        endpointOkUsed = undefined;
        cliMissing = false;
        out.push(
          assert(
            "claude ⑦ 같은 토큰이면 동시 요청은 한 번 · 30초 안 재조회는 접는다",
            first(a) === 70 && first(b) === 70 && callsSame === 1,
            { a: first(a), b: first(b), 요청: callsSame },
          ),
        );
        out.push(assert("★★claude ⑧ 토큰이 바뀌면 접는 창 안이어도 새로 묻고 새 숫자", first(c) === 20 && endpointCalls === 2, { c: first(c), 요청: endpointCalls }));
        out.push(
          assert(
            "claude ⑪ `credentialTag` 는 토큰마다 다르고 토큰 값이 아니다",
            typeof tag1 === "string" && tag1 === keyOf("sk-ant-regression-old") && tagOf?.() === keyOf("sk-ant-regression-new") && !String(tag1).includes("sk-ant"),
            { tag1 },
          ),
        );
      }
      // ⑨ 진행 중 조회
      {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        turns = undefined;
        cliSpawnsUsage = 0;
        const { getUsage } = await startClaude("inflight");
        cliUsedPct = 30; // A = 70
        holdCli = true;
        const pA = getUsage(true);
        const heldA = await heldOne(heldCli);
        holdCli = false;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        cliUsedPct = 60; // B = 40
        const b = await within(getUsage(false));
        for (const r of heldCli.splice(0)) r();
        const a = await pA;
        const again = await getUsage(false);
        out.push(
          assert(
            "★★claude ⑨ 옛 토큰으로 돌던 조회를 새 토큰의 요청이 나눠 쓰지 않고, 늦게 끝난 옛 조회는 멈춘다(«모름»)",
            // 옛 조회는 CLI 에서 돌아왔을 때 자격이 바뀌었으면 거기서 멈추고 «모름» 을 돌려준다(옛 화면 요청 — 화면은 이미 버린다).
            // B 의 답은 CLI 숫자가 아니라 «확인 불가»(CLI 숫자는 쓰지 않는다)
            heldA && unv(b) && a === undefined && unv(again) && cliSpawnsUsage === 2,
            { 붙잡음: heldA, B: b === JOINED_OLD ? "옛 조회를 나눠 씀" : b, A늦게: a, 다음: again, CLI: cliSpawnsUsage },
          ),
        );
      }
      // ⑩ 재시작 너머 파일 캐시
      {
        const cacheOf = (token: string) => ({
          key: keyOf(token),
          src: "endpoint", // 제품이 쓰는 형식 — 숫자는 지금 토큰으로 물은 엔드포인트 값
          notBefore: 0,
          refusedAfterWaiting: 0,
          at: Date.now(),
          value: { windows: [{ windowSeconds: 18_000, remainingPercent: 33, resetAt: Date.now() + 3_600_000 }], measuredAt: Date.now() },
        });
        turns = undefined;
        cliUsedPct = 90; // CLI 에 물으면 10
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        cliSpawnsUsage = 0;
        const other = await (await startClaude("file-other", cacheOf("sk-ant-regression-A"))).getUsage(false);
        const otherSpawns = cliSpawnsUsage;
        cliSpawnsUsage = 0;
        const same = await (await startClaude("file-same", cacheOf("sk-ant-regression-B"))).getUsage(false);
        out.push(
          assert(
            "★★claude ⑩ 재시작 때 다른 토큰이 남긴 파일 캐시 숫자는 쓰지 않는다(새로 묻는다) — 같은 토큰이면 그대로 쓴다",
            unv(other) && otherSpawns === 1 && first(same) === 33 && cliSpawnsUsage === 0,
            { 다른토큰: other, CLI: otherSpawns, 같은토큰: first(same), CLI2: cliSpawnsUsage },
          ),
        );
      }
      // ⑪ 바뀐 직후의 턴 사용률
      {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        turns = undefined;
        cliUsedPct = 30;
        cliSpawnsUsage = 0;
        const { getUsage } = await startClaude("turns");
        await getUsage(false); // A 의 답을 쥔다
        // B 로 바꾸고 첫 조회 전에 B 의 턴이 끝났다 — 코어는 지금 토큰의 턴 값만 준다(`rate-limit-view.ts`).
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        turns = { measuredAt: Date.now() - 1_000, windows: [{ windowSeconds: 18_000, remainingPercent: 88 }] };
        const t = await getUsage(false);
        out.push(
          assert(
            "★claude ⑪ 토큰이 바뀐 직후라도 코어가 준 턴 사용률(지금 토큰의 실측)은 쓴다 — CLI 에 다시 묻지 않는다",
            first(t) === 88 && cliSpawnsUsage === 1,
            { 값: first(t), CLI: cliSpawnsUsage },
          ),
        );
      }
      // ⑫ 제품이 쓴 파일 캐시 → 재기동
      {
        // 파일에 숫자가 담기는 길은 엔드포인트 성공값뿐이다 — CLI 없는 기계 + 엔드포인트 200.
        cliMissing = true;
        turns = undefined;
        endpointOkUsed = 0.4; // 60 남음
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        endpointCalls = 0;
        const first1 = await startClaude("write");
        const wrote = await first1.getUsage(false);
        const saved = JSON.parse(await fsp.readFile(`${first1.dir}/usage-cache.json`, "utf8")) as Record<string, unknown>;
        endpointOkUsed = 0.9; // 다시 물으면 10
        endpointCalls = 0;
        const same = await (await startClaude("reboot-same", undefined, first1.dir)).getUsage(false);
        const sameCalls = endpointCalls;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        endpointCalls = 0;
        const other = await (await startClaude("reboot-other", undefined, first1.dir)).getUsage(false);
        endpointOkUsed = undefined;
        out.push(
          assert(
            "★★claude ⑫ 제품이 쓴 파일 캐시(토큰 표지 포함)를 같은 토큰으로 재기동하면 다시 묻지 않고 쓰고, 다른 토큰이면 숫자를 버리고 새로 묻는다",
            first(wrote) === 60 && saved.key === keyOf("sk-ant-regression-A") && saved.src === "endpoint" && !JSON.stringify(saved).includes("sk-ant") && first(same) === 60 && sameCalls === 0 && first(other) === 10 && endpointCalls === 1,
            { 처음: first(wrote), 파일key: saved.key, 같은토큰: first(same), 요청: sameCalls, 다른토큰: first(other) },
          ),
        );
        // 표지 없는 옛 파일 — 숫자는 쓰지 않되 서버 시계(`notBefore`)는 지킨다(CLI 없는 기계 = 엔드포인트 경로)
        cliMissing = true;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        endpointCalls = 0;
        const legacyWait = Date.now() + 3_600_000;
        const legacy = await (
          await startClaude("legacy", {
            notBefore: legacyWait,
            refusedAfterWaiting: 5,
            at: Date.now(),
            value: { windows: [{ windowSeconds: 18_000, remainingPercent: 33, resetAt: Date.now() + 3_600_000 }], measuredAt: Date.now() },
          })
        ).getUsage(false);
        out.push(
          assert(
            "★claude ⑫ 표지 없는 옛 파일이면 숫자·«안 열림» 판정은 쓰지 않되 서버가 정한 대기 시각은 지킨다(엔드포인트 요청 0)",
            (legacy?.windows ?? []).length === 0 && (legacy as { unavailable?: boolean } | undefined)?.unavailable !== true && legacy?.retryAt === legacyWait && endpointCalls === 0,
            { 답: legacy, 요청: endpointCalls },
          ),
        );
      }
      // ⑬ 겹친 다른 자격 조회의 늦은 짧은 429
      {
        cliMissing = true;
        turns = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        const { getUsage, dir: nbDir } = await startClaude("notbefore");
        endpointCalls = 0;
        endpointRetryAfter = 60; // A 의 답 — 짧다(늦게 온다)
        holdEndpoint = true;
        const pA = getUsage(true);
        const heldEp = await heldOne(heldEndpoint);
        holdEndpoint = false;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        endpointRetryAfter = 3_600; // B 의 답 — 길다(먼저 온다)
        const bJoined = (await within(getUsage(false))) === JOINED_OLD; // 옛 조회를 나눠 쓰면 여기서 멈추지 않게
        for (const r of heldEndpoint.splice(0)) r();
        await pA;
        // 서버 시계는 파일로 재시작 너머까지 지켜진다 — 거기 남은 값이 곧 «언제 다시 묻나» 다(메모리의 5초 연타 하한과 무관).
        const kept = (JSON.parse(await fsp.readFile(`${nbDir}/usage-cache.json`, "utf8")) as { notBefore?: number }).notBefore ?? 0;
        out.push(
          assert(
            "★★claude ⑬ 다른 자격의 조회가 겹쳐 늦게 온 짧은 429 가 서버가 정한 더 긴 대기를 줄이지 않는다(남은 대기 ≥ 50분)",
            heldEp && !bJoined && endpointCalls === 2 && kept > Date.now() + 3_000_000,
            { 붙잡음: heldEp, 옛조회공유: bJoined, 요청: endpointCalls, 남은대기: Math.round((kept - Date.now()) / 1000) + "초" },
          ),
        );
      }
      // ⑬' 대기 전에 보낸 요청의 거절
      {
        cliMissing = true;
        turns = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        const { getUsage, dir: rDir } = await startClaude("refused");
        endpointRetryAfter = 60;
        holdEndpoint = true;
        const pA = getUsage(true);
        const heldA = await heldOne(heldEndpoint);
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        const pB = getUsage(false); // B 도 대기가 생기기 **전에** 보낸다
        for (let i = 0; i < 100 && heldEndpoint.length < 2; i += 1) await tick();
        const bothHeld = heldEndpoint.length === 2;
        holdEndpoint = false;
        heldEndpoint.shift()?.(); // A 의 429 가 먼저 와서 대기 시각을 세운다
        await pA;
        heldEndpoint.shift()?.(); // 그 뒤 B 의 429
        await pB;
        const refused = (JSON.parse(await fsp.readFile(`${rDir}/usage-cache.json`, "utf8")) as { refusedAfterWaiting?: number }).refusedAfterWaiting;
        out.push(
          assert(
            "★claude ⑬' 대기가 생기기 전에 보낸 요청의 거절은 «기다렸다 거절» 로 세지 않는다(겹친 옛 자격의 429 가 먼저 와도)",
            heldA && bothHeld && refused === 0,
            { 붙잡음: [heldA, bothHeld], 기다렸다거절: refused },
          ),
        );
      }
      // ⑭ 토큰·CLI 로그인을 함께 바꾼다
      {
        cliMissing = false;
        turns = undefined;
        tokenOrgs["sk-ant-regression-A"] = "org-A";
        tokenOrgs["sk-ant-regression-B"] = "org-B";
        cliOrg = "org-A";
        cliUsedPct = 30;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        const { getUsage } = await startClaude("org");
        const a = await getUsage(false);
        cliOrg = "org-B"; // CLI 도 B 로 다시 로그인
        cliUsedPct = 60;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        const b = await getUsage(false);
        out.push(
          assert(
            "★claude ⑭ 토큰과 CLI 로그인을 함께 바꾸면 계정 대조를 옛 CLI 조직 메모(10분)로 하지 않는다 — «다른 계정» 이 아니다(숫자는 어느 쪽도 «확인 불가»)",
            unv(a) && unv(b),
            { A: a, B: b },
          ),
        );
        // ⑭' 바뀌기 전에 시작한 조직 조회(A)가 늦게 끝나 새 메모(B)를 덮지 않는다
        cliOrg = "org-A";
        cliUsedPct = 30;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A2";
        tokenOrgs["sk-ant-regression-A2"] = "org-A";
        tokenOrgs["sk-ant-regression-B2"] = "org-B";
        holdAuth = true;
        const pA2 = getUsage(true); // A2 — 조직 조회(`auth status`)가 붙잡힌다
        const heldOrg = await heldOne(heldAuth);
        holdAuth = false;
        cliOrg = "org-B";
        cliUsedPct = 60;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B2";
        const b2 = await within(getUsage(false));
        for (const r of heldAuth.splice(0)) r(); // 이제야 A2 의 조직(org-A) 답이 온다
        await pA2;
        const b2again = await getUsage(false); // 곧바로 보통 조회 — 늦게 끝난 A2 의 숫자가 B2 의 성공값이 되면 여기서 보인다
        // 연타 하한(5초)을 지나 다시 묻는다 — 그때 조직 대조는 메모를 쓴다
        const realNow = Date.now;
        Date.now = () => realNow() + 6_000;
        let b3: Usage | undefined;
        try {
          b3 = await getUsage(true);
        } finally {
          Date.now = realNow;
        }
        out.push(
          assert(
            "★claude ⑭' 바뀌기 전에 시작한 CLI 조직 조회가 늦게 끝나도 새 조직 메모를 덮지 않는다 — 다음 조회도 «다른 계정» 이 아니다",
            heldOrg && unv(b2) && unv(b2again) && unv(b3),
            { 붙잡음: heldOrg, B2: b2 === JOINED_OLD ? "옛 조회를 나눠 씀" : b2, 곧바로: b2again, 다음: b3 },
          ),
        );
        cliOrg = "org-same";
        delete tokenOrgs["sk-ant-regression-A"];
        delete tokenOrgs["sk-ant-regression-B"];
      }
      // ⑯ 옛 자격의 늦은 CLI 실패
      {
        turns = undefined;
        cliOrg = "org-same";
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        const { getUsage } = await startClaude("clidead");
        cliMissing = true; // A 의 CLI 는 실패한다 — 그 실패를 붙잡는다
        holdCli = true;
        const pA = getUsage(true);
        const heldFail = await heldOne(heldCli);
        holdCli = false;
        cliMissing = false;
        cliUsedPct = 25;
        cliSpawnsUsage = 0;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        const b = await within(getUsage(false)); // B 는 CLI 로 성공
        for (const r of heldCli.splice(0)) r(); // 이제야 A 의 «CLI 없음» 이 온다
        await pA;
        const spawnsBefore = cliSpawnsUsage;
        const realNow = Date.now;
        Date.now = () => realNow() + 10 * 60_000 + 1_000; // CLI 조직 확인 주기(10분)를 지나 B 를 다시 묻는다 — 그 전엔 CLI 를 띄우지 않는다(⑳)
        let again: Usage | undefined;
        try {
          again = await getUsage(false);
        } finally {
          Date.now = realNow;
        }
        out.push(
          assert(
            "★claude ⑯ 옛 자격의 CLI 실패가 늦게 와도 새 자격에서 성공한 CLI 를 «없음» 으로 만들지 않는다 — 다음 조회도 CLI 로 묻는다",
            heldFail && unv(b) && cliSpawnsUsage === spawnsBefore + 1 && unv(again),
            { 붙잡음: heldFail, B: b === JOINED_OLD ? "옛 조회를 나눠 씀" : b, CLI재실행: cliSpawnsUsage - spawnsBefore, 다음: again },
          ),
        );
      }
      // ⑰ 옛 자격의 CLI 실패가 **먼저 끝난** 뒤 재인증 — 새 자격은 CLI 를 다시 묻는다(서버 시계는 그대로)
      {
        turns = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        const { getUsage } = await startClaude("clidead-first");
        cliMissing = true;
        endpointRetryAfter = 60;
        await getUsage(true); // A: CLI 실패 → «CLI 없음» 기억 → 엔드포인트 429
        cliMissing = false;
        cliUsedPct = 35;
        cliSpawnsUsage = 0;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        const b = await getUsage(false); // 인증 직후 자동 조회(GET — force 아님)
        out.push(
          assert(
            "★claude ⑰ 옛 자격의 CLI 실패가 먼저 끝났어도 재인증 뒤 자동 조회는 CLI 를 다시 묻는다(수동 🔄 없이)",
            cliSpawnsUsage === 1 && unv(b),
            { CLI: cliSpawnsUsage, B: b },
          ),
        );
      }
      // ⑱ CLI 를 기다리던 옛 조회는 자격이 바뀌었으면 거기서 멈춘다 — 새 토큰으로 엔드포인트까지 가지 않는다
      {
        turns = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        const { getUsage } = await startClaude("abandon");
        cliMissing = true; // A 의 CLI 는 실패하고 그 실패를 붙잡는다 → 풀리면 (가드 없으면) 엔드포인트로 넘어간다
        holdCli = true;
        endpointCalls = 0;
        const pA = getUsage(true);
        const heldA = await heldOne(heldCli);
        holdCli = false;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B";
        endpointRetryAfter = 60;
        await within(getUsage(false)); // B: CLI 실패(없음) → 엔드포인트 1회
        const afterB = endpointCalls;
        for (const r of heldCli.splice(0)) r();
        const a = await pA;
        cliMissing = false;
        out.push(
          assert(
            "★claude ⑱ CLI 를 기다리던 옛 조회는 자격이 바뀌었으면 거기서 멈춘다 — 새 토큰으로 엔드포인트를 더 두드리지 않는다",
            heldA && afterB === 1 && endpointCalls === 1 && a === undefined,
            { 붙잡음: heldA, B뒤: afterB, 최종: endpointCalls, 옛답: a },
          ),
        );
      }
      // ⑲ 재인증 앞뒤 — 첫 조회·이후 보통 조회·🔄 모두 CLI 숫자 대신 «확인 불가», 지금 토큰의 턴 값은 쓴다
      {
        cliMissing = false;
        turns = undefined;
        cliOrg = "org-A"; // 이 기계 CLI 는 A 로 로그인 그대로(재로그인 안 함)
        cliUsedPct = 30; // CLI 가 말하는 A 의 숫자 = 70
        tokenOrgs["sk-ant-regression-vA"] = "org-A";
        tokenOrgs["sk-ant-regression-vB"] = null; // B 토큰의 조직 조회는 실패한다
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-vA";
        const { getUsage, dir: vDir } = await startClaude("verified");
        const a = await getUsage(false); // 같은 조직으로 답해도 CLI 숫자는 확인할 수 없다
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-vB"; // 화면 붙여넣기로 B 재인증
        const realNow = Date.now;
        let shift = 0;
        const later = async (ms: number, force: boolean): Promise<Usage | undefined> => {
          shift += ms;
          Date.now = () => realNow() + shift;
          try {
            return await getUsage(force);
          } finally {
            Date.now = realNow;
          }
        };
        const b1 = await getUsage(false); // 인증 직후 첫 조회
        const b2 = await later(31_000, false); // 접는 창(30초) 뒤 보통 조회
        const b3 = await later(6_000, true); // 🔄
        const saved = JSON.parse(await fsp.readFile(`${vDir}/usage-cache.json`, "utf8")) as { key?: string; value?: unknown };
        turns = { measuredAt: Date.now() - 2 * 3_600_000, windows: [{ windowSeconds: 18_000, remainingPercent: 88 }] }; // 이제 B 로 대화했다(낡은 턴)
        const b4 = await later(31_000, false);
        turns = undefined;
        tokenOrgs["sk-ant-regression-vB"] = "org-A"; // B 토큰도 A 조직이다 — 그래도 CLI 숫자는 계정 식별자가 없어 쓰지 않는다
        const b5 = await later(10 * 60_000, false); // CLI 조직은 주기(10분)마다 이번 조회에서 다시 묻는다(⑳)
        const saved5 = JSON.parse(await fsp.readFile(`${vDir}/usage-cache.json`, "utf8")) as { key?: string; value?: Usage | null };
        out.push(
          assert(
            "★★claude ⑲ 재인증 앞뒤 CLI 숫자(옛 계정일 수 있음)를 첫 조회·이후 보통 조회·🔄 어디서도 보이지 않고 «확인 불가» · 파일에도 안 담는다",
            unv(a) && unv(b1) && unv(b2) && unv(b3) && saved.key === keyOf("sk-ant-regression-vB") && (saved.value === null || saved.value === undefined),
            { A: a, b1, b2, b3, 파일: saved },
          ),
        );
        out.push(
          assert(
            "★claude ⑲ 확인된 값은 쓴다 — 지금 토큰의 턴 값(낡았어도 측정 시각과 함께) · 조직이 같다고 답해도 CLI 숫자는 보이지도 담지도 않는다",
            first(b4) === 88 && unv(b5) && (saved5.value === null || saved5.value === undefined) && saved5.key === keyOf("sk-ant-regression-vB"),
            { b4: first(b4), b5, 파일: saved5 },
          ),
        );
        cliOrg = "org-same";
      }
      // ⑳ 토큰은 그대로, 이 기계 CLI 만 다른 계정으로 다시 로그인 — CLI 숫자는 쓰지 않는다(G2·남은 차단 #1).
      //    주기 안엔 CLI 를 띄우지 않고 지금 자격의 확인된 값(낡은 턴 70) · 엔드포인트를 새로 두드리지 않는다(G4)
      {
        cliMissing = false;
        turns = { measuredAt: Date.now() - 2 * 3_600_000, windows: [{ windowSeconds: 18_000, remainingPercent: 70 }] };
        cliOrg = "org-A";
        cliUsedPct = 30; // A = 70
        tokenOrgs["sk-ant-regression-gA"] = "org-A";
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-gA";
        const { getUsage } = await startClaude("cli-relogin");
        const a = await getUsage(false); // CLI 는 띄우되 그 숫자 대신 지금 토큰의 턴 값 70
        cliOrg = "org-B"; // CLI 만 B 로 다시 로그인 — CLI 가 말하는 숫자는 B 의 40
        cliUsedPct = 60;
        cliSpawnsUsage = 0;
        endpointCalls = 0;
        const realNow = Date.now;
        let shift = 0;
        const later = async (ms: number, force: boolean): Promise<Usage | undefined> => {
          shift += ms;
          Date.now = () => realNow() + shift;
          try {
            return await getUsage(force);
          } finally {
            Date.now = realNow;
          }
        };
        const g1 = await later(31_000, false); // 보통 조회
        const g2 = await later(6_000, true); // 🔄
        const spawnsInCadence = cliSpawnsUsage;
        const g3 = await later(10 * 60_000, false); // 주기를 지나 CLI 와 조직을 이번에 묻는다 — 다른 계정이다
        const refreshAfter = (g2 as { refreshAfter?: number } | undefined)?.refreshAfter ?? 0;
        out.push(
          assert(
            "★★claude ⑳ CLI 만 다른 계정으로 다시 로그인해도 그 숫자를 보이지 않는다 — 보통 조회·🔄·주기 뒤 모두 확인된 A 값(턴, 측정 시각 그대로)",
            first(a) === 70 && first(g1) === 70 && first(g2) === 70 && first(g3) === 70 && g1?.measuredAt === a?.measuredAt && g3?.measuredAt === a?.measuredAt,
            { A: first(a), g1: first(g1), g2: first(g2), g3: first(g3) },
          ),
        );
        out.push(
          assert(
            "★claude ⑳ 확인할 근거가 없는 주기 안에서는 CLI 를 띄우지 않고 · 엔드포인트도 새로 두드리지 않는다 — 🔄 는 연타 하한 뒤 열린다(주기 안 🔄 는 CLI 없이 확인된 값만 다시 읽는다, 인계 1-1)",
            spawnsInCadence === 0 && cliSpawnsUsage === 1 && endpointCalls === 0 && refreshAfter <= realNow() + 31_000 + 6_000 + 5_000 + 1_000,
            { 주기안CLI: spawnsInCadence, CLI: cliSpawnsUsage, 엔드포인트: endpointCalls, 새로고침열림: Math.round((refreshAfter - realNow()) / 1000) + "초 뒤" },
          ),
        );
        turns = undefined;
        cliOrg = "org-same";
      }
      // ㉖ 첫 CLI «확인 불가» → 같은 자격의 턴 값 도착 → 🔄 (인계 1-1)
      {
        cliMissing = false;
        cliOrg = "org-same";
        turns = undefined;
        cliSpawnsUsage = 0;
        endpointCalls = 0;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-g26";
        const { getUsage } = await startClaude("turn-after-unknown");
        const realNow = Date.now;
        let shift = 0;
        const at = async (ms: number, force: boolean): Promise<Usage | undefined> => {
          shift += ms;
          Date.now = () => realNow() + shift;
          try {
            return await getUsage(force);
          } finally {
            Date.now = realNow;
          }
        };
        const ra = (u: unknown): number => (u as { refreshAfter?: number } | undefined)?.refreshAfter ?? Number.POSITIVE_INFINITY;
        const a = await at(0, true); // 첫 CLI — 숫자는 쓰지 않는다 → «확인 불가»
        const aAt = realNow() + shift;
        const spawnsFirst = cliSpawnsUsage;
        turns = { measuredAt: realNow() + shift + 1_000, windows: [{ windowSeconds: 18_000, remainingPercent: 64 }] }; // 같은 자격의 턴이 끝났다
        const b = await at(6_000, true); // 🔄
        const bAt = realNow() + shift;
        const spawnsTurn = cliSpawnsUsage;
        turns = undefined;
        const c = await at(6_000, true); // 주기(10분) 안 🔄 — 턴 값이 없으면 «확인 불가», CLI 는 안 띄운다
        const cAt = realNow() + shift;
        const spawnsCadence = cliSpawnsUsage;
        await at(10 * 60_000, true); // 주기 뒤에는 CLI 를 다시 띄운다(주기 그대로)
        const spawnsAfter = cliSpawnsUsage;
        turns = { measuredAt: realNow() + shift - 1_000, windows: [{ windowSeconds: 18_000, remainingPercent: 64 }] };
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-g26-other"; // 자격이 바뀌었다 — 코어는 새 자격의 턴만 주므로(여기선 없음)
        turns = undefined;
        const e = await at(6_000, true);
        out.push(
          assert(
            "★★claude ㉖ 첫 CLI «확인 불가» 뒤 같은 자격의 턴 값은 🔄 로 바로 보인다(CLI 추가 0) · 🔄 는 연타 하한(5초) 뒤 열린다 · 주기 안 CLI 0·주기 뒤 1 · 엔드포인트 0 · 이전 자격 값 거절",
            // 해제 시각은 **그 응답 기준 5초**(위아래 둘 다) — 로컬 값을 돌려준 🔄 뒤에도 하한이 다시 걸린다(구현 검토 G1).
            unv(a) && spawnsFirst === 1 && ra(a) >= aAt + 5_000 - 50 && ra(a) <= aAt + 5_000 + 1_000 && first(b) === 64 && spawnsTurn === 1 &&
              ra(b) >= bAt + 5_000 - 50 && ra(b) <= bAt + 5_000 + 1_000 && ra(c) >= cAt + 5_000 - 50 && ra(c) <= cAt + 5_000 + 1_000 &&
              unv(c) && spawnsCadence === 1 && spawnsAfter === 2 && endpointCalls === 0 && unv(e) && first(e) === undefined,
            { a: unv(a), 새로고침열림_초: [Math.round((ra(a) - aAt) / 1000), Math.round((ra(b) - bAt) / 1000), Math.round((ra(c) - cAt) / 1000)], b: first(b), c: unv(c), CLI: [spawnsFirst, spawnsTurn, spawnsCadence, spawnsAfter], 엔드포인트: endpointCalls, 다른자격: first(e) },
          ),
        );
        // 같은 답을 실제 화면에 — 첫 답(«확인 불가»+refreshAfter) 뒤 🔄 가 하한 뒤 풀리고, 누르면 턴 값이 그려진다.
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-g26b";
        turns = undefined;
        cliSpawnsUsage = 0;
        // ★한 가상 시계 — 플러그인·화면(`Date.now`)·화면 타이머가 같은 시각을 본다(구현 검토 G2: 타이머만 밀면 하한을 무시해도 화면 단언이 통과했다).
        const clock = makeClock();
        const realDateNow = Date.now;
        const base = realDateNow();
        Date.now = () => base + clock.now();
        try {
        const fresh = await startClaude("turn-after-unknown-ui");
        const first1 = await fresh.getUsage(true);
        turns = { measuredAt: Date.now() + 1_000, windows: [{ windowSeconds: 18_000, remainingPercent: 57 }] };
        let posts = 0;
        const dash = bootDashboard({
          clock,
          i18n: i18nForContext,
          ids: ["plugins-list", "plugins-count", "plugins-search"],
          fetch: async (url: string, init?: { method?: string }) => {
            if (url.startsWith("/api/plugins")) return jsonResponse({ items: [{ name: "claude-sub", enabled: true, needsFacts: [{ kind: "auth", value: "claude" }] }] });
            if (url.startsWith("/api/auth-providers")) return jsonResponse({ providers: [{ provider: "claude", authenticated: true, hasUsage: true, login: { label: "login" } }] });
            if (url.startsWith("/api/auth-usage")) {
              if (init?.method === "POST") {
                posts += 1;
                return jsonResponse({ usage: await fresh.getUsage(true) });
              }
              return jsonResponse({ usage: first1 });
            }
            return jsonResponse({}, 404);
          },
          stubs: "const setChatPanel = () => {};",
        });
        const root = dash.document.getElementById("detail-panel") as MElement;
        dash.run("showPlugins()");
        await clock.advance(10);
        const btn = (): MElement | null => root.querySelector(".usage-refresh");
        const lockedAtFirst = btn()?.disabled === true;
        await clock.advance(4_800);
        const lockedBeforeFloor = btn()?.disabled === true;
        await clock.advance(500);
        const openAfterFloor = btn()?.disabled === false;
        if (btn()?.disabled === false) btn()?.click(); // 잠긴 단추는 브라우저에서 눌리지 않는다(mini-DOM 은 눌러 준다)
        await clock.advance(10);
        for (let i = 0; i < 50 && !(root.querySelector(".plugin-auth-usage")?.textContent ?? "").includes("57"); i += 1) {
          await tick();
          await clock.advance(10);
        }
        const shown = root.querySelector(".plugin-auth-usage")?.textContent ?? "";
        const relockedAfterClick = btn()?.disabled === true;
        await clock.advance(4_600);
        const stillLocked = btn()?.disabled === true;
        await clock.advance(700);
        const reopened = btn()?.disabled === false;
        out.push(
          assert(
            "★★claude ㉖ 화면: 첫 «확인 불가» 뒤 🔄 는 하한 동안만 잠기고 풀린다 → 누르면 CLI 추가 없이 같은 자격의 턴 값이 그려진다",
            lockedAtFirst && lockedBeforeFloor && openAfterFloor && posts === 1 && shown.includes("57") && relockedAfterClick && stillLocked && reopened && cliSpawnsUsage === 1 && clock.errors.length === 0,
            { 첫잠김: lockedAtFirst, 하한직전잠김: lockedBeforeFloor, 하한뒤열림: openAfterFloor, POST: posts, 표시: shown.slice(0, 80), 누른뒤다시잠김: relockedAfterClick, 다시하한직전잠김: stillLocked, 하한뒤다시열림: reopened, CLI: cliSpawnsUsage, 예외: clock.errors.join(" | ") },
          ),
        );
        } finally {
          Date.now = realDateNow;
        }
        turns = undefined;
        // CLI 가 실패하는(실행 불가) 기계 — 🔄 는 CLI 재시도를 위해 하한 뒤 열리지만(종전 그대로), 엔드포인트 백오프(성공 뒤 5분 · 429 의 서버 대기)는
        //  조회 안에서 그대로 지켜 다시 눌러도 엔드포인트를 두드리지 않는다. (번들 실행기 자체가 없는 기계의 해제 시각 분기 `refreshAfterNow` 끝 줄은
        //  이번 변경이 건드리지 않았다 — 이 고정 환경은 번들 실행기를 늘 찾아 그 분기를 만들 수 없다.)
        cliMissing = true;
        endpointOkUsed = 0.3;
        endpointCalls = 0;
        const later2 = async (g: (f?: boolean) => Promise<Usage | undefined>, ms: number): Promise<Usage | undefined> => {
          const base = Date.now;
          Date.now = () => base() + ms;
          try {
            return await g(true);
          } finally {
            Date.now = base;
          }
        };
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-g26-nocli";
        const nc = await startClaude("turn-after-unknown-nocli");
        const okNoCli = await nc.getUsage(true);
        const okAgain = await later2(nc.getUsage, 6_000);
        const callsOk = endpointCalls;
        endpointOkUsed = undefined;
        endpointFailStatus = 429;
        endpointRetryAfter = 900;
        endpointCalls = 0;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-g26-nocli2";
        const n2 = await startClaude("turn-after-unknown-nocli2");
        await n2.getUsage(true);
        await later2(n2.getUsage, 6_000);
        const calls429 = endpointCalls;
        endpointRetryAfter = 60;
        cliMissing = false;
        out.push(
          assert(
            "claude ㉖ CLI 가 실패하는 기계 — 🔄 를 다시 눌러도 엔드포인트 백오프(성공 뒤 5분 · 429 의 서버 대기)를 지켜 다시 두드리지 않는다",
            first(okNoCli) === 70 && first(okAgain) === 70 && callsOk === 1 && calls429 === 1,
            { 성공값: first(okNoCli), 다시: first(okAgain), 성공뒤호출: callsOk, 거절뒤호출: calls429 },
          ),
        );
      }
      // ㉑ 조직 확인을 기다리는 사이 지금 토큰의 턴 값이 왔다 — 판정하는 순간의 턴 값을 쓴다(G5)
      {
        cliMissing = false;
        turns = undefined;
        cliOrg = "org-A";
        tokenOrgs["sk-ant-regression-g5"] = null; // 토큰 조직 모름 — CLI 숫자는 못 쓴다
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-g5";
        const { getUsage } = await startClaude("late-turn");
        holdAuth = true;
        const p = getUsage(false);
        const held = await heldOne(heldAuth);
        holdAuth = false;
        turns = { measuredAt: Date.now() - 1_000, windows: [{ windowSeconds: 18_000, remainingPercent: 77 }] };
        for (const r of heldAuth.splice(0)) r();
        const u = await p;
        turns = undefined;
        // ㉑' 조직이 같아도(CLI 숫자는 안 쓴다) 기다리는 사이 온 턴 값이 답이다
        tokenOrgs["sk-ant-regression-g5ok"] = "org-A";
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-g5ok";
        const s2 = await startClaude("late-turn-ok");
        holdAuth = true;
        const p2 = s2.getUsage(false);
        const held2 = await heldOne(heldAuth);
        holdAuth = false;
        turns = { measuredAt: Date.now() + 1, windows: [{ windowSeconds: 18_000, remainingPercent: 66 }] };
        for (const r of heldAuth.splice(0)) r();
        const u2 = await p2;
        turns = undefined;
        out.push(
          assert(
            "★claude ㉑ 조직 확인을 기다리는 사이 도착한 지금 토큰의 턴 값을 쓴다 — 조직을 모를 때도 같을 때도 «확인 불가» 대신",
            held && first(u) === 77 && held2 && first(u2) === 66,
            { 붙잡음: [held, held2], 모름: u, 확인됨: first(u2) },
          ),
        );
        cliOrg = "org-same";
      }
      // ㉒ 조직 확인을 기다리는 사이 설치 토큰이 바뀌고 새 토큰의 턴 값이 왔다 — 옛 요청은 새 토큰의 값을 제 답으로 내지 않는다
      {
        cliMissing = false;
        turns = undefined;
        cliOrg = "org-A";
        tokenOrgs["sk-ant-regression-rA"] = null; // 확인 불가 분기(판정 순간의 턴 값을 읽는 쪽)
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-rA";
        const { getUsage } = await startClaude("switch-during-org");
        holdAuth = true;
        const pA = getUsage(false);
        const held = await heldOne(heldAuth);
        holdAuth = false;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-rB"; // 화면 밖 재인증 — 그 뒤 B 로 대화가 끝났다
        turns = { measuredAt: Date.now(), windows: [{ windowSeconds: 18_000, remainingPercent: 55 }] };
        for (const r of heldAuth.splice(0)) r();
        const a = await pA;
        turns = undefined;
        out.push(assert("★claude ㉒ 조직 확인을 기다리는 사이 자격이 바뀌면 옛 요청은 거기서 멈춘다 — 새 토큰의 턴 값을 옛 요청의 답으로 내지 않는다", held && a === undefined, { 붙잡음: held, 옛답: a }));
        cliOrg = "org-same";
      }
      // ㉓ 출처 표식 없는 파일(출시본·이전 후보 — 이전 후보는 같은 조직이면 CLI 숫자를 같은 토큰 표지로 담았다)의 숫자는 되살리지 않는다
      {
        cliMissing = false;
        turns = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        endpointCalls = 0;
        const prevCand = await (
          await startClaude("prev-candidate", {
            key: keyOf("sk-ant-regression-A"),
            notBefore: 0,
            refusedAfterWaiting: 0,
            at: Date.now(),
            value: { windows: [{ windowSeconds: 18_000, remainingPercent: 33, resetAt: Date.now() + 3_600_000 }], measuredAt: Date.now() },
          })
        ).getUsage(false);
        out.push(
          assert(
            "★★claude ㉓ 같은 토큰 표지라도 «엔드포인트 값» 표식이 없는 파일의 숫자(CLI 숫자였을 수 있다)는 되살리지 않는다 — «확인 불가»",
            unv(prevCand),
            { 답: prevCand },
          ),
        );
      }
      // ㉔ CLI 주기는 재시작 너머로 — 재시작 직후 보통 조회·🔄 가 CLI 를 다시 띄우지 않는다(종전엔 CLI 성공값이 파일에 있어 접혔다)
      {
        cliMissing = false;
        turns = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-A";
        cliSpawnsUsage = 0;
        const steps: number[] = [];
        const r1 = await startClaude("cadence-1");
        const a = await r1.getUsage(false);
        steps.push(cliSpawnsUsage);
        const r2 = await startClaude("cadence-2", undefined, r1.dir);
        const b = await r2.getUsage(false);
        steps.push(cliSpawnsUsage);
        const c = await r2.getUsage(true);
        steps.push(cliSpawnsUsage);
        // 주기(10분)가 지난 뒤 같은 토큰으로 재시작 — 이번엔 CLI 를 다시 띄운다(남은 시간만 물려받는다)
        const realNow = Date.now;
        Date.now = () => realNow() + 10 * 60_000 + 1_000;
        let e: Usage | undefined;
        try {
          e = await (await startClaude("cadence-late", undefined, r1.dir)).getUsage(false);
        } finally {
          Date.now = realNow;
        }
        steps.push(cliSpawnsUsage);
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-B"; // 다른 토큰은 그 주기를 물려받지 않는다
        const d = await (await startClaude("cadence-3", undefined, r1.dir)).getUsage(false);
        steps.push(cliSpawnsUsage);
        out.push(
          assert(
            "★claude ㉔ 재시작 직후 같은 토큰의 보통 조회·🔄 는 CLI 를 다시 띄우지 않는다(주기 10분 유지) · 주기가 지나면 다시 묻는다 · 다른 토큰은 새로 묻는다",
            unv(a) && unv(b) && unv(c) && unv(e) && unv(d) && steps.join(",") === "1,1,1,2,3",
            { 단계별CLI: steps.join(","), a, b, c, e, d },
          ),
        );
      }
      // ㉕ 같은 조직 CLI 응답이 와도 지금 토큰의 엔드포인트 성공값을 그대로 쓴다(CLI 숫자로 바꾸거나 «확인 불가» 로 지우지 않는다)
      {
        turns = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-E";
        cliMissing = true;
        endpointOkUsed = 0.4; // 60
        const { getUsage } = await startClaude("endpoint-then-cli");
        const e0 = await getUsage(false);
        endpointOkUsed = undefined;
        cliMissing = false;
        cliUsedPct = 90; // CLI 가 말하는 숫자 = 10
        cliSpawnsUsage = 0;
        const realNow = Date.now;
        let shift = 0;
        const later = async (ms: number, force: boolean): Promise<Usage | undefined> => {
          shift += ms;
          Date.now = () => realNow() + shift;
          try {
            return await getUsage(force);
          } finally {
            Date.now = realNow;
          }
        };
        const e1 = await later(31_000, true); // 🔄 — CLI 를 다시 묻는다(같은 조직)
        const e2 = await later(31_000, false); // 주기 안 보통 조회
        cliUsedPct = 30;
        out.push(
          assert(
            "★claude ㉕ 같은 조직 CLI 응답 뒤에도 지금 토큰의 엔드포인트 성공값(숫자·측정 시각)을 그대로 쓴다 — 🔄·주기 안 보통 조회 모두",
            first(e0) === 60 && cliSpawnsUsage === 1 && first(e1) === 60 && e1?.measuredAt === e0?.measuredAt && first(e2) === 60 && e2?.measuredAt === e0?.measuredAt,
            { e0: first(e0), e1, e2, CLI: cliSpawnsUsage },
          ),
        );
      }
      // ㉗ 옛 자격(A)으로 엔드포인트를 기다리던 조회가 새 자격(B)의 성공 뒤 늦게 실패한다(429·502) — 옛 요청은 B 의 성공값을 제 답으로 받지 않는다(«모름»).
      //  B 의 성공값·파일 캐시는 그대로다(검토 3-3).
      for (const failStatus of [429, 502, 200]) {
        turns = undefined;
        cliMissing = true;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-lateA";
        const { getUsage, dir: lfDir } = await startClaude(`late-fail-${failStatus}`);
        endpointOkUsed = undefined;
        endpointFailStatus = failStatus;
        endpointRetryAfter = 60;
        holdEndpoint = true;
        const pA = getUsage(true);
        const heldA = await heldOne(heldEndpoint);
        holdEndpoint = false;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-lateB"; // 화면 붙여넣기 — B 로 다시 인증
        endpointOkUsed = 0.6; // B = 40
        const b = await within(getUsage(false));
        endpointOkUsed = undefined;
        for (const r of heldEndpoint.splice(0)) r(); // 이제야 A 의 실패가 온다
        const a = await pA;
        const again = await getUsage(false);
        const file = JSON.parse(await fsp.readFile(`${lfDir}/usage-cache.json`, "utf8")) as { key?: string; value?: Usage | null };
        endpointFailStatus = 429;
        cliMissing = false;
        out.push(
          assert(
            `★★claude ㉗ 옛 자격의 늦은 엔드포인트 실패(${failStatus})는 새 자격의 성공값을 옛 요청의 답으로 돌려주지 않는다 — B 의 성공값·파일은 그대로`,
            heldA && b !== JOINED_OLD && first(b as Usage | undefined) === 40 && a === undefined && first(again) === 40 && file.key === keyOf("sk-ant-regression-lateB") && first(file.value ?? undefined) === 40,
            { 붙잡음: heldA, B: pct(b), A늦게: a, 다음: first(again), 파일: { key: file.key === keyOf("sk-ant-regression-lateB") ? "B" : file.key, 값: first(file.value ?? undefined) } },
          ),
        );
      }
      // ㉘ B 로 조회한 뒤 토큰만 A 로 돌아왔다(새 조회 전) — 늦게 끝난 옛 A 의 CLI 실패가 B 의 판정(«CLI 없음»)을 쓰거나 엔드포인트로 가지 않는다
      {
        turns = undefined;
        cliMissing = true;
        holdCli = true;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-backA";
        const { getUsage } = await startClaude("late-cli-back");
        endpointCalls = 0;
        const pA = getUsage(true); // A 의 CLI 가 붙잡힌다(나중에 «없음» 으로 끝난다)
        const heldA = await heldOne(heldCli);
        holdCli = false;
        cliMissing = false;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-backB";
        const b = await within(getUsage(false)); // B — CLI 가 있다(숫자는 «확인 불가»)
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-backA"; // 토큰만 A 로 — 아직 A 로 묻지 않았다
        endpointOkUsed = 0.6;
        for (const r of heldCli.splice(0)) r(); // 이제야 A 의 CLI 실패가 온다
        const a = await pA;
        const epAfterA = endpointCalls;
        endpointOkUsed = undefined;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-backB";
        const spawnsBefore = cliSpawnsUsage;
        const realNow = Date.now;
        Date.now = () => realNow() + 11 * 60_000; // CLI 주기(10분)가 지난 B 의 보통 조회 — B 의 «CLI 있음» 판정이 그대로면 CLI 를 다시 띄운다
        let b2: Usage | undefined;
        try {
          b2 = await getUsage(false);
        } finally {
          Date.now = realNow;
        }
        out.push(
          assert(
            "★★claude ㉘ 토큰만 A 로 돌아온 뒤 늦게 끝난 옛 A 의 CLI 는 멈춘다 — 답은 «모름», B 의 판정을 쓰지 않고 엔드포인트도 안 부른다",
            heldA && unv(b) && a === undefined && epAfterA === 0 && cliSpawnsUsage === spawnsBefore + 1 && endpointCalls === 0 && unv(b2),
            { 붙잡음: heldA, B: pct(b), A늦게: a, 엔드포인트: [epAfterA, endpointCalls], CLI재조회: cliSpawnsUsage - spawnsBefore, B다음: b2 },
          ),
        );
      }
      // ㉙ 옛 요청(A)이 답을 정하는 순간 B 의 조회가 시작됐다 — 옛 요청은 B 의 답·`refreshAfter`(B 의 시계)를 받지 않는다(«모름»)
      {
        turns = undefined;
        cliMissing = false;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-hookA";
        const { getUsage } = await startClaude("then-guard");
        let pB: Promise<Usage | undefined> | undefined;
        turnsReads = 0;
        // 읽기 1 = A 조회의 시작 · 읽기 2 = A 가 CLI 뒤 답을 정하는 순간 — 거기서 B 로 다시 인증하고 B 조회가 시작된다
        turnsHook = {
          at: 2,
          run: () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-hookB";
            turns = { windows: [{ windowSeconds: 18000, remainingPercent: 25 }], measuredAt: Date.now() };
            pB = getUsage(false);
          },
        };
        const a = await getUsage(true);
        const b = await pB;
        turnsHook = undefined;
        turns = undefined;
        out.push(
          assert(
            "★★claude ㉙ 옛 요청이 답을 정하는 사이 다른 자격의 조회가 시작되면 옛 요청은 «모름» — 새 자격의 답·`refreshAfter` 를 받지 않는다",
            pB !== undefined && a === undefined && first(b) === 25,
            { A: a, B: first(b) },
          ),
        );
      }
      // ⑮ 코어 — 턴 한도 이벤트의 자격 귀속
      {
        // 모듈 지역 기록을 다른 검사와 나누지 않게 따로 싣는다.
        const v = (await import(`${new URL("../../core/llm-runtime/rate-limit-view.ts", import.meta.url).href}?u1-${Date.now()}`)) as typeof import("../../core/llm-runtime/rate-limit-view.js");
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-turn-A";
        const turnA = v.turnCredentialKey(); // A 로 턴을 시작했다
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-turn-B"; // 턴이 도는 사이 B 로 다시 인증
        v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.97 } } }), Date.now(), turnA);
        const afterLateA = v.turnRateLimitSnapshot();
        v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1 } } }), Date.now(), v.turnCredentialKey());
        const afterB = v.turnRateLimitSnapshot();
        // B 를 기록한 **뒤** 늦은 A 가 또 온다 — B 값을 지우지 않아야 한다.
        v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.99 } } }), Date.now(), turnA);
        const afterLateA2 = v.turnRateLimitSnapshot();
        // 질의가 받는 환경 기준 — 프로세스는 B 인데 질의 환경이 A 면 A 의 표지다.
        const fromEnv = v.turnCredentialKey({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-regression-turn-A" });
        const adapterSrc = await fsp.readFile(new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url), "utf8");
        out.push(
          assert(
            "★★core ⑮ 늦게 온 A 턴의 한도 이벤트는 그사이 인증한 B 의 값이 되지 않고, B 값을 지우지도 않는다 · B 턴 값은 B 의 것",
            afterLateA === undefined && afterB?.windows[0]?.utilization === 0.1 && afterLateA2?.windows[0]?.utilization === 0.1,
            { 늦은A뒤: afterLateA, B뒤: afterB?.windows[0]?.utilization, B뒤늦은A: afterLateA2?.windows[0]?.utilization },
          ),
        );
        // 질의는 **한 문**(`buildQuery`)으로만 띄운다 — 첫 질의·복구 질의 모두. 다른 자리에서 SDK 를 직접 부르거나 `q` 에 다른 것을
        //  넣으면 그 질의의 이벤트는 표지 없이 붙는다(복구 경로만 우회하는 변이를 잡는다).
        const bq = adapterSrc.indexOf("const buildQuery = (o: Options) => {");
        const bqEnd = adapterSrc.indexOf("\n  };", bq);
        const sdkCalls = [...adapterSrc.matchAll(/\bsdk\(\{/g)].map((m) => m.index ?? -1);
        const qAssigns = [...adapterSrc.matchAll(/\bq = ([^;\n]*)/g)].map((m) => m[1] ?? "");
        // 실제 어댑터 — resume 이 죽어 복구 질의를 새로 띄우는 사이 자격이 A→B 로 바뀐다. 복구 질의의 한도 이벤트는 B 의 것이다.
        const { runClaude, withFakeClaudeQuery, SYSTEM_PROMPT_HASH } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
        const { initStore, saveSession } = await import("../../store/sessions.js");
        const shared = await import("../../core/llm-runtime/rate-limit-view.js"); // 어댑터가 쓰는 바로 그 모듈
        initStore();
        const T = `regr:u1-recovery-${Date.now()}`;
        saveSession({ channel: "cli", threadKey: T, claudeSessionId: "sess-u1-old", model: null, systemPromptHash: SYSTEM_PROMPT_HASH });
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-rec-A";
        let fakeSdkCalls = 0;
        let recoveryBefore = "";
        const fake = (() => {
          fakeSdkCalls += 1;
          const n = fakeSdkCalls;
          return (async function* () {
            if (n === 1) {
              process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-rec-B"; // 첫 시도가 죽는 사이 B 로 다시 인증
              throw new Error("No conversation found with session ID: sess-u1-old");
            }
            recoveryBefore = shared.turnCredentialKey();
            yield { type: "system", subtype: "init", session_id: "s-u1-new", model: "claude-fake" };
            yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.33 } } } };
            yield { type: "assistant", session_id: "s-u1-new", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text: "답" }] } };
            yield { type: "result", subtype: "success", is_error: false, result: "답", num_turns: 1, session_id: "s-u1-new", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
          })();
        }) as never;
        let runErr = "";
        // 이 프로세스엔 구독 인증 심이 없다 — 어댑터의 «자격 있나» 문만 가짜 API 키로 연다(표지는 구독 토큰이 먼저라 그대로다).
        const prevKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = "regression-fake-key";
        try {
          await withFakeClaudeQuery(fake, () => runClaude({ text: "안녕", threadKey: T, channel: "cli" } as never));
        } catch (e) {
          runErr = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e); // 아래 단언이 말한다
        } finally {
          if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
          else process.env.ANTHROPIC_API_KEY = prevKey;
        }
        const recSnap = shared.turnRateLimitSnapshot();
        out.push(
          assert(
            "★★core ⑮ 실제 어댑터: 첫 시도와 복구 질의 사이에 자격이 A→B 로 바뀌면 복구 질의의 한도 이벤트는 B 의 값으로 남는다",
            fakeSdkCalls === 2 && recoveryBefore === shared.turnCredentialKey({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-regression-rec-B" }) && recSnap?.windows[0]?.utilization === 0.33,
            { SDK호출: fakeSdkCalls, B의값: recSnap?.windows[0]?.utilization, 오류: runErr },
          ),
        );
        out.push(
          assert(
            "core ⑮ 표지는 질의가 받는 환경으로 잡는다 — 어댑터는 모든 질의를 `buildQuery` 한 문으로 띄우고 거기서 표지를 잡아 이벤트에 넘긴다",
            fromEnv === turnA &&
              bq > 0 &&
              sdkCalls.length > 0 &&
              sdkCalls.every((i) => i > bq && i < bqEnd) &&
              qAssigns.length >= 2 &&
              qAssigns.every((rhs) => rhs.startsWith("buildQuery(")) &&
              /turnCredential = turnCredentialKey\(o\.env \?\? process\.env\)/.test(adapterSrc.slice(bq, bqEnd)) &&
              /noteTurnRateLimit\(view, Date\.now\(\), turnCredential\)/.test(adapterSrc),
            { 환경기준: fromEnv === turnA, sdk호출: sdkCalls.length, 문안: sdkCalls.every((i) => i > bq && i < bqEnd), q대입: qAssigns },
          ),
        );
      }
    } finally {
      globalThis.fetch = realFetch;
      holdCli = false;
      holdAuth = false;
      cliMissing = false;
      holdEndpoint = false;
      restoreCli();
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
