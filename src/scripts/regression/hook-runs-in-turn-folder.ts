/**
 * 회귀: **프로젝트 훅은 그 프로젝트 폴더에서 돈다** (2026-10-09 전체 적대 검토 P2).
 *
 * 사고: 훅 실행기가 `<cwd>/.tiguclaw/settings.json` 을 그 턴의 cwd 로 **찾기는** 했는데, spawn 에 cwd 를 안 넘겨 명령은
 *  **데몬 cwd** 에서 돌았다 — 프로젝트 훅의 상대 경로 스크립트·`git` 명령이 엉뚱한 폴더(설치 폴더)를 봤다. 찾는 곳과 도는
 *  곳이 갈린 것이다.
 *
 * ★등급: 동작 — 진짜 훅을 셸로 돌려 «어디서 돌았나» 를 훅 자신이 파일에 적게 한다.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPreToolUseHooks } from "../../core/entry/hook-runner.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { nodeCommand } from "./_shell-fixture.js";

export const check: RegressionCheck = {
  name: "hook-runs-in-turn-folder",
  guards: "프로젝트 훅이 프로젝트 폴더가 아니라 데몬 cwd 에서 실행되던 것(찾는 곳과 도는 곳이 갈림)",
  run: async (): Promise<Assertion[]> => {
    const proj = realpathSync(mkdtempSync(path.join(tmpdir(), "hook-cwd-proj-")));
    const out = path.join(proj, "where.txt");
    try {
      mkdirSync(path.join(proj, ".tiguclaw"), { recursive: true });
      writeFileSync(
        path.join(proj, ".tiguclaw", "settings.json"),
        JSON.stringify({
          hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: nodeCommand(`require("fs").writeFileSync(${JSON.stringify(out)}, process.cwd())`) }] }] },
        }),
      );
      // 프로젝트 훅은 등록된 프로젝트에서만 돈다(2026-10-09 신뢰 경계) — 등록하고 잰다.
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const { upsertProject, forgetProject } = await import("../../store/projects.js");
      upsertProject({ path: proj, name: "regr-hook-cwd", status: "active", description: null });
      await runPreToolUseHooks({ toolName: "Bash", toolInput: {}, cwd: proj, channel: "cli", threadKey: "regression:hook-cwd" });
      forgetProject(proj);
      let ranIn = "";
      try {
        ranIn = realpathSync(readFileSync(out, "utf8").trim());
      } catch {
        ranIn = "";
      }
      return [
        assert("훅이 실제로 돌았다(빈손 통과 금지)", ranIn !== "", ranIn === "" ? "★훅 미실행" : "실행됨"),
        assert("★훅 명령이 그 턴의 프로젝트 폴더에서 돈다(데몬 cwd 아님)", ranIn === proj, `돈 곳=${ranIn} · 프로젝트=${proj} · 데몬=${process.cwd()}`),
      ];
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  },
};
