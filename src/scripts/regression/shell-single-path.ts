/**
 * 회귀: **셸은 세 어댑터가 같은 경로를 쓴다** (2026-08-09 사용자 신고).
 *
 * 신고: "셸 실행 중에 출력 내용을 백그라운드 잡카드에서 보고 싶다."
 *
 * 확인해 보니 **어댑터마다 달랐다**:
 *  - codex·openai — 우리 MCP `Bash` → `BG_SHELLS` 에 stdout/stderr 적재 → `/api/shell-output`
 *    이 1.5초 비소비 tail 로 서빙 → 카드에서 출력이 보인다.
 *  - claude — SDK 빌트인 `Bash` 는 **SDK 서브프로세스 안**에서 돌아 데몬이 파이프를 못 쥔다.
 *    어댑터가 `tool_result` 텍스트를 긁어 `shell.started` 만 미러링했으므로 **카드는 뜨는데
 *    출력이 없다**(`/api/shell-output` 404). UI 가 없는 게 아니라 먹일 데이터가 없었다.
 *
 * 같은 기능이 어댑터에 따라 되고 안 되는 건 "모든 기능 LLM 무관" 위반이다. 그래서 셸을
 * **한 경로로** 모았다 — `Agent` → `spawn_agent` 와 같은 수법·같은 이유(관측·취소·tail 이
 * 우리 루프 안에서 자연스럽게 이어지는 게 장기적으로 맞다는 사용자 판단).
 *
 * ★범위는 **셸 3종뿐**이다. 파일 도구까지 갈아치우면 능력 손실이라 원칙 1("Claude Code
 *  슈퍼셋 — 누락은 버그")에 걸린다 — 우리 `Read` 는 이미지는 되지만 노트북·PDF 가 없다.
 *
 * ★등급: **행동 게이트**(도구 구성을 실제로 만들어 확인) + **배선 린트**(차단·부착).
 *  실측(라이브 claude 턴): 셸 id `bash_dd5269d1`(우리 형식), `/api/shell-output` 이
 *  `tick-1…tick-6` 을 서빙, `shell.started` 1건(이중 발행 없음), 활동 라벨 `Bash`(정규화됨).
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ADAPTER = "../../../src/core/llm-runtime/adapters/claude-agent-sdk.ts";

export const check: RegressionCheck = {
  name: "shell-single-path",
  guards:
    "셸이 세 어댑터에서 같은 경로 — claude 만 카드에 출력이 안 뜨던 것(SDK 서브프로세스라 파이프를 못 쥠)",
  run: async (): Promise<Assertion[]> => {
    const { createFileOpsMcpServer, SHELL_TOOL_NAMES, SEARCH_TOOL_NAMES, tailShell } = await import(
      "../../core/llm-runtime/capabilities/file-ops-mcp.js"
    );
    const src = (await readFile(new URL(ADAPTER, import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    // ── 도구 구성을 **실제로 만들어** 본다(문자열 검사 아님) ──
    const shellsOnly = createFileOpsMcpServer("/tmp", "regr:shell", { shellsOnly: true });
    const full = createFileOpsMcpServer("/tmp", "regr:shell");
    // ★SDK 가 등록한 실제 도구 목록을 본다 — `_registeredTools` 가 이름→정의 맵이다
    //  (구성 객체의 `tools` 는 생성 시 소비되고 남지 않는다).
    const namesOf = (srv: unknown): string[] =>
      Object.keys(
        (srv as { instance?: { _registeredTools?: Record<string, unknown> } }).instance
          ?._registeredTools ?? {},
      );
    const only = namesOf(shellsOnly);
    const all = namesOf(full);

    // ── 배선: 차단과 부착이 **같은 정의점**을 쓴다 ──
    const blocks =
      /\.\.\.SHELL_TOOL_NAMES,/.test(src) &&
      /\.\.\.SEARCH_TOOL_NAMES,/.test(src) &&
      SEARCH_TOOL_NAMES.length === 2;
    const attaches = /"file-ops": createFileOpsMcpServer\(input\.cwd, input\.threadKey, \{[\s\S]{0,80}shellsOnly: true/.test(src);
    // 이름을 어댑터가 **다시 적지 않는다**(손 목록 금지 — 정의점에서 가져온다).
    const noRespell = !/disallowedTools[\s\S]{0,400}"Bash"/.test(src);

    return [
      assert(
        "★넘긴 도구가 **띄우기·폴링·종료 + 검색 둘**이다(하나만 빠져도 그 기능이 반쪽)",
        // ★기대값을 상수 길이로 쓰면 **상수를 줄여도 통과한다**(변이로 확인). 지켜야 할 성질은
        //  각자의 **역할**이다: 백그라운드로 띄우고(Bash)·진행 중 출력을 읽고(BashOutput)·
        //  멈추고(KillShell), 내용을 찾고(Grep)·파일을 찾는다(Glob).
        ["Bash", "BashOutput", "KillShell", "Grep", "Glob"].every((n) => only.includes(n)) &&
          only.length === 5,
        only.join(",") || "★도구 0개(구성 추출 실패)",
      ),
      assert(
        "전체 부착은 그대로다(codex·openai 회귀 0)",
        all.length > only.length && all.includes("Read") && all.includes("Bash"),
        `${all.length}종`,
      ),
      assert(
        "★파일 도구(Read/Write/Edit)는 **넘기지 않는다** — 우리 Read 가 PDF 를 못 준다(MCP 계약)",
        !only.includes("Read") && !only.includes("Write") && !only.includes("Edit"),
        only.join(","),
      ),
      assert(
        "★우리 Grep 이 claude 빌트인 수준이다(모드·컨텍스트·상한이 실제로 있다)",
        (() => {
          // zod 스키마의 `shape` 이 실제 인자 목록이다(스키마 객체 자체 키는 zod 내부 API).
          const tools = (
            full as unknown as {
              instance?: { _registeredTools?: Record<string, { inputSchema?: { shape?: unknown } }> };
            }
          ).instance?._registeredTools;
          const shape = tools?.["Grep"]?.inputSchema?.shape;
          const keys = Object.keys((shape ?? {}) as Record<string, unknown>);
          return ["output_mode", "-i", "-C", "head_limit", "type", "multiline"].every((k) =>
            keys.includes(k),
          );
        })(),
        "output_mode·-i·-C·head_limit·type·multiline",
      ),
      assert(
        "★차단 목록이 **정의점**을 쓴다(어댑터가 이름을 다시 적지 않는다)",
        blocks && noRespell,
        `차단=${String(blocks)} · 재기입 없음=${String(noRespell)}`,
      ),
      assert(
        "★claude 에 셸 MCP 가 실제로 붙는다(차단만 하고 대체를 안 붙이면 셸이 통째로 사라진다)",
        attaches,
        attaches ? "file-ops(shellsOnly) 부착" : "★부착 없음",
      ),
      assert(
        "tail 진입점이 살아 있다(대시보드가 치는 그 함수)",
        typeof tailShell === "function" && tailShell("없는-셸-id") === undefined,
        "없는 id → undefined",
      ),
    ];
  },
};
