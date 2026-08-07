/**
 * 회귀: **프로젝트 전용 MCP 를 전역에 등록하지 않는다** (2026-08-07 사용자 지정).
 *
 * 실사고(회사 PC 로그): Unity MCP 가 **전역과 프로젝트 양쪽**에 등록돼 있었고, 전역판이
 * 매 부팅 `external-mcp: 'unity-mcp' 연결 실패 — skip` 을 냈다. Unity 와 무관한 대화에도
 * 그 도구가 딸려 실린다 = 오염. 그 앱이 안 떠 있는 기계에서는 영원히 실패한다.
 *
 * ★이름 목록이 아니라 **판정**이다: `command`·`args` 가 **등록된 프로젝트 폴더 안**을
 *  가리키는데 `path` 를 안 줬으면 그건 그 프로젝트 전용이다. 새 서버가 생겨도 목록을 고칠
 *  필요가 없다([[hand-maintained-lists]]).
 * ★판정 못 하는 경우(범용 명령·URL)는 **통과**시킨다 — 막는 게 목적이 아니라 자리를 바로
 *  잡는 게 목적이라, 오탐으로 정상 등록을 방해하면 규칙이 미움받고 결국 우회된다.
 *
 * 동작으로 본다 — 실제 도구 핸들러를 호출한다(문자열 검사면 가드를 지워도 초록일 수 있다).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

interface ToolReg {
  handler: (args: unknown, extra?: unknown) => Promise<unknown>;
}

const textOf = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? "")
    .join(" ");

export const check: RegressionCheck = {
  name: "mcp-scope-guard",
  guards:
    "프로젝트 전용 MCP 가 전역에 등록돼 무관한 대화에 실리고 매 부팅 연결 실패를 내던 것",
  run: async (): Promise<Assertion[]> => {
    const { initStore } = await import("../../store/sessions.js");
    const { listProjects } = await import("../../store/projects.js");
    const { createMcpAdminMcpServer } = await import(
      "../../core/llm-runtime/capabilities/mcp-admin-mcp.js"
    );
    initStore();
    // ★재료를 **직접 만든다**. 종전 판은 "등록 프로젝트가 있으면" 돌았는데, 스위트 홈엔
    //  프로젝트가 0건이라 조기 반환해 **아무것도 검사하지 않았다**(첫 실행에서 1건만 돌아
    //  드러났다). 환경이 맞을 때만 도는 검사는 그물이 아니다.
    const { upsertProject, forgetProject } = await import("../../store/projects.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const base = mkdtempSync(nodePath.join(tmpdir(), "tiguclaw-mcp-scope-"));
    upsertProject({ path: base, name: "회귀-스코프", status: "active", description: "" });
    void listProjects;
    const srv = createMcpAdminMcpServer() as unknown as { instance: unknown };
    const reg = (srv.instance as { _registeredTools: Record<string, ToolReg> })
      ._registeredTools;
    const add = reg["add_mcp_server"];
    if (add === undefined) {
      return [assert("add_mcp_server 도구가 있다", false, "도구 미등록")];
    }

    // ①프로젝트 폴더를 가리키는데 path 없음 → 거부 + 올바른 방법 안내.
    const blocked = textOf(
      await add.handler({ name: "regr-scope-proj", command: `${base}/bin/server` }, {}),
    );
    // ②범용 명령 → 통과(오탐 0). 실제 파일 쓰기가 일어나므로 이름을 regr- 로 두고 아래서 지운다.
    const allowed = textOf(
      await add.handler(
        { name: "regr-scope-generic", command: "npx", args: ["-y", "generic-mcp"] },
        {},
      ),
    );
    // 정리 — 검사가 남긴 전역 등록 제거(테스트가 홈을 더럽히지 않는다).
    let cleaned = "미시도";
    try {
      const { removeExternalMcpServer } = await import("../../core/external-mcp.js");
      await (removeExternalMcpServer as (n: string, p?: string) => Promise<unknown>)(
        "regr-scope-generic",
      );
      cleaned = "제거";
    } catch {
      cleaned = "제거 실패(수동 정리 필요)";
    }

    try {
      forgetProject(base);
    } catch {
      /* 정리 실패 무해 — 일회용 tmp 경로 */
    }

    return [
      assert(
        "★프로젝트 폴더를 가리키는 서버의 전역 등록을 거부한다",
        blocked.includes("전역으로 등록하려 했습니다") && blocked.includes(base),
        blocked.slice(0, 80) || "(빈 응답)",
      ),
      assert(
        "거부할 때 **올바른 방법**을 알려준다(막기만 하면 우회한다)",
        blocked.includes('path="'),
        blocked.includes('path="') ? "path 안내 포함" : "안내 없음",
      ),
      assert(
        "범용 서버의 전역 등록은 통과한다(오탐 0)",
        allowed.includes("등록됨") && allowed.includes("전역"),
        `${allowed.slice(0, 60)} · 정리=${cleaned}`,
      ),
    ];
  },
};
