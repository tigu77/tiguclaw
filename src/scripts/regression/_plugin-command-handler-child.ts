// 자식: 플러그인 메뉴 동작 — 커맨드 파일 `handler:` + 인스턴스 메서드 `getCommandHandlers` (2026-11-03 설계 §2.8 · §7-⑧ · R4 N2).
// 진짜 로더로 홈 플러그인을 설치하고, 채널 입구(`dispatchCommandSlash`)부터 처리기·호스트 출력·중지까지 본다.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { childCollector } from "./_child-checks.js";

assertIsolated();
process.env.TIGUCLAW_DISABLE_ENV_FILE = "1";
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "pch-"));
const W = mkdtempSync(path.join(process.env.TIGUCLAW_HOME, "work-"));
const c = childCollector();

const { initStore } = await import("../../store/sessions.js");
const { upsertProject } = await import("../../store/projects.js");
const sp = await import("../../core/session-projects.js");
const pc = await import("../../core/entry/project-command.js");
const reg = await import("../../core/entry/command-registry.js");
const { getPaths } = await import("../../core/paths.js");
const { getEventBus } = await import("../../core/eventbus.js");
const mgr = await import("../../core/plugins/manager.js");
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const { translate } = await import("../../core/i18n.js");
const { listShells } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
initStore();
mgr.initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const mkProject = (name: string): string => {
  const p = path.join(W, name);
  mkdirSync(path.join(p, ".tiguclaw", "commands"), { recursive: true });
  writeFileSync(path.join(p, "PROJECT.md"), `---\nname: ${name}\n---\n`);
  upsertProject({ path: p, name, status: "active", description: null });
  return p;
};
const A = mkProject("ha");
mkProject("hb");
mkProject("hc"); // 등록만, 연결 안 함
const plugins = getPaths().commonPlugins;
const pkg = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, private: true, type: "module", tiguclaw: { schemaVersion: 1, kind: ["service"], name, entry: "./index.mjs", ...extra } });
const HANDLERS = `
const log = (globalThis.__pch ??= { calls: [], gates: [] });
export default class P {
  async startService() {}
  getCommandHandlers() {
    return {
      h: async (input, host) => {
        log.calls.push({ h: "h", input, turn: host.turn ?? null });
        const posted = await host.postCard({ text: "CARD-TEXT", widget: "px/board", data: { path: input.project.path } });
        log.posted = posted;
        return "HANDLER-OK " + input.project.name + " " + input.args;
      },
      slowh: async (input, host) => {
        log.calls.push({ h: "slowh", input });
        await new Promise((r) => log.gates.push(r));
        log.lateAborted = host.turn !== undefined;
        log.latePosted = await host.postCard({ text: "LATE-CARD", widget: "px/board", data: {} });
        return "LATE-RESULT";
      },
      boom: async () => { throw new Error("BOOM-ERR"); },
      secret: async () => "the key is sk-ant-api03-" + "A".repeat(40),
      bad_name_ok: 1,
      "Bad-Name": async () => "x",
    };
  }
};
`;
const PX = path.join(plugins, "px");
write(path.join(PX, "package.json"), pkg("px", { needs: { ui: ["chat-widget"] } }));
write(path.join(PX, "index.mjs"), HANDLERS);
const pcmd = (dir: string, name: string, fm: string): void => write(path.join(dir, "commands", `${name}.md`), `---\n${fm}\n---\n`);
pcmd(PX, "a", "description: 보드 열기\nscope: projects\nhandler: h");
pcmd(PX, "aconf", "scope: projects\nconfirm: true\nhandler: h");
pcmd(PX, "slow", "scope: projects\nhandler: slowh");
pcmd(PX, "boom", "scope: projects\nhandler: boom");
pcmd(PX, "secret", "scope: projects\nhandler: secret");
pcmd(PX, "nohandler", "scope: projects\nhandler: missing_one");
// 발견 판정 — 무효 조합
pcmd(PX, "noscope", "handler: h");
pcmd(PX, "withrun", "scope: projects\nhandler: h\nrun: echo X");
write(path.join(getPaths().commonCommands, "uh.md"), "---\nscope: projects\nhandler: h\n---\n");
write(path.join(A, ".tiguclaw", "commands", "ph.md"), "---\nscope: projects\nhandler: h\n---\n");
// 화면 선언 없는 플러그인 — postCard 는 false
const PN = path.join(plugins, "pn");
write(path.join(PN, "package.json"), pkg("pn"));
write(path.join(PN, "index.mjs"), HANDLERS.replace("px/board", "pn/board").replace("px/board", "pn/board"));
pcmd(PN, "an", "scope: projects\nhandler: h");
// 폴더 대조 — xh1(코드 있음, 커맨드 없음) · xh2(같은 매니페스트 이름, 코드 없음, 커맨드 b)
write(path.join(plugins, "xh1", "package.json"), pkg("xh"));
write(path.join(plugins, "xh1", "index.mjs"), HANDLERS);
write(path.join(plugins, "xh2", "package.json"), JSON.stringify({ name: "xh", tiguclaw: { name: "xh" } }));
pcmd(path.join(plugins, "xh2"), "b", "scope: projects\nhandler: h");
// 코드 로드 실패
const PF = path.join(plugins, "pf");
write(path.join(PF, "package.json"), pkg("pf"));
write(path.join(PF, "index.mjs"), "throw new Error('load fails');\n");
pcmd(PF, "fa", "scope: projects\nhandler: h");

// 가짜 채널 — 바깥 배달 대신 버스 관측으로 카드를 센다.
registerChannelOutbound("regr-pch", { deliver: async () => undefined });
const outs: { text: string; attachments: unknown[] }[] = [];
getEventBus().subscribe((e) => {
  if (e.type === "channel.message.out") outs.push({ text: String(e.payload.text ?? ""), attachments: (e.payload.attachments as unknown[]) ?? [] });
});
const replies: string[] = [];
const offers: { q: string; options: { label: string; value: string }[] }[] = [];
const mkMsg = (threadKey: string) =>
  ({
    channel: "regr-pch",
    channelAddress: "addr-1",
    threadKey,
    text: "",
    reply: async (t: string) => { replies.push(t); },
    presentOptions: async (q: string, options: { label: string; value: string }[]) => { offers.push({ q, options }); return { ok: true }; },
  }) as never;
const dispatch = (text: string, threadKey: string) => {
  const t = text.trim();
  const sep = t.search(/\s/);
  const cmdName = sep === -1 ? t : t.slice(0, sep);
  const args = sep === -1 ? "" : t.slice(sep + 1).trim();
  return pc.dispatchCommandSlash({ msg: mkMsg(threadKey), args, trimmed: t, sidChannel: "cli" } as never, cmdName);
};
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
};
type Log = { calls: Array<{ h: string; input: { project: { name: string; path: string }; args: string }; turn?: unknown }>; gates: Array<() => void>; posted?: boolean; latePosted?: boolean };
const log = (): Log => ((globalThis as { __pch?: Log }).__pch ??= { calls: [], gates: [] });
const calls = (h: string) => log().calls.filter((x) => x.h === h).length;
const warns: string[] = [];
const origWarn = console.warn;
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); origWarn(...a); };

const tk = `dashboard:pch-${Date.now()}`;
try {
  for (const n of ["px", "pn", "xh", "pf"]) await mgr.installHomePlugin(n);

  // ── 발견 판정 ─────────────────────────────────────────────────────────
  const commonNames = (await reg.discoverCommonProjectCommands()).map((x) => x.name);
  const globalNames = (await reg.discoverCommands()).map((x) => x.name);
  const ownA = (await reg.discoverCommandsForProject(A)).map((x) => x.name);
  await reg.discoverCommonProjectCommands();
  const warnFor = (f: string) => warns.filter((w) => w.includes(f)).length;
  c.check(
    "★⑧ 발견: 플러그인 handler+scope 는 공통에 있고 전역에 없다 · 사용자·프로젝트 handler, scope 없음, handler+run 은 어디에도 없다(경고 1회씩)",
    commonNames.includes("a") && !globalNames.includes("a") && !commonNames.includes("uh") && !globalNames.includes("uh") && !ownA.includes("ph") &&
      !commonNames.includes("noscope") && !globalNames.includes("noscope") && !commonNames.includes("withrun") && !globalNames.includes("withrun") &&
      warnFor("uh.md") === 1 && warnFor("ph.md") === 1 && warnFor("noscope.md") === 1 && warnFor("withrun.md") === 1,
    { commonNames, globalNames, ownA, w: ["uh.md", "ph.md", "noscope.md", "withrun.md"].map(warnFor) },
  );
  c.check("⑧ getCommandHandlers 의 나쁜 칸은 그 처리기만 떨어진다(이름·함수 아님 경고)", warns.some((w) => w.includes("Bad-Name")) && warns.some((w) => w.includes("bad_name_ok")), warns.filter((w) => w.includes("getCommandHandlers")));

  // ── 프로젝트 맥락 ───────────────────────────────────────────────────────
  sp.linkProject(tk, "ha");
  replies.length = 0;
  outs.length = 0;
  const r1 = await dispatch("/project run ha a x", tk);
  await until(() => replies.some((r) => r.startsWith("HANDLER-OK")), 5000);
  const first = log().calls.find((x) => x.h === "h");
  c.check(
    "★⑧ /project run ha a x → 처리기 1회 · input.project.path = 연결 기록 경로 · args = x · host.turn = 메시지 좌표 · 반환 글이 답(비서 턴 없음)",
    r1.kind === "handled" && calls("h") === 1 && first?.input.project.path === A && first.input.args === "x" &&
      JSON.stringify(first.turn) === JSON.stringify({ threadKey: tk, channel: "regr-pch", target: "addr-1" }) && replies.includes("HANDLER-OK ha x"),
    { r1, first, replies },
  );
  const card = outs.find((o) => o.text === "CARD-TEXT");
  c.check(
    "⑧ 화면: needs.ui 있는 플러그인의 postCard → 그 대화로 위젯 첨부 1(데이터에 프로젝트) · 답 글은 그대로",
    log().posted === true && card !== undefined && card.attachments.length === 1 && JSON.stringify(card.attachments[0]).includes(A.replaceAll("\\", "\\\\")),
    { posted: log().posted, card },
  );
  const n0 = calls("h");
  replies.length = 0;
  await dispatch("/project run /etc a", tk);
  await dispatch("/project run hc a", tk);
  const missingTwice = replies.filter((r) => r.includes(translate("srv.project.missingCommand", { project: "§", command: "a" }).split("§")[1]!.slice(0, 6))).length;
  replies.length = 0;
  const shortA = await dispatch("/a y", tk);
  await until(() => replies.some((r) => r.startsWith("HANDLER-OK")), 5000);
  const tk0 = `${tk}-nolink`;
  replies.length = 0;
  const noLink = await dispatch("/a", tk0);
  c.check(
    "★⑧ 슬래시 글자의 경로(/etc)·연결 안 된 등록 프로젝트 → missing, 처리기 0 · 연결 1개 짧은 /a → 같은 처리기 · 연결 0 → 연결하라는 답",
    missingTwice === 2 && calls("h") === n0 + 1 && shortA.kind === "handled" && noLink.kind === "handled" && replies.join().includes("/project link"),
    { missingTwice, calls: calls("h"), shortA, noLink, replies },
  );
  // 화면 선언 없음
  outs.length = 0;
  replies.length = 0;
  await dispatch("/project run ha an", tk);
  await until(() => replies.some((r) => r.startsWith("HANDLER-OK")), 5000);
  c.check("⑧ needs.ui 없는 플러그인의 postCard → false · 첨부 0 · 답 글은 그대로", log().posted === false && outs.every((o) => o.attachments.length === 0) && replies.includes("HANDLER-OK ha"), { posted: log().posted, outs, replies });

  // ── 폴더 대조 · 수명 ────────────────────────────────────────────────────
  const n1 = calls("h");
  replies.length = 0;
  const xb = await dispatch("/project run ha b", tk);
  const xbShort = await dispatch("/b", tk);
  const unavailable = translate("srv.project.pluginUnavailable", { plugin: "§", command: "§" }).split("§")[1]!;
  const xbReplies = replies.filter((r) => r.includes(unavailable)).length;
  replies.length = 0;
  const fa = await dispatch("/project run ha fa", tk);
  const faShort = await dispatch("/fa", tk);
  const faReplies = replies.filter((r) => r.includes(unavailable)).length;
  const shellsBefore = listShells().length;
  c.check(
    "★⑧ 폴더 대조 — 같은 매니페스트 이름의 다른 폴더(xh2) 선언은 로드된 xh1 의 처리기를 부르지 못한다 · 코드 로드 실패(pf)도 — 메뉴 값·짧은 /이름 둘 다 안내 1회씩·handled·처리기 0·셸 0(R4 N2)",
    xb.kind === "handled" && xbShort.kind === "handled" && xbReplies === 2 && fa.kind === "handled" && faShort.kind === "handled" && faReplies === 2 &&
      calls("h") === n1 && shellsBefore === 0,
    { xb, xbShort, xbReplies, fa, faReplies, shells: shellsBefore },
  );
  replies.length = 0;
  await dispatch("/project run ha nohandler", tk);
  c.check("⑧ 선언한 처리기 이름이 코드에 없으면 plugin-unavailable", replies.length === 1 && replies[0]!.includes(unavailable), replies);
  await mgr.setPluginEnabled("px", false);
  replies.length = 0;
  await dispatch("/project run ha a", tk);
  const offMissing = replies.join().includes("/a");
  await mgr.setPluginEnabled("px", true);
  const n2 = calls("h");
  replies.length = 0;
  await dispatch("/project run ha a", tk);
  await until(() => calls("h") === n2 + 1, 5000);
  const reOn = calls("h") === n2 + 1;
  await mgr.removePlugin("px");
  replies.length = 0;
  const afterRm = await sp.expandSessionCommand(tk, "project", "run ha a");
  await mgr.setPluginEnabled("px", true); // 다시 켜 아래 검사를 잇는다
  c.check("⑧ 수명 — 끄면 missing · 다시 켜면 처리기 1회 · 제거하면 missing", offMissing && reOn && afterRm.kind === "missing", { offMissing, reOn, afterRm: afterRm.kind });

  // ── 위험 확인(confirm: true) ────────────────────────────────────────────
  const n3 = calls("h");
  offers.length = 0;
  await dispatch("/project run ha aconf z", tk);
  const confOffer = offers[0];
  const yes = confOffer?.options.find((o) => o.value.includes("--yes="))?.value ?? "";
  const beforeYes = calls("h");
  offers.length = 0;
  await dispatch(yes.replace(" ha aconf", " hb aconf"), tk); // 다른 프로젝트 이름으로 — (hb 는 연결 안 됨 → missing)
  sp.linkProject(tk, "hb");
  await dispatch(yes.replace(" ha aconf", " hb aconf"), tk);
  const reaskedProject = offers.length === 1;
  sp.unlinkProject(tk, "hb");
  write(path.join(PX, "commands", "aconf.md"), "---\nscope: projects\nconfirm: true\nhandler: slowh\n---\n");
  offers.length = 0;
  await dispatch(yes, tk);
  const reaskedHandler = offers.length === 1 && calls("slowh") === 0;
  write(path.join(PX, "commands", "aconf.md"), "---\nscope: projects\nconfirm: true\nhandler: h\n---\n");
  await dispatch(yes, tk);
  await until(() => calls("h") === n3 + 1, 5000);
  c.check(
    "★⑧ confirm: true → 선택지만(처리기 0) · 확인값(--yes=지문) → 처리기 1회 · 다른 프로젝트 이름·처리기 이름이 바뀐 값 → 다시 확인(처리기 0)",
    confOffer !== undefined && (confOffer.q.includes("🧩 px · h z")) && beforeYes === n3 && reaskedProject && reaskedHandler && calls("h") === n3 + 1,
    { q: confOffer?.q, beforeYes, reaskedProject, reaskedHandler, h: calls("h") - n3 },
  );

  // ── 실행 관리 — 중복·/stop·늦은 출력·던짐·비밀 가림 ─────────────────────
  sp.linkProject(tk, "hb");
  replies.length = 0;
  outs.length = 0;
  await dispatch("/project run ha slow", tk);
  await until(() => calls("slowh") === 1, 5000);
  await dispatch("/project run ha slow", tk);
  const dup = replies.filter((r) => r === translate("srv.project.runAlready", { command: "slow", project: "ha" })).length;
  await dispatch("/project run hb slow", tk);
  const bothRunning = await until(() => calls("slowh") === 2, 5000);
  const listed = pc.listProjectRuns().filter((r) => r.endsWith(":slow")).length;
  const stopped = await pc.stopProjectRuns(tk);
  const stopReplies = replies.filter((r) => r.startsWith("⏹")).length;
  for (const g of log().gates.splice(0)) g(); // 처리기가 멈춘 뒤 끝난다 — 카드와 반환을 시도한다
  await new Promise((r) => setTimeout(r, 200));
  c.check(
    "★⑧·R4 N2 중복(같은 A·slow 두 번째=이미 실행 중) · B 는 동시에 · /stop → «멈췄다» 각 1회 · 그 뒤 처리기의 postCard(false)·카드·대체 텍스트·반환 글 전송 0",
    dup === 1 && bothRunning && listed === 2 && stopped === 2 && stopReplies === 2 && log().latePosted === false &&
      !outs.some((o) => o.text === "LATE-CARD") && !replies.some((r) => r.includes("LATE-RESULT")) && pc.listProjectRuns().length === 0,
    { dup, listed, stopped, stopReplies, latePosted: log().latePosted, outs: outs.map((o) => o.text), replies },
  );
  replies.length = 0;
  await dispatch("/project run ha boom", tk);
  await until(() => replies.length > 0, 5000);
  const failed = translate("srv.project.actionFailed", { plugin: "px", command: "boom", error: "BOOM-ERR" });
  const boomReplies = [...replies];
  replies.length = 0;
  await dispatch("/project run ha secret", tk);
  await until(() => replies.length > 0, 5000);
  const secretReply = replies[0] ?? "";
  c.check(
    "⑧ 처리기가 던지면 실패 한 줄(데몬 생존·실행 표 비움) · 반환 글의 비밀처럼 보이는 값은 가린다",
    boomReplies.length === 1 && boomReplies[0] === failed && pc.listProjectRuns().length === 0 && secretReply.includes("the key is") && !secretReply.includes("A".repeat(40)),
    { boomReplies, secretReply },
  );

  // 기존 셸 중단 보존 — `run:` 실행형이 같은 /stop 으로 실제로 죽는다
  const sleeper = path.join(W, "sleep.js");
  write(sleeper, "console.log('SLEEP-PID', process.pid); setTimeout(() => {}, 30000);");
  write(path.join(A, ".tiguclaw", "commands", "zz.md"), `---\nrun: '"${process.execPath}" ${sleeper}'\n---\n`);
  replies.length = 0;
  await dispatch("/project run ha zz", tk);
  let pid = 0;
  await until(() => {
    const s = listShells().find((x) => x.cwd === A && x.status === "running");
    pid = s === undefined ? 0 : 1;
    return pid === 1;
  }, 8000);
  const shellId = listShells().find((x) => x.cwd === A && x.status === "running")?.shellId ?? "";
  await pc.stopProjectRuns(tk);
  const dead = await until(() => listShells().find((x) => x.shellId === shellId)?.status !== "running", 8000);
  c.check("★R4 N2 기존 셸 중단 보존 — RUNS 를 stop() 으로 일반화한 뒤에도 run: 실행형이 /stop 으로 실제로 끝난다(셸 상태가 running 이 아니다)", shellId !== "" && dead, { shellId, status: listShells().find((x) => x.shellId === shellId)?.status });

  // ── 두 채널 표현 — runsWithoutModel 한 함수 ──────────────────────────────
  offers.length = 0;
  await dispatch("/project open ha", tk);
  const label = offers[0]?.options.find((o) => o.value === "/project run ha a")?.label ?? "";
  const menus = await sp.sessionProjectMenus(tk);
  const aCmd = menus.find((m) => m.project.name === "ha")?.commands.find((x) => x.name === "a");
  c.check(
    "⑧ 두 채널 표현 — 텔레그램 라벨 «▶ /a — 보드 열기 · 🧩px» · 브리지 run 플래그 = runsWithoutModel(처리기) 참",
    label === "▶ /a — 보드 열기 · 🧩px" && aCmd !== undefined && reg.runsWithoutModel(aCmd),
    { label },
  );
} catch (e) {
  c.check("자식 검사가 예외 없이 끝난다", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  console.warn = origWarn;
  for (const g of log().gates.splice(0)) g();
  await pc.stopProjectRuns(tk).catch(() => 0);
}
c.done();
