// 자식: **플러그인이 실어 오는 훅**(2026-11-03 설계 `2026-11-03-plugin-hooks-design.md` §9.1) — 자기 임시 홈에서 진짜 셸 훅을 돌린다.
// ★격리 필수: 훅은 임의 셸 명령이다. 러너 홈 아래 하위 홈을 만들고, 사용자의 진짜 훅·플러그인은 보지 않는다.
// ★판정은 반환값이 아니라 **부작용**(표식 파일)으로 본다 — `block:false` 는 «훅 없음» 과 «훅 통과» 가 같은 값이다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { childCollector } from "./_child-checks.js";
import { nodeCommand } from "./_shell-fixture.js";

assertIsolated();
process.env.TIGUCLAW_DISABLE_ENV_FILE = "1";
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "ph-"));
const HOME = process.env.TIGUCLAW_HOME;
const c = childCollector();

const work = path.join(HOME, "work");
const marks = path.join(HOME, "marks");
const plugins = path.join(HOME, "plugins");
mkdirSync(work, { recursive: true });
mkdirSync(marks, { recursive: true });
mkdirSync(plugins, { recursive: true });

// ── 콘솔 수집 — «[hook]» 로그의 횟수를 센다(1회 로그·비정상 종료 로그) ─────────────────────
const logs: string[] = [];
for (const k of ["error", "warn"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    orig(...a);
  };
}
const logCount = (re: RegExp): number => logs.filter((l) => re.test(l)).length;

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const mark = (n: string): string => path.join(marks, n);
const fired = (n: string): boolean => existsSync(mark(n));
const markData = (n: string): { argv: string[]; root: string | null; data: string | null; proj: string | null; cwd: string } =>
  JSON.parse(readFileSync(mark(n), "utf8"));
const clear = (...ns: string[]): void => {
  for (const n of ns) rmSync(mark(n), { force: true });
};
/** 실행되면 표식 파일에 argv·CLAUDE_* 환경·작업 폴더를 남기는 명령. `tail` 은 명령 뒤에 붙는 인자(치환 검사용). */
const markCmd = (n: string, extra = "", tail = ""): string =>
  nodeCommand(
    `require("fs").writeFileSync(${JSON.stringify(mark(n))}, JSON.stringify({argv:process.argv.slice(2),root:process.env.CLAUDE_PLUGIN_ROOT??null,data:process.env.CLAUDE_PLUGIN_DATA??null,proj:process.env.CLAUDE_PROJECT_DIR??null,cwd:process.cwd()}));${extra}`,
  ) + tail;
const blockCmd = (reason: string): string => nodeCommand(`console.error(${JSON.stringify(reason)});process.exitCode=2;`);
const cmd = (command: string, more: Record<string, unknown> = {}) => ({ type: "command", command, ...more });
/** 셸이 `${…}` 를 스스로 펼치지 못하게 감싼다 — 그래야 «우리 치환» 이 없을 때 빨개진다(환경변수가 같은 값을 주므로). */
const lit = (s: string): string => (process.platform === "win32" ? ` "${s}"` : ` '${s}'`);
const hooksJson = (dir: string, hooks: unknown, raw?: string): void =>
  write(path.join(dir, "hooks", "hooks.json"), raw ?? JSON.stringify({ hooks }, null, 2));
const manifest = (dir: string, name: string): void =>
  write(path.join(dir, "package.json"), JSON.stringify({ name, private: true, tiguclaw: { name } }));

// ── 홈 settings.json — 사용자 훅(먼저 돈다) + 세 층 공통 판정(비정상 항목)의 홈 사례 ─────────────
const MIXED_ITEMS = (p: string) => [
  cmd(markCmd(`${p}-ok1`)),
  null,
  { type: "command" },
  cmd(markCmd(`${p}-neg`), { timeout: -1 }),
  cmd(markCmd(`${p}-bad`), { timeout: "bad" }),
  cmd(markCmd(`${p}-big`), { timeout: 3_000_000 }),
  cmd(markCmd(`${p}-ok2`)),
];
const CONV_ITEMS = (p: string) => [
  cmd(markCmd(`${p}-c1`)),
  cmd(markCmd(`${p}-cobj`), { timeout: { toString: 0 } }),
  cmd(markCmd(`${p}-ctiny`), { timeout: 0.0001 }),
  cmd(markCmd(`${p}-c2`)),
];
const NUL_ITEMS = (p: string) => [cmd(markCmd(`${p}-n1`)), cmd("echo a\u0000b"), cmd(markCmd(`${p}-n2`))];
const homeSettings = path.join(HOME, "settings.json");
write(
  homeSettings,
  JSON.stringify(
    {
      hooks: {
        // 줄바꿈 없이 끝나는 출력 — 플러그인 출처 줄이 이 글에 붙지 않고 제 줄에서 시작해야 한다.
        UserPromptSubmit: [{ hooks: [cmd(markCmd("home-ups", 'process.stdout.write("HOME-CTX");'))] }],
        PreToolUse: [
          { matcher: "^HomeBlock$", hooks: [cmd(blockCmd("홈이 막음"))] },
          { matcher: "^Obs.*$", hooks: [cmd(markCmd("home-obs"))] },
          { matcher: "^ObsHome$", hooks: [cmd(blockCmd("홈이 막음"))] },
          { matcher: "^Mixed$", hooks: MIXED_ITEMS("h") },
          { matcher: "^Keep$", hooks: [cmd(markCmd("h-t0"), { timeout: 0 }), cmd(markCmd("h-t5"), { timeout: "5" }), cmd(markCmd("h-t15"), { timeout: 1.5 })] },
          { matcher: "^Conv$", hooks: CONV_ITEMS("h") },
          { matcher: "^Nul$", hooks: NUL_ITEMS("h") },
        ],
      },
    },
    null,
    2,
  ),
);

// ── 믿는 프로젝트 ─────────────────────────────────────────────────────────────────
const proj = path.join(HOME, "proj");
write(
  path.join(proj, ".tiguclaw", "settings.json"),
  JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^PMixed$", hooks: MIXED_ITEMS("p") }, { matcher: "^PConv$", hooks: CONV_ITEMS("p") }] } }),
);

// ── 플러그인들 ───────────────────────────────────────────────────────────────────
// 기본 플러그인: 폴더 `a-n` · 매니페스트 이름 `n` — ROOT(폴더 실경로)와 DATA(`<home>/plugins/n`)가 갈리는 배치(§9.1-2).
const N = path.join(plugins, "a-n");
manifest(N, "n");
const nHooks = (upsText: string) => ({
  UserPromptSubmit: [{ hooks: [cmd(markCmd("n-ups", `console.log(${JSON.stringify(upsText)});`))] }],
  Stop: [{ hooks: [cmd(markCmd("n-stop", 'console.log("STOP-PLUGIN");'))] }],
  StopFailure: [{ hooks: [cmd(markCmd("n-stopfail"))] }],
  PreToolUse: [
    { matcher: "^Bash$", hooks: [cmd(markCmd("n-pre-bash", "", lit("${CLAUDE_PLUGIN_ROOT}") + lit("${CLAUDE_PROJECT_DIR}")))] },
    { matcher: "^Danger$", hooks: [cmd(blockCmd("플러그인이 막음"))] },
    { matcher: "^HomeBlock$", hooks: [cmd(markCmd("n-pre-homeblock"))] },
  ],
  PostToolUse: [{ hooks: [cmd(markCmd("n-post"))] }],
  SubagentStop: [{ hooks: [cmd(markCmd("n-subagent"))] }],
  SessionStart: [{ hooks: [cmd(markCmd("n-session"))] }],
});
const N_RUNNABLE = 8;
hooksJson(N, nHooks("플러그인-맥락-표식"));

const H = await import("../../core/entry/hook-runner.js");
const PH = await import("../../core/plugins/plugin-hooks.js");
const { appRoot, getPaths, pluginDataDir } = await import("../../core/paths.js");
const appRootPlugins = path.join(appRoot(), "plugins");
const { translate } = await import("../../core/i18n.js");
const { initStore } = await import("../../store/sessions.js");
const { upsertProject } = await import("../../store/projects.js");
const { setModuleDisabled } = await import("../../core/settings.js");
initStore();
upsertProject({ path: proj, name: "regr-plugin-hooks-proj", status: "active", description: null });

const base = { cwd: work, channel: "regr", threadKey: "regr:plugin-hooks" };
const pre = (toolName: string, cwd = work) => H.runPreToolUseHooks({ toolName, toolInput: {}, ...base, cwd });
const ups = () => H.runUserPromptSubmitHooks({ prompt: "안녕", ...base });
const sourceLine = (name: string): string => translate("srv.hook.pluginOutput", { plugin: name });
const real = (p: string): string => realpathSync(p);

// ── 1·2 설치로 신뢰 · 여섯 이벤트 · 치환 · 환경변수 · 작업 폴더 ─────────────────────────
{
  const settingsBefore = readFileSync(homeSettings, "utf8");
  const u = await ups();
  await H.runStopHooks({ response: "답", ...base });
  const stopR = await H.runStopHooks({ response: "답", ...base });
  await H.runStopFailureHooks({ error: "boom", ...base });
  const bash = await pre("Bash");
  const danger = await pre("Danger");
  await H.runPostToolUseHooks({ toolName: "mcp__file-ops__Bash", toolInput: {}, toolResponse: "ok", ...base });
  await H.runSubagentStopHooks({ jobId: "j", threadKey: base.threadKey, cwd: work, channel: "regr", status: "done", summary: "s" });
  const six = ["n-ups", "n-stop", "n-stopfail", "n-pre-bash", "n-post", "n-subagent"];
  c.check("1 ★승인 기록 없이 설치만으로 플러그인 훅이 여섯 이벤트 전부에서 돈다", six.every(fired), Object.fromEntries(six.map((n) => [n, fired(n)])));
  c.check("1 우리가 내지 않는 이벤트(SessionStart)는 돌지 않는다", !fired("n-session"), fired("n-session"));
  c.check(
    "1 ★맥락 = 홈 출력 → 제 줄의 출처 줄 «[🧩 n 훅]» → 플러그인 출력(UserPromptSubmit)",
    u.additionalContext === `HOME-CTX\n${sourceLine("n")}\n플러그인-맥락-표식`,
    u.additionalContext,
  );
  c.check("1 Stop 출력에도 출처 줄이 붙는다", stopR.additionalContext === `${sourceLine("n")}\nSTOP-PLUGIN`, stopR.additionalContext);
  c.check(
    "1 ★플러그인 PreToolUse 의 exit 2 가 도구를 막는다(사유가 모델 문장에 실린다)",
    danger.block === true && H.formatToolBlock("Danger", danger.blockReason).includes("플러그인이 막음"),
    danger,
  );
  c.check("1 막지 않은 도구는 막지 않는다", bash.block === false, bash);
  const d = fired("n-pre-bash") ? markData("n-pre-bash") : undefined;
  c.check(
    "1 ★명령 안 `${CLAUDE_PLUGIN_ROOT}`·`${CLAUDE_PROJECT_DIR}` 를 우리가 글자 그대로 치환한다(셸이 못 펼치게 감싼 인자)",
    d !== undefined && d.argv[0] === real(N) && d.argv[1] === work,
    d?.argv,
  );
  c.check("1 작업 폴더 = 넘긴 cwd", d !== undefined && real(d.cwd) === real(work), d?.cwd);
  c.check(
    "2 ★환경변수: ROOT = 폴더 실경로 · DATA = pluginDataDir(매니페스트 이름) ≠ ROOT · PROJECT_DIR = cwd",
    d !== undefined && d.root === real(N) && d.data === pluginDataDir("n") && d.data === path.join(getPaths().commonPlugins, "n") && d.data !== d.root && d.proj === work,
    d && { root: d.root, data: d.data, proj: d.proj },
  );
  c.check("2 데이터 폴더를 만들지 않는다", !existsSync(path.join(plugins, "n")), existsSync(path.join(plugins, "n")));
  c.check("1 홈 settings.json 은 호출 전후 바이트가 같다(승인 기록을 쓰지 않는다)", readFileSync(homeSettings, "utf8") === settingsBefore, "");
  c.check("1 홈 훅에는 CLAUDE_* 를 내보내지 않는다(종전 그대로)", fired("home-ups") && markData("home-ups").root === null && markData("home-ups").proj === null, fired("home-ups") && markData("home-ups"));
}

// ── 3 내용 변경은 다음 호출부터 ────────────────────────────────────────────────────────
{
  hooksJson(N, nHooks("바뀐-문구"));
  const u = await ups();
  c.check("3 ★hooks.json 을 고치면 다음 호출 맥락이 새 문구다(캐시 없음)", u.additionalContext.endsWith(`${sourceLine("n")}\n바뀐-문구`), u.additionalContext);
  hooksJson(N, nHooks("플러그인-맥락-표식"));
}

// ── 4 순서 — 사용자 훅이 먼저 막으면 플러그인 훅은 돌지 않는다 ──────────────────────────
{
  clear("n-pre-homeblock");
  const r = await pre("HomeBlock");
  c.check("4 ★홈 PreToolUse 가 exit 2 면 플러그인 PreToolUse 는 돌지 않는다", r.block === true && !fired("n-pre-homeblock"), { block: r.block, plugin: fired("n-pre-homeblock") });
}

// ── 6 같은 이름 — 홈 안 두 폴더 ──────────────────────────────────────────────────────
{
  const XA = path.join(plugins, "x-a");
  const XB = path.join(plugins, "x-b");
  manifest(XA, "x");
  manifest(XB, "x");
  hooksJson(XA, { PreToolUse: [{ matcher: "^Xtool$", hooks: [cmd(markCmd("xa"))] }] });
  hooksJson(XB, { PreToolUse: [{ matcher: "^Xtool$", hooks: [cmd(markCmd("xb"))] }] });
  await pre("Xtool");
  const inv = await H.listHooksForInventory(work);
  const xb = inv.filter((h) => h.scope === "plugin" && h.source === path.join(XB, "hooks", "hooks.json"));
  c.check("6 ★매니페스트 이름이 같은 두 폴더 — 앞 폴더만 돈다", fired("xa") && !fired("xb"), { xa: fired("xa"), xb: fired("xb") });
  c.check("6 뒤 폴더는 인벤토리에 «가려짐(앞 폴더)» 한 줄", xb.length === 1 && xb[0]?.status === "shadowed" && xb[0]?.shadowedBy === XA, xb);
  rmSync(XA, { recursive: true, force: true });
  rmSync(XB, { recursive: true, force: true });
}

// ── 7 같은 이름 — 번들/홈(주입 뿌리 · 기본 뿌리 배선) ─────────────────────────────────
{
  const fakeBundle = mkdtempSync(path.join(HOME, "bundle-"));
  const fakeHome = mkdtempSync(path.join(HOME, "homeroot-"));
  mkdirSync(path.join(fakeBundle, "y", "skills"), { recursive: true }); // 훅 파일 없음
  hooksJson(path.join(fakeHome, "y"), { PreToolUse: [{ matcher: "^Y$", hooks: [cmd(markCmd("y-home"))] }] });
  const s1 = await PH.pluginHookSources([fakeBundle, fakeHome]);
  c.check(
    "7 ★훅 파일 없는 번들 y 가 이름을 차지 — 홈 y 는 «가려짐(번들 y)» 이고 출처가 아니다",
    s1.length === 1 && s1[0]?.status === "shadowed" && s1[0]?.shadowedBy === path.join(fakeBundle, "y"),
    s1.map((s) => ({ p: s.plugin, st: s.status, by: s.shadowedBy })),
  );
  // 홈 쪽이 매니페스트로 같은 이름을 선언해도 — 데이터 폴더 예외는 홈 데이터 폴더 자리에만 걸린다(번들 쪽 폴더는 이름을 내주지 않는다).
  manifest(path.join(fakeHome, "y-real"), "y");
  hooksJson(path.join(fakeHome, "y-real"), { PreToolUse: [{ matcher: "^Y$", hooks: [cmd(markCmd("y-real"))] }] });
  const s1b = await PH.pluginHookSources([fakeBundle, fakeHome]);
  c.check(
    "7 매니페스트 있는 홈 폴더도 번들 쪽 같은 이름을 넘지 못한다(전부 «가려짐(번들 y)»)",
    s1b.length === 2 && s1b.every((s) => s.status === "shadowed" && s.shadowedBy === path.join(fakeBundle, "y")),
    s1b.map((s) => ({ d: path.basename(s.dir), st: s.status, by: s.shadowedBy })),
  );
  rmSync(path.join(fakeHome, "y-real"), { recursive: true, force: true });
  hooksJson(path.join(fakeBundle, "y"), { PreToolUse: [{ matcher: "^Y$", hooks: [cmd(markCmd("y-bundle"))] }] });
  const s2 = await PH.pluginHookSources([fakeBundle, fakeHome]);
  c.check(
    "7 번들 쪽에 훅 파일이 있으면 번들 것만 출처(loaded), 홈은 가려짐",
    s2.length === 2 && s2[0]?.status === "loaded" && s2[0]?.dir === path.join(fakeBundle, "y") && s2[1]?.status === "shadowed",
    s2.map((s) => ({ d: s.dir, st: s.status })),
  );
  // 기본 뿌리 배선 — 홈에 기본 켜짐 번들 이름(scheduler — 번들엔 훅 파일 없음)의 폴더 + hooks.json.
  const SCHED = path.join(plugins, "scheduler");
  hooksJson(SCHED, { PreToolUse: [{ matcher: "^Sched$", hooks: [cmd(markCmd("sched-home"))] }] });
  await pre("Sched");
  const inv = await H.listHooksForInventory(work);
  const row = inv.find((h) => h.scope === "plugin" && h.plugin === "scheduler");
  c.check(
    "7 ★기본 뿌리는 번들을 먼저 걷는다 — 홈의 번들 이름 폴더 훅은 돌지 않고 «가려짐»(꺼져서 0 과 구분)",
    !fired("sched-home") && row?.status === "shadowed",
    { fired: fired("sched-home"), row },
  );
  rmSync(SCHED, { recursive: true, force: true });
  // ★홈 폴더가 **매니페스트로** 번들 이름을 쓰는 경우 — 데이터 폴더 예외와 무관하게 번들이 먼저다(출처 표시 위조 방지).
  const FAKE = path.join(plugins, "a-fake-sched");
  manifest(FAKE, "scheduler");
  hooksJson(FAKE, { PreToolUse: [{ matcher: "^Sched$", hooks: [cmd(markCmd("sched-fake"))] }] });
  await pre("Sched");
  const fakeRow = (await H.listHooksForInventory(work)).find((h) => h.source === path.join(FAKE, "hooks", "hooks.json"));
  c.check(
    "7 ★번들 이름을 매니페스트로 쓴 홈 플러그인의 훅은 돌지 않고 «가려짐(번들 scheduler)»",
    !fired("sched-fake") && fakeRow?.status === "shadowed" && fakeRow?.shadowedBy === path.join(appRootPlugins, "scheduler"),
    { fired: fired("sched-fake"), fakeRow },
  );
  rmSync(FAKE, { recursive: true, force: true });
  // ★실제 설치에 늘 있는 모양 — 번들 이름의 홈 **데이터 폴더**(훅 파일 없음)는 아무것도 내지 않는다(행 0 · 로그 0).
  write(path.join(SCHED, "settings.json"), "{}");
  const logsBefore = logs.length;
  const inv2 = await H.listHooksForInventory(work);
  c.check(
    "7 ★번들 이름의 홈 데이터 폴더(훅 파일 없음)는 «가려짐» 행도 새 로그도 내지 않는다",
    !inv2.some((h) => h.plugin === "scheduler") && logs.length === logsBefore,
    { rows: inv2.filter((h) => h.plugin === "scheduler"), newLogs: logs.slice(logsBefore) },
  );
  rmSync(SCHED, { recursive: true, force: true });
}

// ── 7b 폴더 이름 ≠ 매니페스트 이름인 플러그인 — 자기 데이터 폴더가 생겨도 자기 훅이 돈다 ───────────────
{
  const ZQ = path.join(plugins, "z-q");
  manifest(ZQ, "q");
  hooksJson(ZQ, { PreToolUse: [{ matcher: "^Qtool$", hooks: [cmd(markCmd("zq"))] }] });
  await pre("Qtool");
  const before = fired("zq");
  // 설정 저장·`dataDir` 쓰기가 만드는 폴더 — `<home>/plugins/q`(매니페스트 없음, 이름순으로 `z-q` 보다 앞).
  write(path.join(pluginDataDir("q"), "settings.json"), "{}");
  clear("zq");
  await pre("Qtool");
  const srcs = (await PH.pluginHookSources()).filter((s) => s.plugin === "q");
  c.check(
    "7b ★자기 데이터 폴더(`<home>/plugins/q`)가 생겨도 플러그인 z-q 의 훅이 그대로 돈다(데이터 폴더가 이름을 차지하지 않는다)",
    before && fired("zq") && srcs.length === 1 && srcs[0]?.status === "loaded" && srcs[0]?.dir === ZQ,
    { before, after: fired("zq"), srcs: srcs.map((s) => ({ d: s.dir, st: s.status })) },
  );
  hooksJson(pluginDataDir("q"), { PreToolUse: [{ matcher: "^Qtool$", hooks: [cmd(markCmd("q-data"))] }] });
  clear("zq");
  await pre("Qtool");
  const srcs2 = (await PH.pluginHookSources()).filter((s) => s.plugin === "q");
  c.check(
    "7b 데이터 폴더에 훅 파일이 있으면 그쪽이 «가려짐(z-q)» — 매니페스트 있는 폴더만 돈다",
    fired("zq") && !fired("q-data") && srcs2.some((s) => s.dir === pluginDataDir("q") && s.status === "shadowed" && s.shadowedBy === ZQ),
    srcs2.map((s) => ({ d: s.dir, st: s.status, by: s.shadowedBy })),
  );
  rmSync(ZQ, { recursive: true, force: true });
  rmSync(pluginDataDir("q"), { recursive: true, force: true });
  // 예외는 **매니페스트 없는** 데이터 폴더에만 — 그 자리에 매니페스트 이름이 같은 진짜 플러그인(`q`)이 있으면 그쪽이 이름을 지킨다.
  manifest(pluginDataDir("q"), "q");
  hooksJson(pluginDataDir("q"), { PreToolUse: [{ matcher: "^Qtool$", hooks: [cmd(markCmd("q-real"))] }] });
  manifest(ZQ, "q");
  hooksJson(ZQ, { PreToolUse: [{ matcher: "^Qtool$", hooks: [cmd(markCmd("zq"))] }] });
  clear("zq", "q-real");
  await pre("Qtool");
  c.check(
    "7b 이름이 정확히 같은 매니페스트 폴더(`q`)는 데이터 폴더 예외에 들지 않는다 — 앞 폴더 `q` 만 돈다",
    fired("q-real") && !fired("zq"),
    { q: fired("q-real"), zq: fired("zq") },
  );
  rmSync(ZQ, { recursive: true, force: true });
  rmSync(pluginDataDir("q"), { recursive: true, force: true });
}

// ── 8·9·10 파일 없음 · 이름 규칙 · 깨진 파일 ─────────────────────────────────────────
{
  mkdirSync(path.join(plugins, "skillonly", "skills", "s"), { recursive: true });
  mkdirSync(path.join(plugins, "Bad_NoHooks", "skills"), { recursive: true });
  mkdirSync(path.join(plugins, "dirhooks", "hooks", "hooks.json"), { recursive: true });
  hooksJson(path.join(plugins, "Bad]Name"), { UserPromptSubmit: [{ hooks: [cmd(markCmd("badname"))] }] });
  hooksJson(path.join(plugins, "unwrapped"), undefined, JSON.stringify({ UserPromptSubmit: [{ hooks: [cmd(markCmd("unwrapped"))] }] }));
  hooksJson(path.join(plugins, "brokenjson"), undefined, "{ not json");
  clear("home-ups", "n-ups");
  const u = await ups();
  const inv = await H.listHooksForInventory(work);
  const rowsOf = (p: string) => inv.filter((h) => h.scope === "plugin" && h.plugin === p);
  c.check(
    "8 ★훅 파일 없는 플러그인(스킬만·이름 규칙 밖)은 인벤토리 행 0 · 로그 0",
    rowsOf("skillonly").length === 0 && rowsOf("Bad_NoHooks").length === 0 && logCount(/skillonly|Bad_NoHooks/) === 0,
    { skillonly: rowsOf("skillonly"), bad: rowsOf("Bad_NoHooks"), logs: logCount(/skillonly|Bad_NoHooks/) },
  );
  c.check("8 hooks.json 이 디렉터리면 «읽을 수 없음»(ENOENT 가 아닌 읽기 오류)", rowsOf("dirhooks").length === 1 && rowsOf("dirhooks")[0]?.status === "invalid" && rowsOf("dirhooks")[0]?.reason === "unreadable", rowsOf("dirhooks"));
  c.check("9 ★이름이 규칙 밖인 폴더의 훅은 돌지 않고 «이름이 맞지 않음»", !fired("badname") && rowsOf("Bad]Name")[0]?.status === "invalid" && rowsOf("Bad]Name")[0]?.reason === "bad-name", { fired: fired("badname"), row: rowsOf("Bad]Name") });
  c.check(
    "10 감싸지 않은 파일·JSON 오류는 «형식 오류» · 실행 0",
    !fired("unwrapped") && rowsOf("unwrapped")[0]?.reason === "bad-format" && rowsOf("brokenjson")[0]?.reason === "bad-format",
    { unwrapped: rowsOf("unwrapped"), broken: rowsOf("brokenjson") },
  );
  c.check("10 깨진 플러그인 파일이 있어도 홈·플러그인 n 훅은 그대로 돈다", fired("home-ups") && fired("n-ups") && u.block === false, { home: fired("home-ups"), n: fired("n-ups") });
  await PH.pluginHookSources();
  c.check("로그: 읽지 않는 플러그인 훅은 (플러그인, 사유)당 프로세스에 한 번", logCount(/플러그인 Bad\]Name 훅을 읽지 않습니다/) === 1, logCount(/플러그인 Bad\]Name 훅을 읽지 않습니다/));
  for (const d of ["skillonly", "Bad_NoHooks", "dirhooks", "Bad]Name", "unwrapped", "brokenjson"]) rmSync(path.join(plugins, d), { recursive: true, force: true });
}

// ── 11·14·18 비정상 항목 — 세 층(홈·믿는 프로젝트·플러그인) 같은 판정 ─────────────────────
hooksJson(path.join(plugins, "mixed"), { PreToolUse: [{ matcher: "^Mixed$", hooks: [...MIXED_ITEMS("m").slice(0, 3), cmd(markCmd("m-args"), { args: ["x"] }), { type: "http", url: "http://127.0.0.1:9" }, ...MIXED_ITEMS("m").slice(3)] }] });
hooksJson(path.join(plugins, "conv"), { PreToolUse: [{ matcher: "^Conv$", hooks: CONV_ITEMS("v") }] });
hooksJson(path.join(plugins, "nul"), { PreToolUse: [{ matcher: "^Nul$", hooks: NUL_ITEMS("u") }] });
{
  const bad = (p: string) => [`${p}-neg`, `${p}-bad`, `${p}-big`];
  const run = async (tool: string, cwd = work): Promise<{ ok: boolean; err?: string }> => {
    try {
      await pre(tool, cwd);
      return { ok: true };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  };
  const r1 = await run("Mixed");
  c.check("11 ★홈 층: null·command 없음·잘못된 timeout 이 있어도 reject 0 · 뒤 정상 훅까지 돈다", r1.ok && fired("h-ok1") && fired("h-ok2"), { r1, ok1: fired("h-ok1"), ok2: fired("h-ok2") });
  c.check("11 홈 층: 잘못된 timeout 항목은 돌지 않는다(즉시 강제 종료 포함)", bad("h").every((n) => !fired(n)), bad("h").map(fired));
  c.check("11 플러그인 층: 정상 항목만 돈다(args·http·잘못된 timeout 0)", fired("m-ok1") && fired("m-ok2") && !fired("m-args") && bad("m").every((n) => !fired(n)), { ok1: fired("m-ok1"), ok2: fired("m-ok2"), args: fired("m-args") });
  const r2 = await run("PMixed", proj);
  c.check("11 ★믿는 프로젝트 층도 같다", r2.ok && fired("p-ok1") && fired("p-ok2") && bad("p").every((n) => !fired(n)), { r2, ok1: fired("p-ok1"), ok2: fired("p-ok2") });
  const r3 = await run("Keep");
  c.check("11 ★보존 값: timeout 0·\"5\"·1.5 는 종전처럼 돈다", r3.ok && fired("h-t0") && fired("h-t5") && fired("h-t15"), { r3, t0: fired("h-t0"), t5: fired("h-t5"), t15: fired("h-t15") });
  const before = logCount(/비정상 종료 \(code -1\)/);
  const r4 = await run("Conv");
  const r5 = await run("PConv", proj);
  const convOk = (p: string) => fired(`${p}-c1`) && fired(`${p}-c2`) && !fired(`${p}-cobj`) && !fired(`${p}-ctiny`);
  c.check(
    "11 ★변환이 던지는 timeout({toString:0})·정수 아닌 ms(0.0001) — 세 층 모두 reject 0 · 뒤 정상 훅 돈다",
    r4.ok && r5.ok && convOk("h") && convOk("v") && convOk("p"),
    { r4, r5, h: convOk("h"), v: convOk("v"), p: convOk("p") },
  );
  c.check("11 그 항목들은 판정에서 걸러져 실행 경계까지 가지 않는다(«비정상 종료(code -1)» 로그 0)", logCount(/비정상 종료 \(code -1\)/) === before, logCount(/비정상 종료 \(code -1\)/) - before);
  const nulBefore = logCount(/비정상 종료 \(code -1\)/);
  const r6 = await run("Nul");
  c.check(
    "18 ★명령 안 NUL(spawn 동기 예외) — 홈·플러그인 층 reject 0 · 두 정상 훅 돈다 · «비정상 종료(code -1)» 로그 층마다 1",
    r6.ok && fired("h-n1") && fired("h-n2") && fired("u-n1") && fired("u-n2") && logCount(/비정상 종료 \(code -1\)/) - nulBefore === 2,
    { r6, h: [fired("h-n1"), fired("h-n2")], u: [fired("u-n1"), fired("u-n2")], logs: logCount(/비정상 종료 \(code -1\)/) - nulBefore },
  );
  const inv = await H.listHooksForInventory(work);
  const st = (p: string) => inv.filter((h) => h.plugin === p).map((h) => h.status);
  const count = (p: string, s: string) => st(p).filter((x) => x === s).length;
  c.check(
    "11 인벤토리(플러그인 mixed): malformed 5 · unsupported 2(args·http) · runnable 2",
    count("mixed", "malformed") === 5 && count("mixed", "unsupported") === 2 && count("mixed", "runnable") === 2,
    st("mixed"),
  );
  c.check("11 인벤토리(플러그인 conv): malformed 2 · runnable 2", count("conv", "malformed") === 2 && count("conv", "runnable") === 2, st("conv"));
  c.check("18 NUL 항목은 필드 판정 밖이라 runnable 로 보인다(실행 경계가 닫는다)", count("nul", "runnable") === 3, st("nul"));
  c.check(
    "14 args 항목(exec 형식)은 실행 0 · «지원 안 함»",
    !fired("m-args") && inv.some((h) => h.plugin === "mixed" && h.status === "unsupported" && h.command !== ""),
    inv.filter((h) => h.plugin === "mixed" && h.status === "unsupported"),
  );
}

// ── 11b 깨진 이벤트 값·매처 묶음 — 그 줄만 malformed, 다른 플러그인·홈 훅은 돈다 ─────────────────────
{
  hooksJson(path.join(plugins, "badgroups"), {
    PreToolUse: 5,
    PostToolUse: [null, { matcher: 7, hooks: [cmd(markCmd("bg-m7"))] }, { hooks: "x" }, { matcher: "^BG$", hooks: [cmd(markCmd("bg-ok"))] }],
  });
  clear("n-post", "n-pre-bash");
  let rej: string | undefined;
  try {
    await H.runHooks("PostToolUse", { tool_name: "BG", ...base }, work, "BG");
    await H.runHooks("PreToolUse", { tool_name: "Bash", ...base }, work, "Bash");
  } catch (e) {
    rej = String(e);
  }
  c.check(
    "11b ★숫자 매처·배열 아닌 이벤트 값·깨진 묶음이 있어도 runHooks reject 0 · 그 플러그인의 정상 묶음과 다른 플러그인(n) 훅이 돈다",
    rej === undefined && fired("bg-ok") && !fired("bg-m7") && fired("n-post") && fired("n-pre-bash"),
    { rej, ok: fired("bg-ok"), m7: fired("bg-m7"), nPost: fired("n-post"), nPre: fired("n-pre-bash") },
  );
  const inv = await H.listHooksForInventory(work);
  const st = inv.filter((h) => h.plugin === "badgroups").map((h) => `${h.event}:${h.status}`);
  c.check(
    "11b 인벤토리: 이벤트 값 1 + 묶음 3 이 malformed 한 줄씩 · 정상 1 이 runnable",
    st.filter((x) => x.endsWith(":malformed")).length === 4 && st.filter((x) => x.endsWith(":runnable")).length === 1 && st.includes("PreToolUse:malformed"),
    st,
  );
  rmSync(path.join(plugins, "badgroups"), { recursive: true, force: true });
}

// ── 12 세는 기준 일치 — 실행 수 = 인벤토리 runnable = /status N ─────────────────────────
const { handleStatus, handlePlugins } = await import("../../core/entry/slash-commands.js");
const slash = async (fn: typeof handleStatus): Promise<string> => {
  const got: string[] = [];
  await fn({ msg: { channel: "cli", threadKey: "cli:regr", text: "", reply: async (t: string) => { got.push(t); } } as never, args: "", trimmed: "", sidChannel: "cli" as never });
  return got.join("\n");
};
{
  hooksJson(path.join(plugins, "only-ne"), { SessionStart: [{ hooks: [cmd(markCmd("ne"))] }] });
  hooksJson(path.join(plugins, "only-unsup"), { PreToolUse: [{ hooks: [{ type: "http", url: "http://127.0.0.1:9" }] }] });
  hooksJson(path.join(plugins, "empty"), {});
  // 매처가 다 맞게 부른 경우의 실제 실행 수(mixed: 위 «Mixed» 호출에서 m-ok1·m-ok2).
  const ran: Record<string, number> = { "only-ne": Number(fired("ne")), "only-unsup": 0, mixed: Number(fired("m-ok1")) + Number(fired("m-ok2")), empty: 0 };
  await pre("Anything");
  ran["only-ne"] = Number(fired("ne"));
  const inv = await H.listHooksForInventory(work);
  const status = await slash(handleStatus);
  const nOf = (p: string): number => {
    const m = new RegExp(`(?:^|[ ,])${p}\\((\\d+)\\)`).exec(status.split("\n").find((l) => l.startsWith(translate("srv.status.pluginHooks", { list: "" }))) ?? "");
    return m ? Number(m[1]) : 0;
  };
  const rows = (p: string) => inv.filter((h) => h.plugin === p && h.status === "runnable").length;
  const table = ["only-ne", "only-unsup", "mixed", "empty"].map((p) => ({ p, ran: ran[p], inv: rows(p), status: nOf(p) }));
  c.check(
    "12 ★플러그인마다 실제 실행 수 = 인벤토리 runnable 행 = /status N (0·0·2·0)",
    table.every((t) => t.ran === t.inv && t.inv === t.status) && table.map((t) => t.inv).join() === "0,0,2,0",
    table,
  );
  c.check("12 «빈 맵» 파일은 행이 없다", inv.filter((h) => h.plugin === "empty").length === 0, inv.filter((h) => h.plugin === "empty"));
  c.check("16 /status 에 «플러그인 훅» 한 줄 — n 은 runnable 수", nOf("n") === N_RUNNABLE, status);
  c.check("16 runnable 0 인 플러그인은 /status 목록에 없다", !/only-ne\(|only-unsup\(|empty\(/.test(status), status);
  for (const d of ["only-ne", "only-unsup", "empty"]) rmSync(path.join(plugins, d), { recursive: true, force: true });
}

// ── 13 관측 이벤트 — 호출당 한 건 · plugin 은 차단 주체가 플러그인일 때만 ─────────────────
{
  hooksJson(path.join(plugins, "oa"), { PreToolUse: [{ matcher: "^Obs.*$", hooks: [cmd(markCmd("oa"))] }] });
  hooksJson(path.join(plugins, "ob"), { PreToolUse: [{ matcher: "^Obs(Pass|Home)$", hooks: [cmd(markCmd("ob"))] }, { matcher: "^ObsB$", hooks: [cmd(blockCmd("B가 막음"))] }] });
  const events: Array<{ blocked: boolean; plugin?: string }> = [];
  H.setHookObserver((ev) => events.push(ev));
  const take = async (tool: string) => {
    events.length = 0;
    clear("oa", "ob", "home-obs");
    await pre(tool);
    return [...events];
  };
  const pass = await take("ObsPass");
  c.check("13 홈·oa·ob 모두 통과 → 이벤트 1건 · blocked:false · plugin 없음", pass.length === 1 && pass[0]?.blocked === false && !("plugin" in (pass[0] ?? {})) && fired("oa") && fired("ob") && fired("home-obs"), pass);
  const b = await take("ObsB");
  c.check("13 ★ob 가 막음 → 이벤트 1건 · blocked:true · plugin:\"ob\"", b.length === 1 && b[0]?.blocked === true && b[0]?.plugin === "ob", b);
  const home = await take("ObsHome");
  c.check("13 홈이 막음 → 이벤트 1건 · plugin 없음 · oa·ob 표식 0", home.length === 1 && home[0]?.blocked === true && home[0]?.plugin === undefined && !fired("oa") && !fired("ob"), { home, oa: fired("oa"), ob: fired("ob") });
  H.setHookObserver(null);
  for (const d of ["oa", "ob"]) rmSync(path.join(plugins, d), { recursive: true, force: true });
}

// ── 15·16 인벤토리 · /plugins · /status ──────────────────────────────────────────────
{
  const inv = await H.listHooksForInventory(work);
  const n = inv.filter((h) => h.plugin === "n");
  c.check(
    "15 인벤토리에 scope:plugin·plugin·status 항목 — 안 나는 이벤트도 «not-emitted» 로 보인다",
    n.length === N_RUNNABLE + 1 && n.every((h) => h.scope === "plugin" && h.source === path.join(N, "hooks", "hooks.json")) && n.filter((h) => h.status === "runnable").length === N_RUNNABLE && n.some((h) => h.event === "SessionStart" && h.status === "not-emitted"),
    n.map((h) => `${h.event}:${h.status}`),
  );
  const homeRows = inv.filter((h) => h.scope !== "plugin");
  c.check(
    "15 홈·프로젝트 줄은 종전 그대로 — status·plugin 없음 · command 형식만",
    homeRows.length > 0 && homeRows.every((h) => h.status === undefined && h.plugin === undefined && typeof h.command === "string"),
    homeRows.length,
  );
  const { collectInventory } = await import("../../core/plugins/inventory.js");
  const ci = await collectInventory();
  const nEntries = ci.hook.filter((e) => (e.metadata as { plugin?: string }).plugin === "n");
  c.check(
    "15 대시보드 인벤토리: 이름에 «🧩 n» 과 상태 · 켜짐 점 = runnable 만",
    nEntries.length === N_RUNNABLE + 1 && nEntries.every((e) => e.name.includes("🧩 n") && e.enabled === ((e.metadata as { status?: string }).status === "runnable")),
    nEntries.map((e) => [e.name, e.enabled]),
  );
  const plug = await slash(handlePlugins);
  c.check("15 /plugins 에 플러그인 훅 줄이 보인다", plug.split("\n").some((l) => l.startsWith(`${translate("srv.plugins.pluginHooks")} (`) && l.includes("🧩 n")), plug);
}

// ── 5 끄기·켜기·제거 — 다음 호출부터 ─────────────────────────────────────────────────
{
  setModuleDisabled("n", true);
  clear("n-ups");
  const off = await ups();
  const offStatus = await slash(handleStatus);
  c.check("5 ★끄면 다음 호출부터 돌지 않는다(표식 0 · 출처 줄 0 · /status 에 n 없음)", !fired("n-ups") && !off.additionalContext.includes(sourceLine("n")) && !/(?:^|[ ,])n\(\d+\)/.test(offStatus), { fired: fired("n-ups"), ctx: off.additionalContext });
  setModuleDisabled("n", false);
  await ups();
  c.check("5 다시 켜면 다음 호출부터 돈다", fired("n-ups"), fired("n-ups"));
  // 남은 플러그인 훅(mixed·conv·nul)과 n 을 치우기 전 /status·/plugins 를 받아 두고, 전부 치운 뒤와 비교한다.
  const withLines = (await slash(handleStatus)).split("\n");
  rmSync(N, { recursive: true, force: true });
  clear("n-ups");
  await ups();
  c.check("5 ★폴더를 지우면 다음 호출부터 돌지 않는다", !fired("n-ups"), fired("n-ups"));
  renameSync(plugins, `${plugins}.off`);
  const none = (await slash(handleStatus)).split("\n");
  const plugNone = await slash(handlePlugins);
  const label = translate("srv.status.pluginHooks", { list: "" });
  const uptime = translate("srv.status.uptime", { uptime: "" });
  const strip = (ls: string[]) => ls.filter((l) => !l.startsWith(label) && !l.startsWith(uptime));
  c.check("16 ★플러그인 훅이 없으면 /status 에 그 줄이 없다", !none.some((l) => l.startsWith(label)), none);
  c.check("16 나머지 /status 줄은 그대로다", JSON.stringify(strip(withLines)) === JSON.stringify(strip(none)), { withLines: strip(withLines), none: strip(none) });
  c.check("15 플러그인 훅이 없으면 /plugins 에 그 줄이 없다", !plugNone.includes(translate("srv.plugins.pluginHooks")), plugNone);
}

c.done();
