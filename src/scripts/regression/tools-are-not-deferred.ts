/**
 * 회귀: **우리 도구는 접히지 않고, 외부 서버는 매 턴을 막지 않는다** (2026-08-15).
 *
 * 사고: SDK 기본값은 MCP 도구를 접고(`defer_loading`) `ToolSearch` 로 열게 한다. 관측된
 * `ToolSearch` 호출이 **전부 `select:` 형태**였다 — `select:mcp__file-ops__Bash`,
 * `select:mcp__skills__invoke_skill`. 이름을 이미 아는 도구의 스키마를 여는 **왕복**이지
 * 탐색이 아니다. 그것도 최다 사용 도구(`Bash` 450회)에 대해.
 *
 * ★근거는 **어댑터 비대칭**이다(사용자 지적): `ToolSearch` 는 claude 에만 있고 codex·openai
 *  엔 없다. 그런데 codex 는 같은 48개를 전부 펼친 채 잘 돈다(실측 `tools 22,525자` 고정,
 *  매 호출 동일 = 프리픽스 캐시 대상). 같은 집합인데 한쪽만 접고 안 접는 쪽이 멀쩡하면
 *  접는 게 필요한 능력이라는 근거가 없다.
 *
 * ★**정책을 소비 경계로 옮긴 이유**(적대 검토 지적). 처음엔 우리 서버 20곳을 감싸는
 *  헬퍼로 생성 때 표식을 붙였다. 그건 "손으로 관리하는 목록" 의 변형이었다 —
 *    ①`createSdkMcpServer` 를 **별칭으로 import** 하면 정의점 검사(문자열 grep)가 못 봤고
 *      (실증: `as makeMcpServer` 로 바꾸니 1,063건 전부 초록인데 표식은 전멸)
 *    ②레포 **밖** 생산자(`<home>/plugins` 사용자 플러그인)는 원리적으로 못 닫으며
 *    ③`mcp.json` 의 `alwaysLoad` 는 검증 없이 SDK 로 들어가 **매 턴 최대 5초** 연결 대기.
 *  소비 경계 한 곳에서 처리하니 셋이 동시에 닫히고, **문자열 검사 두 개를 폐기**했다.
 *  이 파일도 그래서 소스 grep 이 아니라 **정책 함수를 실제로 돌린다**.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { applyToolLoadPolicy } from "../../core/llm-runtime/tool-load-policy.js";
import { createFileOpsMcpServer } from "../../core/llm-runtime/capabilities/file-ops-mcp.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** 등록된 도구들의 `_meta` — SDK 내부 구조지만 이게 유일한 관측면이다. */
const metas = (srv: unknown): Record<string, unknown>[] => {
  const inst = (srv as Record<string, unknown>).instance as Record<string, unknown>;
  const reg = (inst?._registeredTools ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(reg).map((t) => (t._meta ?? {}) as Record<string, unknown>);
};
const allStamped = (srv: unknown): boolean => {
  const m = metas(srv);
  return m.length > 0 && m.every((x) => x[ALWAYS_LOAD_META] === true);
};

const mkServer = (name: string): unknown =>
  createSdkMcpServer({
    name,
    version: "1.0.0",
    tools: [
      tool("t", "d", { a: z.string() }, async () => ({
        content: [{ type: "text" as const, text: "x" }],
      })),
    ],
  });

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① SDK 기본은 안 붙는다 — 대조군(우리가 뭔가 하고 있다는 증거) ────────────
  out.push(
    assert(
      "SDK 기본 서버는 표식이 없다(대조군)",
      !allStamped(mkServer("plain")),
      JSON.stringify(metas(mkServer("plain"))[0] ?? {}),
    ),
  );

  // ── ② ★정책을 지나면 표식이 붙는다 — **생성 방법과 무관하게** ────────────────
  //  이게 핵심이다: 사용자 플러그인이 SDK 문서대로 `createSdkMcpServer` 를 써도,
  //  별칭으로 import 해도, 소비 경계를 지나므로 똑같이 펼쳐진다.
  {
    const applied = applyToolLoadPolicy({ mine: mkServer("mine"), plugin: mkServer("plugin") });
    out.push(
      assert(
        "★정책을 지난 in-process 서버는 전부 펼쳐진다(생성 방법 무관)",
        allStamped(applied.mine) && allStamped(applied.plugin),
        `mine=${allStamped(applied.mine)} plugin=${allStamped(applied.plugin)}`,
      ),
    );
  }

  // ── ③ ★실제 서버(file-ops)도 정책을 지나면 전부 펼쳐진다 ─────────────────────
  {
    const applied = applyToolLoadPolicy({ "file-ops": createFileOpsMcpServer(process.cwd()) });
    const m = metas(applied["file-ops"]);
    out.push(
      assert(
        "★실제 file-ops 도구 전부가 안 접힌다",
        m.length > 0 && m.every((x) => x[ALWAYS_LOAD_META] === true),
        `도구 ${m.length}개 · 표식 ${m.filter((x) => x[ALWAYS_LOAD_META] === true).length}개`,
      ),
    );
  }

  // ── ④ ★외부 서버의 alwaysLoad 는 **떼어낸다** — 매 턴 5초 대기 방지 ──────────
  //  `mcp.json`/`.mcp.json` 은 우리가 안 쓴 파일일 수 있다(남의 레포 것). 검증 없이
  //  SDK 로 넘기면 turn-1 프롬프트를 만들 때 서버 연결까지 막힌다. 옵션을 매 턴 새로
  //  조립하므로 부팅 1회가 아니라 **매 턴**이다.
  {
    const applied = applyToolLoadPolicy({
      unity: { command: "npx", args: ["-y", "mcp-unity"], alwaysLoad: true },
      plain: { command: "npx", args: ["-y", "other"] },
    });
    out.push(
      assert(
        "★외부 stdio 서버의 alwaysLoad 가 제거된다(매 턴 연결 대기 방지)",
        !("alwaysLoad" in (applied.unity as Record<string, unknown>)),
        JSON.stringify(applied.unity),
      ),
    );
    out.push(
      assert(
        "그 외 필드는 그대로 둔다(우리가 남의 설정을 재구성하지 않는다)",
        (applied.unity as { command?: string }).command === "npx" &&
          JSON.stringify(applied.plain) === JSON.stringify({ command: "npx", args: ["-y", "other"] }),
        JSON.stringify(applied.plain),
      ),
    );
  }

  // ── ⑤ ★SDK 내부 구조가 바뀌면 **여기가 먼저 빨간불**이다 ────────────────────
  //  표식은 SDK 내부(`_registeredTools[*]._meta`)를 만져서 찍는다. 그 구조가 바뀌면
  //  정책이 조용히 무력화되므로, 그 사실을 이 검사가 알린다(②③이 곧바로 실패한다).
  //  여기서는 **한 곳에서만 정책을 건다**는 것을 고정한다 — 호출이 흩어지면 다시
  //  "손으로 관리하는 목록" 이 된다.
  {
    const wiring = await sourceHas("../../core/llm-runtime/adapters/claude-agent-sdk.ts", [
      /mcpServers: applyToolLoadPolicy\(\{/,
    ]);
    out.push(
      assert(
        "★정책이 어댑터의 mcpServers 조립 지점에 걸린다",
        wiring.ok,
        wiring.ok ? "소비 경계 확인" : `누락 ${wiring.missing.join(" ")}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "tools-are-not-deferred",
  guards:
    "claude 만 SDK 규칙으로 도구를 접어 이름을 이미 아는 도구(Bash·invoke_skill)의 스키마를 ToolSearch 왕복으로 열던 것 + 외부 mcp.json 의 alwaysLoad 가 매 턴 최대 5초 연결 대기를 만들던 것",
  run,
};
