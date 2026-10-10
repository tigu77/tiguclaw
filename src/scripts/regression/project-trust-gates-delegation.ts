/**
 * 회귀: **등록 안 된 폴더로 위임하면 그 폴더의 `.mcp.json`·`settings.json` 훅을 끈다** (2026-10-09 전체 적대 검토 · 정태님 결정).
 *
 * 사고: 비서가 남의 레포를 받아 그 폴더로 일을 맡기면, 레포의 `.mcp.json` `command` 와 `settings.json` 훅이 **확인 없이 실행됐다**
 *  (레포 내용만으로 명령이 돈다). 결정: 믿는 폴더 = 데몬 폴더 + 등록된 프로젝트(그 안쪽 포함). 그 밖이면 끈 채로 일하고, 위임 응답이
 *  «켤까요?» 를 묻게 하며, 승인되면 등록해 켠다.
 *
 * 지키는 것:
 *  ① 등록 안 된 폴더: `.mcp.json` 의 command 가 실행되지 않는다 · settings.json 훅이 실행되지 않는다 · 위임 안내가 무엇을 껐는지 말한다
 *  ② 등록된 프로젝트(와 그 하위 폴더): 같은 파일이 그대로 켜진다(훅 실행 · MCP 게이트 열림) · 안내 없음
 *
 * 등급: **동작** — 격리 홈의 실제 DB·실제 훅 실행기·실제 외부 MCP 연결 함수.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "project-trust-gates-delegation",
  guards: "등록 안 된 폴더로 위임하면 그 레포의 .mcp.json command·settings.json 훅이 확인 없이 실행되던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-trust-"));
    try {
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const { upsertProject } = await import("../../store/projects.js");
      const trust = await import("../../core/project-trust.js");
      const ext = await import("../../core/external-mcp.js");
      const hooks = await import("../../core/entry/hook-runner.js");

      // 같은 내용의 두 폴더 — 하나만 등록한다.
      const make = (name: string): { dir: string; mcpMark: string; hookMark: string } => {
        const dir = path.join(root, name);
        mkdirSync(path.join(dir, "sub"), { recursive: true });
        const mcpMark = path.join(dir, "PWNED-mcp");
        const hookMark = path.join(dir, "PWNED-hook");
        writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { helper: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(mcpMark)}, 'x'); process.exit(1)`] } } }));
        writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `"${process.execPath}" -e "require('fs').writeFileSync(${JSON.stringify(hookMark).replace(/"/g, "'")}, 'x')"` }] }] } }));
        return { dir, mcpMark, hookMark };
      };
      const stranger = make("cloned-repo");
      const mine = make("my-project");
      upsertProject({ path: mine.dir, name: "my-project", status: "active", description: null });

      const fire = async (cwd: string): Promise<void> => {
        await hooks.runPreToolUseHooks({ toolName: "Read", toolInput: { file_path: "x" }, cwd, channel: "dashboard", threadKey: "agent:trust" });
      };

      // ① 등록 안 된 폴더
      await ext.getConnectedExternalMcpBridges(stranger.dir);
      await fire(stranger.dir);
      await new Promise((r) => setTimeout(r, 300));
      const note = trust.untrustedDelegationNote(stranger.dir);
      out.push(
        assert(
          "① 등록 안 된 폴더: .mcp.json command·settings.json 훅이 실행되지 않는다 · MCP 게이트가 닫힌다",
          !existsSync(stranger.mcpMark) && !existsSync(stranger.hookMark) && ext.isProjectMcpCwd(stranger.dir) === false,
          { mcp실행: existsSync(stranger.mcpMark), 훅실행: existsSync(stranger.hookMark), 게이트: ext.isProjectMcpCwd(stranger.dir) },
        ),
        assert(
          "① 위임 안내가 무엇을 껐는지 말하고 «묻고 등록» 을 시킨다",
          note.includes(".mcp.json") && note.includes("settings.json") && note.includes("project_register"),
          note.slice(0, 160),
        ),
      );

      // ② 등록된 프로젝트와 그 하위 폴더 — 그대로 켜진다
      await fire(mine.dir);
      await new Promise((r) => setTimeout(r, 300));
      out.push(
        assert(
          "② 등록된 프로젝트: 훅이 돈다 · MCP 게이트가 열린다 · 하위 폴더도 같다 · 안내 없음",
          existsSync(mine.hookMark) &&
            ext.isProjectMcpCwd(mine.dir) === true &&
            trust.isTrustedProjectDir(path.join(mine.dir, "sub")) &&
            trust.untrustedDelegationNote(mine.dir) === "",
          {
            훅실행: existsSync(mine.hookMark),
            게이트: ext.isProjectMcpCwd(mine.dir),
            하위: trust.isTrustedProjectDir(path.join(mine.dir, "sub")),
            안내: trust.untrustedDelegationNote(mine.dir),
          },
        ),
      );
      await ext.closeAllExternalMcp?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
