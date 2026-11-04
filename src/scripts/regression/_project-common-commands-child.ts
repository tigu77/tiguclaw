// 자식: 프로젝트 공통 커맨드 — 발견 분할·공존·직접 호출·메뉴·위험 액션·폴더 열기·지문·도구·인벤토리 (2026-11-03 설계 §7 ①~⑧·R1 ①②③⑥).
// 자기 임시 홈(러너 홈 아래)에서 돈다 — 홈 플러그인·cwd·PATH 를 바꾸므로 러너 프로세스와 섞지 않는다.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { assertIsolated, loadPluginModule } from "./_framework.js";
import { childCollector } from "./_child-checks.js";

assertIsolated();
process.env.TIGUCLAW_DISABLE_ENV_FILE = "1";
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "pcc-"));
const W = mkdtempSync(path.join(process.env.TIGUCLAW_HOME, "work-"));
const c = childCollector();

const { initStore } = await import("../../store/sessions.js");
const { upsertProject } = await import("../../store/projects.js");
const reg = await import("../../core/entry/command-registry.js");
const sp = await import("../../core/session-projects.js");
const pc = await import("../../core/entry/project-command.js");
const { getPaths } = await import("../../core/paths.js");
const { openDirectory } = await import("../../core/open-home-directory.js");
const { createCommandToolsMcpServer } = await import("../../core/llm-runtime/capabilities/command-tools-mcp.js");
const { collectInventory } = await import("../../core/plugins/inventory.js");
const { translate } = await import("../../core/i18n.js");
initStore();

// ── 픽스처 ───────────────────────────────────────────────────────────────
const mkProject = (name: string): string => {
  const p = path.join(W, name);
  mkdirSync(path.join(p, ".tiguclaw", "commands"), { recursive: true });
  writeFileSync(path.join(p, "PROJECT.md"), `---\nname: ${name}\n---\n`);
  upsertProject({ path: p, name, status: "active", description: null });
  return p;
};
const A = mkProject("pa");
mkProject("pb");
const E = mkProject("pe"); // 폴더를 지워 «폴더 없음» 을 본다
const userDir = getPaths().commonCommands;
mkdirSync(userDir, { recursive: true });
const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const plugDir = path.join(getPaths().commonPlugins, "pcc-plug");
write(path.join(plugDir, "package.json"), JSON.stringify({ name: "pcc-plug", tiguclaw: { name: "pcc-plug" } }));
const pcmd = (name: string, text: string): void => write(path.join(plugDir, "commands", `${name}.md`), text);
const ucmd = (name: string, text: string): void => write(path.join(userDir, `${name}.md`), text);
const own = (proj: string, name: string, text: string): void => write(path.join(proj, ".tiguclaw", "commands", `${name}.md`), text);
const cwdProj = path.join(W, "daemon-cwd");
write(path.join(cwdProj, ".tiguclaw", "commands", "d3.md"), "BODY-CWD-D3");
process.chdir(cwdProj); // 데몬 cwd 프로젝트(범위 없음) — `discoverCommands` 기본 cwd

ucmd("common1", "---\ndescription: 공통 하나\nscope: projects\n---\nCOMMON-BODY $ARGUMENTS");
ucmd("typo1", "---\nscope: project\n---\nTYPO");
ucmd("glob1", "---\nscope: global\n---\nGLOBAL-WORD");
pcmd("pprompt", "---\nscope: projects\n---\nPLUGIN-PROMPT");
// 공존 표(§2.2) 다섯 줄
ucmd("d1", "BODY-USER-GLOBAL-D1");
pcmd("d1", "---\nscope: projects\n---\nBODY-PLUGIN-COMMON-D1");
pcmd("d2", "BODY-PLUGIN-GLOBAL-D2");
ucmd("d2", "---\nscope: projects\n---\nBODY-USER-COMMON-D2");
ucmd("d3", "---\nscope: projects\n---\nBODY-USER-COMMON-D3");
ucmd("d4", "---\nscope: projects\n---\nBODY-USER-COMMON-D4");
pcmd("d4", "---\nscope: projects\n---\nBODY-PLUGIN-COMMON-D4");
own(A, "d5", "BODY-OWN-D5");
ucmd("d5", "---\nscope: projects\n---\nBODY-USER-COMMON-D5");
// 같은 루트 안에서도 전역·공통 동명은 공존한다 — 홈·플러그인 × 루트의 범위 양방향.
const sameRootCases: Array<{ name: string; source: "user" | "plugin"; global: string; common: string }> = [];
for (const [label, root, source] of [["home", userDir, "user"], ["plugin", path.join(plugDir, "commands"), "plugin"]] as const) {
  for (const commonAtRoot of [false, true]) {
    const name = `dual-${label}-${commonAtRoot ? "common" : "global"}-first`;
    const shallow = path.join(root, `${name}.md`);
    const nested = path.join(root, "shared", `${name}.md`);
    const commonBody = "---\nscope: projects\n---\nDUAL-COMMON";
    const globalBody = "DUAL-GLOBAL";
    write(shallow, commonAtRoot ? commonBody : globalBody);
    write(nested, commonAtRoot ? globalBody : commonBody);
    // 범위를 나눠도 같은 범위의 중복은 기존대로 얕은 쪽 하나만 남긴다.
    write(path.join(root, "shadow", `${name}.md`), commonAtRoot ? commonBody : globalBody);
    write(path.join(root, "shared", "shadow", `${name}.md`), commonAtRoot ? globalBody : commonBody);
    sameRootCases.push({ name, source, global: realpathSync(commonAtRoot ? nested : shallow), common: realpathSync(commonAtRoot ? shallow : nested) });
  }
}
// 실행형
const node = `"${process.execPath}"`;
write(path.join(W, "where.js"), "console.log('WHERE', process.cwd());");
write(path.join(W, "slow.js"), "setTimeout(() => console.log('SLOW-DONE'), 20000);");
ucmd("crun", `---\nscope: projects\nrun: '${node} "${path.join(W, "where.js")}"'\n---\n`);
ucmd("grun", "---\nrun: echo SHOULD-NOT\n---\n");
ucmd("slow", `---\nscope: projects\nrun: '${node} "${path.join(W, "slow.js")}"'\n---\n`);
pcmd("ff", `---\nscope: projects\nconfirm: true\nrun: '${node} "${path.join(W, "where.js")}"'\n---\n`);
ucmd("guard", `---\nscope: projects\nconfirm: true\nrun: '${node} "${path.join(W, "where.js")}"'\n---\n`);

const replies: string[] = [];
const offers: { q: string; options: { label: string; value: string }[] }[] = [];
const mkMsg = (threadKey: string) =>
  ({
    channel: "cli",
    threadKey,
    text: "",
    reply: async (t: string) => { replies.push(t); },
    presentOptions: async (q: string, options: { label: string; value: string }[]) => { offers.push({ q, options }); return { ok: true }; },
  }) as never;
const dispatch = (text: string, threadKey: string) => {
  const t = text.trim();
  const sep = t.search(/\s/);
  const cmd = sep === -1 ? t : t.slice(0, sep);
  const args = sep === -1 ? "" : t.slice(sep + 1).trim();
  return pc.dispatchCommandSlash({ msg: mkMsg(threadKey), args, trimmed: t, sidChannel: "cli" } as never, cmd);
};
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};
const names = (cs: { name: string }[]): string[] => cs.map((x) => x.name);
const warns: string[] = [];
const origWarn = console.warn;
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

try {
  // ── ① 발견 분할 ─────────────────────────────────────────────────────────
  const global1 = await reg.discoverCommands();
  const all1 = await reg.getAllCommands();
  const common1 = await reg.discoverCommonProjectCommands();
  const forA = await reg.discoverCommandsForProject(A);
  for (const sample of sameRootCases) {
    const global = global1.filter((x) => x.name === sample.name);
    const common = common1.filter((x) => x.name === sample.name);
    c.check(
      `★①② 같은 ${sample.source} 루트 동명 공존(${sample.name}): 전역·공통 각각 1개 · 범위 안 중복은 얕은 파일 우선`,
      global.length === 1 && global[0]!.filePath === sample.global && global[0]!.source === sample.source && global[0]!.scope === undefined &&
        common.length === 1 && common[0]!.filePath === sample.common && common[0]!.source === sample.source && common[0]!.scope === "projects" &&
        forA.find((x) => x.name === sample.name)?.filePath === sample.common,
      { sample, global, common },
    );
  }
  await reg.discoverCommands(); // 두 번째 걷기 — 경고는 한 번
  c.check(
    "① scope: projects 파일은 전역(discoverCommands·getAllCommands)에 없고 공통·프로젝트 목록에 있다",
    !names(global1).includes("common1") && !names(all1).includes("common1") && names(common1).includes("common1") && names(forA).includes("common1"),
    { global: names(global1), common: names(common1), forA: names(forA) },
  );
  const typoWarns = warns.filter((w) => w.includes("typo1.md")).length;
  const globWarns = warns.filter((w) => w.includes("glob1.md")).length;
  c.check(
    "① 범위 오타(scope: project)·파일의 scope: global 은 어디에도 없다(전역으로 새지 않는다) + 경고는 각각 한 번",
    ![...global1, ...common1, ...forA].some((x) => x.name === "typo1" || x.name === "glob1") && typoWarns === 1 && globWarns === 1,
    { typoWarns, globWarns },
  );

  // ── R1 ① 범위별 동명 공존(§2.2 공존 표) ─────────────────────────────────
  const g = new Map(global1.map((x) => [x.name, x] as const));
  const p = new Map(forA.map((x) => [x.name, x] as const));
  const src = (m: Map<string, { source: string; scope?: string }>, n: string) => (m.get(n) === undefined ? "none" : `${m.get(n)!.source}${m.get(n)!.scope === "projects" ? "+c" : ""}`);
  const table = {
    d1: [src(g, "d1"), src(p, "d1")],
    d2: [src(g, "d2"), src(p, "d2")],
    d3: [src(g, "d3"), src(p, "d3")],
    d4: [src(g, "d4"), src(p, "d4")],
    d5: [src(g, "d5"), src(p, "d5")],
  };
  c.check(
    "★R1① 공존 표 — 사용자 전역+플러그인 공통 · 플러그인 전역+사용자 공통 · cwd 프로젝트+사용자 공통 · 사용자 공통+플러그인 공통 · P 자기 것+사용자 공통",
    JSON.stringify(table) ===
      JSON.stringify({
        d1: ["user", "plugin+c"],
        d2: ["plugin", "user+c"],
        d3: ["project", "user+c"],
        d4: ["none", "user+c"],
        d5: ["none", "project"],
      }),
    table,
  );

  // ── 직접 호출 0/1/N · 라우팅 ────────────────────────────────────────────
  const tk = `dashboard:pcc-${Date.now()}`;
  replies.length = 0;
  const zero = await dispatch("/common1", tk);
  const zeroReply = replies.join("\n");
  sp.linkProject(tk, "pa");
  const one = await dispatch("/common1 hello", tk);
  const pluginPrompt = await dispatch("/pprompt", tk);
  const ownPrompt = await dispatch("/d5", tk);
  const shortD1 = await dispatch("/d1", tk);
  const runD1 = await dispatch("/project run pa d1", tk);
  const runD3 = await dispatch("/project run pa d3", tk);
  c.check(
    "③ 연결 0 → 프로젝트를 연결하라는 답(비서 턴 없음)",
    zero.kind === "handled" && zeroReply.includes("/project link") && zeroReply.includes("/common1"),
    { zero, zeroReply },
  );
  const targetA = translate("srv.project.commandTarget", { name: "pa", path: A });
  c.check(
    "③ 연결 1 → 공통 프롬프트형은 대상 줄(이름·경로)로 시작 · 플러그인이면 출처(🧩) · 자기 프롬프트형은 본문 그대로",
    one.kind === "prompt" && one.text.startsWith(`${targetA}\n`) && one.text.endsWith("COMMON-BODY hello") &&
      pluginPrompt.kind === "prompt" && pluginPrompt.text.includes(A) && pluginPrompt.text.includes("🧩") && pluginPrompt.text.endsWith("PLUGIN-PROMPT") &&
      ownPrompt.kind === "prompt" && ownPrompt.text === "BODY-OWN-D5",
    { one, pluginPrompt, ownPrompt },
  );
  c.check(
    "★R1① 짧은 /d1 은 전역(사용자 전역)에 · /project run pa d1 은 공통(플러그인)에 · cwd 프로젝트 d3 가 있어도 P 메뉴의 d3 는 사용자 공통",
    shortD1.kind === "prompt" && shortD1.text === "BODY-USER-GLOBAL-D1" &&
      runD1.kind === "prompt" && runD1.text.endsWith("BODY-PLUGIN-COMMON-D1") && runD3.kind === "prompt" && runD3.text.endsWith("BODY-USER-COMMON-D3"),
    { shortD1, runD1, runD3 },
  );
  sp.linkProject(tk, "pb");
  offers.length = 0;
  const two = await dispatch("/common1", tk);
  c.check(
    "③ 연결 2 → 고르기(후보 2, 서로 다른 값)",
    two.kind === "handled" && offers.length === 1 && offers[0]!.options.length === 2 && new Set(offers[0]!.options.map((o) => o.value)).size === 2,
    offers[0],
  );
  sp.unlinkProject(tk, "pb");

  // ── ④ 실행형 공통 · 전역 run ─────────────────────────────────────────────
  const ex = await sp.expandSessionCommand(tk, "project", "run pa crun");
  const exG = await sp.expandSessionCommand(tk, "grun", "");
  c.check(
    "④ /project run pa crun → run, 그 프로젝트 폴더 · 전역 run:(scope 없음) → run-needs-project",
    ex.kind === "run" && ex.project.path === A && exG.kind === "run-needs-project",
    { ex: ex.kind === "run" ? { path: ex.project.path, script: ex.script } : ex, exG },
  );
  replies.length = 0;
  await dispatch("/project run pa crun", tk);
  const ranHere = await until(() => replies.some((r) => r.includes("WHERE")), 15_000);
  c.check("④ 공통 실행형이 그 프로젝트 폴더에서 실제로 돈다", ranHere && replies.some((r) => r.includes(`WHERE ${A}`) || r.includes(A)), replies.slice(-2));

  // ── ⑤ 메뉴 — 텔레그램 /project open · 브리지 GET ────────────────────────
  offers.length = 0;
  await dispatch("/project open pa", tk);
  const menu = offers[0]?.options ?? [];
  const idx = (pred: (o: { label: string; value: string }) => boolean) => menu.findIndex(pred);
  const iOwn = idx((o) => o.value === "/project run pa d5");
  const iCommon = idx((o) => o.value === "/project run pa common1");
  const iPlug = idx((o) => o.value === "/project run pa pprompt");
  const iDetail = idx((o) => o.value === "/project show pa");
  const iFolder = idx((o) => o.value === "/project folder pa");
  const iUnlink = idx((o) => o.value === "/project unlink pa");
  c.check(
    "⑤ /project open: 자기 → 공통(꼬리 «공통»·🧩플러그인) → 상세·폴더 열기·연결 해제 순(코어 표에서)",
    iOwn >= 0 && iOwn < iCommon && iCommon < iDetail && iPlug < iDetail && iDetail < iFolder && iFolder < iUnlink && iUnlink === menu.length - 1 &&
      menu[iCommon]!.label.includes(translate("srv.project.commonTag")) && menu[iPlug]!.label.includes("🧩pcc-plug") && !menu[iOwn]!.label.includes("·") &&
      menu[iDetail]!.label.includes(translate("sproj.openDetail")) && menu[iFolder]!.label.includes(translate("proj.folder.open")),
    menu,
  );
  sp.linkProject(tk, "pe");
  rmSync(E, { recursive: true, force: true });
  offers.length = 0;
  await dispatch("/project open pe", tk);
  const menuE = offers[0]?.options ?? [];
  c.check(
    "⑤ 폴더 없는 프로젝트엔 «폴더 열기» 가 없다(상세·해제는 있다)",
    menuE.length > 0 && !menuE.some((o) => o.value.startsWith("/project folder")) && menuE.some((o) => o.value === "/project unlink pe"),
    menuE,
  );
  const route = await loadPluginModule<{ handleGetSessionProjects: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-session-projects.js");
  let body: { linked?: Array<{ name: string; actions: Array<{ id: string; value: string; danger?: boolean; labelKey: string }>; commands: Array<{ name: string; common: boolean; run: boolean; source: string; pluginId?: string }> }> } = {};
  await route.handleGetSessionProjects({
    url: new URL(`http://x/session-projects?threadKey=${encodeURIComponent(tk)}`),
    channelName: "http-bridge",
    res: { writeHead: () => undefined, setHeader: () => undefined, end: (s: string) => { body = JSON.parse(s); } },
  });
  const ga = body.linked?.find((l) => l.name === "pa");
  const ge = body.linked?.find((l) => l.name === "pe");
  c.check(
    "⑤ 브리지 GET: actions 3개(detail·folder·unlink, 값 = 코어 슬래시) · 공통 플래그·출처 · 폴더 없으면 folder 없음",
    JSON.stringify(ga?.actions.map((a) => a.id)) === JSON.stringify(["detail", "folder", "unlink"]) &&
      ga?.actions.find((a) => a.id === "unlink")?.danger === true && ga?.actions.find((a) => a.id === "folder")?.value === "/project folder pa" &&
      ga?.commands.find((x) => x.name === "common1")?.common === true && ga?.commands.find((x) => x.name === "d5")?.common === false &&
      ga?.commands.find((x) => x.name === "pprompt")?.pluginId === "pcc-plug" && ga?.commands.find((x) => x.name === "crun")?.run === true &&
      JSON.stringify(ge?.actions.map((a) => a.id)) === JSON.stringify(["detail", "unlink"]),
    { pa: ga?.actions, pe: ge?.actions, cmds: ga?.commands },
  );
  sp.unlinkProject(tk, "pe");

  // ── R3 ③ 위험 액션 — 표를 걷는다(손목록 아님) ───────────────────────────
  const dangerResults: unknown[] = [];
  let dangerOk = sp.PROJECT_MENU_ACTIONS.some((a) => a.danger === true);
  for (const a of sp.PROJECT_MENU_ACTIONS.filter((x) => x.danger === true)) {
    offers.length = 0;
    const before = sp.linkedProjects(tk).map((x) => x.name).join();
    await dispatch(a.slash("pa"), tk);
    const after = sp.linkedProjects(tk).map((x) => x.name).join();
    const confirmValue = offers[0]?.options.find((o) => o.value !== "/project")?.value ?? "";
    const askedOnly = before === after && offers.length === 1 && confirmValue !== "";
    let applied = false;
    if (confirmValue !== "") {
      await dispatch(confirmValue, tk);
      applied = sp.linkedProjects(tk).map((x) => x.name).join() !== before;
      sp.linkProject(tk, "pa");
    }
    const telegramValue = menu.find((o) => o.label.includes(translate(a.labelKey)))?.value;
    dangerOk &&= askedOnly && applied && telegramValue === a.slash("pa");
    dangerResults.push({ id: a.id, askedOnly, applied, telegramValue });
  }
  c.check("★R3③ danger 액션마다: 확인 전 꼴은 묻기만(상태 그대로) · 확인 꼴은 바뀐다 · 텔레그램 메뉴 값 = 확인 전 꼴", dangerOk, dangerResults);

  // ── ⑥ /project folder — 가짜 opener(PATH 앞) · 무디스플레이 ─────────────
  if (process.platform !== "win32") {
    const fakeBin = mkdtempSync(path.join(W, "bin-"));
    const openLog = path.join(fakeBin, "calls.log");
    for (const n of ["open", "xdg-open"]) {
      write(path.join(fakeBin, n), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${openLog}'\nexit 0\n`);
      chmodSync(path.join(fakeBin, n), 0o755);
    }
    const oldPath = process.env.PATH;
    const oldDisplay = process.env.DISPLAY;
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    process.env.DISPLAY = ":synthetic-pcc";
    replies.length = 0;
    try {
      await dispatch("/project folder pa", tk);
    } finally {
      process.env.PATH = oldPath;
      if (oldDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = oldDisplay;
    }
    const calls = existsSync(openLog) ? readFileSync(openLog, "utf8").trim().split("\n").filter((l) => l !== "") : [];
    c.check(
      "⑥ /project folder pa → (가짜) opener 1회, 인자 끝 = 그 프로젝트 등록 경로 · «열었습니다»",
      calls.length === 1 && calls[0]!.endsWith(A) && replies.join().includes(translate("proj.folder.opened")),
      { calls, replies },
    );
    // 무디스플레이 리눅스 — opener 를 부르기 전에 거절
    let fakeRuns = 0;
    const fakeRun = ((..._a: unknown[]) => { fakeRuns++; const ch = new EventEmitter(); return ch; }) as never;
    pc.__setFolderOpenerForTest((d) => openDirectory(d, "linux", {}, fakeRun));
    replies.length = 0;
    await dispatch("/project folder pa", tk);
    pc.__setFolderOpenerForTest(undefined);
    c.check("⑥ 무디스플레이(linux) → 안내(folderNoDisplay)·opener 0", fakeRuns === 0 && replies.join().includes(translate("srv.project.folderNoDisplay")), { fakeRuns, replies });
    replies.length = 0;
    await dispatch("/project folder /etc", tk);
    c.check("⑥ 연결 안 된 이름·경로 글자는 열지 않는다(연결 기록의 경로만)", !replies.join().includes(translate("proj.folder.opened")), replies);
  }

  // ── R1 ⑥ 확인 지문·중복 실행 ────────────────────────────────────────────
  sp.linkProject(tk, "pb");
  offers.length = 0;
  await dispatch("/project run pa guard", tk);
  const vA = offers[0]?.options.find((o) => o.value.includes("--yes="))?.value ?? "";
  offers.length = 0;
  replies.length = 0;
  await dispatch(vA.replace(" pa guard", " pb guard"), tk);
  const reasked = offers.length === 1 && !replies.some((r) => r.includes("▶"));
  // 확인창 뒤 같은 이름이 다른 파일로(사용자 공통 추가 → 플러그인 공통을 가린다)
  offers.length = 0;
  await dispatch("/project run pa ff", tk);
  const vF = offers[0]?.options.find((o) => o.value.includes("--yes="))?.value ?? "";
  const ffSourcePlugin = (offers[0]?.q ?? "").includes("pcc-plug");
  ucmd("ff", `---\nscope: projects\nconfirm: true\nrun: '${node} "${path.join(W, "where.js")}"'\n---\n`);
  offers.length = 0;
  replies.length = 0;
  await dispatch(vF, tk);
  const reaskedFile = offers.length === 1 && !replies.some((r) => r.includes("▶"));
  c.check(
    "★R1⑥ A 의 확인값을 B 로 바꾸면 다시 묻는다(지문에 프로젝트) · 확인창 뒤 같은 이름이 다른 파일로 풀리면 다시 묻는다(지문에 파일) · 플러그인 출처가 확인창에 보인다",
    vA !== "" && reasked && vF !== "" && reaskedFile && ffSourcePlugin,
    { vA, reasked, vF, reaskedFile, ffSourcePlugin },
  );
  replies.length = 0;
  await dispatch("/project run pa slow", tk);
  await dispatch("/project run pb slow", tk);
  await until(() => replies.filter((r) => r.startsWith("▶")).length >= 2, 5_000);
  await dispatch("/project run pa slow", tk);
  const started = replies.filter((r) => r.startsWith("▶")).length;
  const already = replies.filter((r) => r.includes(translate("srv.project.runAlready", { command: "slow", project: "pa" }))).length;
  const stopped = await pc.stopProjectRuns(tk);
  c.check("★R1⑥ A·B 공통 slow 동시 실행은 둘 다 시작 · 같은 A 두 번째는 «이미 실행 중»", started === 2 && already === 1 && stopped === 2, { started, already, stopped, replies });

  // ── ② 도구(register_command scope) · ⑦ list_commands · ⑧ 인벤토리 ──────
  type Tools = Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<{ content?: { text?: string }[]; isError?: boolean }>; inputSchema?: unknown }>;
  const tools = (createCommandToolsMcpServer() as unknown as { instance: { _registeredTools: Tools } }).instance._registeredTools;
  const call = async (a: Record<string, unknown>) => {
    const r = await tools["register_command"]!.handler(a, {});
    return { err: r.isError === true, text: (r.content ?? []).map((x) => x.text ?? "").join("") };
  };
  const fileOf = (n: string): string => readFileSync(path.join(userDir, `${n}.md`), "utf8");
  const inCommon = async (n: string) => names(await reg.discoverCommonProjectCommands()).includes(n);
  const inGlobal = async (n: string) => names(await reg.discoverCommands()).includes(n);
  const s1 = await call({ name: "sc1", prompt: "SC1", scope: "projects" });
  const s1File = fileOf("sc1");
  const s1c = await inCommon("sc1");
  const s2 = await call({ name: "sc1", prompt: "SC1 v2", scope: "global", overwrite: true });
  const s2File = fileOf("sc1");
  const s2g = (await inGlobal("sc1")) && !(await inCommon("sc1"));
  const s3 = await call({ name: "sc1", prompt: "SC1 v3", scope: "projects", overwrite: true });
  const s4 = await call({ name: "sc1", prompt: "SC1 v4", overwrite: true });
  const s4c = (await inCommon("sc1")) && fileOf("sc1").includes("scope: projects");
  const r1 = await call({ name: "sc2", run: "echo hi", scope: "projects" });
  const r2 = await call({ name: "sc2", run: "echo hi2", overwrite: true });
  const r2c = fileOf("sc2").includes("scope: projects") && fileOf("sc2").includes("echo hi2");
  const n1 = await call({ name: "sc3", prompt: "SC3" });
  const n1g = !fileOf("sc3").includes("scope") && (await inGlobal("sc3"));
  const both = await call({ name: "sc4", prompt: "x", scope: "projects", project: "pa" });
  const bothG = await call({ name: "sc4", prompt: "x", scope: "global", project: "pa" });
  const runNoScope = await call({ name: "sc5", run: "echo x" });
  const schema = tools["register_command"]!.inputSchema as { safeParse?: (v: unknown) => { success: boolean } } | undefined;
  const schemaRejects = schema?.safeParse !== undefined ? !schema.safeParse({ name: "x", prompt: "y", scope: "project" }).success : "unmeasured";
  c.check(
    "★R2② 범위 전환: projects→파일에 scope 줄 · global 덮어쓰기→줄 없음·전역 · 다시 projects · 생략 덮어쓰기=유지 · 공통 실행형 생략 덮어쓰기 거절 안 함 · 새 파일 생략=전역",
    !s1.err && s1File.includes("scope: projects") && s1c && !s2.err && !s2File.includes("scope") && s2g && !s3.err && !s4.err && s4c &&
      !r1.err && !r2.err && r2c && !n1.err && n1g,
    { s1, s2, s2File, s4, r1, r2, n1 },
  );
  c.check(
    "R2② scope+project 거절(두 값 다) · 범위 없는 실행형 거절 · 스키마 밖 값(scope: project) 거절",
    both.err && bothG.err && runNoScope.err && schemaRejects === true,
    { both: both.text, runNoScope: runNoScope.text, schemaRejects },
  );
  const list = await tools["list_commands"]!.handler({}, {});
  const listText = (list.content ?? []).map((x) => x.text ?? "").join("");
  const commonHead = listText.indexOf("모든 프로젝트 공통");
  c.check(
    "⑦ list_commands(무인자): 전역 목록 뒤 «모든 프로젝트 공통» 구획(공통 이름은 그 뒤에만, 플러그인은 출처)",
    commonHead > 0 && listText.includes("## 전역 명령 묶음") && listText.indexOf("/common1") > commonHead &&
      listText.includes("/pprompt") && listText.slice(commonHead).includes("🧩 pcc-plug"),
    listText.slice(0, 1500),
  );
  const managed = await reg.listCommandsIn(userDir);
  c.check(
    "⑦ 관리 원본 listCommandsIn 은 전역·공통 모두 보존(전역 출력에서만 분리) · 같은 홈의 범위별 동명도 둘 다 관리 가능",
    managed.some((x) => x.name === "common1" && x.scope === "projects") &&
      sameRootCases.filter((x) => x.source === "user").every((sample) => managed.filter((x) => x.name === sample.name).length === 2),
    managed.map((x) => ({ name: x.name, scope: x.scope })),
  );
  const inv = await collectInventory();
  const invCommon = inv.command.find((e) => e.name === "common1");
  c.check("⑧ 인벤토리: 공통 커맨드가 scope: projects 메타로 나온다", invCommon?.metadata?.scope === "projects", invCommon ?? inv.command.map((e) => e.name));
} catch (e) {
  c.check("자식 검사가 예외 없이 끝난다", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  console.warn = origWarn;
  await pc.stopProjectRuns(`dashboard:never`).catch(() => 0);
}
c.done();
