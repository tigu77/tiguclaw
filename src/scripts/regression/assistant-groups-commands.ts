/**
 * 회귀: **비서가 커맨드를 묶을 수 있다** — 커맨드가 하위 폴더 묶음을 지원하니 비서의 도구도 그걸 다뤄야 한다 (2026-10-10 정태님:
 * «커맨드 자체가 하위를 지원하게 됐으니 비서도 그거에 맞게 할 수 있어야 당연한 거지»).
 *
 * 사고: 묶음(`commands/배포/스테이징/x.md` → 메뉴 배포 › 스테이징 › /x)은 생겼는데 `register_command` 는 맨 위에만 만들고, `list_commands`
 *  는 묶음을 안 보여 주고 연결 프로젝트 명령도 못 봤다. 전역 커맨드 묶음은 안내조차 없었다 — 비서는 «묶어 줘» 를 할 수단이 없었다.
 *
 * 지키는 것(실제 도구를 MCP 다리로 부른다 — 격리 홈):
 *  ① group 으로 만들면 그 하위 폴더에 생기고, list_commands 가 묶음과 함께 보여 준다(전역)
 *  ② 이미 있는 명령에 group 만 주면 내용 그대로 옮긴다 · group '' 은 맨 위로 · 비게 된 폴더는 치운다
 *  ③ overwrite + group 이면 새 묶음에 쓰고 옛 자리는 지운다(같은 이름이 두 폴더에 남지 않는다)
 *  ④ 폴더 밖으로 못 나간다(`..`)·탐색 상한(3단)보다 깊게는 안 만든다
 *  ⑤ 프로젝트 명령도 같은 규칙 — list_commands(project) 가 그 프로젝트 묶음을 보여 준다
 *
 * 등급: **동작**.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "assistant-groups-commands",
  guards: "커맨드 묶음(하위 폴더)이 생겼는데 비서 도구는 맨 위에만 만들고 묶음을 못 보던 것 — 전역 커맨드는 안내조차 없었다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { getPaths } = await import("../../core/paths.js");
    const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
    const { createCommandToolsMcpServer } = await import("../../core/llm-runtime/capabilities/command-tools-mcp.js");
    const t = await adaptClaudeMcpServer(createCommandToolsMcpServer(), "regr-cmd-group");
    const call = async (tool: string, args: Record<string, unknown>): Promise<string> => JSON.stringify(await t.callTool(tool, args));
    const root = getPaths().commonCommands;
    const at = (...p: string[]): string => path.join(root, ...p);

    // ①
    await call("register_command", { name: "regr-stg", prompt: "스테이징 배포", group: "배포/스테이징" });
    const list1 = await call("list_commands", {});
    out.push(
      assert(
        "★① group 으로 만들면 그 하위 폴더에 생기고, list_commands 가 묶음과 함께 보여 준다",
        existsSync(at("배포", "스테이징", "regr-stg.md")) && list1.includes("배포 › 스테이징") && list1.includes("/regr-stg"),
        list1.slice(0, 300),
      ),
    );

    // ② 옮기기만 — 내용 그대로
    const before = readFileSync(at("배포", "스테이징", "regr-stg.md"), "utf8");
    const mv = await call("register_command", { name: "regr-stg", group: "운영" });
    const movedBody = existsSync(at("운영", "regr-stg.md")) ? readFileSync(at("운영", "regr-stg.md"), "utf8") : "";
    const top = await call("register_command", { name: "regr-stg", group: "" });
    out.push(
      assert(
        "★② group 만 주면 내용 그대로 옮기고('' 은 맨 위로) 비게 된 묶음 폴더는 치운다",
        movedBody === before && existsSync(at("regr-stg.md")) && !existsSync(at("운영")) && !existsSync(at("배포")) && /옮겼습니다/.test(mv) && /옮겼습니다/.test(top),
        { 옮김: mv.slice(0, 120), 맨위: top.slice(0, 120), 운영폴더남음: existsSync(at("운영")), 배포폴더남음: existsSync(at("배포")) },
      ),
    );

    // ③ overwrite + group
    await call("register_command", { name: "regr-ow", prompt: "옛", group: "가" });
    await call("register_command", { name: "regr-ow", prompt: "새", group: "나", overwrite: true });
    out.push(
      assert(
        "③ overwrite + group 이면 새 묶음에 쓰고 옛 자리는 지운다(같은 이름이 두 폴더에 남지 않는다)",
        existsSync(at("나", "regr-ow.md")) && !existsSync(at("가", "regr-ow.md")) && readFileSync(at("나", "regr-ow.md"), "utf8").includes("새"),
        { 새자리: existsSync(at("나", "regr-ow.md")), 옛자리: existsSync(at("가", "regr-ow.md")) },
      ),
    );

    // ③' 같은 자리 덮어쓰기는 파일을 남긴다 — 홈이 심링크 아래(맥 임시 폴더 /var→/private/var)면 «다른 자리» 로 보고 방금 쓴 파일을
    //  지웠다(적대 검토 F2). 격리 홈이 바로 그 모양이다.
    await call("register_command", { name: "regr-ow", prompt: "또 새", group: "나", overwrite: true });
    await call("register_command", { name: "regr-top", prompt: "위", overwrite: true });
    await call("register_command", { name: "regr-top", prompt: "위2", group: "", overwrite: true });
    out.push(
      assert(
        "★③' 같은 묶음·맨 위에서 덮어쓰면 파일이 남는다(심링크 경로에서 방금 쓴 파일을 지우지 않는다)",
        existsSync(at("나", "regr-ow.md")) && readFileSync(at("나", "regr-ow.md"), "utf8").includes("또 새") && existsSync(at("regr-top.md")),
        { 묶음안: existsSync(at("나", "regr-ow.md")), 맨위: existsSync(at("regr-top.md")) },
      ),
    );
    // ③'' 옮길 자리에 같은 이름의 다른 파일이 있으면 덮지 않는다(적대 검토 F6)
    {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      writeFileSync(at("regr-dup.md"), "---\n---\nTOP\n");
      mkdirSync(at("다"), { recursive: true });
      writeFileSync(at("다", "regr-dup.md"), "---\n---\nHAND\n");
      const r = await call("register_command", { name: "regr-dup", group: "다" });
      out.push(
        assert(
          "③'' 옮길 자리에 같은 이름의 다른 파일이 있으면 덮지 않고 이유를 말한다",
          readFileSync(at("다", "regr-dup.md"), "utf8").includes("HAND") && existsSync(at("regr-dup.md")) && /이미 있어/.test(r),
          r.slice(0, 160),
        ),
      );
      rmSync(at("regr-dup.md"), { force: true });
      rmSync(at("다"), { recursive: true, force: true });
      rmSync(at("regr-top.md"), { force: true });
    }

    // ④ 탈출·깊이
    const esc = await call("register_command", { name: "regr-esc", prompt: "x", group: "../밖" });
    const deep = await call("register_command", { name: "regr-deep", prompt: "x", group: "a/b/c/d" });
    const bad = await Promise.all(["..\\..\\밖", ".숨김", "a:b", "x*y"].map((g) => call("register_command", { name: "regr-bad", prompt: "x", group: g })));
    out.push(
      assert(
        "④ 역슬래시(윈도우 `..\\..` 탈출)·점 시작·윈도우 금지 글자 묶음도 거절한다",
        bad.every((r) => /쓸 수 없습니다/.test(r)) && !existsSync(at("regr-bad.md")),
        bad.map((r) => r.slice(30, 90)),
      ),
    );
    out.push(
      assert(
        "④ 폴더 밖(`..`)·탐색 상한(3단)보다 깊은 묶음은 거절하고 아무것도 만들지 않는다",
        /쓸 수 없습니다/.test(esc) && /3단까지/.test(deep) && !existsSync(path.join(path.dirname(root), "밖")) && !existsSync(at("a")),
        { 탈출: esc.slice(0, 120), 깊이: deep.slice(0, 120) },
      ),
    );

    // ⑤ 프로젝트
    const proj = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-cmdgroup-"));
    try {
      const { upsertProject } = await import("../../store/projects.js");
      upsertProject({ path: proj, name: "regr-cmd-proj", status: "active", description: null });
      await call("register_command", { name: "regr-build", prompt: "빌드해", project: "regr-cmd-proj", group: "빌드" });
      const plist = await call("list_commands", { project: "regr-cmd-proj" });
      out.push(
        assert(
          "⑤ 프로젝트 명령도 같은 규칙 — list_commands(project) 가 그 프로젝트의 묶음을 보여 준다",
          existsSync(path.join(proj, ".tiguclaw", "commands", "빌드", "regr-build.md")) && plist.includes("[빌드]") && plist.includes("/regr-build"),
          plist.slice(0, 200),
        ),
      );
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
    for (const n of ["regr-stg.md", path.join("나", "regr-ow.md")]) rmSync(at(n), { force: true });
    rmSync(at("나"), { recursive: true, force: true });
    return out;
  },
};

export default check;
