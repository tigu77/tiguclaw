// 자식: **활성 플러그인 스킬을 이름 몰라도 찾아 쓴다**(2026-11-24 ⑥, 설계 `docs/decisions/2026-11-24-plugin-skill-discovery.md` §5).
// ★격리: 러너 홈 아래 하위 홈 — 플러그인 폴더·설정·사용 기록·LIVE(프로세스 전역)를 러너의 다른 검사와 섞지 않는다. 모델·네트워크 0.
// ★LIVE 는 제품 `trackPlugin` 으로 채운다(가짜 로드 기록 — 플러그인 코드는 import·실행하지 않는다).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { childCollector } from "./_child-checks.js";

assertIsolated();
process.env.TIGUCLAW_DISABLE_ENV_FILE = "1";
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "psd-"));
const HOME = process.env.TIGUCLAW_HOME;
const c = childCollector();

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const skillMd = (name: string, desc: string, extra = ""): string => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n본문 ${name} — 고유 표식 ${name}-body\n`;
const plugins = path.join(HOME, "plugins");
const seedPlugin = (folder: string, manifestName: string | undefined, skills: Array<[string, string, string?]>): string => {
  const dir = path.join(plugins, folder);
  if (manifestName !== undefined) {
    write(path.join(dir, "package.json"), JSON.stringify({ name: folder, tiguclaw: { schemaVersion: 1, kind: ["service"], name: manifestName, entry: "./index.js" } }));
  }
  for (const [n, d, x] of skills) write(path.join(dir, "skills", n, "SKILL.md"), skillMd(n, d, x ?? ""));
  return dir;
};

// ── 픽스처 ────────────────────────────────────────────────────────────────────────────
const U = "zqxwvu"; // 스킬 설명에만 있는 낱말 — 어떤 도구 설명에도 없다(비활성 서버 하나만 일부러 쓴다)
const dirA = seedPlugin("a-folder", "alpha-plug", [
  ["alpha-procedure", `프레임을 찍고 ${U} 좌표로 누르는 절차`],
  ["alpha-mainonly", `${U} 메인 칸 전용 절차`, "reach: main\n"],
  ["alpha-hidden", `${U} 모델 자동 호출 금지`, "disable-model-invocation: true\n"],
  ["shadowed-name", `${U} 플러그인 판 — 프로젝트 판에 가려진다`],
  ["alpha-rank-target", "rankbeta 를 먼저 적고 rankalpha 를 나중에 적은 목표"],
  ["alpha-rank-solo", "rankalpha 단독 후보 — 발견 순서는 맨 뒤, 사용빈도는 최고"],
]);
const dirC = seedPlugin("c-plug", "charlie-plug", [["charlie-skill", `${U} 도구 없이 스킬만 주는 플러그인`]]);
seedPlugin("d-plug", "delta-plug", [["delta-skill", `${U} 꺼진 플러그인의 스킬`]]);
seedPlugin("e-copy", "computer-use", [["echo-skill", `${U} 번들 이름을 쓴 홈 사본(로더가 안 돌림)`]]);
seedPlugin("f-nomani", undefined, [["foxtrot-skill", `${U} 매니페스트 없는 폴더`]]);
seedPlugin("g-plug", "golf-plug", [["golf-skill", `${U} 이름은 선언했지만 로드 기록 없음`]]);
const dirH1 = seedPlugin("h1", "hotel-plug", [["hotel-one", `${U} 대표 폴더 1`]]);
const dirH2 = seedPlugin("h2", "hotel-plug", [["hotel-two", `${U} 대표 폴더 2`]]);
const bigSkills = (tag: string): Array<[string, string]> =>
  Array.from({ length: 30 }, (_, i) => [`${tag}-${String(i).padStart(2, "0")}`, `bigbudget 묶음 ${tag} ${i}${i === 29 ? " lateword" : ""}`]);
const dirB1 = seedPlugin("p-big1", "big-one", bigSkills("bigone"));
const dirB2 = seedPlugin("p-big2", "big-two", bigSkills("bigtwo"));
// 앞 묶음들이 예산 50 을 **정확히** 다 쓰고 뒤에 남는 묶음(이름 0개 표시) — 계산은 아래 «상한» 단언 참고
const dirB3 = seedPlugin("p-big3", "big-three", Array.from({ length: 5 }, (_, i): [string, string] => [`bigthree-${i}`, `bigbudget 셋째 ${i}`]));
// 캡 초과 + 순위 경쟁자 — 홈 공통 스킬 55개(한 낱말 rankalpha, 사용빈도 높음)
for (let i = 0; i < 55; i++) {
  const n = `rank-${String(i).padStart(2, "0")}`;
  write(path.join(HOME, "skills", n, "SKILL.md"), skillMd(n, `rankalpha 보조 ${i}`));
}
// 프로젝트 cwd — 같은 이름으로 플러그인 스킬을 가린다
const cwd = path.join(HOME, "work", "proj");
write(path.join(cwd, ".tiguclaw", "skills", "shadowed-name", "SKILL.md"), skillMd("shadowed-name", `${U} 프로젝트 판`));

const main = async (): Promise<void> => {
  const { setModuleDisabled } = await import("../../core/settings.js");
  setModuleDisabled("delta-plug", true);
  const { initStore } = await import("../../store/sessions.js");
  initStore();
  const { recordSkillInvocation } = await import("../../store/skill-usage.js");
  for (let i = 0; i < 55; i++) for (let k = 0; k < 5; k++) recordSkillInvocation(`rank-${String(i).padStart(2, "0")}`, Date.now());
  for (let k = 0; k < 9; k++) recordSkillInvocation("alpha-rank-solo", Date.now());

  const { appRoot } = await import("../../core/paths.js");
  const { trackPlugin } = await import("../../core/plugins/manager.js");
  const track = (name: string, dir: string): void =>
    trackPlugin(
      { manifest: { schemaVersion: 1, name } as never, pluginDir: dir, capabilities: ["service"], instance: {} },
      "home",
      { wired: [], skipped: [], dispose: async () => {} } as never,
    );
  track("alpha-plug", dirA);
  track("charlie-plug", dirC);
  track("hotel-plug", dirH1);
  track("big-one", dirB1);
  track("big-two", dirB2);
  track("big-three", dirB3);
  track("computer-use", path.join(appRoot(), "plugins", "computer-use")); // E 와 같은 이름 — LIVE 대표는 번들 폴더
  // golf-plug·f-nomani·delta-plug 는 LIVE 에 없다

  const reg = await import("../../core/llm-runtime/capabilities/skill-registry.js");
  const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
  const { createFindCapabilitiesMcpServer } = await import("../../core/llm-runtime/capabilities/find-capabilities-mcp.js");
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");

  const text = (r: unknown): string => (Array.isArray(r) ? r : [r]).map((x) => (x as { text?: string })?.text ?? JSON.stringify(x)).join("");
  const skillsSrv = async (turn: "main" | "subagent") =>
    adaptClaudeMcpServer(reg.createSkillInvokeMcpServer(cwd, { channel: "cli", threadKey: `regr:psd:${turn}`, adapter: "claude", turn }), "skills");
  const fakeSrv = (name: string, toolName: string, desc: string) =>
    createSdkMcpServer({ name, version: "0.0.0", tools: [tool(toolName, desc, { x: z.string().optional() }, async () => ({ content: [{ type: "text" as const, text: "" }] }))] });
  const extra = { "alpha-plug": fakeSrv("alpha-plug", "alpha_tool", "화면을 찍습니다"), "inactive-srv": fakeSrv("inactive-srv", "inactive_tool", `${U} 비활성 서버 도구`) };
  const fcSrv = async (turn: "main" | "subagent" | undefined, withScope = true) =>
    adaptClaudeMcpServer(
      createFindCapabilitiesMcpServer(["skills", "alpha-plug"], undefined, extra, withScope ? { cwd, ...(turn !== undefined ? { turn } : {}) } : undefined),
      "find-capabilities",
    );
  const names = (body: string): string[] => [...body.matchAll(/^- ([^:\n]+):/gm)].map((m) => m[1]!);
  /** `find_capabilities` 응답에서 «<plugin> [스킬]» 항목의 스킬 이름 목록. */
  const itemSkills = (body: string, plugin: string): string[] | undefined => {
    const m = new RegExp(`^- \\*\\*${plugin.replace(/[-]/g, "\\-")}\\*\\* \\[스킬\\][^\\n]*\\n {4}스킬: ([^\\n]*)$`, "m").exec(body);
    if (m === null) return undefined;
    return m[1]!.replace(/ \(\d+개 중 \d+개[^)]*\)/, "").replace(/ — invoke_skill.*$/, "").split(", ").filter((s) => s !== "");
  };
  const allItemSkills = (body: string): string[] =>
    [...body.matchAll(/^ {4}스킬: ([^\n]*)$/gm)].flatMap((m) => m[1]!.replace(/ \(\d+개 중 \d+개[^)]*\)/, "").replace(/ — invoke_skill.*$/, "").split(", ").filter((s) => s !== "" && !s.startsWith("(")));
  const expectInvoke = (file: string): string => `Base directory for this skill: ${path.dirname(realpathSync(file))}\n\n${readFileSync(file, "utf8")}`;
  const fileA = path.join(dirA, "skills", "alpha-procedure", "SKILL.md");

  // ── 전제: 첫 invoke 전, 같은 cwd·칸·사용량의 상시 인덱스가 잘렸고 A 스킬이 거기 없다 ──
  const idx = reg.formatSkillIndex(await reg.discoverSkills(cwd), "main");
  c.check(
    "전제 — 상시 인덱스가 잘렸고(«자주 쓰는») 활성 플러그인 스킬 alpha-procedure 는 거기 없다(캡 밖 발견을 재는 상태)",
    idx.includes("자주 쓰는") && !idx.includes("- alpha-procedure:"),
    { header: idx.split("\n").find((l) => l.startsWith("자주 쓰는")) ?? "(없음)", hasA: idx.includes("- alpha-procedure:") },
  );

  const sMain = await skillsSrv("main");
  // ⓐ 다단어 find_skills → 이름 → invoke 응답 = 그 파일
  const fs1 = text(await sMain.callTool("find_skills", { query: `화면 ${U} 눌러줘` }));
  c.check("ⓐ 다단어 `find_skills('화면 zqxwvu 눌러줘')` 가 활성 플러그인 스킬 alpha-procedure 를 찾는다", names(fs1).includes("alpha-procedure"), names(fs1));
  const inv1 = text(await sMain.callTool("invoke_skill", { name: "alpha-procedure" }));
  c.check("ⓐ 찾은 이름의 `invoke_skill` 응답 = 기준 폴더 줄 + 빈 줄 + 그 SKILL.md 원문(정확히)", inv1 === expectInvoke(fileA), inv1.slice(0, 120));

  // ⓑ find_capabilities(같은 낱말) → A 스킬 항목 안 → invoke
  const fcMain = await fcSrv("main");
  const cap1 = text(await fcMain.callTool("find_capabilities", { query: U }));
  const aItem = itemSkills(cap1, "alpha-plug");
  c.check("ⓑ `find_capabilities('zqxwvu')` 의 **alpha-plug [스킬] 항목** 안에 alpha-procedure 가 있다", aItem?.includes("alpha-procedure") === true, aItem ?? cap1.slice(0, 400));
  c.check("ⓑ MCP 항목(alpha-plug 도구)은 그대로 따로 있다 — 스킬은 MCP 항목에 섞이지 않는다", /^- \*\*alpha-plug\*\* — /m.test(text(await fcMain.callTool("find_capabilities", {}))), "MCP 항목 확인");
  c.check("ⓑ 도구 없이 스킬만 주는 로드된 플러그인 C 도 자기 항목으로 나온다", itemSkills(cap1, "charlie-plug")?.includes("charlie-skill") === true, itemSkills(cap1, "charlie-plug") ?? null);

  // negative — 소속 표시
  const capSkills = allItemSkills(cap1);
  for (const [n, why] of [
    ["delta-skill", "꺼진 플러그인"],
    ["echo-skill", "번들 이름 홈 사본(LIVE 대표 폴더가 번들)"],
    ["foxtrot-skill", "매니페스트 없는 폴더"],
    ["golf-skill", "로드 기록 없음"],
    ["shadowed-name", "프로젝트 판에 가려진 이름"],
    ["alpha-hidden", "disable-model-invocation"],
  ] as const) c.check(`소속 표시 negative — ${why}: ${n} 이 [스킬] 항목에 없다`, !capSkills.includes(n), capSkills);
  c.check("소속 표시 negative — 활성 이름에 없는 extra 서버의 도구명·설명은 안 나온다", !cap1.includes("inactive_tool") && !cap1.includes("비활성 서버 도구"), cap1.includes("inactive"));

  // negative — 꺼진 플러그인은 레거시까지 미발견, 이름 지정 탈출구 구분
  const fsU = names(text(await sMain.callTool("find_skills", { query: U })));
  c.check("꺼진 D 스킬은 `find_skills`·상시 인덱스·이름 지정 `invoke_skill` 모두 미발견", !fsU.includes("delta-skill") && !idx.includes("delta-skill") && text(await sMain.callTool("invoke_skill", { name: "delta-skill" })).includes("미발견"), fsU);
  c.check("disable-model-invocation 스킬은 `find_skills` 에 없고 이름 지정 `invoke_skill` 은 열린다(현행 탈출구)", !fsU.includes("alpha-hidden") && text(await sMain.callTool("invoke_skill", { name: "alpha-hidden" })).includes("alpha-hidden-body"), fsU.includes("alpha-hidden"));
  c.check("결함 3 기존 동작 기록 — LIVE 대조 실패 폴더(E·F·G)의 스킬은 레거시 `find_skills` 에 종전대로 남는다(후속)", ["echo-skill", "foxtrot-skill", "golf-skill"].every((n) => fsU.includes(n)), fsU);
  c.check(
    "가려진 이름의 `invoke_skill` 은 프로젝트 판 파일을 준다(소속 항목이 안내하지 않는 이유)",
    text(await sMain.callTool("invoke_skill", { name: "shadowed-name" })) === expectInvoke(path.join(cwd, ".tiguclaw", "skills", "shadowed-name", "SKILL.md")),
    "project",
  );

  // 칸 — 서브에이전트는 reach:main 을 두 발견 도구에서 못 보고, 이름 지정은 열린다
  const sSub = await skillsSrv("subagent");
  const fcSub = await fcSrv("subagent");
  const fsSub = names(text(await sSub.callTool("find_skills", { query: U })));
  const capSubBody = text(await fcSub.callTool("find_capabilities", { query: U }));
  const capSub = allItemSkills(capSubBody);
  const subA = itemSkills(capSubBody, "alpha-plug") ?? [];
  c.check("서브에이전트 칸: reach:main 스킬은 `find_skills`·`find_capabilities` 둘 다 없다", !fsSub.includes("alpha-mainonly") && !capSub.includes("alpha-mainonly"), { fsSub, capSub });
  c.check("서브에이전트 칸: 그 칸에 닿는 alpha-procedure 는 `find_skills` 와 alpha-plug [스킬] 항목 둘 다에 있다(묶음이 통째로 사라지지 않는다)", fsSub.includes("alpha-procedure") && subA.includes("alpha-procedure") && !subA.includes("alpha-mainonly"), { fsSub, subA });
  c.check("메인 칸: reach:main 스킬이 두 발견 도구에 있다(칸 판정이 실제로 갈린다)", fsU.includes("alpha-mainonly") && capSkills.includes("alpha-mainonly"), { fsU, capSkills });
  c.check("서브에이전트 칸에서도 이름 지정 `invoke_skill(alpha-mainonly)` 은 열린다(부모 지정 탈출구)", text(await sSub.callTool("invoke_skill", { name: "alpha-mainonly" })).includes("alpha-mainonly-body"), "invoke");

  // find_skills 순위 — 빈도 높은 한 낱말 후보 55개보다 빈도 0 인 두 낱말 후보가 먼저, 50건 안에 실제 표시
  const rank = text(await sMain.callTool("find_skills", { query: "rankalpha rankbeta" }));
  c.check("`find_skills` 순위: 걸린 낱말 2개(사용 0) 후보가 걸린 1개(사용 5~9)·56개 후보보다 먼저 나오고 50건 잘림 안에 있다", names(rank)[0] === "alpha-rank-target" && rank.includes("개 더 있습니다"), names(rank).slice(0, 3));
  // 단일 낱말·빈 질의 — 종전 규칙(통짜 부분일치·사용빈도순·50·같은 머리말과 줄 형식)과 **응답 전체가 같다**
  const { listSkillUsage } = await import("../../store/skill-usage.js");
  const { asReach, turnReaches } = await import("../../core/llm-runtime/capability-reach.js");
  const usage = new Map(listSkillUsage({ limit: 500 }).map((r) => [r.skillName, r.invokeCount]));
  const legacyFind = async (query: string | undefined): Promise<string> => {
    const inv = (await reg.discoverSkills(cwd)).filter((s) => !s.disableModelInvocation && turnReaches("main", asReach(s.reach)));
    const q = (query ?? "").toLowerCase();
    const m = inv.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    m.sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0));
    const shown = m.slice(0, 50);
    const lines = shown.map((s) => `- ${s.name}: ${s.description}`);
    const rest = m.length - shown.length;
    const tail = rest > 0 ? `\n\n… ${rest}개 더 있습니다 — query 로 좁혀서 다시 부르세요.` : "";
    return (q === ""
      ? `사용 가능 스킬 ${m.length}개${rest > 0 ? ` 중 ${shown.length}개` : "(전체)"}:\n${lines.join("\n")}`
      : `'${query}' 매칭 스킬 ${m.length}개${rest > 0 ? ` 중 ${shown.length}개` : ""}:\n${lines.join("\n")}`) + tail;
  };
  const singleBody = text(await sMain.callTool("find_skills", { query: "rankalpha" }));
  c.check("단일 낱말 `find_skills('rankalpha')` 응답 전체가 종전 규칙의 응답과 같다", singleBody === (await legacyFind("rankalpha")), names(singleBody).slice(0, 3));
  c.check("단일 낱말에서 사용빈도가 순위를 정한다 — 발견 순서상 맨 뒤(56번째)인 alpha-rank-solo(사용 9)가 맨 앞", names(singleBody)[0] === "alpha-rank-solo", names(singleBody).slice(0, 3));
  const emptyBody = text(await sMain.callTool("find_skills", {}));
  c.check("빈 질의 `find_skills()` 응답 전체가 종전 규칙의 응답과 같다", emptyBody === (await legacyFind(undefined)), emptyBody.split("\n")[0]);

  // find_capabilities 이름 합계 상한
  const live = await reg.discoverSkills(cwd);
  const per = new Map<string, number>();
  const { liveOwnerOf } = await import("../../core/plugins/manager.js");
  for (const s of live) if (s.source === "plugin" && reg.skillVisibleTo(s, "main") && liveOwnerOf(s) !== undefined) per.set(liveOwnerOf(s)!.name, (per.get(liveOwnerOf(s)!.name) ?? 0) + 1);
  const totalVisible = [...per.values()].reduce((a, b) => a + b, 0);
  c.check("상한 전제 — 로드된 플러그인마다 보이는 스킬 < 50, 합계 ≥ 51", [...per.values()].every((n) => n < 50) && totalVisible >= 51, Object.fromEntries(per));
  const capAll = text(await fcMain.callTool("find_capabilities", {}));
  const shownAll = allItemSkills(capAll);
  c.check("무인자 `find_capabilities` 의 [스킬] 이름 합계가 정확히 50 이고 잘린 항목에 «N개 중 M개» 안내", shownAll.length === 50 && /\(\d+개 중 \d+개 — 나머지는 find_skills 로\)/.test(capAll), { shown: shownAll.length, totalVisible });
  // 예산 전제: big-three 앞 묶음들(computer-use 1 · alpha 4 · charlie 1 · hotel 1 · big-one 30 · big-two 30 = 67)이 50 을 다 쓴다
  const b3 = /^- \*\*big-three\*\* \[스킬\][^\n]*\n( {4}[^\n]*)$/m.exec(capAll)?.[1] ?? "";
  c.check("이름을 하나도 못 실은 묶음(big-three)은 전체 수와 find_skills 안내만 — 이름 지정 `invoke_skill` 을 권하지 않는다", /스킬 5개 — 표시 한도를 넘어/.test(b3) && b3.includes("find_skills") && !b3.includes("invoke_skill") && !b3.includes("bigthree-"), b3);
  // 표시 문구(summary)에만 있는 낱말로는 [스킬] 항목이 걸리지 않는다 — 채점은 플러그인 이름 + 스킬 이름·설명
  const capSummaryWord = text(await fcMain.callTool("find_capabilities", { query: "절차(스킬)." }));
  c.check("공통 표시 문구에만 있는 낱말(«절차(스킬).»)로는 어떤 [스킬] 항목도 안 나온다", !capSummaryWord.includes("[스킬]"), capSummaryWord.slice(0, 120));
  // 스킬 **이름**에만 있는 낱말 — `find_skills` 후보 선정·`find_capabilities` 묶음 선정·묶음 안 정렬 세 곳이 이름도 본다
  const byName = "bigone-29";
  c.check("스킬 이름에만 있는 낱말(bigone-29)로 `find_skills` 가 그 스킬을 찾는다", names(text(await sMain.callTool("find_skills", { query: byName }))).includes(byName), "find_skills");
  // ★설명에도 있는 낱말(bigbudget)을 섞지 않는다 — 섞으면 이름 검색 없이도 묶음이 걸린다(구현 R3).
  const capByName = text(await fcMain.callTool("find_capabilities", { query: byName }));
  c.check("스킬 이름에만 있는 낱말로 `find_capabilities` 의 big-one [스킬] 묶음이 걸리고 그 이름이 묶음 안 맨 앞이다", itemSkills(capByName, "big-one")?.[0] === byName, itemSkills(capByName, "big-one")?.slice(0, 3) ?? null);
  // 소유 플러그인 **이름**으로도 묶음을 찾는다(스킬 이름·설명엔 없는 낱말)
  const capByOwner = text(await fcMain.callTool("find_capabilities", { query: "charlie-plug" }));
  c.check("소유 플러그인 이름(charlie-plug)으로 질의하면 그 [스킬] 항목 안에 charlie-skill 이 있다", itemSkills(capByOwner, "charlie-plug")?.includes("charlie-skill") === true, itemSkills(capByOwner, "charlie-plug") ?? capByOwner.slice(0, 200));
  const capLate = text(await fcMain.callTool("find_capabilities", { query: "bigbudget lateword" }));
  c.check("질의 응답: 항목 안에서 걸린 낱말이 많은 스킬(발견 순서상 맨 뒤 bigone-29)이 먼저 실린다", itemSkills(capLate, "big-one")?.[0] === "bigone-29", itemSkills(capLate, "big-one")?.slice(0, 3) ?? null);

  // 호출 시점 판정 — 같은 팩토리 인스턴스, LIVE 대표 폴더 교체
  const before = allItemSkills(text(await fcMain.callTool("find_capabilities", { query: U })));
  track("hotel-plug", dirH2);
  const after = allItemSkills(text(await fcMain.callTool("find_capabilities", { query: U })));
  c.check(
    "호출 시점 판정: 같은 팩토리에서 hotel-plug 대표 폴더를 h1→h2 로 바꾸면 hotel-one 이 사라지고 hotel-two 가 나온다",
    before.includes("hotel-one") && !before.includes("hotel-two") && after.includes("hotel-two") && !after.includes("hotel-one"),
    { before: before.filter((n) => n.startsWith("hotel")), after: after.filter((n) => n.startsWith("hotel")) },
  );

  // skillScope 생략 = 종전(스킬 항목 0)
  const noScope = text(await (await fcSrv(undefined, false)).callTool("find_capabilities", {}));
  c.check("`skillScope` 를 안 주면 [스킬] 항목이 없다(종전 그대로)", !noScope.includes("[스킬]"), noScope.includes("[스킬]"));

  // 3어댑터 — 한 번 만든 {cwd, turn} 을 두 팩토리에 같이 넘긴다(코드 대조)
  const src = (rel: string): string => readFileSync(new URL(`../../core/llm-runtime/adapters/${rel}`, import.meta.url), "utf8");
  // ★주석 줄을 걷고 공백을 접어 **실제 호출 인자 전체**를 본다 — 어댑터마다 기대 cwd·adapter 이름이 다르다.
  for (const [f, scopeDef, adapter] of [
    ["claude-agent-sdk.ts", "const skillScope = { cwd, turn: turnKind };", "claude"],
    ["openai-codex-oauth.ts", "const skillScope = { cwd: discoveryCwd, turn: turnKind };", "codex"],
    ["openai-agents-sdk.ts", "const skillScope = { cwd: discoveryCwd, turn: turnKind };", "openai"],
  ] as const) {
    const flat = src(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n").replace(/\s+/g, " ");
    const skillCalls = [...flat.matchAll(/createSkillInvokeMcpServer\(/g)].length;
    const fcCalls = [...flat.matchAll(/createFindCapabilitiesMcpServer\(/g)].length;
    const ok =
      flat.includes("const turnKind = turnKindOf(input);") &&
      flat.includes(scopeDef) &&
      skillCalls === 1 &&
      flat.includes(`createSkillInvokeMcpServer(skillScope.cwd, { channel: input.channel, threadKey: input.threadKey, adapter: "${adapter}", turn: skillScope.turn, })`) &&
      fcCalls === 1 &&
      /createFindCapabilitiesMcpServer\( capabilityActiveNames, (?:undefined|"[^"]*"), input\.extraMcpServers, skillScope, \)/.test(flat);
    c.check(`${f}: 한 번 만든 skillScope(기대 cwd)를 스킬 서버(channel·threadKey·adapter "${adapter}" 그대로)와 find_capabilities 둘에 넘긴다`, ok, { skillCalls, fcCalls, scope: flat.includes(scopeDef) });
  }
  c.done();
};
main().catch((e) => {
  c.check("자식 검사가 예외 없이 끝났다", false, e instanceof Error ? e.stack : String(e));
  c.done();
});
