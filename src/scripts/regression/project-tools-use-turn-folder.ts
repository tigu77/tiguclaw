/**
 * 회귀: **프로젝트·MCP 관리 도구의 상대 경로는 그 턴의 작업 폴더 기준이고, 이름으로 해제하면 실제로 해제된다** (2026-10-09).
 *
 * 사고 ①: `project_register`·`project_update`·`project_capabilities`·`add/list/remove_mcp_server` 가 `path.resolve(인자)`
 *  였다 — 기준이 **데몬 process.cwd()**(설치 폴더)라, 프로젝트에서 «이 폴더 등록해 줘(path=".")» 가 tiguclaw 자신을
 *  등록하고 `.mcp.json` 을 설치 폴더에 썼다.
 * 사고 ②: `project_forget("이름")` 이 그 이름을 경로로 풀어 **0행을 지우고** «해제했습니다» 라고 답했다.
 *
 * ★등급: 동작 — 실제 도구 서버를 띄워 등록·해제 결과를 DB·파일로 본다(세 어댑터가 같은 팩토리에 턴 cwd 를 넘긴다).
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectRegistryMcpServer } from "../../core/llm-runtime/capabilities/project-registry.js";
import { createMcpAdminMcpServer } from "../../core/llm-runtime/capabilities/mcp-admin-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { listProjects } from "../../store/projects.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const textOf = (content: unknown): string => {
  const arr = Array.isArray(content) ? content : [content];
  return (arr[0] as { text?: string } | undefined)?.text ?? JSON.stringify(content);
};

export const check: RegressionCheck = {
  name: "project-tools-use-turn-folder",
  guards: "프로젝트·MCP 관리 도구의 상대 경로가 데몬 cwd(설치 폴더) 기준이던 것 + project_forget(이름)이 0행을 지우고 «해제했다» 고 답하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const work = realpathSync(mkdtempSync(path.join(tmpdir(), "proj-tools-")));
    const name = `regproj-${process.pid}`;
    const sub = path.join(work, "app");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "PROJECT.md"), `---\nname: ${name}\ndescription: 회귀\n---\n본문\n`);
    const daemonMcp = path.join(process.cwd(), ".mcp.json");
    const daemonMcpBefore = existsSync(daemonMcp);
    try {
      const reg = await adaptClaudeMcpServer(createProjectRegistryMcpServer("dashboard:proj-tools", work), "projects");
      const r1 = textOf(await reg.callTool("project_register", { path: "app" }));
      const row = listProjects().find((p) => p.name === name);
      out.push(assert("★상대 경로 등록은 턴 폴더 기준이다(데몬 cwd 아님)", row?.path === sub, `${r1.slice(0, 50)} · 등록 경로=${row?.path ?? "(없음)"} · 기대=${sub}`));
      const cap = textOf(await reg.callTool("project_capabilities", { path: "app" }));
      out.push(assert("project_capabilities 도 같은 기준이다", cap.includes(`경로: ${sub}`), cap.slice(0, 80)));

      const miss = textOf(await reg.callTool("project_forget", { path: `no-such-${process.pid}` }));
      out.push(assert("없는 이름을 해제하라면 «해제한 것 없음» 이라 말한다(거짓 성공 금지)", /해제한 것 없음/.test(miss) && !/해제했습니다/.test(miss), miss.slice(0, 80)));
      const byName = textOf(await reg.callTool("project_forget", { path: name }));
      const still = listProjects().some((p) => p.name === name);
      out.push(assert("★이름으로 해제하면 실제로 지워진다", !still && /해제했습니다/.test(byName), `${byName.slice(0, 60)} · 남음=${still}`));
      await reg.close();

      const admin = await adaptClaudeMcpServer(createMcpAdminMcpServer(sub), "mcp-admin");
      const a1 = textOf(await admin.callTool("add_mcp_server", { name: "regtool", command: "echo", path: "." }));
      const wroteHere = existsSync(path.join(sub, ".mcp.json"));
      const wroteDaemon = !daemonMcpBefore && existsSync(daemonMcp);
      out.push(assert("★MCP 등록의 path=\".\" 는 턴 폴더의 .mcp.json 이다(설치 폴더 아님)", wroteHere && !wroteDaemon, `${a1.slice(0, 60)} · 턴폴더=${wroteHere} · 데몬cwd=${wroteDaemon}`));
      const rm = textOf(await admin.callTool("remove_mcp_server", { name: "regtool", path: "." }));
      out.push(assert("제거도 같은 기준이다", /제거됨/.test(rm), rm.slice(0, 60)));
      await admin.close();
    } finally {
      if (!daemonMcpBefore && existsSync(daemonMcp)) rmSync(daemonMcp, { force: true });
      rmSync(work, { recursive: true, force: true });
    }
    return out;
  },
};
