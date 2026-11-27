/**
 * 회귀: **한 홈에 업데이트 실행은 하나 — 겹치는 요청은 변경 전에 거절하고, 결과 책임은 한 규칙으로** (2026-11-27 §15).
 *
 * 사고(설계 정본 `docs/decisions/2026-11-25-windows-update-late-restart.md` §15): 데몬이 Windows 위임 뒤 잠금을 풀어 연타가 위임 CLI 둘을 띄웠고,
 *  CLI 에 «한 홈 한 실행» 이 없어 터미널 실행·위임 실행이 겹쳤으며, 부팅 결과 처리 중에도 `/update` 를 받았다. 겹친 실행이 남긴 실패 기록을
 *  서로 옮기면서 옛 판 소비자가 읽는 도중 A 를 옮기고 B 를 공개해 A 2회·B 0회가 났다(`evidence/c6-old-consumer.log` overlap).
 *
 * 무엇을 재나(전부 **실행**한다):
 *  ① 실행권 문(`bin/daemon.mjs` `runUpdateCommand`) — 실제 `net`(격리 TMP 의 POSIX 소켓 = Windows 명명 파이프 대역): env 를 읽고 지움 ·
 *     실행 파이프 쥠/거절 · 인계 중 터미널 물러남 · 위임 자식의 보고와 `ok`/끊김 · `listen` 오류의 복구 예외(터미널 + 연결 거부만) · 옛 판 부모 자식의 슬롯 대기·세션 키 버림.
 *  ② 데몬(`runSelfUpdate` Windows 위임 갈래)과 ① 을 한 실행으로(자식 프로세스 — `_update-run-exclusive-child.ts`): 실제 git 저장소에서 acquired/refused/기한/늦은 자식/
 *     다른 실행/남은 기록/최신/인계 창 터미널/토큰.
 *  ③ busy 문구 — 슬래시·도구·HTTP 가 같은 함수, 대시보드 칩이 서버 문구를 띄우고 `unconfirmed` 면 재기동 대기에 들어가지 않는다.
 * 등급: **동작**.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { spawnProbe } from "./_probe-helpers.js";

const REPO = path.resolve(import.meta.dirname, "../../..");

type Gate = { env: Record<string, string | undefined>; refused?: { reason: string; record: boolean }; dropThread?: boolean };

export const check: RegressionCheck = {
  name: "update-run-exclusive",
  guards:
    "한 홈에서 업데이트 실행이 겹치고(위임 뒤 잠금 해제 · CLI 배타 없음 · 부팅 결과 처리 중 접수) 겹친 실행의 실패 기록이 서로를 옮겨 옛 판 소비자와 A 2회·B 0회가 나던 것 — 실행권·인계 규약 (등급: 동작)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const d = (await import(new URL("../../../bin/daemon.mjs", import.meta.url).href)) as {
      runUpdateCommand: (c: { homeAbs: string }, cmd: string, io?: Record<string, unknown>) => Promise<void>;
      runUpdate: (c: { homeAbs: string }, gate?: unknown) => unknown;
    };
    const { makeBootRunner } = await import("./_update-boot-harness.js");
    const bootRunner = await makeBootRunner(REPO);
    const { updateOriginSession } = await import("../../core/self-update.js");
    const fsp = await import("node:fs/promises");
    const fspReal = { readFile: (x: string) => fsp.readFile(x, "utf8"), writeFile: (x: string, raw: string) => fsp.writeFile(x, raw, "utf8"), unlink: (x: string) => fsp.unlink(x), rename: (a: string, b: string) => fsp.rename(a, b), readdir: (x: string) => fsp.readdir(x) };
    const consume = async (h: string, bootId: string) => {
      const k = { t: 0 };
      return bootRunner({ fsp: fspReal, home: h, boot: { instanceId: "a".repeat(64), bootId, startedAt: Date.now(), revision: "2".repeat(40) }, updateOriginSession, translate: (x: string) => x, now: () => k.t, sleep: async (ms) => { k.t += ms; } });
    };
    const root = mkdtempSync(path.join(os.tmpdir(), "upd-excl-"));
    let n = 0;
    const sock = (tag: string) => path.join(root, `${tag}-${++n}.sock`);
    const servers: net.Server[] = [];
    const hold = (p: string, onConn?: (s: net.Socket) => void) =>
      new Promise<net.Server>((res, rej) => { const s = net.createServer((c) => { c.on("error", () => undefined); onConn?.(c); }); s.once("error", rej); s.listen(p, () => { servers.push(s); res(s); }); });
    const free = (p: string) => new Promise<boolean>((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(p, () => s.close(() => res(true))); });
    /** 가짜 «데몬» 인계 파이프 — 보고를 적고 mode 대로 `ok` 또는 끊기. */
    const parent = async (p: string, mode: "ok" | "close") => {
      const got: unknown[] = [];
      await hold(p, (c) => { let b = ""; c.on("data", (x) => { b += String(x); if (!b.includes("\n")) return; got.push(JSON.parse(b.slice(0, b.indexOf("\n")))); if (mode === "ok") c.end("ok\n"); else c.destroy(); }); });
      return got;
    };
    /** 거절 보고는 `ok` 를 기다리지 않는다(§16) — 대역 부모가 줄을 받을 때까지(상한 2초) 기다린 뒤 단언한다. */
    const received = async (got: unknown[]) => { for (let i = 0; i < 200 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10)); };
    const call = async (cmd: string, env: Record<string, string>, io: Record<string, unknown>) => {
      for (const k of Object.keys(process.env)) if (k.startsWith("TIGUCLAW_UPDATE_")) delete process.env[k];
      Object.assign(process.env, env);
      const runs: Gate[] = [];
      let sleeps = 0;
      const clock = { t: 0 };
      await d.runUpdateCommand({ homeAbs: root }, cmd, { sleep: async (ms: number) => { sleeps++; clock.t += ms; }, now: () => clock.t, run: (_c: unknown, g: Gate) => { runs.push(g); }, ...io });
      const left = Object.keys(process.env).filter((k) => k.startsWith("TIGUCLAW_UPDATE_"));
      return { runs, sleeps, left };
    };
    /** 바깥에서 run 대역을 넘길 때 받은 문(gate) — call 의 runs 는 그때 비어 있다. */
    const runsSide: Gate[] = [];
    const tok = { TIGUCLAW_UPDATE_HANDOFF_TOKEN: "tok-1", TIGUCLAW_UPDATE_PREV_SHA: "1111111", TIGUCLAW_UPDATE_NOTIFY_CHANNEL: "fixture", TIGUCLAW_UPDATE_NOTIFY_TARGET: "t", TIGUCLAW_UPDATE_NOTIFY_THREAD: "dashboard:side" };
    const { translate: translate0 } = await import("../../core/i18n.js");
    try {
      // ── ① 실행권 문 ─────────────────────────────────────────────────────────────
      {
        const r = await call("update", { TIGUCLAW_UPDATE_NOTIFY_CHANNEL: "fixture", TIGUCLAW_UPDATE_NOTIFY_THREAD: "dashboard:x" }, { platform: "darwin" });
        out.push(assert("★env 는 읽어 두고 이 프로세스 환경에서 지운다 — 띄우는 감독자·데몬이 이번 요청 좌표를 물려받지 않게", r.left.length === 0 && r.runs.length === 1 && r.runs[0]!.env.TIGUCLAW_UPDATE_NOTIFY_CHANNEL === "fixture" && r.runs[0]!.refused === undefined, JSON.stringify(r)));
      }
      {
        const run = sock("run"); await hold(run);
        const r = await call("update", {}, { platform: "win32", runName: run, handoffName: sock("h") });
        out.push(assert("★실행 파이프를 다른 실행이 쥠 → 터미널 거절(기록 0 · 변경 전)", r.runs.length === 1 && r.runs[0]!.refused?.record === false && /already running/.test(r.runs[0]!.refused.reason), JSON.stringify(r.runs)));
      }
      {
        const run = sock("run"), h = sock("h"); await hold(h, (c) => c.destroy());
        const r = await call("update", {}, { platform: "win32", runName: run, handoffName: h });
        out.push(assert("★인계 중(인계 파이프 있음) 현 판 터미널은 쥔 실행 파이프를 놓고 거절", r.runs.length === 1 && /handing an update over/.test(r.runs[0]!.refused?.reason ?? "") && (await free(run)), JSON.stringify(r.runs)));
      }
      {
        // 실행이 끝나면(같은 프로세스가 살아 있어도) 실행 파이프를 놓는다 — 다음 실행이 같은 이름을 쥔다(프로세스 종료에 기대지 않음).
        const run = sock("run"), h = sock("h-none");
        const a = await call("update", {}, { platform: "win32", runName: run, handoffName: h });
        const releasedAfterRun = await free(run);
        const b = await call("update", {}, { platform: "win32", runName: run, handoffName: h });
        out.push(assert("★실행 끝 → 같은 프로세스에서 실행 파이프 놓음 · 다음 실행이 쥐고 진행",
          a.runs.length === 1 && a.runs[0]!.refused === undefined && releasedAfterRun && b.runs.length === 1 && b.runs[0]!.refused === undefined, JSON.stringify({ a: a.runs, releasedAfterRun, b: b.runs })));
      }
      for (const [mode, wantRecord, wantRun] of [["ok", false, true], ["close", true, false]] as const) {
        const run = sock("run"), h = sock("h"); const got = await parent(h, mode);
        const r = await call("update-delegated", tok, { platform: "win32", runName: run, handoffName: h, slot: () => "empty" });
        const ok = got.length === 1 && (got[0] as { token: string; result: string }).token === "tok-1" && (got[0] as { result: string }).result === "acquired" &&
          r.runs.length === 1 && (wantRun ? r.runs[0]!.refused === undefined : r.runs[0]!.refused?.record === wantRecord);
        out.push(assert(`★위임 자식 acquired + ${mode === "ok" ? "`ok` → 실행 1" : "`ok` 없이 끊김 → 실행 0·not-started 기록(record)"}`, ok, JSON.stringify({ got, runs: r.runs })));
      }
      {
        // 끝까지: `ok` 없이 끊긴(부모가 기한·정지로 사라진) 요청 → 실제 runUpdate 가 not-started 를 옆 보존 → 실제 부팅 소비가 그 요청 좌표로 1 · 다음 0.
        const h0 = mkdtempSync(path.join(root, "home-"));
        const run = sock("run"), hh = sock("h"); await parent(hh, "close");
        for (const k of Object.keys(process.env)) if (k.startsWith("TIGUCLAW_UPDATE_")) delete process.env[k];
        Object.assign(process.env, tok);
        await d.runUpdateCommand({ homeAbs: h0 }, "update-delegated", { platform: "win32", runName: run, handoffName: hh, slot: () => "empty", run: (c: { homeAbs: string }, g: unknown) => d.runUpdate(c, g) });
        const recs = (await fsp.readdir(h0)).filter((x) => x.startsWith(".update-failed"));
        const b1 = await consume(h0, "44444444-4444-4444-8444-444444444444"), b2 = await consume(h0, "55555555-5555-4555-8555-555555555555");
        const f1 = b1.deliveries.filter((x) => x.text.startsWith("FAILURE:"));
        out.push(assert("★끝까지 — `ok` 없이 끊긴 위임 요청: 실행 0 · 실제 not-started 기록 1(옆 보존) → 부팅이 그 좌표·세션으로 1 · 다음 부팅 0",
          recs.length === 1 && recs[0]!.startsWith(".update-failed.unsent-") && f1.length === 1 && f1[0]!.text === "FAILURE:not-started" && f1[0]!.target === "t" && f1[0]!.observeThreadKey === "dashboard:side" &&
          b2.deliveries.filter((x) => x.text.startsWith("FAILURE:")).length === 0, JSON.stringify({ recs, d1: b1.deliveries, d2: b2.deliveries.length })));
      }
      for (const mode of ["ok", "close"] as const) {
        // §16 — 거절은 기록이 먼저: 부모의 `ok` 여부와 무관하게 기록(record)을 남긴 **뒤** 보고하고, 보고엔 놓인 이름을 싣는다(대역 run 은 경로를 안 돌려줘 null).
        const run = sock("run"), h = sock("h"); const got = await parent(h, mode);
        const order: string[] = [];
        const r = await call("update-delegated", tok, { platform: "win32", runName: run, handoffName: h, slot: () => "occupied", run: (_c: unknown, g: Gate) => { order.push(`run:${got.length}`); runsSide.push(g); } });
        await received(got);
        const g0 = runsSide.splice(0);
        out.push(assert(`★위임 자식이 쥔 뒤 슬롯이 차 있음(부모 ${mode}) → 기록(record) 먼저 · 그다음 refused 보고(record 필드) · 두 번째 기록 0`,
          (got[0] as { result?: string })?.result === "refused" && "record" in (got[0] as object) && (got[0] as { record?: unknown }).record === null && g0.length === 1 && g0[0]!.refused?.record === true && JSON.stringify(order) === JSON.stringify(["run:0"]) && r.runs.length === 0,
          JSON.stringify({ got, g0, order })));
      }
      {
        // 끝까지(실제 runUpdate): 보고의 record = 그 순간 실제로 있는 자기 옆 보존 기록 이름 · 부모가 선점하지 않으면 부팅이 그 좌표로 1 · 다음 0
        const h0 = mkdtempSync(path.join(root, "home-"));
        const run = sock("run"), hh = sock("h");
        const seen: string[][] = []; const got: unknown[] = [];
        await hold(hh, (c) => { let b = ""; c.on("data", (x) => { b += String(x); if (!b.includes("\n")) return; got.push(JSON.parse(b.slice(0, b.indexOf("\n")))); seen.push(readdirSync(h0).filter((n) => n.startsWith(".update-failed"))); c.end("ok\n"); }); });
        for (const k of Object.keys(process.env)) if (k.startsWith("TIGUCLAW_UPDATE_")) delete process.env[k];
        Object.assign(process.env, tok);
        await d.runUpdateCommand({ homeAbs: h0 }, "update-delegated", { platform: "win32", runName: run, handoffName: hh, slot: () => "occupied", run: (c: { homeAbs: string }, g: unknown) => d.runUpdate(c, g) });
        await received(got);
        const b1 = await consume(h0, "44444444-4444-4444-8444-444444444444"), b2 = await consume(h0, "55555555-5555-4555-8555-555555555555");
        const f1 = b1.deliveries.filter((x) => x.text.startsWith("FAILURE:"));
        const rec = (got[0] as { record?: unknown } | undefined)?.record;
        out.push(assert("★끝까지 — 거절 보고의 record 는 실제 runUpdate 가 놓은 자기 옆 보존 이름(보고 순간 존재) · `ok` 를 받아도 기록은 그대로 → 선점하지 않은 부모면 부팅 1 · 다음 0",
          typeof rec === "string" && /^\.update-failed\.unsent-[0-9A-Za-z-]+$/.test(rec) && JSON.stringify(seen) === JSON.stringify([[rec]]) && f1.length === 1 && f1[0]!.text === "FAILURE:not-started" && f1[0]!.target === "t" &&
          b2.deliveries.filter((x) => x.text.startsWith("FAILURE:")).length === 0, JSON.stringify({ got, seen, d1: b1.deliveries })));
      }
      {
        // 인계 중 다른 현 판 실행이 잠깐 쥐었다가 놓는다 — 자식은 인계 파이프가 살아 있는 동안 다시 해 본다.
        const run = sock("run"), h = sock("h"); const got = await parent(h, "ok");
        const blocker = await hold(run);
        let tries = 0;
        const r = await call("update-delegated", tok, { platform: "win32", runName: run, handoffName: h, slot: () => "empty", sleep: async () => { if (++tries === 2) await new Promise<void>((res) => blocker.close(() => res())); } });
        out.push(assert("★위임 자식: 실행 파이프가 막혀도 인계 파이프가 살아 있으면 재시도 → 쥐면 acquired·실행 1", tries >= 2 && r.runs.length === 1 && r.runs[0]!.refused === undefined && (got[0] as { result?: string })?.result === "acquired", JSON.stringify({ tries, runs: r.runs, got })));
      }
      {
        const run = sock("run"); await hold(run);
        const r = await call("update-delegated", tok, { platform: "win32", runName: run, handoffName: sock("h-absent"), slot: () => "empty" });
        out.push(assert("★위임 자식: 실행 파이프 막힘 + 인계 파이프 없음 → 거절 보고 실패 → not-started 기록(record)", r.runs.length === 1 && r.runs[0]!.refused?.record === true, JSON.stringify(r.runs)));
      }
      {
        // `listen` 이 EADDRINUSE 외로 실패한다(EACCES) — 배타 없이 진행하는 예외는 터미널 + 연결 거부(데몬 없음)뿐.
        const failingNet = { createServer: () => { const s = new net.Server(); (s as unknown as { listen: () => void }).listen = () => { setImmediate(() => s.emit("error", Object.assign(new Error("EACCES"), { code: "EACCES" }))); }; return s; }, connect: net.connect };
        const rows: Array<[string, string, Record<string, string>, unknown, boolean]> = [
          ["터미널 + 연결 거부", "update", {}, { ok: false, absent: true, why: "no answer (ECONNREFUSED)" }, true],
          ["터미널 + 데몬 응답", "update", {}, { ok: true, why: "" }, false],
          ["터미널 + 판정 불능(시한)", "update", {}, { ok: false, why: "no answer within 1.5s" }, false],
          ["옛 판 부모 자식 + 연결 거부", "update", { TIGUCLAW_UPDATE_PREV_SHA: "1111111" }, { ok: false, absent: true, why: "" }, false],
        ];
        const bad: string[] = [];
        for (const [label, cmd, env, health, proceed] of rows) {
          const r = await call(cmd, env, { platform: "win32", net: failingNet, health: () => health, runName: sock("run"), handoffName: sock("h"), slot: () => "empty" });
          const went = r.runs.length === 1 && r.runs[0]!.refused === undefined;
          if (went !== proceed || r.runs.length !== 1) bad.push(`${label}: ${JSON.stringify(r.runs)}`);
        }
        const h = sock("h"); const got = await parent(h, "ok");
        const dr = await call("update-delegated", tok, { platform: "win32", net: { createServer: failingNet.createServer, connect: net.connect }, runName: sock("run"), handoffName: h, slot: () => "empty" });
        await received(got);
        if (!((got[0] as { result?: string })?.result === "refused" && dr.runs[0]?.refused?.record === true)) bad.push(`위임 자식: ${JSON.stringify({ got, runs: dr.runs })}`);
        out.push(assert("★`listen` 비-EADDRINUSE: 터미널 + 연결 거부만 진행 · 데몬 응답·판정 불능·옛 판 부모 자식은 거절 · 위임 자식은 refused 보고", bad.length === 0, bad.join(" | ") || "5/5"));
      }
      {
        let left = 3;
        const r = await call("update", { TIGUCLAW_UPDATE_PREV_SHA: "1111111", TIGUCLAW_UPDATE_NOTIFY_THREAD: "dashboard:stale" }, { platform: "darwin", slot: () => (left-- > 0 ? "occupied" : "empty") });
        const all = await call("update", { TIGUCLAW_UPDATE_PREV_SHA: "1111111" }, { platform: "darwin", slot: () => "occupied" });
        out.push(assert("★옛 판 부모가 띄운 자식: 슬롯이 비기를 기다린 뒤 진행(세션 키는 버림) · 끝까지 차면 정확히 상한(250ms×480) 뒤 거절",
          r.runs.length === 1 && r.runs[0]!.refused === undefined && r.runs[0]!.dropThread === true && r.sleeps === 3 &&
          all.runs.length === 1 && /^could not confirm within 120 seconds that an earlier update's result had been delivered$/.test(all.runs[0]!.refused?.reason ?? "") && all.runs[0]!.refused?.record === false && all.sleeps === 480,
          JSON.stringify({ r: { sleeps: r.sleeps, runs: r.runs.map((g) => ({ refused: g.refused, dropThread: g.dropThread })) }, all: { sleeps: all.sleeps, refused: all.runs[0]?.refused } })));
        // 마감에 닿는 순간 처음으로 «비어 있음» 이 보여도 진행하지 않는다(I2 #5).
        let tNow = 0;
        const late = await call("update", { TIGUCLAW_UPDATE_PREV_SHA: "1111111" }, { platform: "darwin", now: () => tNow, sleep: async (ms: number) => { tNow += ms; }, slot: () => (tNow >= 120000 ? "empty" : "occupied") });
        out.push(assert("★옛 판 부모 자식: 마감에 닿은 뒤 처음 본 «비어 있음» 은 진행 근거가 아니다 → 거절", late.runs.length === 1 && /^could not confirm within 120 seconds/.test(late.runs[0]!.refused?.reason ?? "") && !/still waiting/.test(late.runs[0]!.refused?.reason ?? ""), JSON.stringify(late.runs)));
        const term = await call("update", {}, { platform: "darwin", slot: () => "occupied" });
        out.push(assert("★터미널은 슬롯을 기다리지 않는다(최후 복구를 막지 않음)", term.sleeps === 0 && term.runs.length === 1 && term.runs[0]!.refused === undefined, JSON.stringify(term)));
      }
      {
        // 실제 프로세스: 실행 파이프를 쥔 채 runUpdate 가 끝나면 프로세스가 끝난다(쥔 소켓이 수명을 붙잡지 않는다 — unref).
        const run = sock("run");
        const t0 = Date.now();
        const child = spawnProbe(REPO, ["--input-type=module", "-e", `const d=await import(${JSON.stringify(new URL("../../../bin/daemon.mjs", import.meta.url).href)});await d.runUpdateCommand({homeAbs:${JSON.stringify(root)}},"update",{platform:"win32",runName:${JSON.stringify(run)},handoffName:${JSON.stringify(sock("h"))},run:(_c,g)=>{if(g&&g.refused){console.log("REFUSED "+g.refused.reason);process.exit(3)}console.log("RAN")}});`], { cwd: REPO, timeout: 20_000 });
        const second = spawnProbe(REPO, ["--input-type=module", "-e", `const d=await import(${JSON.stringify(new URL("../../../bin/daemon.mjs", import.meta.url).href)});await d.runUpdateCommand({homeAbs:${JSON.stringify(root)}},"update",{platform:"win32",runName:${JSON.stringify(run)},handoffName:${JSON.stringify(sock("h"))},run:(_c,g)=>{if(g&&g.refused){console.log("REFUSED "+g.refused.reason);process.exit(3)}console.log("RAN2")}});`], { cwd: REPO, timeout: 20_000 });
        out.push(assert("★실제 자식 프로세스: 실행 파이프를 쥔 채 runUpdate 1회 뒤 스스로 끝나고 · 다음 프로세스가 같은 이름을 쥐어 실행한다(놓기 = 실행 끝)",
          child.status === 0 && (child.stdout ?? "").includes("RAN") && second.status === 0 && (second.stdout ?? "").includes("RAN2") && !(second.stdout ?? "").includes("already running") && Date.now() - t0 < 30_000,
          `1:${child.status} ${(child.stderr ?? "").slice(-160)} · 2:${second.status} ${(second.stdout ?? "").slice(-160)}`));
      }

      // ── ② 데몬 인계 + 실행권 문 — 한 실행으로(자식 프로세스) ────────────────────────────
      const child = spawnProbe(REPO, [path.join(REPO, "src", "scripts", "regression", "_update-run-exclusive-child.ts")], { cwd: REPO, timeout: 120_000 });
      const rows = (child.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
      const by = (name: string) => rows.find((r) => r.name === name) as Record<string, any> | undefined;
      out.push(assert("자식이 실제로 돌았다", child.status === 0 && rows.length >= 40, `status=${child.status} rows=${rows.length} ${(child.stderr ?? "").slice(-300)}`));
      const hb0 = by("http-busy");
      out.push(assert("★실제 HTTP 처리기(`/api/self-update`): 부팅 결과 처리 중 → busy(results) + 사유 문장(message)", hb0?.body?.status === "busy" && hb0?.body?.reason === "results" && hb0?.body?.message === translate0("srv.update.busyResults"), JSON.stringify(hb0)));
      const bp = by("boot-pending");
      out.push(assert("★부팅 결과 처리 중(기본값) → busy(results) · pull 0", bp?.status === "busy" && bp?.reason === "results" && typeof bp?.head === "string", JSON.stringify(bp)));
      const ac = by("acquired"), st = by("stale-only");
      out.push(assert("★정상 인계: `update-delegated` 로 띄움 → acquired+`ok` → updating · 자식 runUpdate 1 · 앵커=pull 전·표시=pull 전 · 인계 파이프 닫힘",
        ac?.status === "updating" && ac?.spawned?.[0]?.at(-1) === "update-delegated" && ac?.runs?.length === 1 && ac.runs[0].refused === undefined &&
        ac.runs[0].env.TIGUCLAW_UPDATE_PREV_SHA === ac.from && ac.runs[0].env.TIGUCLAW_UPDATE_REPORT_FROM === ac.from && ac.from !== ac.to && typeof ac.runs[0].env.TIGUCLAW_UPDATE_HANDOFF_TOKEN === "string" &&
        ac.runs[0].env.TIGUCLAW_UPDATE_NOTIFY_THREAD === "dashboard:side" && ac.handoffFree === true, JSON.stringify(ac)));
      out.push(assert("★빌드만 뒤처진 갱신: 앵커 = HEAD(받을 커밋 없음) · 표시 = 실행 빌드 — 두 값이 자식까지 갈리지 않는다",
        st?.status === "updating" && st?.runs?.length === 1 && st.runs[0].env.TIGUCLAW_UPDATE_PREV_SHA === st.head.slice(0, 7) && st.runs[0].env.TIGUCLAW_UPDATE_REPORT_FROM !== st.runs[0].env.TIGUCLAW_UPDATE_PREV_SHA, JSON.stringify(st)));
      // ── §16 거절 = 기록이 먼저, 데몬은 그 기록을 선점했을 때만 직접 알린다 ──
      const NS = "FAILURE:not-started@chat-1#dashboard:side", OTHER = "FAILURE:rolled-back@null#dashboard:default", NS_FULL = `fixture:${NS}`;
      /** 보고 줄의 `record`(배선된 값) · 그 순간 그 이름의 기록(not-started · 요청 좌표) · 응답 뒤 그 이름·선점본 0 · `ok` 쓰기 0 (D1 #5·D2 #1) */
      const claimedRefusal = (x: Record<string, any> | undefined) => {
        const rep = (() => { try { return JSON.parse(x?.wire?.reports?.[0] ?? "null"); } catch { return null; } })() as { result?: string; record?: unknown } | null;
        const seen = (x?.wire?.atReport ?? []) as Array<{ name: string; outcome: string; channel: string; target: string; threadKey: string }>;
        return rep?.result === "refused" && typeof rep.record === "string" && seen.length === 1 && seen[0]!.name === rep.record && seen[0]!.outcome === "not-started" && seen[0]!.channel === "fixture" && seen[0]!.target === "chat-1" && seen[0]!.threadKey === "dashboard:side" &&
          x?.wire?.okWrites === 0 && !(x?.failedLeft ?? []).some((n: string) => n.includes(".unsent-") || n.includes(".claim-"));
      };
      /** 저장이 성공한 거절의 «확정 거절(busy) + 부팅 배달(not-started)» — 정확히 1 이어야 한다(§16-1 a). 실행은 0. */
      const refusalCount = (x: Record<string, any> | undefined) => (x?.status === "busy" && x?.reason === "child" ? 1 : 0) + ((x?.deliveredFull ?? []) as string[]).filter((v) => v === NS_FULL).length;
      /** 그 시나리오 자식의 실행 문 호출 — 거절 1·진행 0 이어야 한다(실행 수는 자식 쪽 기록으로 센다 — I1 #3). */
      const childRuns = (tag: string) => { const g = rows.filter((r) => r.name === `${tag}:run`) as Array<{ gate?: { refused?: unknown } }>; return { refused: g.filter((x) => x.gate?.refused !== undefined).length, ran: g.filter((x) => x.gate?.refused === undefined).length }; };
      const oneRefusal = (tag: string) => { const c = childRuns(tag); return c.refused === 1 && c.ran === 0; };
      const rs = by("refused-slot"), rsRun = by("refused-slot:run");
      out.push(assert("★자식이 쥔 뒤 슬롯이 차 있음 → 자식이 not-started 를 옆 보존한 뒤 refused(기록 이름) 보고 → 데몬이 그 기록을 선점 → busy(child)·사유 · `ok` 쓰기 0 · 기록 0 · 앞선 기록만 부팅 1",
        rs?.status === "busy" && rs?.reason === "child" && /still waiting/.test(rs?.error ?? "") && rsRun?.gate?.refused?.record === true && claimedRefusal(rs) && refusalCount(rs) === 1 && oneRefusal("refused-slot") &&
        JSON.stringify(rs?.delivered) === JSON.stringify([OTHER]) && rs?.handoffFree === true, JSON.stringify({ rs, rsRun })));
      const ru = by("refused-ack-unknown");
      out.push(assert("★c7 반례 — `ok` 쓰기는 즉시(자식이 읽음)·완료 콜백과 close 는 마감 뒤(마감 순간 송신 결과 불명)인 순서에서도 거절은 정확히 한 번(확정 거절 + 채널·대상·세션이 맞는 배달 = 1) · 자식 실행 0",
        refusalCount(ru) === 1 && oneRefusal("refused-ack-unknown") && (ru?.delivered ?? []).includes(OTHER) && (ru?.wire?.okWrites === 0 || ru?.sinceSpawn >= 550), JSON.stringify({ ru, runs: childRuns("refused-ack-unknown") })));
      const rlp = by("refused-late-processed");
      out.push(assert("★거절 보고가 마감 뒤에 처리됨(루프 지연 — 타이머보다 먼저) → 마감 뒤 관측은 인정하지 않는다: 기록 그대로 · unconfirmed · 부팅이 요청 채널·대상·세션으로 1 · 자식 실행 0",
        rlp?.status === "unconfirmed" && refusalCount(rlp) === 1 && (rlp?.deliveredFull ?? []).filter((v: string) => v === NS_FULL).length === 1 && oneRefusal("refused-late-processed") && rlp?.wire?.okWrites === 0 && rlp?.sinceSpawn >= 850, JSON.stringify(rlp)));
      out.push(assert("★같은 순서(반례 net)에서 거절은 데몬이 기록을 선점해 알린다 — `ok` 를 쓰지 않는다", ru?.status === "busy" && claimedRefusal(ru), JSON.stringify(ru?.wire)));
      const rcf = by("refused-claim-fails");
      out.push(assert("★있는 기록의 선점 실패(실제 rename EACCES) → unconfirmed(확정 거절 아님) · 기록 그대로 → 부팅이 그 요청 좌표로 1 · 실행 0",
        rcf?.status === "unconfirmed" && refusalCount(rcf) === 1 && (rcf?.deliveredFull ?? []).filter((v: string) => v === NS_FULL).length === 1 && oneRefusal("refused-claim-fails") && rcf?.wire?.okWrites === 0, JSON.stringify(rcf)));
      const rm = by("refused-missing"), rb = by("refused-bad-name"), rbw = by("refused-bad-name:wire"), rn = by("refused-null"), rnf = by("refused-no-field");
      out.push(assert("★저장 실패 부류(상태만): 없는 이름 → unconfirmed · 형식 밖 이름 → unconfirmed·홈 밖 파일 그대로·선점본 0 · null → busy(child) · `record` 필드 없음(모르는 보고) → unconfirmed · 넷 다 `ok` 0",
        rm?.status === "unconfirmed" && rb?.status === "unconfirmed" && rbw?.escapeKept === true && !(rb?.failedLeft ?? []).some((n: string) => n.includes(".claim-")) && rn?.status === "busy" && rn?.reason === "child" && rnf?.status === "unconfirmed" &&
        [rm, rb, rn, rnf].every((x) => x?.wire?.okWrites === 0 && (x?.delivered ?? []).length === 0), JSON.stringify({ rm, rb, rbw, rn, rnf })));
      const nc = by("no-child");
      out.push(assert("★자식이 안 뜬다(옛 CLI 의 모르는 명령) → 기한 → unconfirmed · 실행 0 · 인계 파이프 닫힘", nc?.status === "unconfirmed" && nc?.runs?.length === 0 && nc?.handoffFree === true && nc?.elapsed >= 1400, JSON.stringify(nc)));
      const lc = by("late-child"), lcRun = by("late-child:run");
      out.push(assert("★기한 뒤 늦게 뜬 자식 → 인계 파이프 없음 → 실행 0 · 실제 not-started 기록 → 부팅이 그 요청 좌표·세션으로 1 · 데몬은 unconfirmed",
        lc?.status === "unconfirmed" && lcRun?.gate?.refused?.record === true && JSON.stringify(lc?.delivered) === JSON.stringify(["FAILURE:not-started@chat-1#dashboard:side"]), JSON.stringify({ lc, lcRun })));
      const se = by("spawn-error");
      out.push(assert("★띄우기가 늦게 실패(`error` 이벤트) → 데몬은 살아서 failed(넘기지 못함) · 실행 0 · 파이프 놓음", se?.status === "failed" && /spawn cmd ENOENT \(fixture\)/.test(se?.error ?? "") && se?.runs?.length === 0 && se?.handoffFree === true, JSON.stringify(se)));
      const aw = by("ack-write-fails");
      out.push(assert("★`ok` 로컬 송신 실패 → 데몬 unconfirmed · 자식은 끊김으로 봄 → 실행 0 · not-started 1 → 부팅 1",
        aw?.status === "unconfirmed" && aw?.runs?.length === 1 && aw.runs[0].refused?.record === true && JSON.stringify(aw?.delivered) === JSON.stringify(["FAILURE:not-started@chat-1#dashboard:side"]), JSON.stringify(aw)));
      for (const nm of ["ack-cb-error-first", "ack-hangs"]) {
        const x = by(nm);
        out.push(assert(`★\`ok\` 송신 ${nm === "ack-hangs" ? "이 기한까지 끝나지 않음 → 기한에 unconfirmed·연결 끊김" : "의 종료 콜백이 오류를 받음(오류 콜백 → error 순서)"} → 데몬 unconfirmed · 자식 실행 0 · not-started 1 → 부팅 1`,
          x?.status === "unconfirmed" && x?.runs?.length === 1 && x.runs[0].refused?.record === true && JSON.stringify(x?.delivered) === JSON.stringify(["FAILURE:not-started@chat-1#dashboard:side"]) && x?.handoffFree === true && (nm !== "ack-hangs" || x?.elapsed < 3000), JSON.stringify(x)));
      }
      // 기한은 하나(I3 #3): 보고가 2000 중 1600 을 쓴 뒤 송신이 끝나지 않으면 띄운 때부터 ~2000 에 끝난다(보고 뒤 새 기한이면 ~3600).
      const lr = by("ack-late-report");
      out.push(assert("★보고가 기한 대부분을 쓴 뒤 `ok` 송신이 안 끝남 → **원래 마감**에 unconfirmed(새 기한 없음) · 자식 실행 0 · not-started 1",
        lr?.status === "unconfirmed" && typeof lr?.sinceSpawn === "number" && lr.sinceSpawn >= 1900 && lr.sinceSpawn < 2900 && lr?.runs?.length === 1 && lr.runs[0].refused?.record === true &&
        JSON.stringify(lr?.delivered) === JSON.stringify(["FAILURE:not-started@chat-1#dashboard:side"]), JSON.stringify(lr)));
      const ad = by("ack-after-deadline");
      out.push(assert("★송신 완료가 마감 뒤에 관측됨 → 인정하지 않고 unconfirmed(자식은 `ok` 를 받아 진행 — 결과는 자식 몫)",
        ad?.status === "unconfirmed" && ad?.runs?.length === 1 && ad.runs[0].refused === undefined, JSON.stringify(ad)));
      const adr = by("ack-after-deadline-refused"), adrRun = by("ack-after-deadline-refused:run");
      out.push(assert("★`ok` 완료가 마감 뒤에 관측되는 net 에서도 `refused` 엔 `ok` 를 쓰지 않는다 → 데몬이 기록 선점 → busy(child·사유) · 기록 0 · 부팅은 앞선 기록만 1 — 거절 정확히 하나(§16)",
        adr?.status === "busy" && adr?.reason === "child" && /still waiting/.test(adr?.error ?? "") && adrRun?.gate?.refused?.record === true && claimedRefusal(adr) && refusalCount(adr) === 1 && oneRefusal("ack-after-deadline-refused") &&
        JSON.stringify(adr?.delivered) === JSON.stringify(["FAILURE:rolled-back@null#dashboard:default"]) && adr?.handoffFree === true, JSON.stringify({ adr, adrRun })));
      const cf = by("clock-forward");
      out.push(assert("★마감을 정한 뒤 자식 보고 직전에 벽시계가 한 시간 앞당겨져도 기한 안의 보고는 `ok` → updating · 자식 실행 1(단조 마감 — I3 #1·I4 #2)",
        cf?.status === "updating" && cf?.runs?.length === 1 && cf.runs[0].refused === undefined, JSON.stringify(cf)));
      const cw = by("connected-then-deadline:wire"), cd = by("connected-then-deadline");
      out.push(assert("★연결만 열고 기한까지 보고 안 함 → 기한에 `ok` 없이 닫힘(늦은 보고 받지 않음) · unconfirmed", cw?.got === "closed:" && cd?.status === "unconfirmed", JSON.stringify({ cw, cd })));
      const sq = by("seq-terminal-then-late");
      out.push(assert("★순서 — A 기한 → B 터미널 설치(실행 1) → 늦은 A 자식: A 실행 0 · A not-started 1(그 좌표) · 다음 부팅 0",
        sq?.runs?.length === 2 && sq.runs[0].tag === "B-terminal" && sq.runs[0].gate?.refused === undefined && sq.runs[1].tag === "A-late" && sq.runs[1].gate?.refused?.record === true &&
        JSON.stringify(sq.delivered) === JSON.stringify(["FAILURE:not-started@chat-1#dashboard:side"]) && sq.again?.length === 0, JSON.stringify(sq)));
      const s2b = by("seq2-B"), s2r = by("seq2-runs");
      out.push(assert("★순서 — A 기한 → B 데몬 인계 중 늦은 A 자식: A 토큰 거부 → A 실행 0·not-started 1 · B 대기 유지 → B 자식 실행 1 · updating",
        s2b?.status === "updating" && s2r?.runs?.length === 2 && s2r.runs[0].tag === "A-late" && s2r.runs[0].gate?.refused?.record === true && s2r.runs[1].tag === "B-child" && s2r.runs[1].gate?.refused === undefined &&
        JSON.stringify(s2b?.delivered) === JSON.stringify(["FAILURE:not-started@chat-1#dashboard:side"]), JSON.stringify({ s2b, s2r })));
      out.push(assert("★정상 인계·빌드만 뒤처짐에서 기록 0(실행만 넘김)", JSON.stringify(ac?.delivered) === "[]" && JSON.stringify(st?.delivered) === "[]", JSON.stringify({ a: ac?.delivered, s: st?.delivered })));
      const orr = by("other-running");
      out.push(assert("★다른 CLI 가 실행 파이프를 쥠 → busy(running) · pull 0 · spawn 0", orr?.status === "busy" && orr?.reason === "running" && orr?.spawned?.length === 0 && orr?.head !== ac?.head, JSON.stringify(orr)));
      const so = by("slot-occupied");
      out.push(assert("★슬롯에 기록이 남음 → busy(slot) · pull 0 · spawn 0 · 파이프 놓음", so?.status === "busy" && so?.reason === "slot" && so?.spawned?.length === 0 && so?.handoffFree === true && so?.head === orr?.head, JSON.stringify(so)));
      const ut = by("up-to-date");
      out.push(assert("★받을 것도 뒤처짐도 없음 → up-to-date · spawn 0 · 파이프 놓음", ut?.status === "up-to-date" && ut?.spawned?.length === 0 && ut?.handoffFree === true, JSON.stringify(ut)));
      const tg = by("terminal-in-gap"), tgT = by("terminal-in-gap:terminal"), tgC = by("terminal-in-gap:child");
      out.push(assert("★인계 창의 현 판 터미널은 물러나고(실행 0) 자식이 쥐고 진행(실행 1) · updating", tg?.status === "updating" && tgT?.termRuns?.length === 1 && /handing an update over/.test(tgT.termRuns[0].refused?.reason ?? "") && tgC?.gate?.refused === undefined, JSON.stringify({ tg, tgT, tgC })));
      const tw = by("tokens:wire"), tk = by("tokens");
      out.push(assert("★`ok` 는 자기 토큰의 첫 보고에만 한 번 — 빈 연결·다른 토큰·같은 토큰 두 번째는 `ok` 없이 닫힘 · 응답 1", tw?.empty === "" && tw?.wrong === "" && [tw?.a, tw?.b].filter((x) => x === "ok\n").length === 1 && tk?.status === "updating", JSON.stringify({ tw, tk })));

      // ── ③ 문구 — 세 입구 같은 함수 · 칩 ──────────────────────────────────────────────
      const su = await import("../../core/self-update.js");
      const { translate } = await import("../../core/i18n.js");
      const mcpSrc = readFileSync(path.join(REPO, "src/core/llm-runtime/capabilities/update-self-mcp.ts"), "utf8");
      const routes = readFileSync(path.join(REPO, "plugins/http-bridge/routes-ops.ts"), "utf8");
      const reasons = [["results", "srv.update.busyResults"], ["slot", "srv.update.busyUndelivered"], ["lock", "srv.update.busyLock"], [undefined, "srv.update.busy"], ["running", "srv.update.busy"]] as const;
      const wrong = reasons.filter(([reason, key]) => su.formatSelfUpdateResult({ status: "busy", ...(reason ? { reason } : {}) }) !== translate(key));
      out.push(assert("busy 사유 문구: 슬래시 렌더가 사유별 카탈로그 키 · `unconfirmed` 는 인계 미확인 문구", wrong.length === 0 && su.formatSelfUpdateResult({ status: "unconfirmed" }) === translate("srv.update.handoffUnconfirmed") && su.formatSelfUpdateResult({ status: "busy", reason: "child", error: "X" }).includes("X"), JSON.stringify(wrong)));
      void mcpSrc; void routes;
      const mcp = (await import("../../core/llm-runtime/capabilities/update-self-mcp.js")) as { renderResult: (r: unknown) => string };
      const { selfUpdateHttpBody } = (await import(new URL("../../../plugins/http-bridge/routes-ops.ts", import.meta.url).href)) as { selfUpdateHttpBody: (r: unknown) => Promise<Record<string, unknown>> };
      const tb = mcp.renderResult({ status: "busy", reason: "results" }), tu = mcp.renderResult({ status: "unconfirmed" });
      const hb = await selfUpdateHttpBody({ status: "busy", reason: "slot" }), hu = await selfUpdateHttpBody({ status: "unconfirmed" }), hok = await selfUpdateHttpBody({ status: "updating", from: "a", to: "b" });
      out.push(assert("★도구·HTTP 실제 렌더: busy 사유·unconfirmed 가 슬래시와 같은 문장 · HTTP 는 busy·unconfirmed 에만 message",
        tb === translate("srv.update.busyResults") && tu === translate("srv.update.handoffUnconfirmed") && hb.message === translate("srv.update.busyUndelivered") && hu.message === translate("srv.update.handoffUnconfirmed") && hok.message === undefined,
        JSON.stringify({ tb, tu, hb, hu, hok })));
      const chipRaw = readFileSync(path.join(REPO, "packages/dashboard/js/update-chip.js"), "utf8");
      const from = chipRaw.indexOf("      const selfUpdateToast = ");
      const fn = chipRaw.slice(from, chipRaw.indexOf("\n      };", from) + "\n      };".length);
      const ctx: Record<string, unknown> = { i18n: (k: string) => `<${k}>` };
      vm.createContext(ctx); vm.runInContext(`${fn}\nthis.__t = selfUpdateToast;`, ctx);
      const t = ctx.__t as (d: unknown, s: number) => { text: string; tone: string; then: string | null };
      // 클릭 뒤 처리 전부(`handleSelfUpdateResponse`) — 실제 함수로 토스트·재기동 대기·새로 읽기 횟수를 센다.
      const from2 = chipRaw.indexOf("      const handleSelfUpdateResponse = ");
      const fn2 = chipRaw.slice(from2, chipRaw.indexOf("\n      };", from2) + "\n      };".length);
      vm.runInContext(`${fn2}\nthis.__h = handleSelfUpdateResponse;`, ctx);
      const h = ctx.__h as (d: unknown, s: number, fx: unknown) => Promise<void>;
      const glue = async (data: unknown) => { const seen = { toasts: [] as string[], reload: 0, refresh: 0 }; await h(data, 200, { showToast: (x: string) => seen.toasts.push(x), reloadWhenBack: async () => { seen.reload++; }, refresh: async () => { seen.refresh++; } }); return seen; };
      const gb = await glue(hb), gu = await glue(hu), gok = await glue({ status: "updating" });
      out.push(assert("★칩 클릭 뒤 처리(실제 함수 · HTTP 본문 그대로 넣음): busy → 서버 문구·재기동 대기 0·새로 읽기 0 · unconfirmed → 서버 문구·재기동 대기 0 · updating → 재기동 대기 1",
        gb.toasts[0] === hb.message && gb.reload === 0 && gb.refresh === 0 && gu.toasts[0] === hu.message && gu.reload === 0 && gok.reload === 1, JSON.stringify({ gb, gu, gok })));
      const busy = t({ status: "busy", message: "M-busy" }, 200), unc = t({ status: "unconfirmed", message: "M-unc" }, 200), upd = t({ status: "updating" }, 200), oldBusy = t({ status: "busy" }, 200);
      out.push(assert("★칩: busy·unconfirmed 는 서버 문구 · unconfirmed 는 재기동 대기 0 · updating 만 재기동 대기 · 옛 서버(문구 없음) busy 는 종전 문구",
        busy.text === "M-busy" && busy.then === null && unc.text === "M-unc" && unc.then !== "reload" && upd.then === "reload" && oldBusy.text === "<upd.busy>", JSON.stringify({ busy, unc, upd, oldBusy })));
      // ── ③′ 칩의 **실제 클릭 처리기** — 미니 DOM 에 update-chip.js 전체를 싣고, 등록된 click 을 낸다(I2 #7) ───────────
      {
        const md = await import("./_mini-dom.js");
        const clickWith = async (selfUpdateBody: Record<string, unknown>) => {
          const clock = md.makeClock();
          const toasts: string[] = []; const fetches: string[] = [];
          const { document, ctx } = md.makeDomContext({
            i18n: (k: string) => `<${k}>`, currentLocale: () => "ko", showToast: (t: string) => toasts.push(t),
            setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
            fetch: async (url: string) => {
              fetches.push(url);
              if (url === "/api/update-availability") return { ok: true, status: 200, json: async () => ({ state: "available", newVersion: "9.9.9" }) };
              if (url === "/api/self-update") return { ok: true, status: 200, json: async () => selfUpdateBody };
              if (url === "/api/health") return { ok: true, status: 200, json: async () => ({ uptime_ms: 5 }) };
              return { ok: false, status: 404, json: async () => ({}) };
            },
          });
          const chipEl = document.createElement("button"); chipEl.id = "update-chip"; document.body.appendChild(chipEl);
          vm.createContext(ctx); vm.runInContext(md.dashSource("update-chip.js"), ctx);
          await clock.flush();
          md.dispatch(chipEl, md.makeEvent("click"));
          await clock.flush();
          return { toasts, health: fetches.filter((u) => u === "/api/health").length, availability: fetches.filter((u) => u === "/api/update-availability").length };
        };
        const cb = await clickWith(hb), cu = await clickWith(hu), cok = await clickWith({ status: "updating", from: "a", to: "b" });
        out.push(assert("★칩 실제 클릭(등록된 처리기): busy → 서버 문구 토스트·재기동 대기 0 · unconfirmed → 서버 문구·재기동 대기 0·새로 읽기 1 · updating → 재기동 대기 시작",
          cb.toasts.includes(String(hb.message)) && cb.health === 0 && cu.toasts.includes(String(hu.message)) && cu.health === 0 && cu.availability === 2 && cok.health >= 1,
          JSON.stringify({ cb, cu, cok })));
      }
      // ── ④ `/health` 가 부팅 결과 처리 상태를 싣는다(실제 경로 실행 — 브리지 라우트) · 끝나면 false ─────────────
      {
        const { handleHealth } = (await import(new URL("../../../plugins/http-bridge/routes-ops.ts", import.meta.url).href)) as { handleHealth: (ctx: unknown) => Promise<void> };
        const read = async () => {
          let body = "";
          await handleHealth({ res: { writeHead: () => undefined, setHeader: () => undefined, end: (b: string) => { body = b; } }, bus: null, sseClients: new Set(), channelHandler: null });
          return JSON.parse(body) as { updateResultsPending?: unknown };
        };
        // 같은 러너 프로세스의 다른 검사가 이미 끝냈을 수 있다 — 지금 모듈 상태를 그대로 싣는지 + 끝 뒤 false 인지를 본다.
        const state = su.bootUpdateResultsPending();
        const before = await read();
        su.endBootUpdateResults();
        const after = await read();
        out.push(assert("★/health 의 updateResultsPending = 부팅 결과 처리 상태 그대로 → 끝 표지 뒤 false(단조)", typeof before.updateResultsPending === "boolean" && before.updateResultsPending === state && after.updateResultsPending === false, JSON.stringify({ state, before: before.updateResultsPending, after: after.updateResultsPending })));
      }
    } finally {
      for (const s of servers) s.close();
      for (const k of Object.keys(process.env)) if (k.startsWith("TIGUCLAW_UPDATE_")) delete process.env[k];
      rmSync(root, { recursive: true, force: true });
    }
    return out;
  },
};
