/**
 * 회귀: **커맨드를 하위 폴더로 묶을 수 있다** (2026-10-09 정태님: 칩 메뉴 aaa › bbb › /ccc).
 *
 * 종전엔 `commands/` 바로 아래만 읽어 `commands/aaa/ccc.md` 가 **조용히 사라졌다**(Claude Code 는 하위 폴더를 읽는다).
 *
 * 지키는 것:
 *  ① 하위 폴더까지 읽고 이름은 파일 이름 그대로 · 폴더 경로는 `folder` 로만(맨 위는 없음) · 깊이 상한 · 점 폴더·node_modules 제외
 *  ② 같은 이름이 두 폴더에 있으면 하나만(얕은 쪽) — 목록에 두 번 뜨지 않는다
 *  ③ 옛 평면 폴더(`<cwd>/commands`)는 안 내려간다(코드 레포의 문서 폴더일 수 있다) · `.tiguclaw/commands` 는 내려간다
 *  ④ 만들기·지우기 도구가 하위 폴더의 커맨드를 찾는다 — 못 찾으면 지우지 못하고, 같은 이름을 맨 위에 또 만든다
 *  ⑤ 대시보드 목록(`getAllCommands`)이 `folder` 를 싣는다
 *
 * 등급: **동작** — 격리 홈·임시 폴더에 실제 파일을 두고 실제 로더·도구를 부른다.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

type Tools = Record<string, { handler?: (a: Record<string, unknown>, e: unknown) => Promise<{ content?: { text?: string }[]; isError?: boolean }> }>;

export const check: RegressionCheck = {
  name: "command-folders",
  guards: "하위 폴더에 둔 커맨드가 조용히 사라지던 것 + 묶음을 들이며 생길 겹침·과탐색·지우기 실패",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const reg = await import("../../core/entry/command-registry.js");
    const { createCommandToolsMcpServer } = await import("../../core/llm-runtime/capabilities/command-tools-mcp.js");
    const { getPaths } = await import("../../core/paths.js");
    const out: Assertion[] = [];
    const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-cmdfold-"));
    const put = (file: string, body = "---\ndescription: d\n---\nbody\n"): void => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    };
    const globalDir = getPaths().commonCommands;
    const made: string[] = [];
    try {
      // ①② 프로젝트 커맨드 폴더
      const proj = path.join(root, "proj");
      const pc = path.join(proj, ".tiguclaw", "commands");
      put(path.join(pc, "top.md"));
      put(path.join(pc, "aaa", "x.md"));
      put(path.join(pc, "aaa", "bbb", "y.md"));
      put(path.join(pc, "aaa", "bbb", "c", "atlimit.md")); // 깊이 3 — 읽힌다
      put(path.join(pc, "aaa", "bbb", "c", "d", "toodeep.md")); // 깊이 4 — 안 읽힌다
      put(path.join(pc, ".hidden", "h.md"));
      put(path.join(pc, "node_modules", "n.md"));
      put(path.join(pc, "dup.md"), "---\ndescription: top\n---\n");
      put(path.join(pc, "aaa", "dup.md"), "---\ndescription: nested\n---\n");
      const list = await reg.discoverProjectCommands(proj);
      const by = new Map(list.map((c) => [c.name, c]));
      const names = [...by.keys()].sort().join(",");
      out.push(
        assert(
          "① 하위 폴더까지 읽고 이름은 파일 이름 그대로 · 폴더는 folder 로",
          by.get("top")?.folder === undefined && by.get("x")?.folder === "aaa" && by.get("y")?.folder === "aaa/bbb" && by.get("atlimit")?.folder === "aaa/bbb/c",
          `${names} · x=${by.get("x")?.folder} y=${by.get("y")?.folder}`,
        ),
        assert("① 깊이 상한·점 폴더·node_modules 는 안 읽는다", !by.has("toodeep") && !by.has("h") && !by.has("n"), names),
        assert(
          "② 같은 이름이 두 폴더에 있으면 하나만 — 얕은 쪽",
          list.filter((c) => c.name === "dup").length === 1 && by.get("dup")?.description === "top",
          `dup ${list.filter((c) => c.name === "dup").length}개 · ${by.get("dup")?.description}`,
        ),
      );

      // ③ 데몬 폴더(cwd): 옛 평면 폴더는 맨 위만, .tiguclaw/commands 는 하위까지
      const cwd = path.join(root, "cwd");
      put(path.join(cwd, "commands", "flatlegacy.md"));
      put(path.join(cwd, "commands", "docs", "legacynested.md"));
      put(path.join(cwd, ".tiguclaw", "commands", "grp", "newnested.md"));
      const all = await reg.discoverCommands(cwd);
      const allNames = new Set(all.map((c) => c.name));
      out.push(
        assert(
          "③ 옛 평면 폴더(<cwd>/commands)는 안 내려가고 .tiguclaw/commands 는 내려간다",
          allNames.has("flatlegacy") && !allNames.has("legacynested") && all.find((c) => c.name === "newnested")?.folder === "grp",
          [...allNames].filter((n) => /legacy|nested/.test(n)).join(","),
        ),
      );

      // ④ 도구 — 전역 홈 커맨드 폴더의 하위 폴더
      const tools: Tools =
        (createCommandToolsMcpServer() as unknown as { instance?: { _registeredTools?: Tools } }).instance?._registeredTools ?? {};
      const nestedDel = path.join(globalDir, "regrgrp", "regr-fold-del.md");
      const nestedReg = path.join(globalDir, "regrgrp", "regr-fold-reg.md");
      made.push(path.join(globalDir, "regrgrp"), path.join(globalDir, "regr-fold-reg.md"));
      put(nestedDel);
      put(nestedReg, "---\ndescription: old\n---\nOLD\n");
      const del = await tools["delete_command"]!.handler!({ name: "regr-fold-del" }, {});
      const dup = await tools["register_command"]!.handler!({ name: "regr-fold-reg", prompt: "NEW" }, {});
      const over = await tools["register_command"]!.handler!({ name: "regr-fold-reg", prompt: "NEW", overwrite: true }, {});
      out.push(
        assert("④ delete_command 가 하위 폴더의 커맨드를 지운다", del.isError !== true && !existsSync(nestedDel), del.content?.[0]?.text?.slice(0, 120)),
        assert(
          "④ register_command 는 하위 폴더의 같은 이름을 겹침으로 본다 · 덮어쓰면 그 자리에 쓴다(맨 위에 둘째를 만들지 않는다)",
          dup.isError === true &&
            over.isError !== true &&
            readFileSync(nestedReg, "utf8").includes("NEW") &&
            !existsSync(path.join(globalDir, "regr-fold-reg.md")),
          `${dup.content?.[0]?.text?.slice(0, 80)} · 맨 위 생김=${existsSync(path.join(globalDir, "regr-fold-reg.md"))}`,
        ),
      );

      // ⑤ 대시보드 목록
      const listed = await reg.getAllCommands(cwd);
      out.push(
        assert(
          "⑤ 대시보드 목록이 folder 를 싣는다(맨 위 것엔 없다)",
          listed.find((c) => c.name === "newnested")?.folder === "grp" && listed.find((c) => c.name === "flatlegacy")?.folder === undefined,
          JSON.stringify(listed.find((c) => c.name === "newnested")),
        ),
      );
    } finally {
      for (const p of made) rmSync(p, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
