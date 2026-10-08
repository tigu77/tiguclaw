/**
 * 회귀: **세션에 프로젝트를 연결하면 그 프로젝트의 커맨드·맥락이 그 세션에만 붙는다** (2026-10-08,
 * docs/decisions/2026-10-08-session-project-links.md).
 *
 * 배경(정태님 «프로젝트 전용 커맨드가 노출되기가 쉽지 않다»): 커맨드를 찾는 기준이 데몬이 떠 있는 폴더뿐이라, 메인 대화에는 프로젝트
 * 맥락이 아예 없었다. 지키는 것 — 판단은 `core/session-projects.ts` 한 곳:
 *  ① 연결은 등록된 프로젝트만 · 세션마다 따로 · 여러 개 · 해제
 *  ② 연결된 프로젝트의 커맨드는 그 세션에서만 풀리고, 이름이 겹치면 추측하지 않고 고르게 한다 · 없으면 종전 전역
 *  ③ 연결된 프로젝트에서는 `.tiguclaw/commands` 만(옛 평면 `commands/` 는 남의 레포 소스 폴더일 수 있다)
 *  ④ 비서 맥락엔 이름·경로·한 줄만 · 연결 없으면 0줄
 *  ⑤ `/project` 목록·메뉴는 기록에 안 남고, 상태 변경·실행은 남는다
 *  ⑥ (2026-10-08 적대 검토) 한 대화 안에서 이름은 하나 · 파생 턴(매니저·스케줄)엔 연결 안 함 · 전역 커맨드가 먼저 ·
 *     `/project run` 은 **연결된** 프로젝트만 · 휘발 판정과 실행 분기가 같은 파서 · 맥락 조립에 실제로 실린다 · 세 어댑터가 세션을 넘긴다
 *
 * 등급: **동작** — 격리 홈의 실제 DB 와 임시 프로젝트 폴더로 코어 함수를 돌린다.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "session-project-links",
  guards: "프로젝트 전용 커맨드·맥락이 메인 대화에 닿을 길이 없던 것 — 세션 연결이 그 세션에만, 등록 프로젝트만, 겹침은 고르게, 맥락은 한 줄로",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { initStore } = await import("../../store/sessions.js");
    const { upsertProject, forgetProject } = await import("../../store/projects.js");
    const sp = await import("../../core/session-projects.js");
    const { isEphemeralCommandText, splitFirstToken } = await import("../../core/entry/command-registry.js");
    const { formatConversationContext } = await import("../../core/prompt-assembly.js");
    const { getPaths } = await import("../../core/paths.js");
    initStore();
    const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-sproj-"));
    const mk = (name: string, cmds: Record<string, string>, legacy?: Record<string, string>): string => {
      const dir = path.join(root, name);
      mkdirSync(path.join(dir, ".tiguclaw", "commands"), { recursive: true });
      writeFileSync(path.join(dir, "PROJECT.md"), `---\nname: ${name}\ndescription: ${name} 설명\n---\n본문`);
      for (const [n, body] of Object.entries(cmds)) writeFileSync(path.join(dir, ".tiguclaw", "commands", `${n}.md`), body);
      if (legacy) {
        mkdirSync(path.join(dir, "commands"), { recursive: true });
        for (const [n, body] of Object.entries(legacy)) writeFileSync(path.join(dir, "commands", `${n}.md`), body);
      }
      upsertProject({ path: dir, name, status: "active", description: `${name} 설명` });
      return dir;
    };
    const a = mk("regr-alpha", { deploy: "---\ndescription: 알파 배포\n---\nALPHA DEPLOY $ARGUMENTS", only: "ALPHA ONLY", "regr-shadow": "PROJECT SHADOW" }, { stray: "LEGACY" });
    const b = mk("regr beta", { deploy: "BETA DEPLOY" });
    const g = mk("regr-gamma", { secret: "GAMMA SECRET" }); // 등록만 하고 연결은 안 한다
    // 이름이 regr-alpha 인 **다른 경로**의 등록 프로젝트(정태님 기계의 tiguclaw-v2 · tiguclaw 처럼)
    const dup = path.join(root, "elsewhere", "regr-alpha");
    mkdirSync(dup, { recursive: true });
    writeFileSync(path.join(dup, "PROJECT.md"), "---\nname: regr-alpha\n---\n");
    // 같은 이름의 전역 커맨드(홈 commands/) — 연결한 프로젝트가 가로채면 안 된다
    const globalDir = getPaths().commonCommands;
    mkdirSync(globalDir, { recursive: true });
    const globalCmd = path.join(globalDir, "regr-shadow.md");
    writeFileSync(globalCmd, "GLOBAL SHADOW");
    const unregistered = path.join(root, "loose");
    mkdirSync(unregistered);
    const s1 = `dashboard:regr-sp-${Date.now()}`;
    const s2 = `${s1}-other`;
    try {
      const notReg = sp.linkProject(s1, unregistered);
      const l1 = sp.linkProject(s1, "regr-alpha");
      const l1again = sp.linkProject(s1, "regr-alpha");
      const l2 = sp.linkProject(s1, b); // 경로로
      const linked = sp.linkedProjects(s1).map((p) => p.name);
      const otherSession = sp.linkedProjects(s2).length;
      const one = await sp.expandSessionCommand(s1, "only", "");
      const amb = await sp.expandSessionCommand(s1, "deploy", "now");
      const run = await sp.expandSessionCommand(s1, "project", `run "regr beta" deploy`);
      const runArgs = await sp.expandSessionCommand(s1, "project", "run regr-alpha deploy fast");
      const legacy = await sp.expandSessionCommand(s1, "stray", "");
      const otherSees = await sp.expandSessionCommand(s2, "only", "");
      const missing = await sp.expandSessionCommand(s1, "project", "run regr-alpha nope");
      const ctx = sp.linkedProjectsContextLines(s1);
      const assembled = formatConversationContext({ channel: "dashboard", threadKey: s1 });
      // 매니저·서브에이전트는 원 대화의 연결을 물려받는다 · 원 대화가 없는 파생 턴(스케줄)은 0줄
      const { registerJob } = await import("../../core/worker-jobs.js");
      const jobId = registerJob({ label: "regr", threadKey: s1, channel: "dashboard", channelUserId: "regr", task: "regr" });
      const subId = registerJob({ label: "regr-sub", threadKey: `worker:${jobId}`, channel: "dashboard", channelUserId: "regr", task: "regr" });
      const inheritedMgr = formatConversationContext({ channel: "dashboard", threadKey: `worker:${jobId}` });
      const inheritedSub = formatConversationContext({ channel: "dashboard", threadKey: `agent:${subId}` });
      const schedCtx = formatConversationContext({ channel: "dashboard", threadKey: "scheduler:regr-sp" });
      upsertProject({ path: dup, name: "regr-alpha", status: "active", description: null }); // 첫 연결 뒤에 등록(이름 연결이 «여럿» 이 안 되게)
      const dupLink = sp.linkProject(s1, dup);
      const afterDup = sp.linkedProjects(s1).map((p) => p.path);
      const derived = ["worker:regr-job", "agent:regr-job", "scheduler:regr"].map((tk) => sp.linkProject(tk, "regr-alpha"));
      const derivedLinked = ["worker:regr-job", "agent:regr-job", "scheduler:regr"].map((tk) => sp.linkedProjects(tk).length);
      const shadowShort = await sp.expandSessionCommand(s1, "regr-shadow", "");
      const shadowRun = await sp.expandSessionCommand(s1, "project", "run regr-alpha regr-shadow");
      const notLinkedRun = await sp.expandSessionCommand(s1, "project", "run regr-gamma secret");
      const notLinkedShort = await sp.expandSessionCommand(s1, "secret", "");
      const quotedSub = '/project "run" regr-alpha deploy';
      const parsersAgree = splitFirstToken(quotedSub.slice("/project".length)).first === "run" && !isEphemeralCommandText(quotedSub);
      const ctxNone = sp.linkedProjectsContextLines(s2);
      const un = sp.unlinkProject(s1, "regr beta");
      const afterUnlink = sp.linkedProjects(s1).map((p) => p.name);
      const ephem = {
        list: isEphemeralCommandText("/project"),
        open: isEphemeralCommandText('/project open "regr beta"'),
        unlinkAsk: isEphemeralCommandText("/project unlink regr-alpha"),
        unlinkDo: isEphemeralCommandText("/project unlink regr-alpha confirm"),
        link: isEphemeralCommandText("/project link regr-alpha"),
        run: isEphemeralCommandText("/project run regr-alpha deploy"),
      };
      const adapters = ["claude-agent-sdk", "openai-codex-oauth", "openai-agents-sdk"].map((f) => {
        const src = readFileSync(path.join(process.cwd(), "src/core/llm-runtime/adapters", `${f}.ts`), "utf8");
        return { f, passes: /createProjectRegistryMcpServer\(\s*input\.threadKey\s*\)/.test(src) };
      });
      return [
        assert(
          "★연결은 등록된 프로젝트만 · 이름·경로 둘 다 · 다시 연결해도 하나 · 다른 세션엔 안 붙는다",
          !notReg.ok && notReg.reason === "not-registered" && l1.ok && !l1.already && l1again.ok && l1again.already && l2.ok &&
            linked.join("|") === "regr-alpha|regr beta" && otherSession === 0,
          { notReg: notReg.ok ? "ok" : notReg.reason, linked, otherSession },
        ),
        assert(
          "★연결된 프로젝트의 커맨드는 그 세션에서 풀린다 · 이름이 겹치면 고르게(추측 실행 0) · `/project run` 은 그 프로젝트 것 · 인자 치환",
          one.kind === "text" && one.text === "ALPHA ONLY" &&
            amb.kind === "choose" && amb.options.length === 2 && amb.options.every((o) => o.value.startsWith("/project run ") && o.value.endsWith(" deploy now")) &&
            amb.options.some((o) => o.value.includes('"regr beta"')) &&
            run.kind === "text" && run.text === "BETA DEPLOY" && runArgs.kind === "text" && runArgs.text === "ALPHA DEPLOY fast",
          { one, amb: amb.kind === "choose" ? amb.options.map((o) => o.value) : amb.kind, run, runArgs },
        ),
        assert(
          "연결 안 한 세션엔 안 보이고(전역으로 넘어간다) · 옛 평면 commands/ 는 안 읽는다 · 없는 커맨드는 «찾지 못했다»",
          otherSees.kind === "none" && legacy.kind === "none" && missing.kind === "missing",
          { otherSees: otherSees.kind, legacy: legacy.kind, missing: missing.kind },
        ),
        assert(
          "★비서 맥락: 연결마다 이름·경로·한 줄(PROJECT.md 본문은 안 싣는다) · 연결 없으면 0줄",
          ctx.length === 3 && ctx.some((l) => l.includes("regr-alpha") && l.includes(a) && l.includes("regr-alpha 설명")) && !ctx.join("\n").includes("본문") && ctxNone.length === 0,
          ctx,
        ),
        assert("해제하면 그 세션 목록에서 빠진다", un.ok && afterUnlink.join("|") === "regr-alpha", afterUnlink),
        assert(
          "★한 대화 안에서 이름은 하나 — 같은 이름의 다른 프로젝트는 연결 거절(이름으로 가리키는 메뉴·버튼이 둘째를 골라도 첫째를 돌린다)",
          !dupLink.ok && dupLink.reason === "name-taken" && !afterDup.includes(path.resolve(dup)),
          { dupLink: dupLink.ok ? "ok" : dupLink.reason, afterDup },
        ),
        assert(
          "★파생 턴(매니저·서브·스케줄)엔 연결하지 않는다 — 내부 좌표에 걸고 «연결했다» 고 보고하던 것",
          derived.every((r) => !r.ok && r.reason === "not-a-conversation") && derivedLinked.every((n) => n === 0),
          { derived: derived.map((r) => (r.ok ? "ok" : r.reason)), derivedLinked },
        ),
        assert(
          "★전역 커맨드가 먼저 — 연결한 프로젝트의 같은 이름 커맨드가 `/이름` 을 가로채지 않고, 그건 `/project run` 으로 부른다",
          shadowShort.kind === "text" && shadowShort.text === "GLOBAL SHADOW" && shadowRun.kind === "text" && shadowRun.text === "PROJECT SHADOW",
          { shadowShort, shadowRun },
        ),
        assert(
          "★`/project run`·짧은 이름 모두 **연결된** 프로젝트만 — 등록만 된 프로젝트의 커맨드는 이 대화에서 안 돈다(권한 경계)",
          notLinkedRun.kind === "missing" && notLinkedShort.kind === "none",
          { notLinkedRun: notLinkedRun.kind, notLinkedShort: notLinkedShort.kind },
        ),
        assert("휘발 판정과 실행 분기가 같은 파서 — `/project \"run\" …` 을 한쪽만 실행으로 읽지 않는다", parsersAgree, { quotedSub }),
        assert(
          "★매니저·서브에이전트는 맡긴 대화의 연결을 물려받는다(자기 좌표엔 연결이 없다) · 원 대화 없는 스케줄은 0줄",
          [inheritedMgr, inheritedSub].every((t) => t.includes("이 일을 맡긴 대화에 연결된 프로젝트") && t.includes(a)) &&
            !schedCtx.includes("연결된 프로젝트"),
          { inheritedMgr: inheritedMgr.slice(0, 400), schedCtx: schedCtx.slice(0, 200) },
        ),
        assert(
          "프로젝트 전용 스킬·에이전트·MCP 는 «그 폴더로 위임(path)» 하면 켜진다고 알린다(메인에 섞지 않는다)",
          ctx[0]!.includes("path") && ctx[0]!.includes("project_capabilities"),
          ctx[0],
        ),
        assert(
          "★연결 줄이 실제 맥락 조립(formatConversationContext, 세 어댑터 공용)에 실린다",
          ctx.every((l) => assembled.includes(l)),
          assembled.slice(0, 600),
        ),
        assert("세 어댑터 모두 프로젝트 도구에 이 대화(세션)를 넘긴다 — 안 넘기면 link_project 가 늘 거절", adapters.every((x) => x.passes), adapters),
        assert(
          "★`/project` 목록·메뉴·해제 확인은 기록 안 함(휘발) · 연결·해제 확정·실행은 기록",
          ephem.list && ephem.open && ephem.unlinkAsk && !ephem.unlinkDo && !ephem.link && !ephem.run,
          ephem,
        ),
      ];
    } finally {
      sp.unlinkProject(s1, "regr-alpha");
      forgetProject(a);
      forgetProject(b);
      forgetProject(g);
      forgetProject(dup);
      rmSync(globalCmd, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
};
