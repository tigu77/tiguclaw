/**
 * 회귀: **외부 MCP 설정 변경이 재시작 없이 다음 턴에 반영된다** (Codex·OpenAI 경로, 2026-10-16).
 *
 * 사고: 회사 인스턴스에서 VoxelBuilder 에 `voxelbuilder-s5` 를 추가했는데, 그 프로젝트가 이미 `godot-mcp` 로 연결돼 있어
 *  새 위임에 네 도구가 안 보였다. 전역은 프로세스당 1회, 프로젝트는 첫 위임 1회 연결이라 재시작 전엔 반영이 안 됐다
 *  (Claude 는 매 턴 다시 읽어 바로 보였다 — 어댑터 비대칭). 정태님: «MCP 도 결국 데이터니까 그때그때 읽어들이는 방식».
 *
 * 본다(실제 stdio MCP 서버 프로세스로 — 같은 프로세스 안에서):
 *  ① 새 서버 연결 · 같은 설정은 재사용(같은 pid) · 동시 획득에도 한 번만 띄움
 *  ② 설정이 바뀌면 새로 연결 — 옛 연결은 그걸 쥔 턴이 놓을 때까지 살아 있고(쓰던 도구가 턴 도중에 안 끊김) 놓으면 닫힌다
 *  ③ 빠진 서버는 닫힌다 · 못 읽는 설정(쓰는 중·반쯤 저장)은 지금 연결을 지우지 않는다
 *  ④ 끊긴 연결(대상 프로세스 종료)은 다음 획득이 다시 연결한다
 *  ⑤ 실패는 같은 설정이면 간격 안에 다시 띄우지 않고, 간격이 지나거나 설정이 바뀌면 다시 시도한다(영구 캐시 0)
 *  ⑥ shutdown 은 은퇴했지만 쥔 턴이 남은 연결까지 닫는다 · 두 어댑터가 받은 래퍼를 놓는다(건너뛰는 경로 포함)
 *  ⑦ 프로젝트 .mcp.json 도 다음 위임에 반영 · 같은 이름은 프로젝트가 덮고 가려진 전역 래퍼는 바로 놓인다
 *  ⑧ 매달리는 재시도가 턴을 막지 않는다 · ⑨ 종료와 겹친 연결도 닫힌다 · 경고에 설정 내용이 안 실린다 · ⑩ @openai/agents 의 전역 목록 캐시를 타지 않는다
 *
 * 등급: **실행**(격리 홈 · 실제 자식 프로세스) + 배선 1건(어댑터 소스).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assert, assertIsolated, within, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

export const check: RegressionCheck = {
  name: "mcp-config-hot-reload",
  guards: "외부 MCP 등록·변경·제거가 Codex·OpenAI 에서 재시작 전엔 반영 안 되던 것 + 끊긴 연결이 영영 안 돌아오던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { getPaths } = await import("../../core/paths.js");
    const ext = await import("../../core/external-mcp.js");
    const home = getPaths().home;
    const sdk = (f: string): string => pathToFileURL(path.join(REPO, "node_modules/@modelcontextprotocol/sdk/dist/esm/server", f)).href;
    // 가짜 MCP 서버 — 인자로 받은 이름의 도구 하나, 부르면 자기 pid 를 답한다. 뜰 때마다 spawn 기록을 남긴다.
    const server = path.join(home, "fake-mcp.mjs");
    const spawns = path.join(home, "spawns.log");
    writeFileSync(
      server,
      `import { McpServer } from ${JSON.stringify(sdk("mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdk("stdio.js"))};
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(spawns)}, process.argv[2] + "\\n");
const s = new McpServer({ name: "fake", version: "1.0.0" });
s.tool(process.argv[2], "probe", async () => ({ content: [{ type: "text", text: String(process.pid) }] }));
await s.connect(new StdioServerTransport());
`,
      "utf8",
    );
    // 실패하는 서버 — 뜨자마자 끝난다(유효한 MCP 아님). 뜬 횟수를 센다.
    const failing = path.join(home, "failing-mcp.cjs");
    writeFileSync(failing, `require("fs").appendFileSync(${JSON.stringify(spawns)}, "fail:" + process.argv[2] + "\\n"); process.exit(1);\n`, "utf8");
    // 느린 서버 — initialize 전에 1.5초 쉰다(종료와 겹치는 연결). 매달리는 서버 — 첫 실행은 바로 죽고, 그 뒤엔 응답 없이 매달린다.
    const slow = path.join(home, "slow-mcp.mjs");
    writeFileSync(slow, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(spawns)}, "slow:" + process.pid + "\\n");
await new Promise((r) => setTimeout(r, 1500));
await import(${JSON.stringify(pathToFileURL(server).href)});
`, "utf8");
    const hangFlag = path.join(home, "hang.flag");
    const hang = path.join(home, "hang-mcp.cjs");
    writeFileSync(hang, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(spawns)}, "hang:" + process.pid + "\\n");
process.stdin.resume(); setInterval(() => {}, 1000);
if (!fs.existsSync(${JSON.stringify(hangFlag)})) {
  // 첫 실행: initialize 에 **오류로 답하고 살아 있는다** — 연결 실패 뒤 우리가 자식을 닫는지 본다.
  fs.writeFileSync(${JSON.stringify(hangFlag)}, "1");
  let buf = ""; process.stdin.on("data", (d) => { buf += d; const nl = buf.indexOf("\\n"); if (nl < 0) return;
    const id = JSON.parse(buf.slice(0, nl)).id; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "probe refuses" } }) + "\\n"); });
}
`, "utf8");
    const pidsTagged = (tag: string): number[] =>
      existsSync(spawns) ? readFileSync(spawns, "utf8").split("\n").filter((l) => l.startsWith(tag + ":")).map((l) => Number(l.slice(tag.length + 1))) : [];
    const mcpJson = path.join(home, "mcp.json");
    const setServers = (servers: Record<string, string[]>): void =>
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([n, args]) => [n, { command: process.execPath, args }])) }), "utf8");
    const spawnCount = (tag: string): number =>
      existsSync(spawns) ? readFileSync(spawns, "utf8").split("\n").filter((l) => l === tag).length : 0;
    type Bridge = Awaited<ReturnType<typeof ext.getConnectedExternalMcpBridges>>[number];
    // 본 자식 pid 전부 — 마지막에 남은 것을 직접 죽인다. 정리가 깨진 변이에서 자식이 살아남으면 러너가 **끝나지 않았다**
    //  (실측: shutdown 정리를 뺀 변이가 5분 시한까지 매달림). 무한 대기 대신 빨간불로 끝나게 한다.
    const seen = new Set<number>();
    const pidOf = async (b: Bridge, tool: string): Promise<number> => {
      const c = (await b.callTool(tool, {})) as unknown as { text?: string }[];
      const pid = Number(c[0]?.text ?? NaN);
      if (Number.isFinite(pid)) seen.add(pid);
      return pid;
    };
    const toolsOf = async (bs: Bridge[]): Promise<string[]> =>
      (await Promise.all(bs.map(async (b) => (await b.listTools()).map((t) => `${b.name}:${t.name}`)))).flat().sort();
    const release = async (bs: Bridge[]): Promise<void> => {
      for (const b of bs) await b.close();
    };
    const acquire = async (what: string): Promise<Bridge[]> => {
      const r = await within(20000, what, ext.getConnectedExternalMcpBridges());
      if ("timedOut" in r) throw new Error(r.timedOut);
      return r.value;
    };

    await ext.closeAllExternalMcp();
    try {
      // ① 새 서버 · 재사용 · 동시 획득
      setServers({ a: [server, "a_tool"] });
      const [t1, t1b] = await Promise.all([acquire("동시 획득 1"), acquire("동시 획득 2")]);
      const pidA = await pidOf(t1[0]!, "a_tool");
      await release(t1b);
      out.push(assert("① 새 서버를 연결한다 · 동시에 받아도 한 번만 띄운다",
        (await toolsOf(t1)).join() === "a:a_tool" && spawnCount("a_tool") === 1, { tools: await toolsOf(t1), spawns: spawnCount("a_tool") }));

      setServers({ a: [server, "a_tool"], b: [server, "b_tool"] });
      const t2 = await acquire("서버 추가 뒤");
      const a2 = t2.find((b) => b.name === "a")!;
      const pidBefore = await pidOf(t2.find((b) => b.name === "b")!, "b_tool");
      out.push(assert("① 서버를 더하면 다음 획득에 붙고, 그대로인 서버는 같은 연결(같은 pid)을 재사용한다",
        (await toolsOf(t2)).join() === "a:a_tool,b:b_tool" && (await pidOf(a2, "a_tool")) === pidA && spawnCount("a_tool") === 1,
        { tools: await toolsOf(t2), samePid: (await pidOf(a2, "a_tool")) === pidA, spawns: spawnCount("a_tool") }));
      await release(t2);
      // 지문에 env 도 든다 — 토큰만 바꿔도 새 프로세스(옛 토큰으로 계속 돌지 않게)
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { a: { command: process.execPath, args: [server, "a_tool"] }, b: { command: process.execPath, args: [server, "b_tool"], env: { PROBE_TOKEN: "rotated" } } } }), "utf8");
      const tEnv = await acquire("env 만 바뀐 뒤");
      const pidAfterEnv = await pidOf(tEnv.find((b) => b.name === "b")!, "b_tool");
      await release(tEnv);
      out.push(assert("① env 만 바뀌어도 새로 연결한다(옛 프로세스가 옛 토큰으로 계속 돌지 않게)",
        Number.isFinite(pidBefore) && Number.isFinite(pidAfterEnv) && pidAfterEnv !== pidBefore, { pidBefore, pidAfterEnv }));

      // ② 설정 변경 — 옛 연결은 쥔 턴(t1)이 놓을 때까지 산다
      setServers({ a: [server, "a2_tool"], b: [server, "b_tool"] });
      const t3 = await acquire("설정 변경 뒤");
      const oldStillWorks = await pidOf(t1[0]!, "a_tool");
      const aliveWhileHeld = alive(pidA);
      await release(t1);
      const closedAfterRelease = await waitFor(() => !alive(pidA), 5000);
      out.push(assert("② 설정이 바뀌면 다음 획득은 새 연결 · 옛 연결은 쥔 턴이 쓰는 동안 살아 있고, 놓으면 닫힌다",
        (await toolsOf(t3)).join() === "a:a2_tool,b:b_tool" && oldStillWorks === pidA && aliveWhileHeld && closedAfterRelease,
        { tools: await toolsOf(t3), oldStillWorks: oldStillWorks === pidA, aliveWhileHeld, closedAfterRelease }));
      const pidB = await pidOf(t3.find((b) => b.name === "b")!, "b_tool");
      await release(t3);

      // ③ 빠진 서버 · 못 읽는 설정
      setServers({ a: [server, "a2_tool"] });
      const t4 = await acquire("서버 제거 뒤");
      const bClosed = await waitFor(() => !alive(pidB), 5000);
      await release(t4);
      writeFileSync(mcpJson, '{ "mcpServers": { "a": ', "utf8"); // 반쯤 저장된 파일
      const t5 = await acquire("못 읽는 설정");
      const keptOnCorrupt = (await toolsOf(t5)).join();
      await release(t5);
      out.push(assert("③ 빠진 서버는 닫힌다 · 못 읽는 설정 파일은 지금 연결을 지우지 않는다",
        (await toolsOf(t4)).join() === "a:a2_tool" && bClosed && keptOnCorrupt === "a:a2_tool",
        { afterRemove: await toolsOf(t4), bClosed, keptOnCorrupt }));

      // ④ 끊긴 연결 — 대상 프로세스가 죽으면 다음 획득이 다시 연결한다
      setServers({ a: [server, "a2_tool"] });
      const t6 = await acquire("끊기기 전");
      const pidA2 = await pidOf(t6[0]!, "a2_tool");
      await release(t6);
      process.kill(pidA2, "SIGKILL");
      await waitFor(() => !alive(pidA2), 5000);
      await new Promise((r) => setTimeout(r, 100));
      const t7 = await acquire("끊긴 뒤");
      const pidA3 = t7[0] ? await pidOf(t7[0], "a2_tool") : NaN;
      await release(t7);
      out.push(assert("④ 끊긴 연결은 다음 획득에 다시 연결된다(새 pid)",
        Number.isFinite(pidA3) && pidA3 !== pidA2 && alive(pidA3), { before: pidA2, after: pidA3 }));

      // ⑤ 실패 — 같은 설정이면 간격 안엔 다시 안 띄우고, 간격이 지나거나 설정이 바뀌면 다시 시도
      setServers({ a: [server, "a2_tool"], bad: [failing, "x"] });
      await release(await acquire("실패 1"));
      await release(await acquire("실패 2(간격 안)"));
      const withinWindow = spawnCount("fail:x");
      const realNow = Date.now;
      Date.now = () => realNow() + 61_000;
      try {
        await release(await acquire("실패 3(간격 뒤)"));
      } finally {
        Date.now = realNow;
      }
      // 간격 뒤 재시도는 **백그라운드**다(턴이 안 기다린다) — 뜰 때까지 본다.
      await waitFor(() => spawnCount("fail:x") >= 2, 5000);
      const afterWindow = spawnCount("fail:x");
      setServers({ a: [server, "a2_tool"], bad: [failing, "y"] });
      await release(await acquire("실패 4(설정 바뀜)"));
      out.push(assert("⑤ 실패한 서버는 같은 설정이면 간격 안엔 다시 안 띄우고 · 간격 뒤엔 다시 시도 · 설정이 바뀌면 바로 시도",
        withinWindow === 1 && afterWindow === 2 && spawnCount("fail:y") === 1, { withinWindow, afterWindow, changed: spawnCount("fail:y") }));

      // ⑦ 프로젝트 범위 — 그 프로젝트 .mcp.json 도 다음 위임에 반영 · 같은 이름이면 프로젝트가 덮고, 가려진 전역 래퍼는 바로 놓인다
      {
        const { initStore } = await import("../../store/sessions.js");
        initStore();
        const { upsertProject } = await import("../../store/projects.js");
        const { mkdirSync } = await import("node:fs");
        const proj = path.join(home, "proj-hot");
        mkdirSync(proj, { recursive: true });
        upsertProject({ path: proj, name: "proj-hot", status: "active", description: null });
        const setProject = (servers: Record<string, string[]>): void =>
          writeFileSync(path.join(proj, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([n, args]) => [n, { command: process.execPath, args }])) }), "utf8");
        const acquireAt = async (what: string): Promise<Bridge[]> => {
          const r = await within(20000, what, ext.getConnectedExternalMcpBridges(proj));
          if ("timedOut" in r) throw new Error(r.timedOut);
          return r.value;
        };
        setServers({ a: [server, "ga_tool"] });
        const g = await acquire("전역 a");
        const pidGlobalA = await pidOf(g[0]!, "ga_tool");
        await release(g);
        setProject({ a: [server, "pa_tool"] });
        const p1 = await acquireAt("프로젝트 위임 1");
        const p1Tools = await toolsOf(p1);
        await release(p1);
        setProject({ a: [server, "pa_tool"], c: [server, "pc_tool"] });
        const p2 = await acquireAt("프로젝트 설정 추가 뒤");
        const p2Tools = await toolsOf(p2);
        await release(p2);
        // 가려진 전역 a 를 바꾼다 — 위임 턴이 그 래퍼를 놓았으면 쥔 턴이 0 이라 바로 닫힌다
        setServers({ a: [server, "ga2_tool"] });
        await release(await acquire("전역 a 교체"));
        const shadowedClosed = await waitFor(() => !alive(pidGlobalA), 5000);
        out.push(assert("⑦ 프로젝트 .mcp.json 도 다음 위임에 반영 · 같은 이름은 프로젝트가 덮고 · 가려진 전역 래퍼는 놓여 교체 때 바로 닫힌다",
          p1Tools.join() === "a:pa_tool" && p2Tools.join() === "a:pa_tool,c:pc_tool" && shadowedClosed,
          { p1Tools, p2Tools, shadowedClosed }));
      }

      // ⑧ 매달리는 재시도는 턴을 막지 않는다 · 실패한 연결의 자식은 남지 않는다 (적대 검토 F2 — 종전엔 줄 안에서 기다려 무관한 턴까지 60초씩)
      {
        setServers({ a: [server, "a2_tool"], h: [hang] });
        await release(await acquire("매달림 1(첫 실행은 오류로 답하고 살아 있음)"));
        const firstHangPid = pidsTagged("hang")[0] ?? NaN;
        const firstReaped = await waitFor(() => !alive(firstHangPid), 3000);
        const realNow = Date.now;
        Date.now = () => realNow() + 61_000;
        let t0 = 0;
        let elapsed = [0, 0];
        try {
          t0 = realNow();
          const [x, y] = await Promise.all([acquire("간격 뒤 재시도(매달림)"), acquire("동시에 들어온 무관한 턴")]);
          elapsed = [realNow() - t0, realNow() - t0];
          await release(x);
          await release(y);
        } finally {
          Date.now = realNow;
        }
        await waitFor(() => pidsTagged("hang").length >= 2, 3000);
        for (const pid of pidsTagged("hang")) seen.add(pid);
        // 재시도는 **짧게만**(3초 상한) 기다린다 — 0 이면 앱을 켠 뒤 첫 턴에 도구가 없고(재검토 P2), 길면 매달리는 서버가 턴을 그만큼 늦춘다.
        out.push(assert("⑧ 실패한 서버의 재시도가 응답 없이 매달려도 턴(무관한 턴 포함)은 짧게만 기다린다 · 실패한 첫 연결의 자식은 정리된다",
          firstReaped && elapsed[0]! < 5000 && pidsTagged("hang").length >= 2, { firstReaped, elapsedMs: elapsed[0], hangSpawns: pidsTagged("hang").length }));
        setServers({ a: [server, "a2_tool"] });
        await release(await acquire("매달림 서버 뺌"));
      }

      // ⑧' 대상 앱을 켠 뒤 **첫 턴부터** 붙는다 · 설정에서 뺀 서버의 연결은 다음 턴이 안 기다린다 (재검토 P2·P3)
      {
        const upFlag = path.join(home, "app-up.flag");
        const appup = path.join(home, "appup-mcp.mjs");
        writeFileSync(appup, `import { existsSync } from "node:fs"; if (!existsSync(${JSON.stringify(upFlag)})) process.exit(1);
await import(${JSON.stringify(pathToFileURL(server).href)});
`, "utf8");
        setServers({ a: [server, "a2_tool"], u: [appup, "u_tool"] });
        await release(await acquire("앱 꺼짐"));
        writeFileSync(upFlag, "1"); // 앱을 켰다
        const realNow = Date.now;
        Date.now = () => realNow() + 61_000;
        let firstTurn: string[] = [];
        try {
          const t = await acquire("앱 켠 뒤 첫 턴");
          firstTurn = await toolsOf(t);
          await release(t);
        } finally {
          Date.now = realNow;
        }
        setServers({ a: [server, "a2_tool"], s: [slow, "s_tool"] });
        const slowSeen = pidsTagged("slow").length;
        void ext.getConnectedExternalMcpBridges().then(release).catch(() => undefined);
        await waitFor(() => pidsTagged("slow").length > slowSeen, 3000);
        for (const pid of pidsTagged("slow")) seen.add(pid);
        setServers({ a: [server, "a2_tool"] });
        const t0 = Date.now();
        await release(await acquire("붙는 중인 서버를 뺀 뒤"));
        const removedWaitMs = Date.now() - t0;
        out.push(assert("⑧' 대상 앱을 켠 뒤 첫 턴부터 그 서버가 붙는다 · 설정에서 뺀 서버의 진행 중 연결은 다음 턴이 안 기다린다",
          firstTurn.includes("u:u_tool") && removedWaitMs < 800, { firstTurn, removedWaitMs }));
      }

      // ⑨ 종료가 진행 중인 연결과 겹쳐도 고아가 없다 (F3) · 못 읽는 설정 경고에 파일 내용이 안 실린다 (F4)
      {
        setServers({ a: [server, "a2_tool"], s: [slow, "s_tool"] });
        const slowBefore = pidsTagged("slow").length;
        void ext.getConnectedExternalMcpBridges().then(release).catch(() => undefined);
        await waitFor(() => pidsTagged("slow").length > slowBefore, 3000);
        await ext.closeAllExternalMcp();
        const slowPid = pidsTagged("slow")[slowBefore] ?? NaN;
        seen.add(slowPid);
        const slowReaped = await waitFor(() => !alive(slowPid), 6000);
        const warned: string[] = [];
        const realWarn = console.warn;
        console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
        try {
          setServers({ a: [server, "a2_tool"] });
          await release(await acquire("손상 전"));
          writeFileSync(mcpJson, '{ "mcpServers": { "a": { "env": { "T": ghp_PROBESECRET } } } }', "utf8");
          await release(await acquire("손상(따옴표 없는 토큰)"));
        } finally {
          console.warn = realWarn;
        }
        const leak = warned.some((w) => w.includes("PROBESECRET"));
        out.push(assert("⑨ 종료와 겹친 연결은 끝나는 대로 닫힌다(고아 0) · 못 읽는 설정 경고에 파일 내용이 안 실린다",
          slowReaped && !leak && warned.some((w) => w.includes("못 읽음")), { slowReaped, leak, warned: warned.map((w) => w.slice(0, 120)) }));
      }

      // ⑩ @openai/agents 경로 — SDK 가 같은 이름의 서버를 바꿔도 새 도구 목록을 본다 (F1: 전역 캐시가 서버 이름 키라 옛 목록을 냈다)
      {
        const core = (await import("@openai/agents-core")) as unknown as { RunContext: new (c: unknown) => unknown };
        const mcpmod = (await import(pathToFileURL(path.join(REPO, "node_modules/@openai/agents-core/dist/mcp.js")).href)) as {
          getAllMcpTools: (o: { mcpServers: Bridge[]; runContext: unknown; agent: unknown }) => Promise<{ name: string }[]>;
        };
        const sdkTools = async (bs: Bridge[]): Promise<string[]> =>
          (await mcpmod.getAllMcpTools({ mcpServers: bs, runContext: new core.RunContext({}), agent: { name: "x" } })).map((t) => t.name).sort();
        setServers({ a: [server, "sdk_old_tool"] });
        const s1 = await acquire("SDK 1");
        const first = await sdkTools(s1);
        await release(s1);
        setServers({ a: [server, "sdk_new_tool"] });
        const s2 = await acquire("SDK 2");
        const second = await sdkTools(s2);
        await release(s2);
        out.push(assert("⑩ @openai/agents 도 같은 이름의 서버가 바뀌면 새 도구 목록을 본다(전역 목록 캐시를 타지 않는다)",
          first.join() === "sdk_old_tool" && second.join() === "sdk_new_tool", { first, second }));
      }

      // ⑥ shutdown — 은퇴했지만 쥔 턴이 남은 연결도 닫는다
      setServers({ a: [server, "a2_tool"] });
      const held = await acquire("쥔 채로");
      const pidHeld = await pidOf(held[0]!, "a2_tool");
      setServers({ a: [server, "a3_tool"] });
      const t8 = await acquire("교체");
      const pidNew = await pidOf(t8[0]!, "a3_tool");
      await ext.closeAllExternalMcp();
      const bothClosed = await waitFor(() => !alive(pidHeld) && !alive(pidNew), 5000);
      out.push(assert("⑥ shutdown 은 은퇴했지만 쥔 턴이 남은 연결까지 닫는다(고아 0)", bothClosed, { held: alive(pidHeld), current: alive(pidNew) }));
    } finally {
      await ext.closeAllExternalMcp();
      for (const pid of seen) if (alive(pid)) process.kill(pid, "SIGKILL");
    }

    // ⑥ 배선 — 두 어댑터가 받은 래퍼를 턴 끝에 놓는다(건너뛰는 경로 포함)
    const codex = stripComments(readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"));
    const openai = stripComments(readSourceSync("src/core/llm-runtime/adapters/openai-agents-sdk.ts"));
    const codexPush = /for \(const extBridge of await getConnectedExternalMcpBridges\([^)]*\)\) \{\s*allBridges\.push\(extBridge\);/.test(codex);
    const openaiSkipRelease = /if \(\(await probeBridgeTools\(bridge\)\) === null\) \{\s*await bridge\.close\(\);\s*continue;/.test(openai);
    out.push(assert("★두 어댑터가 받은 외부 MCP 래퍼를 놓는다 — codex 는 턴 끝 일괄 close 묶음에 넣고 · openai 는 건너뛰는 래퍼를 바로 놓는다",
      codexPush && openaiSkipRelease, { codexPush, openaiSkipRelease }));
    return out;
  },
};
