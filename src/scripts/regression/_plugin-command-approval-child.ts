// 자식: 플러그인 공통 실행형의 «커맨드별 처음 한 번 승인» (2026-11-03 설계 §2.5·§7-⑦ R2·R3·R4 N1) + 플러그인 켜기·끄기·설치·제거·모듈 화면의
// `commands.changed`·비활성 부재(§7-④). 자기 임시 홈에서 실제 로더·설정 파일·DB 로 돈다.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { assertIsolated, loadPluginModule } from "./_framework.js";
import { childCollector } from "./_child-checks.js";

assertIsolated();
process.env.TIGUCLAW_DISABLE_ENV_FILE = "1";
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "pca-"));
const W = mkdtempSync(path.join(process.env.TIGUCLAW_HOME, "work-"));
const c = childCollector();

const { initStore } = await import("../../store/sessions.js");
const { upsertProject } = await import("../../store/projects.js");
const sp = await import("../../core/session-projects.js");
const pc = await import("../../core/entry/project-command.js");
const reg = await import("../../core/entry/command-registry.js");
const { getPaths } = await import("../../core/paths.js");
const { getEventBus } = await import("../../core/eventbus.js");
const settings = await import("../../core/settings.js");
const mgr = await import("../../core/plugins/manager.js");
const { collectInventory } = await import("../../core/plugins/inventory.js");
const { translate } = await import("../../core/i18n.js");
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
mkProject("qa");
mkProject("qb");
const plugins = getPaths().commonPlugins;
const settingsFile = getPaths().settings;
const node = `"${process.execPath}"`;
const where = path.join(W, "where.js");
write(where, "console.log('WHERE', process.cwd(), process.argv.slice(2).join(' '));");
const runLine = (tail = "$ARGUMENTS"): string => `${node} ${where} ${tail}`;
/** 진짜 플러그인 — 폴더 이름(apx-folder) ≠ 매니페스트 이름(apx). 서비스 하나만 낸다(코드 로드·LIVE 확인용). */
const mkPlugin = (folder: string, name: string): string => {
  const dir = path.join(plugins, folder);
  write(
    path.join(dir, "package.json"),
    JSON.stringify({ name, private: true, type: "module", tiguclaw: { schemaVersion: 1, kind: ["service"], name, entry: "./index.mjs" } }),
  );
  write(path.join(dir, "index.mjs"), "export default class P { async startService() {} async stop() {} };\n");
  return dir;
};
const APX = mkPlugin("apx-folder", "apx");
const BPX = mkPlugin("bpx", "bpx");
const cmd = (dir: string, name: string, body: string): string => {
  const f = path.join(dir, "commands", `${name}.md`);
  write(f, body);
  return f;
};
const common = (run: string, extra = ""): string => `---\nscope: projects\n${extra}run: '${run}'\n---\n`;
cmd(APX, "c", common(runLine()));
cmd(BPX, "c", common(runLine()));
// 설정 항목의 다른 키가 보존되는지 본다.
write(settingsFile, JSON.stringify({ modules: { apx: { enabled: true, note: "keep" } }, theme: "keep-me" }, null, 2));

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
  const cmdName = sep === -1 ? t : t.slice(0, sep);
  const args = sep === -1 ? "" : t.slice(sep + 1).trim();
  return pc.dispatchCommandSlash({ msg: mkMsg(threadKey), args, trimmed: t, sidChannel: "cli" } as never, cmdName);
};
const expand = (tk: string, text: string) => sp.expandSessionCommand(tk, "project", text);
const approvals = (plugin: string): Record<string, string> => {
  const root = JSON.parse(readFileSync(settingsFile, "utf8")) as { modules?: Record<string, { approvedCommands?: Record<string, string> }> };
  return root.modules?.[plugin]?.approvedCommands ?? {};
};
const entryOf = (plugin: string): Record<string, unknown> =>
  ((JSON.parse(readFileSync(settingsFile, "utf8")) as { modules?: Record<string, Record<string, unknown>> }).modules ?? {})[plugin] ?? {};
const yesOf = (e: Awaited<ReturnType<typeof expand>>): string => (e.kind === "confirm" ? e.value.split(" ")[2]!.slice("--yes=".length) : "");
const kinds = (...es: Awaited<ReturnType<typeof expand>>[]) => es.map((e) => e.kind + (e.kind === "confirm" && e.approval === true ? "(approval)" : ""));
const tk = `dashboard:pca-${Date.now()}`;
const tk2 = `${tk}-2`;
const events: { type: string; payload: Record<string, unknown> }[] = [];
const unsub = getEventBus().subscribe((e) => { if (e.type === "commands.changed") events.push({ type: e.type, payload: e.payload }); });
const modEvents = (): number => events.filter((e) => e.payload.reason === "module").length;

try {
  // 설치(문 ①) — 진짜 로더로
  let before = modEvents();
  const inst = await mgr.installHomePlugin("apx");
  await mgr.installHomePlugin("bpx");
  const installEvents = modEvents() - before;
  sp.linkProject(tk, "qa");
  sp.linkProject(tk2, "qb");

  // ── 첫 실행 → 승인 확인(범위 문구) → 확인 꼴 → 기록 → 실행 ────────────────
  offers.length = 0;
  await dispatch("/project run qa c first", tk);
  const firstQ = offers[0]?.q ?? "";
  const firstYes = offers[0]?.options.find((o) => o.value.includes("--yes="))?.value ?? "";
  const scopeText = translate("srv.project.pluginApprovalConfirm", { command: "c", project: "qa", script: "S", source: "X" }).split("\n").at(-1)!;
  replies.length = 0;
  await dispatch(firstYes, tk);
  const ranAfterApprove = replies.some((r) => r.startsWith("▶"));
  const rec = approvals("apx");
  const entry = entryOf("apx");
  c.check(
    "★⑦ 첫 실행은 승인 확인(«어느 대화·어느 프로젝트·어떤 인자» 범위 문구·출처) → 확인 꼴로 실행하면 매니페스트 이름 키로 기록 · 항목의 다른 키 보존",
    firstQ.includes(scopeText) && firstQ.includes("apx-folder") && ranAfterApprove && typeof rec.c === "string" && entry.note === "keep" && entry.enabled === true &&
      (JSON.parse(readFileSync(settingsFile, "utf8")) as { theme?: string }).theme === "keep-me" && !("apx-folder" in (JSON.parse(readFileSync(settingsFile, "utf8")) as { modules: object }).modules),
    { firstQ, rec, entry },
  );
  const expectPrint = sp.scriptPrint(["apx", "c", path.join(realpathSync(APX), "commands", "c.md"), runLine()].join("\0"));
  c.check("⑦ 기록값 = 확인창에 보여 준 대상의 승인 지문(매니페스트·이름·파일·치환 전 run)", rec.c === expectPrint, { rec: rec.c, expectPrint });
  const again = await expand(tk2, "run qb c other-args");
  c.check("★⑦ 같은 줄 두 번째 — 다른 대화·다른 프로젝트·다른 인자에서도 확인 없이 run", again.kind === "run", kinds(again));

  // 세 경로의 기록 키 = 매니페스트 이름(메뉴 값 · 짧은 /이름 · 직접 친 /project run)
  cmd(APX, "e1", common(runLine()));
  cmd(APX, "e2", common(runLine()));
  cmd(APX, "e3", common(runLine()));
  offers.length = 0;
  await dispatch("/project open qa", tk);
  const menuValue = offers[0]?.options.find((o) => o.value.endsWith(" e1"))?.value ?? "";
  const paths: Record<string, string> = {};
  for (const [label, text] of [["menu", menuValue], ["short", "/e2"], ["typed", "/project run qa e3"]] as const) {
    offers.length = 0;
    await dispatch(text, tk);
    const y = offers[0]?.options.find((o) => o.value.includes("--yes="))?.value ?? "";
    await dispatch(y, tk);
    paths[label] = y;
  }
  const ap3 = approvals("apx");
  c.check(
    "R2⑦ pluginName 전달 — 메뉴 값·짧은 /이름·직접 친 /project run 세 경로 모두 매니페스트 이름(apx) 칸에 기록",
    menuValue !== "" && typeof ap3.e1 === "string" && typeof ap3.e2 === "string" && typeof ap3.e3 === "string",
    { paths, ap3 },
  );

  // run 줄을 바꾸면 다시 묻는다
  cmd(APX, "c", common(runLine("changed $ARGUMENTS")));
  const changed = await expand(tk, "run qa c");
  c.check("⑦ run 줄이 바뀌면 다시 승인 확인", changed.kind === "confirm" && changed.approval === true, kinds(changed));

  // ── R2 B1: 확인창 뒤 치환 전 run 만 바뀜(치환 후는 같음) ─────────────────
  cmd(APX, "b1", common(runLine("hello")));
  const b1Shown = await expand(tk, "run qa b1 hello");
  cmd(APX, "b1", common(runLine("$ARGUMENTS")));
  const b1Old = await expand(tk, `run --yes=${yesOf(b1Shown)} qa b1 hello`);
  // 매니페스트 이름만 바뀐 경우
  cmd(APX, "b2", common(runLine()));
  const b2Shown = await expand(tk, "run qa b2");
  const pkg = path.join(APX, "package.json");
  const pkgText = readFileSync(pkg, "utf8");
  writeFileSync(pkg, pkgText.replace('"name":"apx"', '"name":"apx-renamed"').replaceAll('"name":"apx"', '"name":"apx-renamed"'));
  const b2Old = await expand(tk, `run --yes=${yesOf(b2Shown)} qa b2`);
  writeFileSync(pkg, pkgText);
  const apB = approvals("apx");
  c.check(
    "★R2 B1 옛 확인값: 치환 전 run 만 바뀌면 다시 묻고 기록 0 · 매니페스트 이름만 바뀌어도 다시 묻는다",
    b1Shown.kind === "confirm" && b1Old.kind === "confirm" && apB.b1 === undefined && b2Shown.kind === "confirm" && b2Old.kind === "confirm" && apB.b2 === undefined &&
      approvals("apx-renamed").b2 === undefined,
    { k: kinds(b1Shown, b1Old, b2Shown, b2Old), apB },
  );

  // ── 격리: A 의 c 승인 → 이름·run 같은 B 의 c 는 확인 · 승인된 A 의 새 커맨드는 확인 ─────
  cmd(APX, "c", common(runLine()));
  const isoB = await expand(tk, "run qa c");
  cmd(APX, "d", common(runLine()));
  const newD = await expand(tk, "run qa d");
  // bpx 의 c 는 같은 순위라 앞(apx-folder)에 가려져 있다 — apx 의 c 를 잠시 빼서 bpx 의 c 를 부른다(이름·run 같음)
  rmSync(path.join(APX, "commands", "c.md"));
  const otherPlugin = await expand(tk, "run qa c");
  cmd(APX, "c", common(runLine()));
  c.check(
    "★R2⑦ 격리 — 이름·run 이 같은 다른 플러그인의 c 는 승인 확인 · 승인된 플러그인의 새 커맨드도 승인 확인 · 같은 줄로 되돌린 c 는 옛 승인으로 run",
    isoB.kind === "run" && newD.kind === "confirm" && newD.approval === true && otherPlugin.kind === "confirm" && otherPlugin.approval === true &&
      otherPlugin.source?.includes("bpx") === true,
    { k: kinds(isoB, newD, otherPlugin), src: otherPlugin.kind === "confirm" ? otherPlugin.source : "" },
  );

  // ── 같은 매니페스트 이름 두 폴더 · 파일 이동 ─────────────────────────────
  const X1 = path.join(plugins, "xa1");
  const X2 = path.join(plugins, "xa2");
  for (const d of [X1, X2]) {
    write(path.join(d, "package.json"), JSON.stringify({ name: "xdup", tiguclaw: { name: "xdup" } }));
    cmd(d, "xc", common(runLine()));
  }
  const xFirst = await expand(tk, "run qa xc");
  await expand(tk, `run --yes=${yesOf(xFirst)} qa xc`);
  const xRecorded = typeof approvals("xdup").xc === "string";
  const xWasX1 = xFirst.kind === "confirm" && (xFirst.source ?? "").includes("xa1");
  rmSync(X1, { recursive: true, force: true });
  const xAfter = await expand(tk, "run qa xc");
  cmd(APX, "mv", common(runLine()));
  const mvFirst = await expand(tk, "run qa mv");
  await expand(tk, `run --yes=${yesOf(mvFirst)} qa mv`);
  const mvRun = await expand(tk, "run qa mv");
  mkdirSync(path.join(APX, "commands", "sub"), { recursive: true });
  renameSync(path.join(APX, "commands", "mv.md"), path.join(APX, "commands", "sub", "mv.md"));
  const mvMoved = await expand(tk, "run qa mv");
  c.check(
    "★R2⑦ 같은 매니페스트 이름 두 폴더 — 앞(xa1) 승인 뒤 그 폴더가 빠져 xa2 가 올라오면 다시 묻는다 · 커맨드 파일을 하위 폴더로 옮기면 다시 묻는다",
    xWasX1 && xRecorded && xAfter.kind === "confirm" && xAfter.approval === true && (xAfter.source ?? "").includes("xa2") &&
      mvRun.kind === "run" && mvMoved.kind === "confirm" && mvMoved.approval === true,
    { k: kinds(xFirst, xAfter, mvRun, mvMoved), xRecorded },
  );

  // ── 철회 ────────────────────────────────────────────────────────────────
  const rootRev = JSON.parse(readFileSync(settingsFile, "utf8")) as { modules: Record<string, { approvedCommands: Record<string, string> }> };
  delete rootRev.modules.apx!.approvedCommands.e1;
  writeFileSync(settingsFile, JSON.stringify(rootRev, null, 2));
  const revoked = await expand(tk, "run qa e1");
  c.check("R2⑦ 철회 — 기록 키를 파일에서 지우면 다음 호출은 다시 승인 확인", revoked.kind === "confirm" && revoked.approval === true, kinds(revoked));

  // ── 홈 층만 읽는다 ─────────────────────────────────────────────────────
  const cwdDir = path.join(W, "cwd-layer");
  write(
    path.join(cwdDir, ".tiguclaw", "settings.json"),
    JSON.stringify({ modules: { apx: { approvedCommands: { e1: sp.scriptPrint(["apx", "e1", path.join(realpathSync(APX), "commands", "e1.md"), runLine()].join("\0")) } } } }),
  );
  const prevCwd = process.cwd();
  process.chdir(cwdDir);
  const layered = await expand(tk, "run qa e1");
  process.chdir(prevCwd);
  c.check("R3⑦ 읽기는 홈 층만 — 데몬 cwd 의 .tiguclaw/settings.json 에 맞는 승인이 있어도 확인", layered.kind === "confirm" && layered.approval === true, kinds(layered));

  // ── confirm: true (§8-1b) — 승인 있는 상태 · 승인 없는 상태(R4 N1) ───────
  cmd(APX, "cc", common(runLine()));
  const ccA = await expand(tk, "run qa cc");
  await expand(tk, `run --yes=${yesOf(ccA)} qa cc`); // confirm:false 로 승인 기록
  const ccRecorded = approvals("apx").cc;
  cmd(APX, "cc", common(runLine(), "confirm: true\n"));
  const ccB = await expand(tk, "run qa cc");
  const bytesBefore = readFileSync(settingsFile, "utf8");
  const ccRun = await expand(tk, `run --yes=${yesOf(ccB)} qa cc`);
  const bytesAfter = readFileSync(settingsFile, "utf8");
  const ccB2 = await expand(tk, "run qa cc");
  cmd(APX, "cc", common(runLine()));
  const ccBack = await expand(tk, "run qa cc");
  c.check(
    "★§8-1b confirm: true 는 승인 기록이 맞아도 매번 확인(일반 실행 확인 문구) · 확인 꼴 실행 뒤 파일 그대로 · 두 번째도 확인 · confirm 을 되돌리면 옛 승인으로 run",
    typeof ccRecorded === "string" && ccB.kind === "confirm" && ccB.approval === undefined && ccRun.kind === "run" && bytesBefore === bytesAfter &&
      ccB2.kind === "confirm" && ccBack.kind === "run",
    { k: kinds(ccB, ccRun, ccB2, ccBack) },
  );
  // R4 N1 — 승인 키가 없는 초기 상태
  cmd(APX, "nc", common(runLine(), "confirm: true\n"));
  offers.length = 0;
  await dispatch("/project run qa nc", tk);
  const ncQ = offers[0]?.q ?? "";
  const ncYes = offers[0]?.options.find((o) => o.value.includes("--yes="))?.value ?? "";
  replies.length = 0;
  await dispatch(ncYes, tk);
  const ncRan = replies.some((r) => r.startsWith("▶"));
  const ncKey = approvals("apx").nc;
  const nc2 = await expand(tk, "run qa nc");
  cmd(APX, "nc", common(runLine()));
  const nc3 = await expand(tk, "run qa nc");
  c.check(
    "★R4 N1 승인 없는 confirm: true — ①일반 확인(승인 범위 문구 아님) ②확인 꼴로 실행해도 승인 키가 생기지 않는다 ③다시 확인 ④confirm:false 로 바꾸면 처음 승인 확인",
    !ncQ.includes(scopeText) && ncQ.includes("nc") && ncRan && ncKey === undefined && nc2.kind === "confirm" && nc3.kind === "confirm" && nc3.approval === true,
    { ncQ, ncRan, ncKey, k: kinds(nc2, nc3) },
  );

  // 사용자 공통 실행형은 confirm:false 면 첫 실행부터 run
  write(path.join(getPaths().commonCommands, "ucr.md"), common(runLine()));
  const ucr = await expand(tk, "run qa ucr");
  c.check("⑦ 사용자 공통 실행형(confirm 없음)은 첫 실행부터 run(승인은 플러그인 것만)", ucr.kind === "run", kinds(ucr));

  // ── 쓰는 순간 재확인 · 동시 갱신 · 저장 실패 ─────────────────────────────
  const disabledFile = JSON.parse(readFileSync(settingsFile, "utf8")) as { modules: Record<string, Record<string, unknown>> };
  disabledFile.modules.zoff = { enabled: false };
  writeFileSync(settingsFile, JSON.stringify(disabledFile, null, 2));
  const offBytes = readFileSync(settingsFile, "utf8");
  const wr = settings.recordPluginCommandApproval("zoff", "k", "print");
  c.check("R2⑦ 쓰는 순간 재확인 — enabled:false 항목엔 기록 함수가 «disabled» 를 돌려주고 파일은 그대로", wr === "disabled" && readFileSync(settingsFile, "utf8") === offBytes, wr);

  cmd(APX, "p1", common(runLine()));
  cmd(APX, "p2", common(runLine()));
  const p1 = await expand(tk, "run qa p1");
  const p2 = await expand(tk, "run qa p2");
  await Promise.all([
    expand(tk, `run --yes=${yesOf(p1)} qa p1`),
    expand(tk, `run --yes=${yesOf(p2)} qa p2`),
    Promise.resolve().then(() => settings.setModuleDisabled("other-plugin", true)),
  ]);
  const conc = approvals("apx");
  c.check(
    "R2⑦ 동시 갱신 — 승인 둘 + 다른 플러그인 끄기를 같이 돌려도 세 키가 모두 남는다",
    typeof conc.p1 === "string" && typeof conc.p2 === "string" && entryOf("other-plugin").enabled === false,
    { conc, other: entryOf("other-plugin") },
  );

  // ★앞에서 띄운 셸들의 «끝났습니다» 답이 비동기로 온다 — 그 답이 아래 «안내 정확히 1회» 창에 끼지 않게 다 끝나길 기다린다.
  const settle = Date.now() + 15_000;
  while (pc.listProjectRuns().length > 0 && Date.now() < settle) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  cmd(APX, "sf", common(runLine()));
  const sfShown = await expand(tk, "run qa sf");
  const goodBytes = readFileSync(settingsFile, "utf8");
  writeFileSync(settingsFile, "{ broken json");
  const sfBroken = await expand(tk, "run qa sf"); // 깨진 상태의 일반 호출 — 기록이 안 읽혀 확인
  const sfFail = await expand(tk, `run --yes=${yesOf(sfShown)} qa sf`);
  replies.length = 0;
  offers.length = 0;
  const sfDispatch = await dispatch(`/project run --yes=${yesOf(sfShown)} qa sf`, tk);
  const brokenAfter = readFileSync(settingsFile, "utf8");
  const failText = translate("srv.project.approvalSaveFailed", { command: "sf", error: "§" }).split("§")[0]!;
  c.check(
    "★R2·R3⑦ 저장 실패 — 깨진 설정에서 확인 꼴 → approval-failed · 셸 시작 0 · 파일 그대로 · 입구까지: 안내 정확히 1회·handled(비서 턴 0) · 일반 호출은 확인",
    sfBroken.kind === "confirm" && sfFail.kind === "approval-failed" && sfDispatch.kind === "handled" && replies.length === 1 && replies[0]!.startsWith(failText) &&
      !replies.some((r) => r.startsWith("▶")) && offers.length === 0 && brokenAfter === "{ broken json",
    { k: kinds(sfBroken, sfFail), sfDispatch, replies },
  );
  writeFileSync(settingsFile, goodBytes);

  // ── 끄기·켜기(대조군) · 실제 제거 경로(R3) — 다섯 문 이벤트(④) ───────────
  const cOk = await expand(tk, "run qa e2"); // 승인 재사용 중(apx 에만 있는 이름)
  before = modEvents();
  const off = await mgr.setPluginEnabled("apx", false);
  const offEvents = modEvents() - before;
  const offMissing = await expand(tk, "run qa e2");
  const offShort = await sp.expandSessionCommand(tk, "e2", "");
  offers.length = 0;
  await dispatch("/project open qa", tk);
  const offMenu = offers[0]?.options.some((o) => o.value === "/project run qa e2") ?? true;
  const offInv = (await collectInventory()).command.some((e) => e.name === "e1" && e.metadata?.pluginId === "apx-folder");
  const keptWhileOff = typeof approvals("apx").e2 === "string";
  before = modEvents();
  await mgr.setPluginEnabled("apx", true);
  const onEvents = modEvents() - before;
  const reused = await expand(tk, "run qa e2");
  c.check(
    "④ 끄면: /project run=missing · 짧은 /e2 는 none · 메뉴·인벤토리에 없음 · 기록은 남는다 → 켜면 무확인 run(대조군)",
    cOk.kind === "run" && off.ok && offMissing.kind === "missing" && offShort.kind === "none" &&
      !offMenu && !offInv && keptWhileOff && reused.kind === "run",
    { k: kinds(cOk, offMissing, offShort, reused), offMenu, offInv },
  );
  before = modEvents();
  const rm = await mgr.removePlugin("apx");
  const rmEvents = modEvents() - before;
  const afterRm = entryOf("apx");
  await mgr.setPluginEnabled("apx", true);
  const afterRe = await expand(tk, "run qa c");
  c.check(
    "★R3⑦ 실제 제거 경로(removePlugin) — 파일에 enabled:false 와 승인 삭제가 함께 남고 · 다시 켠 같은 커맨드는 처음 승인 확인",
    rm.ok && afterRm.enabled === false && afterRm.approvedCommands === undefined && afterRm.note === "keep" && afterRe.kind === "confirm" && afterRe.approval === true,
    { afterRm, k: kinds(afterRe) },
  );
  // 모듈 화면(POST /set-module-enabled)
  const routes = await loadPluginModule<{ handleSetModuleEnabled: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-settings.js");
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ name: "bpx", enabled: false }))]), { headers: {} });
  let status = 0;
  before = modEvents();
  await routes.handleSetModuleEnabled({
    req,
    res: { writeHead: (s: number) => { status = s; }, setHeader: () => undefined, end: () => undefined },
    url: new URL("http://x/set-module-enabled"),
    channelName: "http-bridge",
  });
  const routeEvents = modEvents() - before;
  // 실패(깨진 설정으로 던짐)면 발행 0
  writeFileSync(settingsFile, "{ broken");
  before = modEvents();
  let threw = false;
  try {
    settings.setModuleDisabled("bpx", false);
  } catch {
    threw = true;
  }
  const failEvents = modEvents() - before;
  writeFileSync(settingsFile, goodBytes);
  c.check(
    "★④ 다섯 문(설치·끄기·켜기·제거·모듈 화면) 각각 성공 뒤 commands.changed 발행 · 깨진 설정으로 던지면 발행 0",
    inst.ok && installEvents >= 2 && offEvents >= 1 && onEvents >= 1 && rmEvents >= 1 && status === 200 && routeEvents >= 1 && threw && failEvents === 0,
    { installEvents, offEvents, onEvents, rmEvents, status, routeEvents, failEvents },
  );
} catch (e) {
  c.check("자식 검사가 예외 없이 끝난다", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  unsub();
  await pc.stopProjectRuns(tk).catch(() => 0);
  void reg;
}
c.done();
