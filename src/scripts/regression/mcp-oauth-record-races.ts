/**
 * 회귀: **원격 MCP 로그인 기록 경합** — 삭제·로그인 완료·늦은 401·갱신 결과가 같은 서버 기록에서 겹칠 때 (2026-11-06, v9 «확인된 인접 결함» (a)(b) ·
 *  [결정](../../../docs/decisions/2026-11-06-v082-oauth-record-races.md)).
 *
 * ★순서는 시간이 아니라 **사건**으로 정한다 — 기록 폴더로 가는 다음 교체(`rename`) 한 건을 붙잡고(도착 사건), 경쟁 동작을 시작한 뒤 푼다.
 *  붙잡힌 동안 같은 서버의 기록을 읽거나 폴더를 열거하면 «진행 중 쓰기를 기다리지 않았다» 이다(읽기·열거도 사건으로 센다).
 *  옛 동작이면 그 순간 결과가 결정적이도록 붙잡은 쓰기를 **나중에** 착지시킨다. 시한(`within`)은 실패 판정 전용이다.
 * 본다:
 *  R1 «인증 필요» 쓰기 도중 서버 삭제 → 삭제는 그 쓰기 뒤에 지우고 그 이름 파일 0·none · 그 뒤 새 401 은 정상 기록(재등록)
 *  R2 로그인 완료 쓰기 도중 헤더 없는 401 → 통지는 그 쓰기 뒤 현재 기록으로 판단 → 로그인 유지
 *  R2c refresh 없는 공급자 — 로그인 전에 헤더 없이 보낸 요청의 늦은 401 은 새 로그인을 지우지 않는다 · 지금 토큰의 401 은 그대로 «로그인 필요»
 *  R3 갱신 도중 새 로그인 → 옛 갱신이 거절·성공·일시 실패로 끝나도 새 로그인의 기록과 401 판정 상태(강제 갱신 표시·재시도 대기)가 그대로 · R3c(대조) 새 로그인이
 *   없으면 갱신 결과가 저장된다
 *  R4 한 서버의 쓰기가 붙잡힌 동안 다른 서버(다른 이름 · **다른 설정 파일의 같은 이름**)의 통지·삭제는 기다리지 않는다
 *  R5 쓰기 실패 뒤 같은 서버의 다음 통지가 멈추지 않는다
 *  R6 브리지 연결 시도 중 서버 제거 → 그 연결의 늦은 401 이 지운 서버의 기록을 만들지 않는다
 *  R7 Claude 턴이 인증 기록을 기다리는 중 취소 → 턴은 먼저 끝나고, 붙잡힌 쓰기 뒤에 줄 선 같은 서버의 통지는 쓰기가 풀리면 끝난다
 *  R8 Claude `failed` 확인 요청(최대 10초)이 도는 중 서버 제거 → 그 401 이 지운 서버의 기록을 만들지 않는다
 *  R9 준비를 마친 로그인의 완료가, 그사이 저장된 다른 로그인의 클라이언트가 아니라 **자기가 인가에 쓴 클라이언트**로 교환·저장한다(다음 갱신이 된다)
 *  R10 로그인 준비 도중 다른 로그인이 저장되면 준비의 게시는 그 묶음을 건드리지 않고 · 상태만 바뀌었으면(«로그인 필요») 지금 상태 위에 얹는다
 *  R11 갱신 판단(refresh 없음·다른 인가 서버에 묶임) 도중 새 로그인 → 옛 판단이 새 로그인을 «로그인 필요» 로 바꾸거나 강제 갱신 표시를 지우지 않는다 · 대조: 새 로그인이 없으면 «로그인 필요»
 *  R12·R13 Claude `needs-auth`·`failed` 통지의 설정 조회가 옛 설정을 읽은 뒤(결과 전달 전) 서버 제거가 끝나도 지운 서버의 기록을 만들지 않는다
 *  R14 믿는 프로젝트와 전역에 같은 이름 — 프로젝트 서버 제거는 막고(a), 전역의 같은 이름만 지운 것은 프로젝트 통지를 버리지 않는다(b)
 * ★붙잡기 도착이 시한을 넘기면 예약·붙잡힌 쓰기를 모두 풀고(`take`) 정리에서도 푼다 — 실패 판정 중에 검사가 매달리거나 패치가 남지 않게.
 * 등급: **실행**(격리 홈 · 같은 프로세스의 실제 HTTP 가짜 인가 서버). 실서비스 로그인은 하지 않는다.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { startFakeOAuthMcp } from "./_fake-oauth-server.js";

type Held = { release: () => void; fail: (e: Error) => void };

export const check: RegressionCheck = {
  name: "mcp-oauth-record-races",
  guards: "원격 MCP 로그인 기록 — 느린 쓰기 도중 서버 삭제가 지운 기록을 되살리고, 로그인 완료 쓰기 도중 늦은 401·갱신 결과가 방금 마친 로그인을 덮던 것(v9 맥 합성 재현)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { getPaths } = await import("../../core/paths.js");
    const ext = await import("../../core/external-mcp.js");
    const oauth = await import("../../core/mcp-oauth.js");
    const fake = await startFakeOAuthMcp();
    const { as, url } = fake;
    const redirectUrl = `http://127.0.0.1:1${oauth.MCP_OAUTH_CALLBACK_PATH}`;
    const home = getPaths().home;
    const file = path.join(home, "mcp.json");
    const dir = path.join(home, "mcp-oauth");
    const prevMcp = existsSync(file) ? readFileSync(file, "utf8") : undefined;

    // ── 사건 장치: 기록 폴더로 가는 교체를 붙잡고, 붙잡힌 동안의 읽기·열거를 센다 ──────────────────────────────
    const fsp = (await import("node:fs/promises")).default as unknown as Record<"rename" | "readFile" | "readdir", (...a: unknown[]) => Promise<unknown>>;
    const real = { rename: fsp.rename, readFile: fsp.readFile, readdir: fsp.readdir };
    const inDir = (p: unknown): boolean => typeof p === "string" && p.startsWith(dir + path.sep);
    const gate = {
      armed: 0, active: 0, waiters: [] as Array<(h: Held) => void>, handles: new Set<Held>(),
      readsWhileHeld: 0, listsWhileHeld: 0, readSeq: 0, readsDone: [] as number[], readDoneWaiters: [] as Array<() => void>,
      /** 예약·대기를 버리고 붙잡힌 쓰기를 모두 푼다(실패 판정·정리용). */
      reset(): void {
        this.armed = 0;
        this.waiters.length = 0;
        for (const h of [...this.handles]) h.release();
      },
    };
    fsp.rename = async (from: unknown, to: unknown, ...rest: unknown[]) => {
      if (gate.armed > 0 && inDir(to)) {
        gate.armed--;
        gate.active++;
        try {
          await new Promise<void>((resolve, reject) => {
            const h: Held = {
              release: () => (gate.handles.delete(h), resolve()),
              fail: (e) => (gate.handles.delete(h), reject(e)),
            };
            gate.handles.add(h);
            for (const w of gate.waiters.splice(0)) w(h);
          });
        } finally {
          gate.active--;
        }
      }
      return real.rename(from, to, ...rest);
    };
    /** 설정 파일(`target` — 전역 `mcp.json` 또는 프로젝트 `.mcp.json`) 읽기 한 건 — 내용은 지금 읽고(옛 설정), 그 결과의 전달만 붙잡는다(R12~R14). */
    const cfgHold = { armed: false, target: file, arrived: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined };
    fsp.readFile = (p: unknown, ...rest: unknown[]) => {
      if (cfgHold.armed && p === cfgHold.target) {
        cfgHold.armed = false;
        return real.readFile(p, ...rest).then((v) => new Promise((res) => {
          cfgHold.release = () => res(v);
          cfgHold.arrived?.();
        }));
      }
      if (!(gate.active > 0 && inDir(p))) return real.readFile(p, ...rest);
      gate.readsWhileHeld++;
      const seq = ++gate.readSeq; // 발행 순번 — 어느 호출 뒤에 발행된 읽기인지 가른다
      const r = real.readFile(p, ...rest);
      r.then(() => {
        gate.readsDone.push(seq);
        for (const w of gate.readDoneWaiters.splice(0)) w();
      }, () => undefined);
      return r;
    };
    fsp.readdir = (p: unknown, ...rest: unknown[]) => {
      if (gate.active > 0 && p === dir) gate.listsWhileHeld++;
      return real.readdir(p, ...rest);
    };
    /** 다음 교체 한 건을 붙잡는다 — 붙잡힌 순간(사건) 풀 손잡이를 준다. */
    const holdNext = (): Promise<Held> => {
      gate.armed++;
      return new Promise((r) => void gate.waiters.push(r));
    };
    /** 실패 판정 전용 시한 — 정상 경로는 사건이 오는 즉시 끝난다. */
    const within = <T>(p: Promise<T>, ms = 10_000): Promise<T | "timeout"> => {
      let t: NodeJS.Timeout | undefined;
      return Promise.race([p, new Promise<"timeout">((r) => (t = setTimeout(() => r("timeout"), ms)))]).finally(() => clearTimeout(t));
    };
    /** 붙잡기 도착을 기다린다 — 시한을 넘기면 예약과 이미 붙잡힌 쓰기를 모두 풀어 같은 서버의 뒤 처리가 매달리지 않게 한다. */
    const take = async (h: Promise<Held>): Promise<Held | "timeout"> => {
      const r = await within(h);
      if (r === "timeout") gate.reset();
      return r;
    };
    /**
     * 붙잡힌 동안 **순번 `after` 뒤에 발행된** 기록 읽기가 n 건 끝날 때까지(사건) — 경쟁 동작이 옛 기록을 «다 읽었다» 는 지점.
     *  순번으로 가르는 이유: 먼저 시작한 다른 호출의 읽기(옛 코드에선 잠금 없이 바로 읽는다)가 섞여 일찍 풀리면, 확인하려던 분기에 들어가지 않은
     *  채로 결과가 나온다(코드 검토 R2).
     */
    const readsDoneAfter = async (after: number, n: number): Promise<void> => {
      while (gate.readsDone.filter((q) => q > after).length < n) await new Promise<void>((r) => void gate.readDoneWaiters.push(r));
    };
    /** 이벤트 루프 한 바퀴 — 기다리지 않는 쪽이 동기·마이크로태스크로 이미 읽거나 열거했는지 보는 지점(시간 가정이 아니다). */
    const turn = (): Promise<void> => new Promise((r) => setImmediate(r));
    const settle = (p: Promise<unknown>): Promise<string> =>
      p.then(() => "ok", (e: unknown) => `err:${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? "?"}`);
    /** 그 이름의 기록 파일 수(임시 사본 포함) — 내용의 `name` 으로 센다. */
    const filesFor = (name: string): number => {
      if (!existsSync(dir)) return 0;
      let n = 0;
      for (const f of readdirSync(dir)) {
        try {
          if ((JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { name?: string }).name === name) n++;
        } catch {
          /* 빈 임시 파일 등 */
        }
      }
      return n;
    };
    type Rec = { name?: string; tokens?: { access_token?: string; issuer?: string }; client?: { client_id?: string }; loginNeeded?: boolean; expiresAt?: number };
    /** 그 이름 기록(검사가 만든 가짜 값) — 읽기가 갱신을 일으키지 않게 파일에서 직접 본다. `edit` 를 주면 고쳐 쓴다(검사 준비용). */
    const recordOf = (name: string, edit?: (r: Rec) => void): Rec | undefined => {
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        if (!f.endsWith(".json")) continue;
        const r = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Rec;
        if (r.name !== name) continue;
        if (edit !== undefined) (edit(r), writeFileSync(path.join(dir, f), JSON.stringify(r)));
        return r;
      }
      return undefined;
    };
    const recordToken = (name: string): string | undefined => recordOf(name)?.tokens?.access_token;
    const lastAccess = (): string | undefined => as.issued.filter((v) => v.startsWith("at-")).at(-1);
    const warns: string[] = [];
    const warnWaiters = new Set<{ test: (l: string) => boolean; done: (l: string) => void }>();
    const nextWarn = (test: (l: string) => boolean): Promise<string> => new Promise((done) => void warnWaiters.add({ test, done }));
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      const line = a.map(String).join(" ");
      warns.push(line);
      for (const w of warnWaiters) if (w.test(line)) (warnWaiters.delete(w), w.done(line));
    };
    const follow = async (authUrl: string): Promise<string> => (await fetch(authUrl, { redirect: "manual" })).headers.get("location") ?? "";
    const startedLogin = async (k: { file: string; name: string; url: string }) => {
      const st = await oauth.startMcpLogin(k, redirectUrl);
      return st.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(st.url)) : null;
    };
    const loginFresh = async (k: { file: string; name: string; url: string }): Promise<void> => {
      await oauth.forgetMcpOAuth(k.file, k.name);
      const p = await startedLogin(k);
      if (p !== null) await oauth.completeMcpLogin(p);
    };
    const key = (name: string) => ({ file, name, url });

    try {
      // ── R1 (a) «인증 필요» 쓰기 도중 삭제 ──────────────────────────────────────────────────────────────
      {
        const kA = key("race-a");
        await oauth.forgetMcpOAuth(file, kA.name);
        const h = holdNext();
        const note = settle(oauth.noteMcpUnauthorized(kA, undefined));
        const held = await take(h);
        gate.listsWhileHeld = 0;
        let forgetDone = false;
        const forgot = oauth.forgetMcpOAuth(file, kA.name).then((n) => ((forgetDone = true), n));
        await turn();
        const listedEarly = gate.listsWhileHeld;
        const doneEarly = forgetDone;
        // 옛 동작: 삭제가 쓰기를 안 기다리고 열거·종료 — 끝난 뒤 풀어야 «쓰기가 삭제 뒤에 착지» 가 결정적이다.
        if (listedEarly > 0 || doneEarly) await within(forgot);
        if (held !== "timeout") held.release();
        const noteRes = await within(note);
        const removed = await within(forgot);
        const left = filesFor(kA.name);
        const st = await oauth.mcpOAuthStatus(kA);
        out.push(assert("★R1 «인증 필요» 쓰기 도중 서버 삭제 → 삭제는 그 쓰기를 기다려 지운다 · 그 이름 기록 0 · 상태 none",
          held !== "timeout" && listedEarly === 0 && !doneEarly && noteRes === "ok" && removed === 1 && left === 0 && st === "none",
          { held: held !== "timeout", listedEarly, doneEarly, noteRes, removed, left, status: st }));
        // 삭제 뒤 같은 이름의 새 401 — 막히지 않고 정상 기록(재등록 뒤 새 요청)
        await within(oauth.noteMcpUnauthorized(kA, undefined));
        const st2 = await oauth.mcpOAuthStatus(kA);
        out.push(assert("R1b 삭제 뒤 같은 이름의 새 401 은 정상으로 «인증 필요» 기록", st2 === "login-needed", st2));
        await oauth.forgetMcpOAuth(file, kA.name);
      }

      // ── R2 (b) 로그인 완료 쓰기 도중 헤더 없는 401 ─────────────────────────────────────────────────────
      {
        const kB = key("race-b");
        await oauth.forgetMcpOAuth(file, kB.name);
        const parsed = await startedLogin(kB);
        const h1 = holdNext();
        const comp = parsed === null ? Promise.resolve({ ok: false } as { ok: boolean }) : oauth.completeMcpLogin(parsed);
        const held1 = await take(h1);
        gate.readsWhileHeld = 0;
        const h2 = holdNext(); // 옛 동작이면 통지의 쓰기도 붙잡아 완료 뒤에 착지시킨다
        const note = settle(oauth.noteMcpUnauthorized(kB, undefined));
        await turn();
        const readEarly = gate.readsWhileHeld;
        if (readEarly > 0) {
          const held2 = await take(h2);
          if (held1 !== "timeout") held1.release();
          await within(comp);
          if (held2 !== "timeout") held2.release();
        } else if (held1 !== "timeout") held1.release();
        const done = await within(comp);
        const noteRes = await within(note);
        gate.armed = 0;
        gate.waiters.length = 0; // 쓰이지 않은 대기는 버린다
        const st = await oauth.mcpOAuthStatus(kB);
        const tok = await oauth.mcpAccessToken(kB);
        out.push(assert("★R2 로그인 완료 쓰기 도중 헤더 없는 401 → 통지는 그 쓰기 뒤 현재 기록으로 판단 · 로그인 유지(authorized·토큰)",
          held1 !== "timeout" && readEarly === 0 && done !== "timeout" && (done as { ok: boolean }).ok && noteRes === "ok" && st === "authorized" && tok !== undefined,
          { held: held1 !== "timeout", readEarly, completed: done !== "timeout" && (done as { ok: boolean }).ok, noteRes, status: st, token: tok !== undefined }));
        await oauth.forgetMcpOAuth(file, kB.name);
      }

      // ── R2c refresh 없는 공급자 — 옛 연결(헤더 없음)의 늦은 401 vs 지금 토큰의 401 ──────────────────────────────
      {
        const kC = key("race-c");
        as.noRefresh = true;
        await loginFresh(kC);
        const t = await oauth.mcpAccessToken(kC);
        await oauth.noteMcpUnauthorized(kC, undefined); // 로그인 전에 헤더 없이 보낸 요청의 401
        const stLate = await oauth.mcpOAuthStatus(kC);
        const tLate = await oauth.mcpAccessToken(kC);
        await oauth.noteMcpUnauthorized(kC, t); // 지금 토큰이 거절됨 — 갱신할 길이 없다
        const stCur = await oauth.mcpOAuthStatus(kC);
        as.noRefresh = false;
        out.push(assert("★R2c refresh 없는 공급자 — 헤더 없이 보낸 요청의 늦은 401 은 새 로그인을 지우지 않는다 · 지금 토큰의 401 은 «로그인 필요»",
          t !== undefined && stLate === "authorized" && tLate === t && stCur === "login-needed", { stLate, sameToken: tLate === t, stCur }));
        await oauth.forgetMcpOAuth(file, kC.name);
      }

      // ── R3 갱신 도중 새 로그인 — 옛 갱신 거절 / R3b 옛 갱신 성공 ─────────────────────────────────────────
      for (const mode of ["invalid_grant", "ok", "server_error", "control"] as const) {
        const kD = key(`race-d-${mode}`);
        as.expiresIn = 60; // 갱신 창(5분) 안 — 다음 읽기가 갱신하고, 로그인 시작도 «이미 로그인됨» 으로 끝나지 않는다
        await loginFresh(kD);
        as.expiresIn = 3600;
        const t1 = as.issued.filter((v) => v.startsWith("at-")).at(-1);
        as.holdGrant = "refresh_token";
        const arrived = new Promise<void>((r) => (as.onHeldGrant = r));
        const reading = oauth.mcpAccessToken(kD); // 갱신 시작(요청이 붙잡힘)
        const gotRefresh = await within(arrived);
        as.onHeldGrant = undefined;
        if (mode === "control") {
          // 대조 — 그사이 아무 일도 없으면 갱신 결과가 저장되고 그 토큰이 쓰인다(근거 확인이 정상 저장을 막지 않는다).
          fake.releaseGrant();
          const got = await within(reading);
          const now = await oauth.mcpAccessToken(kD);
          const st = await oauth.mcpOAuthStatus(kD);
          const stale = warns.some((l) => l.startsWith(`mcp-oauth: '${kD.name}' `));
          out.push(assert("★R3c [대조] 그사이 새 로그인이 없으면 갱신한 토큰이 저장되고 쓰인다(근거 확인이 정상 저장을 막지 않는다)",
            gotRefresh !== "timeout" && typeof got === "string" && got !== t1 && now === got && as.access.has(now) && st === "authorized" && !stale,
            { gotRefresh: gotRefresh !== "timeout", fresh: typeof got === "string" && got !== t1, saved: now === got, status: st, stale }));
          await oauth.forgetMcpOAuth(file, kD.name);
          continue;
        }
        const parsed = await startedLogin(kD);
        const comp = parsed === null ? { ok: false } : await oauth.completeMcpLogin(parsed);
        const t2 = await oauth.mcpAccessToken(kD); // 새 로그인의 토큰
        // 새 토큰이 거절됨 — 다음 읽기가 강제 갱신해야 한다(옛 갱신의 결과가 이 표시를 지우거나 재시도 대기로 막으면 안 된다).
        as.access.delete(t2 ?? "");
        await oauth.noteMcpUnauthorized(kD, t2);
        as.refreshMode = mode;
        const ended = nextWarn((l) => l.startsWith(`mcp-oauth: '${kD.name}' `));
        fake.releaseGrant();
        const line = await within(ended);
        as.refreshMode = "ok";
        await within(reading); // 옛 갱신 작업이 끝났다(대기열에서 빠짐)
        const recTok = recordToken(kD.name);
        const st = await oauth.mcpOAuthStatus(kD);
        const t3 = await oauth.mcpAccessToken(kD); // 새 토큰의 강제 갱신
        const kept = typeof line === "string" && line.includes("그사이 인증 기록이 바뀌어");
        out.push(assert(`★R3 갱신 도중 새 로그인 → 옛 갱신이 ${mode === "ok" ? "성공으로" : mode === "invalid_grant" ? "거절로" : "일시 실패로"} 끝나도 새 로그인의 기록이 그대로 · 새 토큰의 401 에 따른 강제 갱신이 일어난다 · 경고는 «그사이 기록이 바뀌어 그대로 둠»`,
          gotRefresh !== "timeout" && comp.ok && t2 !== undefined && kept && recTok === t2 && st === "authorized" && t3 !== undefined && t3 !== t2 && as.access.has(t3),
          { gotRefresh: gotRefresh !== "timeout", completed: comp.ok, warn: line === "timeout" ? "timeout" : line.replace(/'.*?'/, "'…'"), keptNewLogin: recTok === t2, status: st, forcedRefresh: t3 !== undefined && t3 !== t2 && as.access.has(t3) }));
        await oauth.forgetMcpOAuth(file, kD.name);
      }

      // ── R4 다른 서버 격리 ─────────────────────────────────────────────────────────────────────────────
      {
        const kE = key("race-e");
        const kF = key("race-f");
        // 다른 설정 파일(프로젝트 `.mcp.json`)의 같은 이름 — 기록 열쇠는 (파일, 이름, URL) 이라 다른 서버다(독립 변이 사냥: 잠금 열쇠를 이름만으로 넓혀도 초록이었다).
        const kE2 = { file: path.join(home, "race-project", ".mcp.json"), name: kE.name, url };
        for (const k of [kE, kF, kE2]) await oauth.forgetMcpOAuth(k.file, k.name);
        const h = holdNext();
        const noteE = settle(oauth.noteMcpUnauthorized(kE, undefined));
        const held = await take(h);
        gate.readsWhileHeld = 0;
        gate.listsWhileHeld = 0;
        const noteF = await within(settle(oauth.noteMcpUnauthorized(kF, undefined)));
        const stF = await oauth.mcpOAuthStatus(kF);
        const noteE2 = await within(settle(oauth.noteMcpUnauthorized(kE2, undefined)));
        const stE2 = await oauth.mcpOAuthStatus(kE2);
        const forgotOther = await within(oauth.forgetMcpOAuth(file, "race-unrelated"));
        const seen = { reads: gate.readsWhileHeld, lists: gate.listsWhileHeld }; // 장치가 이 경로의 읽기·열거를 실제로 본다(대조)
        if (held !== "timeout") held.release();
        const noteERes = await within(noteE);
        const stE = await oauth.mcpOAuthStatus(kE);
        out.push(assert("★R4 한 서버의 쓰기가 붙잡힌 동안 다른 서버(다른 이름 · 다른 설정 파일의 같은 이름)의 통지·삭제는 기다리지 않는다(그 뒤 붙잡힌 쪽도 정상 착지)",
          held !== "timeout" && noteF === "ok" && stF === "login-needed" && noteE2 === "ok" && stE2 === "login-needed" && forgotOther === 0 && noteERes === "ok" && stE === "login-needed",
          { held: held !== "timeout", noteF, stF, noteE2, stE2, forgotOther, noteERes, stE }));
        out.push(assert("R4b [장치 대조] 붙잡힌 동안의 기록 읽기·폴더 열거를 장치가 센다(R1·R2 의 «0» 이 못 보는 0 이 아님)",
          seen.reads > 0 && seen.lists > 0, seen));
        for (const k of [kE, kF, kE2]) await oauth.forgetMcpOAuth(k.file, k.name);
      }

      // ── R5 쓰기 실패 뒤 정리 ─────────────────────────────────────────────────────────────────────────
      {
        const kG = key("race-g");
        await oauth.forgetMcpOAuth(file, kG.name);
        const h = holdNext();
        const first = settle(oauth.noteMcpUnauthorized(kG, undefined));
        const held = await take(h);
        if (held !== "timeout") held.fail(Object.assign(new Error("injected"), { code: "EREGRRACE" }));
        const r1 = await within(first);
        const r2 = await within(settle(oauth.noteMcpUnauthorized(kG, undefined)));
        const st = await oauth.mcpOAuthStatus(kG);
        const tmpLeft = existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".tmp-")).length : 0;
        out.push(assert("★R5 쓰기가 실패해도 같은 서버의 다음 통지가 멈추지 않는다(실패는 호출자에게 · 임시 사본 0)",
          r1 === "err:EREGRRACE" && r2 === "ok" && st === "login-needed" && tmpLeft === 0, { r1, r2, status: st, tmpLeft }));
        await oauth.forgetMcpOAuth(file, kG.name);
      }

      // ── R6 브리지 연결 시도 중 서버 제거 → 늦은 401 ────────────────────────────────────────────────────
      {
        const name = "racebridge";
        await ext.closeAllExternalMcp();
        await oauth.forgetMcpOAuth(file, name);
        writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
        as.holdMcp = true;
        const arrived = new Promise<void>((r) => (as.onHeldMcp = r));
        const bridges = ext.getConnectedExternalMcpBridges();
        const got401 = await within(arrived);
        const removed = await ext.removeExternalMcpServer(name);
        fake.releaseMcp();
        as.onHeldMcp = undefined;
        const bs = await within(bridges);
        if (bs !== "timeout") for (const b of bs) await b.close();
        await ext.closeAllExternalMcp();
        const left = filesFor(name);
        const st = await oauth.mcpOAuthStatus(key(name));
        out.push(assert("★R6 브리지 연결 시도 중 서버 제거 → 그 연결의 늦은 401 이 지운 서버의 기록을 만들지 않는다",
          got401 !== "timeout" && removed && bs !== "timeout" && left === 0 && st === "none",
          { got401: got401 !== "timeout", removed, bridges: bs === "timeout" ? "timeout" : bs.length, left, status: st }));
      }

      // ── R7 Claude 턴이 인증 기록을 기다리는 중 취소 → 뒤에 줄 선 같은 서버의 통지 ─────────────────────────────
      {
        const name = "race-claude";
        const kR = key(name);
        writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
        await oauth.forgetMcpOAuth(file, name);
        const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
        const fakeQuery = (() =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake", tools: [], mcp_servers: [{ name, status: "needs-auth" }] };
            yield { type: "result", subtype: "success", is_error: false, result: "답", num_turns: 1, session_id: "s2", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
          })()) as never;
        const prevKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
        const cancel = new AbortController();
        let held: Held | "timeout" = "timeout";
        let outcome: unknown = "not-run";
        let followRes: unknown = "not-run";
        try {
          const h = holdNext();
          const turnP = withFakeClaudeQuery(fakeQuery, () => runClaude({ text: "해줘", threadKey: "regr:race-claude", channel: "cli", abortSignal: cancel.signal } as never))
            .then(() => "returned", (e: unknown) => String((e as Error)?.message ?? e));
          held = await take(h);
          cancel.abort(new Error("regr-race-cancel"));
          outcome = await within(turnP); // 쓰기는 아직 붙잡혀 있다
          const follow = settle(oauth.noteMcpUnauthorized(kR, undefined)); // 붙잡힌 쓰기 뒤에 줄 선다
          if (held !== "timeout") held.release();
          followRes = await within(follow);
        } finally {
          if (held !== "timeout") held.release();
          if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
          else process.env.ANTHROPIC_API_KEY = prevKey;
        }
        const st = await oauth.mcpOAuthStatus(kR);
        out.push(assert("★R7 Claude 턴이 인증 기록을 기다리는 중 취소 → 턴은 쓰기를 풀기 전에 끝나고, 뒤에 줄 선 같은 서버의 통지는 쓰기가 풀리면 끝난다",
          held !== "timeout" && outcome === "regr-race-cancel" && followRes === "ok" && st === "login-needed",
          { held: held !== "timeout", outcome, followRes, status: st }));
        await oauth.forgetMcpOAuth(file, name);
      }

      // ── R8 Claude `failed` 확인 요청이 도는 중 서버 제거 ──────────────────────────────────────────────
      {
        const name = "race-probe";
        writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
        await oauth.forgetMcpOAuth(file, name);
        as.holdMcp = true;
        const arrived = new Promise<void>((r) => (as.onHeldMcp = r));
        const probing = settle(ext.noteRemoteConnectFailed(name, undefined, { type: "http", url, headers: { Authorization: "Bearer at-not-accepted-race" } }));
        const got401 = await within(arrived);
        const removed = await ext.removeExternalMcpServer(name);
        fake.releaseMcp();
        as.onHeldMcp = undefined;
        const res = await within(probing);
        const left = filesFor(name);
        const st = await oauth.mcpOAuthStatus(key(name));
        out.push(assert("★R8 Claude `failed` 확인 요청이 도는 중 서버 제거 → 그 401 이 지운 서버의 기록을 만들지 않는다",
          got401 !== "timeout" && removed && res === "ok" && left === 0 && st === "none",
          { got401: got401 !== "timeout", removed, res, left, status: st }));
      }

      // ── R12·R13 Claude 통지의 설정 조회가 옛 설정을 읽은 뒤, 그 결과가 전달되기 전에 서버 제거가 끝남 ──────────────────────
      //  (결정 문서 §남는 것 «설정 조회 ↔ 세대 캡처» 창.) R12 `needs-auth`(로그인돼 있던 서버) · R13 `failed` 확인 요청.
      for (const kind of ["needs-auth", "failed"] as const) {
        const name = `race-cfg-${kind}`;
        writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
        if (kind === "needs-auth") await loginFresh(key(name)); // 토큰이 있던 서버 — 되살아나는 기록에 비밀이 실리는지도 본다
        else await oauth.forgetMcpOAuth(file, name);
        const arrived = new Promise<void>((r) => (cfgHold.arrived = r));
        cfgHold.armed = true;
        const noting = settle(kind === "needs-auth"
          ? ext.noteRemoteAuthRequired(name, undefined, undefined)
          : ext.noteRemoteConnectFailed(name, undefined, { type: "http", url, headers: { Authorization: "Bearer at-not-accepted-cfg-race" } }));
        cfgHold.armed = false; // 통지의 첫 읽기만(동기로 발행됐다)
        const gotRead = await within(arrived);
        const removed = await within(ext.removeExternalMcpServer(name)); // 통지가 옛 설정을 쥔 채 제거가 끝난다
        cfgHold.release?.();
        cfgHold.release = undefined;
        cfgHold.arrived = undefined;
        const res = await within(noting);
        const left = filesFor(name);
        const rec = recordOf(name);
        const st = await oauth.mcpOAuthStatus(key(name));
        out.push(assert(`★${kind === "needs-auth" ? "R12" : "R13"} Claude \`${kind}\` 통지가 옛 설정을 읽은 뒤 서버 제거가 끝나면 → 지운 서버의 기록을 만들지 않는다`,
          gotRead !== "timeout" && removed === true && res === "ok" && left === 0 && st === "none",
          { gotRead: gotRead !== "timeout", removed, res, left, status: st, recTokens: rec?.tokens !== undefined, recClient: rec?.client !== undefined }));
        await oauth.forgetMcpOAuth(file, name);
      }

      // ── R14 믿는 프로젝트 `.mcp.json` 과 전역에 같은 이름 — 비교하는 세대는 **읽은 파일**의 것 ──────────────────────
      //  a: 프로젝트의 옛 설정을 읽은 뒤 프로젝트 서버 제거 → 기록 없음 · b: 전역의 같은 이름만 제거 → 프로젝트 통지는 버리지 않는다.
      {
        const { initStore } = await import("../../store/sessions.js");
        initStore();
        const { upsertProject, forgetProject } = await import("../../store/projects.js");
        const proj = mkdtempSync(path.join(home, "race-proj-"));
        const projFile = path.join(proj, ".mcp.json");
        upsertProject({ path: proj, name: "race-proj", status: "active", description: null });
        try {
          for (const kind of ["needs-auth", "failed"] as const) {
            for (const removeWhere of ["project", "global"] as const) {
              const name = `race-pg-${kind}`;
              const kP = { file: projFile, name, url };
              writeFileSync(projFile, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
              writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
              await oauth.forgetMcpOAuth(projFile, name);
              await oauth.forgetMcpOAuth(file, name);
              const arrived = new Promise<void>((r) => (cfgHold.arrived = r));
              cfgHold.target = projFile;
              cfgHold.armed = true;
              const noting = settle(kind === "needs-auth"
                ? ext.noteRemoteAuthRequired(name, proj, undefined)
                : ext.noteRemoteConnectFailed(name, proj, { type: "http", url, headers: { Authorization: `Bearer at-not-accepted-pg-${removeWhere}` } }));
              cfgHold.armed = false;
              const gotRead = await within(arrived);
              const removed = await within(ext.removeExternalMcpServer(name, removeWhere === "project" ? proj : undefined));
              cfgHold.release?.();
              cfgHold.release = undefined;
              cfgHold.arrived = undefined;
              cfgHold.target = file;
              const res = await within(noting);
              const stP = await oauth.mcpOAuthStatus(kP);
              const stG = await oauth.mcpOAuthStatus(key(name));
              const want = removeWhere === "project" ? "none" : "login-needed";
              out.push(assert(`★R14${removeWhere === "project" ? "a" : "b"} \`${kind}\` 통지가 프로젝트의 옛 설정을 읽은 뒤 ${removeWhere === "project" ? "프로젝트 서버 제거 → 지운 프로젝트 서버의 기록을 만들지 않는다" : "전역의 같은 이름만 제거 → 프로젝트 서버의 통지는 그대로 기록된다"}`,
                gotRead !== "timeout" && removed === true && res === "ok" && stP === want && stG === "none",
                { gotRead: gotRead !== "timeout", removed, res, project: stP, global: stG }));
              await oauth.forgetMcpOAuth(projFile, name);
              await oauth.forgetMcpOAuth(file, name);
            }
          }
        } finally {
          cfgHold.target = file;
          forgetProject(proj);
          rmSync(proj, { recursive: true, force: true });
        }
      }

      // ── R9 준비를 마친 로그인 완료 ↔ 그사이 저장된 다른 로그인 — 완료는 자기가 인가에 쓴 클라이언트로 ──────────────────────
      {
        const kH = key("race-h");
        as.expiresIn = 60; // 두 로그인 시작이 «이미 로그인됨» 으로 끝나지 않게
        await loginFresh(kH); // 클라이언트 C0(콜백 포트 1)
        const otherPort = `http://127.0.0.1:2${oauth.MCP_OAUTH_CALLBACK_PATH}`;
        const sA = await oauth.startMcpLogin(kH, otherPort); // 포트가 바뀜 → 다시 등록한 C1 로 준비
        const pA = sA.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(sA.url)) : null;
        as.expiresIn = 3600;
        as.holdGrant = "authorization_code";
        const exch = new Promise<void>((r) => (as.onHeldGrant = r));
        const compA = pA === null ? Promise.resolve({ ok: false } as { ok: boolean }) : oauth.completeMcpLogin(pA); // A 가 시도를 점유하고 교환 중
        const gotExch = await within(exch);
        as.onHeldGrant = undefined;
        as.holdGrant = undefined; // 이후 교환은 붙잡지 않는다
        const pB = await startedLogin(kH); // B 는 C0 으로 준비(그때 디스크 묶음은 그대로)
        fake.releaseGrant(); // A 완료 → C1 과 그 토큰 저장
        const doneA = await within(compA);
        const doneB = pB === null ? { ok: false } : await oauth.completeMcpLogin(pB); // B 완료
        const tB = await oauth.mcpAccessToken(kH);
        await oauth.noteMcpUnauthorized(kH, tB); // 강제 갱신 — 기록의 클라이언트와 refresh 토큰이 짝이 맞아야 된다
        const rf0 = as.rejected.length;
        const tB2 = await oauth.mcpAccessToken(kH);
        const st = await oauth.mcpOAuthStatus(kH);
        out.push(assert("★R9 준비를 마친 로그인의 완료는 그사이 저장된 다른 로그인의 클라이언트가 아니라 자기가 인가에 쓴 클라이언트로 저장 → 다음 갱신이 된다",
          gotExch !== "timeout" && doneA !== "timeout" && (doneA as { ok: boolean }).ok && doneB.ok && tB !== undefined && tB2 !== undefined && tB2 !== tB && as.access.has(tB2) && st === "authorized",
          { gotExch: gotExch !== "timeout", doneA: doneA !== "timeout" && (doneA as { ok: boolean }).ok, doneB: doneB.ok, refreshed: tB2 !== undefined && tB2 !== tB, status: st, rejectedDelta: as.rejected.length - rf0 }));
        await oauth.forgetMcpOAuth(file, kH.name);
      }

      // ── R10 W2 디스크 반영 — 준비 도중 (a) 다른 로그인이 저장되면 그 묶음을 건드리지 않는다 (b) 상태만 바뀌었으면 지금 상태 위에 얹는다 ───────
      {
        const kI = key("race-i");
        as.expiresIn = 60;
        await loginFresh(kI); // C0 · 만료 임박
        const otherPort = `http://127.0.0.1:2${oauth.MCP_OAUTH_CALLBACK_PATH}`;
        const sA = await oauth.startMcpLogin(kI, otherPort); // 다시 등록한 C1 로 준비(디스크엔 안 넣는다)
        const c1 = [...as.clients].filter(([, uris]) => uris.includes(otherPort)).at(-1)?.[0];
        const pA = sA.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(sA.url)) : null;
        as.expiresIn = 3600;
        const h = holdNext();
        const compA = pA === null ? Promise.resolve({ ok: false } as { ok: boolean }) : oauth.completeMcpLogin(pA); // 교환 뒤 저장이 붙잡힘(잠금 쥔 채)
        const held = await take(h);
        const tA = lastAccess();
        const bRead = readsDoneAfter(gate.readSeq, 1);
        const sB = oauth.startMcpLogin(kI, redirectUrl); // 옛 묶음(C0)을 읽고 준비 → 게시는 A 저장 뒤
        const gotRead = await within(bRead);
        if (held !== "timeout") held.release();
        const doneA = await within(compA);
        const sBres = await within(sB);
        const afterA = recordOf(kI.name);
        const pB = sBres !== "timeout" && sBres.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(sBres.url)) : null;
        const doneB = pB === null ? { ok: false } : await within(oauth.completeMcpLogin(pB));
        const tB = await within(oauth.mcpAccessToken(kI));
        if (typeof tB === "string") await within(oauth.noteMcpUnauthorized(kI, tB));
        const tB2 = await within(oauth.mcpAccessToken(kI));
        out.push(assert("★R10a 로그인 준비 도중 다른 로그인이 저장되면 준비의 게시는 그 묶음(토큰·클라이언트)을 건드리지 않고, 그 준비도 자기 클라이언트로 완료·갱신된다",
          held !== "timeout" && gotRead !== "timeout" && doneA !== "timeout" && (doneA as { ok: boolean }).ok && afterA?.tokens?.access_token === tA && afterA?.client?.client_id === c1 &&
            doneB !== "timeout" && doneB.ok && typeof tB === "string" && typeof tB2 === "string" && tB2 !== tB && as.access.has(tB2),
          { held: held !== "timeout", gotRead: gotRead !== "timeout", doneA: doneA !== "timeout" && (doneA as { ok: boolean }).ok, keptA: afterA?.tokens?.access_token === tA, keptClient: afterA?.client?.client_id === c1, doneB: doneB !== "timeout" && doneB.ok, refreshed: typeof tB2 === "string" && tB2 !== tB }));
        await oauth.forgetMcpOAuth(file, kI.name);

        const kJ = key("race-j");
        as.expiresIn = 60;
        await loginFresh(kJ);
        as.expiresIn = 3600;
        const hj = holdNext();
        const marking = settle(oauth.markMcpLoginNeeded(kJ)); // «로그인 필요» 쓰기가 붙잡힘(잠금 쥔 채)
        const heldJ = await take(hj);
        const jRead = readsDoneAfter(gate.readSeq, 1);
        const sJ = oauth.startMcpLogin(kJ, redirectUrl); // 옛 상태(표시 없음)를 읽고 준비 → 게시는 표시 뒤
        const gotJRead = await within(jRead);
        if (heldJ !== "timeout") heldJ.release();
        const markRes = await within(marking);
        const sJres = await within(sJ);
        const stJ = await oauth.mcpOAuthStatus(kJ);
        out.push(assert("★R10b 로그인 준비 도중 상태만 바뀌면(«로그인 필요») 준비의 게시는 지금 상태 위에 얹는다 — 옛 사본으로 표시를 지우지 않는다",
          heldJ !== "timeout" && gotJRead !== "timeout" && markRes === "ok" && sJres !== "timeout" && sJres.status === "redirect" && stJ === "login-needed",
          { held: heldJ !== "timeout", gotRead: gotJRead !== "timeout", markRes, started: sJres === "timeout" ? "timeout" : sJres.status, status: stJ }));
        await oauth.forgetMcpOAuth(file, kJ.name);
      }

      // ── R11 갱신 판단(refresh 없음 · 다른 인가 서버에 묶임) 도중 새 로그인 ─────────────────────────────────────
      for (const kind of ["no-refresh", "elsewhere"] as const) {
        for (const withLogin of [false, true]) {
          const kK = key(`race-k-${kind}-${withLogin ? "login" : "control"}`);
          as.noRefresh = kind === "no-refresh";
          as.expiresIn = kind === "no-refresh" ? 0 : 3600; // refresh 없음: 받자마자 만료
          await loginFresh(kK);
          as.expiresIn = 3600;
          if (kind === "elsewhere") recordOf(kK.name, (r) => { r.tokens!.issuer = "http://127.0.0.1:1/"; r.expiresAt = Date.now() - 1000; }); // 다른 인가 서버에 묶임 · 만료
          if (!withLogin) {
            const t = await within(oauth.mcpAccessToken(kK));
            const st = await oauth.mcpOAuthStatus(kK);
            out.push(assert(`R11 [대조] ${kind === "no-refresh" ? "refresh 없음·만료" : "다른 인가 서버에 묶임·만료"} — 새 로그인이 없으면 «로그인 필요»`,
              t === undefined && st === "login-needed", { token: t === undefined ? "none" : "given", status: st }));
          } else {
            const pB = await startedLogin(kK);
            const h = holdNext();
            const compB = pB === null ? Promise.resolve({ ok: false } as { ok: boolean }) : oauth.completeMcpLogin(pB); // 새 로그인 저장이 붙잡힘(잠금 쥔 채)
            const held = await take(h);
            const t1 = lastAccess();
            const noted = kind === "elsewhere" ? settle(oauth.noteMcpUnauthorized(kK, t1)) : Promise.resolve("ok"); // 새 토큰 거절 → 강제 갱신 표시(잠금 뒤 순서)
            // 읽기 1(`mcpAccessToken`) + 갱신 작업의 읽기 1 — 둘 다 옛 기록. 통지의 읽기(옛 코드는 잠금 없이 바로)는 순번으로 뺀다.
            const reads = readsDoneAfter(gate.readSeq, 2);
            const reading = oauth.mcpAccessToken(kK);
            const gotReads = await within(reads);
            if (held !== "timeout") held.release();
            const doneB = await within(compB);
            const noteRes = await within(noted);
            await within(reading);
            const kept = recordToken(kK.name);
            const st = await oauth.mcpOAuthStatus(kK);
            const next = await within(oauth.mcpAccessToken(kK));
            const ok = kind === "no-refresh" ? next === t1 : typeof next === "string" && next !== t1 && as.access.has(next);
            out.push(assert(`★R11 ${kind === "no-refresh" ? "refresh 없음·만료" : "다른 인가 서버에 묶임·만료"} 판단 도중 새 로그인 → 옛 판단이 새 로그인을 «로그인 필요» 로 바꾸지 않는다${kind === "elsewhere" ? " · 새 토큰의 강제 갱신 표시도 지우지 않는다(다음 읽기가 갱신)" : ""}`,
              held !== "timeout" && gotReads !== "timeout" && doneB !== "timeout" && (doneB as { ok: boolean }).ok && noteRes === "ok" && kept === t1 && st === "authorized" && ok,
              { held: held !== "timeout", gotReads: gotReads !== "timeout", doneB: doneB !== "timeout" && (doneB as { ok: boolean }).ok, noteRes, keptNewLogin: kept === t1, status: st, next: next === t1 ? "same" : typeof next === "string" ? "refreshed" : String(next) }));
          }
          as.noRefresh = false;
          await oauth.forgetMcpOAuth(file, kK.name);
        }
      }
    } finally {
      gate.reset();
      fsp.rename = real.rename;
      fsp.readFile = real.readFile;
      fsp.readdir = real.readdir;
      console.warn = origWarn;
      as.holdMcp = false;
      as.holdGrant = undefined;
      await ext.closeAllExternalMcp().catch(() => undefined);
      await fake.close();
      if (prevMcp === undefined) writeFileSync(file, JSON.stringify({ mcpServers: {} }));
      else writeFileSync(file, prevMcp);
    }
    // 비밀이 경고에 실리지 않는다(이 검사가 만든 경고 전부)
    const leaked = warns.filter((l) => as.issued.some((v) => l.includes(v))).length;
    out.push(assert("이 검사의 경고에 code·토큰이 실리지 않는다", leaked === 0, { warns: warns.length, leaked }));
    return out;
  },
};
