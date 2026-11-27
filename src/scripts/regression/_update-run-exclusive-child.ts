/**
 * `update-run-exclusive` 의 자식 — 실제 git 저장소에서 **Windows 위임 갈래의 실제 `runSelfUpdate`** 를 돌리고(플랫폼·소켓·자식 실행만 주입),
 * 넘겨받는 쪽은 **실제 `runUpdateCommand`**(`bin/daemon.mjs`)를 같은 프로세스에서 부른다 — 둘의 인계 규약(실행 파이프·인계 파이프·`ok`)을 한 실행으로 잰다.
 *
 * ★자식인 이유: 홈(`TIGUCLAW_HOME`)·PATH·`process.env` 를 바꾸고, 쥔 소켓이 프로세스 끝까지 남는다(그 성질 그대로 잰다).
 * ★외부로 안 나간다: git 원격은 로컬 bare · 소켓은 격리 TMP 의 POSIX 경로(Windows 명명 파이프 대역 — `EADDRINUSE`·닫으면 회수는 같다) · `runUpdate` 는 기록 대역.
 * 결과: 시나리오마다 JSON 한 줄.
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "../../..");
const root = mkdtempSync(path.join(os.tmpdir(), "upd-run-excl-"));
const home = path.join(root, "home");
mkdirSync(home);
process.env.TIGUCLAW_HOME = home;
process.env.TIGUCLAW_RUNTIME = "built";
const g = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let sock = 0;
const sockPath = (tag: string) => path.join(root, `${tag}-${++sock}.sock`);

try {
  // ── 저장소: 앱(c0) · 원격에 c1(받을 커밋) ──
  const origin = path.join(root, "origin.git");
  const app = path.join(root, "app");
  const other = path.join(root, "other");
  g(["init", "-q", "--bare", "-b", "main", origin], root);
  g(["clone", "-q", origin, app], root);
  for (const d of [app]) { g(["config", "user.email", "r@r.invalid"], d); g(["config", "user.name", "r"], d); }
  writeFileSync(path.join(app, ".gitignore"), "dist/\nnode_modules/\n");
  writeFileSync(path.join(app, "a.txt"), "0\n");
  g(["add", "-A"], app); g(["commit", "-q", "-m", "c0"], app); g(["push", "-q", "-u", "origin", "main"], app);
  const c0 = g(["rev-parse", "HEAD"], app);
  g(["clone", "-q", origin, other], root);
  g(["config", "user.email", "r@r.invalid"], other); g(["config", "user.name", "r"], other);
  writeFileSync(path.join(other, "a.txt"), "1\n"); g(["commit", "-q", "-am", "c1"], other); g(["push", "-q", "origin", "main"], other);
  const c1 = g(["rev-parse", "HEAD"], other);

  const su = (await import(pathToFileURL(path.join(REPO, "src/core/self-update.ts")).href)) as typeof import("../../core/self-update.js");
  const d = (await import(pathToFileURL(path.join(REPO, "bin/daemon.mjs")).href)) as {
    runUpdateCommand: (c: { homeAbs: string }, cmd: string, io?: Record<string, unknown>) => Promise<void>;
    runUpdate: (c: { homeAbs: string }, gate?: unknown) => unknown;
  };
  const { makeBootRunner } = await import(pathToFileURL(path.join(REPO, "src/scripts/regression/_update-boot-harness.ts")).href);
  const bootRunner = await makeBootRunner(REPO);
  const fspReal = { readFile: (x: string) => readFile(x, "utf8"), writeFile: (x: string, raw: string) => writeFile(x, raw, "utf8"), unlink: (x: string) => unlink(x), rename: (a: string, b: string) => rename(a, b), readdir: (x: string) => readdir(x) };
  let bootN = 0;
  /** 실제 부팅 소비(옛 판이 아닌 현 판 영역) — 실패 통지 목적지만 센다. */
  const consume = async () => {
    const k = { t: 0 };
    const b = await bootRunner({ fsp: fspReal, home, boot: { instanceId: "a".repeat(64), bootId: `4444444${++bootN}-4444-4444-8444-444444444444`, startedAt: Date.now(), revision: "2".repeat(40) }, updateOriginSession: su.updateOriginSession, translate: (x: string) => x, now: () => k.t, sleep: async (ms: number) => { k.t += ms; } });
    const f = (b.deliveries as Array<{ channel: string; text: string; target: string | null; observeThreadKey?: string }>).filter((x) => x.text.startsWith("FAILURE:"));
    return { short: f.map((x) => `${x.text}@${x.target}#${x.observeThreadKey}`), full: f.map((x) => `${x.channel}:${x.text}@${x.target}#${x.observeThreadKey}`) };
  };
  /** 거절이면 실제 runUpdate(변경 전에 끝나고 기록만 쓴다) · 진행이면 기록 대역 — 실행 수를 센다. */
  const runOf = (tag: string, runs: unknown[]) => (c: { homeAbs: string }, gate: { refused?: unknown } | undefined) => { runs.push({ tag, gate }); return gate?.refused !== undefined ? d.runUpdate(c, gate) : undefined; };
  const failed = path.join(home, ".update-failed");
  const notify = { channel: "fixture", target: "chat-1", threadKey: "dashboard:side" };
  /** 홈의 옆 보존 기록(파일·디렉터리 기록) — 이름·결과·요청 좌표. */
  const asideNow = () => readdirSync(home).filter((n) => n.startsWith(".update-failed.unsent-")).map((n) => {
    const p = path.join(home, n);
    try {
      const m = JSON.parse(readFileSync(statSync(p).isDirectory() ? path.join(p, "record.json") : p, "utf8")) as { outcome?: string; notify?: { channel?: string; target?: string; threadKey?: string } };
      return { name: n, outcome: m.outcome ?? null, channel: m.notify?.channel ?? null, target: m.notify?.target ?? null, threadKey: m.notify?.threadKey ?? null };
    } catch { return { name: n, outcome: "(unreadable)", channel: null, target: null, threadKey: null }; }
  });
  type Wire = { reports: string[]; atReport: ReturnType<typeof asideNow>; okWrites: number };
  /** 데몬 쪽 인계 소켓 관측(§16 D1 #5) — 보고 줄이 도착한 순간의 옆 보존 기록 · 그 연결로 나간 `ok` 쓰기 수. 다른 대역(net) 위에 얹는다. */
  const spyNet = (base: typeof net, wire: Wire) => ({ createServer: (h: (sock: net.Socket) => void) => base.createServer((sock: net.Socket) => {
    sock.on("data", (x) => { if (String(x).includes("\n")) { wire.reports.push(String(x).trim()); wire.atReport.push(...asideNow()); } });
    const s = sock as unknown as { end: (...a: unknown[]) => unknown; write: (...a: unknown[]) => unknown };
    const realEnd = s.end.bind(sock), realWrite = s.write.bind(sock);
    s.end = (...a: unknown[]) => { if (a[0] !== undefined && typeof a[0] !== "function" && String(a[0]).includes("ok")) wire.okWrites++; return realEnd(...a); };
    s.write = (...a: unknown[]) => { if (String(a[0]).includes("ok")) wire.okWrites++; return realWrite(...a); };
    h(sock);
  }), connect: base.connect } as unknown as typeof net);
  /** 인계 파이프에 줄 하나를 쓰고 닫힐 때까지 받은 것 — 배선 대역 자식. */
  const talk = (to: string, line: string | null) => new Promise<string>((res) => {
    const c = net.connect(to);
    let got = ""; c.on("data", (x) => { got += String(x); }); c.on("close", () => res(got)); c.on("error", () => res(got));
    c.on("connect", () => { if (line !== null) c.write(line + "\n"); else setTimeout(() => c.destroy(), 100); });
  });

  /** 한 시나리오 — 앱을 c0 로 되돌리고(이 자식의 임시 저장소), 실제 runSelfUpdate 를 Windows 위임 갈래로 돈다. */
  const scenario = async (name: string, o: {
    child?: (env: Record<string, string>, names: { run: string; handoff: string }, args: string[]) => Promise<void> | void;
    pre?: (names: { run: string; handoff: string }) => Promise<(() => void) | void> | (() => void) | void;
    remoteMoved?: boolean; runningBuild?: string | null; waitMs?: number; after?: number; names?: { run: string; handoff: string }; net?: typeof net; spawnObj?: () => { unref: () => void; once?: (ev: "error", fn: (e: Error) => void) => unknown };
    /** 기본 자식(실제 runUpdateCommand)을 이만큼 늦게 시작한다 · beforeChild = 그 지연 뒤 자식이 보고하기 직전 한 번(데몬이 마감을 정한 뒤 — 시계 조작 등) */
    childDelayMs?: number; beforeChild?: () => void;
  }) => {
    g(["reset", "-q", "--hard", c0], app);
    if (o.remoteMoved === false) { g(["fetch", "-q", "origin"], app); g(["reset", "-q", "--hard", c1], app); }
    rmSync(failed, { force: true, recursive: true });
    const names = o.names ?? { run: sockPath("run"), handoff: sockPath("handoff") };
    const runs: Array<{ refused?: { reason: string; record: boolean }; env: Record<string, string | undefined>; dropThread?: boolean }> = [];
    const spawned: string[][] = [];
    const cleanup = await o.pre?.(names);
    const t0 = performance.now();
    let spawnedAt = -1;
    const wire: Wire = { reports: [], atReport: [], okWrites: 0 };
    const r = await su.runSelfUpdate({
      cwd: app, notify, platform: "win32", builtRuntime: true, net: spyNet(o.net ?? net, wire), pipeNames: names, handoffWaitMs: o.waitMs ?? 1500,
      keepAlive: true, ...(o.runningBuild !== undefined ? { runningBuild: o.runningBuild } : {}),
      spawnChild: (_cmd, args, options) => {
        spawned.push(args);
        spawnedAt = performance.now();
        if (o.spawnObj !== undefined) return o.spawnObj();
        const env = (options.env ?? {}) as Record<string, string>;
        // 넘겨받는 쪽 = 실제 runUpdateCommand — 같은 프로세스라 환경을 그 값으로 바꿔 준다(자식 프로세스의 환경과 같다).
        void (async () => {
          for (const k of Object.keys(process.env)) if (k.startsWith("TIGUCLAW_UPDATE_")) delete process.env[k];
          if (o.childDelayMs !== undefined) await sleep(o.childDelayMs);
          o.beforeChild?.();
          if (o.child !== undefined) await o.child(env, names, args);
          else {
            for (const [k, v] of Object.entries(env)) if (k.startsWith("TIGUCLAW_UPDATE_")) process.env[k] = v;
            await d.runUpdateCommand({ homeAbs: home }, String(args.at(-1)), { platform: "win32", runName: names.run, handoffName: names.handoff, run: (c: { homeAbs: string }, gate: never) => { runs.push(gate); return (gate as { refused?: unknown } | undefined)?.refused !== undefined ? d.runUpdate(c, gate) : undefined; } });
          }
        })();
        return { unref: () => undefined };
      },
    });
    const tEnd = performance.now();
    const elapsed = Math.round(tEnd - t0);
    /** 자식을 띄운 때부터 응답까지(ms) — 기한이 하나인지 보는 값 */
    const sinceSpawn = spawnedAt < 0 ? null : Math.round(tEnd - spawnedAt);
    await sleep(o.after ?? 300);
    if (typeof cleanup === "function") cleanup();
    // 응답 뒤 데몬은 두 파이프를 놓았나 — 같은 이름을 다시 쥐어 본다.
    const free = async (p: string) => new Promise<boolean>((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(p, () => s.close(() => res(true))); });
    const handoffFree = await free(names.handoff);
    const got = o.after === -1 ? { short: [], full: [] } : await consume();
    const delivered = got.short, deliveredFull = got.full;
    console.log(JSON.stringify({ name, wire, delivered, deliveredFull, status: r.status, reason: r.reason ?? null, error: r.error ?? null, from: r.from ?? null, to: r.to ?? null, spawned, runs, handoffFree, elapsed, sinceSpawn, head: g(["rev-parse", "HEAD"], app), failedLeft: (() => { try { return execFileSync("ls", ["-a", home], { encoding: "utf8" }).split("\n").filter((n) => n.startsWith(".update-failed")); } catch { return []; } })() }));
  };

  // 실제 HTTP 처리기 — 부팅 결과 처리 중이라 아무것도 안 바꾸고 busy(results) + 사유 문장
  {
    const { handleSelfUpdate } = (await import(pathToFileURL(path.join(REPO, "plugins/http-bridge/routes-ops.ts")).href)) as { handleSelfUpdate: (ctx: unknown) => Promise<void> };
    let body = "";
    await handleSelfUpdate({ res: { writeHead: () => undefined, setHeader: () => undefined, end: (b: string) => { body = b; } } });
    console.log(JSON.stringify({ name: "http-busy", body: JSON.parse(body) }));
  }
  // 부팅 결과 처리 중(기본값) — 아무것도 안 바꾸고 busy(results)
  {
    const r = await su.runSelfUpdate({ cwd: app, platform: "win32", builtRuntime: true, net, pipeNames: { run: sockPath("run"), handoff: sockPath("handoff") } });
    console.log(JSON.stringify({ name: "boot-pending", status: r.status, reason: r.reason ?? null, head: g(["rev-parse", "HEAD"], app) }));
    su.endBootUpdateResults();
  }
  // R1 정상 인계: acquired + ok → updating · 자식 runUpdate 1(앵커 = pull 전 · 표시 = pull 전)
  await scenario("acquired", {});
  // R1′ 빌드만 뒤처짐(받을 커밋 없음) — 앵커 = HEAD, 표시 = 실행 빌드
  await scenario("stale-only", { remoteMoved: false, runningBuild: c0 });
  // R2 자식이 쥔 뒤 슬롯이 차 있다 → 자식이 not-started 를 옆 보존한 뒤 refused 보고 → 데몬이 그 기록을 선점해 busy(child) · `ok` 쓰기 0 · 기록 0(§16)
  /** 슬롯을 채운 뒤 실제 runUpdateCommand(거절이면 실제 runUpdate — 반환을 잇는다). `afterRecord` = 거절 기록을 쓴 직후·보고 전. */
  const slotRefusingChild = (tag: string, afterRecord?: () => void) => async (env: Record<string, string>, names: { run: string; handoff: string }, args: string[]) => {
    writeFileSync(failed, JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "other" }));
    for (const [k, v] of Object.entries(env)) if (k.startsWith("TIGUCLAW_UPDATE_")) process.env[k] = v;
    await d.runUpdateCommand({ homeAbs: home }, String(args.at(-1)), { platform: "win32", runName: names.run, handoffName: names.handoff, run: (c: { homeAbs: string }, gate: { refused?: unknown }) => {
      console.log(JSON.stringify({ name: `${tag}:run`, gate }));
      if (gate?.refused === undefined) return undefined;
      const kept = d.runUpdate(c, gate);
      afterRecord?.();
      return kept;
    } });
  };
  await scenario("refused-slot", { child: slotRefusingChild("refused-slot") });
  // ★c7 반례(§16-1 a): 데몬의 `ok` 는 즉시 써지는데(자식이 읽는다) 완료 콜백은 마감 뒤 — c7 은 unconfirmed 로 답하고 자식은 `ok` 를 받아 기록 0 → 거절 통지 0
  //  기록 선점이 아닌 `ok` 로 책임을 정하면 이 순서에서 확정 거절 + 배달 = 0 이다.
  //  데몬 쪽 소켓의 `ok` 쓰기는 즉시 나가고(자식이 읽는다), 완료 콜백·`close`·`error` 는 마감 뒤로 미룬다 — 마감 순간 송신 결과는 불명이다(I1 #3).
  const lateCbNet = (blockMs: number) => ({ createServer: (h: (sock: net.Socket) => void) => net.createServer((sock) => {
    const realEnd = sock.end.bind(sock) as (d?: unknown) => net.Socket;
    const realOnce = sock.once.bind(sock) as (ev: string, fn: (...a: unknown[]) => void) => net.Socket;
    (sock as unknown as { end: (d?: unknown, cb?: (e?: Error) => void) => net.Socket }).end = (d?: unknown, cb?: (e?: Error) => void) => { realEnd(d); setTimeout(() => cb?.(), blockMs); return sock; };
    (sock as unknown as { once: (ev: string, fn: (...a: unknown[]) => void) => net.Socket }).once = (ev, fn) => (ev === "close" || ev === "error" ? realOnce(ev, (...a) => { setTimeout(() => fn(...a), blockMs); }) : realOnce(ev, fn));
    h(sock);
  }), connect: net.connect } as unknown as typeof net);
  await scenario("refused-ack-unknown", { net: lateCbNet(900), waitMs: 600, after: 1200, child: slotRefusingChild("refused-ack-unknown") });
  // 보고 줄은 마감 안에 도착했지만 이벤트 루프가 밀려 **마감 뒤에** 처리된다(데이터 처리 직전 900ms 붙잡힘 — 타이머 콜백보다 먼저 돈다) →
  //  마감 뒤 관측은 인정하지 않는다: 기록에 손대지 않고 unconfirmed · 기록은 부팅 1(I1 #1)
  const lateDataNet = (blockMs: number) => ({ createServer: (h: (sock: net.Socket) => void) => net.createServer((sock) => {
    let once = false;
    sock.on("data", () => { if (once) return; once = true; const until = performance.now() + blockMs; while (performance.now() < until) { /* 루프를 붙잡는다 */ } });
    h(sock);
  }), connect: net.connect } as unknown as typeof net);
  await scenario("refused-late-processed", { net: lateDataNet(900), waitMs: 600, after: 600, child: slotRefusingChild("refused-late-processed") });
  // 있는 기록의 선점이 실패한다 — 거절 기록을 쓴 직후 홈 쓰기 권한을 거둬 데몬의 실제 rename 이 EACCES → unconfirmed · 기록 그대로 → 부팅 1(소비 전 되돌림)
  await scenario("refused-claim-fails", { after: 600, pre: () => () => chmodSync(home, 0o755), child: slotRefusingChild("refused-claim-fails", () => chmodSync(home, 0o555)) });
  // 배선 대역 보고(저장 실패 부류 — 상태만): 처음부터 없는 이름 · 형식 밖 이름(홈 밖을 가리킴) · null
  //  · 필드 없음(모르는 보고 — 단정하지 않는다 → unconfirmed)
  for (const [tag, record] of [["refused-missing", ".update-failed.unsent-1-1-nothere"], ["refused-bad-name", "../escape-target"], ["refused-null", null], ["refused-no-field", undefined]] as const) {
    const escape = path.join(root, "escape-target");
    await scenario(tag, { pre: () => { writeFileSync(escape, "outside-home"); }, child: async (env, names) => {
      const got = await talk(names.handoff, JSON.stringify({ token: env.TIGUCLAW_UPDATE_HANDOFF_TOKEN, result: "refused", reason: "fixture", record }));
      console.log(JSON.stringify({ name: `${tag}:wire`, got, escapeKept: existsSync(escape) && readFileSync(escape, "utf8") === "outside-home" }));
    } });
  }
  // R3 자식이 아예 안 뜬다(옛 CLI 의 모르는 명령) → 기한 → unconfirmed · 실행 0
  await scenario("no-child", { child: () => undefined });
  // R4 기한 뒤 늦게 뜬 자식 → 인계 파이프 없음 → 실행 0 · not-started 기록 요청(record=true)
  await scenario("late-child", { waitMs: 400, after: 2500, child: async (env, names, args) => {
    await sleep(900);
    for (const [k, v] of Object.entries(env)) if (k.startsWith("TIGUCLAW_UPDATE_")) process.env[k] = v;
    await d.runUpdateCommand({ homeAbs: home }, String(args.at(-1)), { platform: "win32", runName: names.run, handoffName: names.handoff, run: (c: { homeAbs: string }, gate: { refused?: unknown }) => { console.log(JSON.stringify({ name: "late-child:run", gate })); return gate?.refused !== undefined ? d.runUpdate(c, gate) : undefined; } });
  } });
  // R5 다른 CLI 가 이미 실행 파이프를 쥐었다 → busy(running) · pull 0 · spawn 0
  {
    let held: net.Server | null = null;
    await scenario("other-running", { pre: async (names) => { held = await new Promise<net.Server>((res) => { const s = net.createServer(); s.listen(names.run, () => res(s)); }); return () => held?.close(); } });
  }
  // R7 슬롯에 기록이 남았다 → busy(slot) · pull 0 · 파이프 놓음
  await scenario("slot-occupied", { pre: () => { writeFileSync(failed, JSON.stringify({ stage: "x", outcome: "unchanged" })); } });
  // R8 받을 것도 뒤처짐도 없다 → up-to-date · spawn 0
  await scenario("up-to-date", { remoteMoved: false, runningBuild: c1, pre: () => { mkdirSync(path.join(app, "dist"), { recursive: true }); writeFileSync(path.join(app, "dist", ".build-commit"), `${c1}\n`); return () => rmSync(path.join(app, "dist"), { recursive: true, force: true }); } });
  // R9 인계 창에 현 판 터미널이 실행 파이프를 쥐었다 → 인계 파이프를 보고 놓고 거절 → 자식이 쥐고 진행
  await scenario("terminal-in-gap", { child: async (env, names, args) => {
    const termRuns: unknown[] = [];
    await d.runUpdateCommand({ homeAbs: home }, "update", { platform: "win32", runName: names.run, handoffName: names.handoff, run: (_c: unknown, gate: unknown) => { termRuns.push(gate); } });
    console.log(JSON.stringify({ name: "terminal-in-gap:terminal", termRuns }));
    for (const [k, v] of Object.entries(env)) if (k.startsWith("TIGUCLAW_UPDATE_")) process.env[k] = v;
    await d.runUpdateCommand({ homeAbs: home }, String(args.at(-1)), { platform: "win32", runName: names.run, handoffName: names.handoff, run: (_c: unknown, gate: unknown) => { console.log(JSON.stringify({ name: "terminal-in-gap:child", gate })); } });
  } });
  // R10 다른 토큰·빈 연결·같은 토큰 두 보고 — 자기 토큰 첫 보고에만 ok 한 번
  await scenario("tokens", { child: async (env, names) => {
    const empty = await talk(names.handoff, null);
    const wrong = await talk(names.handoff, JSON.stringify({ token: "not-this-request", result: "acquired" }));
    const right = JSON.stringify({ token: env.TIGUCLAW_UPDATE_HANDOFF_TOKEN, result: "acquired" });
    const [a, b] = await Promise.all([talk(names.handoff, right), talk(names.handoff, right)]);
    console.log(JSON.stringify({ name: "tokens:wire", empty, wrong, a, b }));
  } });
  // 띄우기가 늦게 실패한다(`error` 이벤트, 다음 턴) — 데몬은 살아서 failed(넘기지 못함)로 답하고 파이프를 놓는다
  await scenario("spawn-error", { spawnObj: () => { const e = new EventEmitter() as EventEmitter & { unref: () => void }; e.unref = () => undefined; setImmediate(() => e.emit("error", new Error("spawn cmd ENOENT (fixture)"))); return e; } });
  // `ok` 송신이 로컬에서 실패한다(보고 직후 자식이 연결을 끊음) → 데몬은 unconfirmed(단정 안 함)
  // 인계 파이프의 `end` 를 바꾼 net — mode: error-only(오류만) · cb-error-first(종료 콜백이 오류를 받은 뒤 error) · hang(콜백·오류 없음)
  //  late-sync = 송신이 이벤트 루프를 마감 너머까지 붙잡은 뒤 실제로 `ok` 를 보내고 성공 콜백을 바로 부른다(완료가 마감 **뒤에** 관측됨)
  const endNet = (mode: "error-only" | "cb-error-first" | "hang" | "late-sync", blockMs = 0) => ({ createServer: (h: (sock: net.Socket) => void) => net.createServer((sock) => {
    const realEnd = sock.end.bind(sock) as (d?: unknown) => net.Socket;
    (sock as unknown as { end: (d?: unknown, cb?: (e?: Error) => void) => net.Socket }).end = (d?: unknown, cb?: (e?: Error) => void) => {
      if (mode === "late-sync") {
        const until = performance.now() + blockMs;
        while (performance.now() < until) { /* 루프를 붙잡는다 */ }
        realEnd(d);
        cb?.();
        return sock;
      }
      if (mode !== "hang") setImmediate(() => { if (mode === "cb-error-first") cb?.(new Error("EPIPE (fixture)")); sock.emit("error", new Error("EPIPE (fixture)")); });
      return sock;
    };
    h(sock);
  }), connect: net.connect } as unknown as typeof net);
  await scenario("ack-write-fails", { net: endNet("error-only") });
  await scenario("ack-cb-error-first", { net: endNet("cb-error-first") });
  await scenario("ack-hangs", { net: endNet("hang"), waitMs: 600, after: 600 });
  // 보고가 기한 대부분(2000 중 1600)을 쓴 뒤 `ok` 송신이 끝나지 않는다 → **원래 마감**(띄운 때부터 2000)에 unconfirmed — 새 기한을 받지 않는다(I3 #3)
  await scenario("ack-late-report", { net: endNet("hang"), waitMs: 2000, childDelayMs: 1600, after: 600 });
  // 송신 완료가 마감 뒤에 관측된다(루프가 붙잡힘) → 인정하지 않고 unconfirmed(자식은 `ok` 를 받아 진행 — 결과는 자식이 잇는다)
  await scenario("ack-after-deadline", { net: endNet("late-sync", 900), waitMs: 600, after: 600 });
  // 같은 늦은 관측 net 이지만 보고가 `refused`(자식이 쥔 뒤 슬롯이 차 있음) → 거절엔 `ok` 를 쓰지 않는다 · 데몬이 기록을 선점해 busy · 기록 0 — 정확히 하나(§16)
  await scenario("ack-after-deadline-refused", { net: endNet("late-sync", 900), waitMs: 600, after: 600, child: slotRefusingChild("ack-after-deadline-refused") });
  // 데몬이 마감을 정한 **뒤**, 자식이 보고하기 직전에 벽시계가 한 시간 앞으로 조정된다 — 단조 마감이라 기한 안의 보고는 그대로 `ok` → updating(I3 #1, I4 #2)
  {
    const realNow = Date.now;
    try {
      await scenario("clock-forward", { childDelayMs: 200, beforeChild: () => { Date.now = () => realNow() + 3_600_000; } });
    } finally {
      Date.now = realNow;
    }
  }
  // 연결만 열고 기한까지 보고하지 않는다 → 기한에 `ok` 없이 닫힘 · 늦은 보고는 받지 않는다
  await scenario("connected-then-deadline", { waitMs: 400, after: 900, child: async (env, names) => {
    const got = await new Promise<string>((res) => { const c = net.connect(names.handoff); let g = ""; c.on("data", (x) => { g += String(x); }); c.on("close", () => res(`closed:${g}`)); c.on("error", () => res(`error:${g}`)); c.on("connect", () => setTimeout(() => c.write(JSON.stringify({ token: env.TIGUCLAW_UPDATE_HANDOFF_TOKEN, result: "acquired" }) + "\n"), 600)); });
    console.log(JSON.stringify({ name: "connected-then-deadline:wire", got }));
  } });
  // A 기한 → B 터미널 설치 완료(실행 파이프를 쥐었다 놓음) → 늦은 A 자식: 실행 0 · A not-started 1 · B 실행 1
  {
    const names = { run: sockPath("run"), handoff: sockPath("handoff") };
    let aEnv: Record<string, string> = {}; let aArgs: string[] = [];
    await scenario("seq-A-deadline", { names, waitMs: 300, after: -1, child: (env, _n, args) => { aEnv = env; aArgs = args; } });
    const seqRuns: unknown[] = [];
    for (const k of Object.keys(process.env)) if (k.startsWith("TIGUCLAW_UPDATE_")) delete process.env[k];
    await d.runUpdateCommand({ homeAbs: home }, "update", { platform: "win32", runName: names.run, handoffName: names.handoff, slot: () => "empty", run: runOf("B-terminal", seqRuns) });
    for (const [k, v] of Object.entries(aEnv)) if (k.startsWith("TIGUCLAW_UPDATE_")) process.env[k] = v;
    await d.runUpdateCommand({ homeAbs: home }, String(aArgs.at(-1)), { platform: "win32", runName: names.run, handoffName: names.handoff, run: runOf("A-late", seqRuns) });
    const delivered = (await consume()).short; const again = (await consume()).short;
    console.log(JSON.stringify({ name: "seq-terminal-then-late", runs: seqRuns, delivered, again }));
  }
  // A 기한 → B 데몬이 같은 인계 이름으로 인계 중 늦은 A 자식: A 토큰 거부 → A 실행 0·not-started 1 · B 대기 유지·실행 1
  {
    const names = { run: sockPath("run"), handoff: sockPath("handoff") };
    let aEnv: Record<string, string> = {}; let aArgs: string[] = [];
    await scenario("seq2-A-deadline", { names, waitMs: 300, after: -1, child: (env, _n, args) => { aEnv = env; aArgs = args; } });
    const seqRuns: unknown[] = [];
    await scenario("seq2-B", { names, waitMs: 3000, child: async (bEnv, n, bArgs) => {
      for (const [k, v] of Object.entries(aEnv)) if (k.startsWith("TIGUCLAW_UPDATE_")) process.env[k] = v;
      await d.runUpdateCommand({ homeAbs: home }, String(aArgs.at(-1)), { platform: "win32", runName: n.run, handoffName: n.handoff, run: runOf("A-late", seqRuns) });
      for (const k of Object.keys(process.env)) if (k.startsWith("TIGUCLAW_UPDATE_")) delete process.env[k];
      for (const [k, v] of Object.entries(bEnv)) if (k.startsWith("TIGUCLAW_UPDATE_")) process.env[k] = v;
      await d.runUpdateCommand({ homeAbs: home }, String(bArgs.at(-1)), { platform: "win32", runName: n.run, handoffName: n.handoff, run: runOf("B-child", seqRuns) });
    } });
    console.log(JSON.stringify({ name: "seq2-runs", runs: seqRuns, tokens: { a: aEnv.TIGUCLAW_UPDATE_HANDOFF_TOKEN ?? null } }));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
