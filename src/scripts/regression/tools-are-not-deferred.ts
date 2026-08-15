/**
 * 회귀: **우리 도구는 접히지 않는다** — claude 만 `ToolSearch` 왕복을 하던 것 (2026-08-15).
 *
 * 사고: SDK 기본값은 MCP 도구를 **접고**(`defer_loading`) `ToolSearch` 로 열게 한다.
 * 실측한 `ToolSearch` 호출이 **전부 `select:` 형태**였다 —
 *   `select:mcp__file-ops__Bash` · `select:mcp__skills__invoke_skill` · `select:mcp__memory__read_memory`
 * 즉 "뭐가 있지?" 를 묻는 **탐색이 아니라**, 이름을 이미 아는 도구의 스키마를 여는 **왕복**
 * 이다. 그것도 우리 최다 사용 도구(`Bash` 450회)에 대해.
 *
 * ★결정적 근거는 **어댑터 비대칭**이다(사용자 지적): `ToolSearch` 는 claude(SDK)에만 있고
 *  codex·openai 엔 없다. 그런데 codex 는 같은 48개를 **전부 펼친 채로 잘 돈다**(실측:
 *  매 호출 `tools 22,525자` 고정, 전체 요청의 10~16%, 매번 동일해 프리픽스 캐시 대상).
 *  같은 도구 집합인데 한쪽만 접고 있고 **안 접는 쪽이 멀쩡하다** — 접는 게 필요한 능력이라는
 *  근거가 없다. 필요했다면 세 어댑터 공통으로 만들었어야 하고, 아니면 claude 도 안 쓰는 게
 *  맞다. 후자를 택했다.
 *
 * ★스킬은 이 축이 아니다 — 스킬은 도구가 아니라 **인덱스**(`SKILL_INDEX_CAP=40`)로 실리고
 *  본문은 `invoke_skill` 로 부를 때 온다. 그 접기 규칙은 우리가 만들었고 3어댑터 공통이다.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createOurMcpServer } from "../../core/llm-runtime/capabilities/_our-mcp.js";
import { createFileOpsMcpServer } from "../../core/llm-runtime/capabilities/file-ops-mcp.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** 등록된 도구들의 `_meta` — SDK 내부 구조지만 이게 유일한 관측면이다. */
const toolMetas = (srv: unknown): Record<string, unknown>[] => {
  const inst = (srv as Record<string, unknown>).instance as Record<string, unknown>;
  const reg = (inst?._registeredTools ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(reg).map((t) => (t._meta ?? {}) as Record<string, unknown>);
};

const probeTool = tool(
  "t",
  "d",
  { a: z.string() },
  async () => ({ content: [{ type: "text" as const, text: "x" }] }),
);

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 우리 헬퍼는 실제로 표식을 붙인다 — SDK 기본과 **다르다** ────────────────
  //  대조군이 없으면 "원래 그런 것" 과 구분이 안 된다.
  const ours = createOurMcpServer({ name: "probe", version: "1.0.0", tools: [probeTool] });
  const plain = createSdkMcpServer({ name: "probe", version: "1.0.0", tools: [probeTool] });
  out.push(
    assert(
      "★우리 서버의 도구엔 alwaysLoad 표식이 붙는다",
      toolMetas(ours).every((m) => m[ALWAYS_LOAD_META] === true),
      JSON.stringify(toolMetas(ours)[0]),
    ),
  );
  out.push(
    assert(
      "SDK 기본은 안 붙는다(대조군 — 우리가 뭔가 하고 있다는 증거)",
      toolMetas(plain).every((m) => m[ALWAYS_LOAD_META] === undefined),
      JSON.stringify(toolMetas(plain)[0] ?? {}),
    ),
  );

  // ── ② ★실제 서버에도 붙는다 — 헬퍼만 고치고 호출부를 안 바꾼 상태 방지 ───────
  const fileOps = createFileOpsMcpServer(REPO);
  const metas = toolMetas(fileOps);
  out.push(
    assert(
      "★실제 file-ops 서버의 도구 전부가 안 접힌다(호출부까지 전환됐다)",
      metas.length > 0 && metas.every((m) => m[ALWAYS_LOAD_META] === true),
      `도구 ${metas.length}개 · 표식 ${metas.filter((m) => m[ALWAYS_LOAD_META] === true).length}개`,
    ),
  );

  // ── ③ ★정의점이 하나다 — 새 서버가 정책을 우회하지 못한다 ────────────────────
  //  20곳에 손으로 `alwaysLoad: true` 를 붙였다면 21번째에서 빠진다(손으로 관리하는
  //  목록 = 드리프트 신호). 그래서 **직접 호출 금지**를 판정으로 검사한다.
  {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!/node_modules|dist|\.git/.test(p)) await walk(p);
          continue;
        }
        if (!p.endsWith(".ts")) continue;
        if (p.endsWith("_our-mcp.ts") || p.includes("scripts/regression")) continue;
        const src = (await readFile(p, "utf8"))
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/\bcreateSdkMcpServer\s*\(/.test(src)) offenders.push(path.relative(REPO, p));
      }
    };
    await walk(path.join(REPO, "src"));
    await walk(path.join(REPO, "plugins"));
    out.push(
      assert(
        "★우리 서버는 전부 정의점(createOurMcpServer)을 지난다",
        offenders.length === 0,
        offenders.length === 0 ? "직접 호출 0곳" : `★우회: ${offenders.join(", ")}`,
      ),
    );
  }

  // ── ④ ★외부 MCP 서버엔 켜지 않는다 — 부팅이 연결까지 블로킹된다 ─────────────
  //  SDK 문서 명시: 켜면 turn-1 프롬프트에 도구가 있어야 해서 서버 연결까지 **부팅이
  //  막힌다**(최대 5초). 우리 in-process 서버는 연결이 즉시라 그 대가가 없지만, 사용자가
  //  등록한 stdio/http 서버에 켜면 그 대가를 그대로 문다.
  {
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!/node_modules|dist|\.git/.test(p)) await walk(p);
          continue;
        }
        if (!p.endsWith(".ts") || p.includes("scripts/regression")) continue;
        const src = (await readFile(p, "utf8"))
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/alwaysLoad/.test(src)) hits.push(path.relative(REPO, p));
      }
    };
    await walk(path.join(REPO, "src"));
    await walk(path.join(REPO, "plugins"));
    out.push(
      assert(
        "★alwaysLoad 는 우리 정의점 한 곳에만 있다(외부 MCP 로 새지 않는다)",
        hits.length === 1 && hits[0]?.endsWith("_our-mcp.ts") === true,
        hits.join(", "),
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "tools-are-not-deferred",
  guards:
    "claude 만 SDK 규칙으로 도구를 접어, 이름을 이미 아는 도구(Bash·invoke_skill·read_memory)의 스키마를 ToolSearch 왕복으로 열던 것 — codex 는 같은 48개를 전부 펼친 채 멀쩡히 돈다",
  run,
};
