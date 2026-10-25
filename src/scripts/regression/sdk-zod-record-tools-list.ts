/**
 * 회귀: **record 스키마(`z.record`)가 든 코어 MCP 서버의 도구 목록이 실제로 나온다** (2026-10-24 데브싱크 중단).
 *
 * 사고: 공개 싱크 §5 의 `npm audit fix` 가 zod 를 4.4.3 → 4.6.7 로 올렸다(GHSA-mrhx-c7xc-m3w5 — 4.6.6 미만 high).
 *  그런데 당시 claude-agent-sdk 0.3.280 은 zod 4.5 이상에서 `z.record` 가 든 서버의 tools/list 를 **통째로** 실패시킨다
 *  (`MCP error -32603 … reading 'push'`) — record 도구 하나가 아니라 그 서버의 도구가 전부 사라진다.
 *  배포 트리 회귀가 132/6,072 빨강이었지만 «find-capabilities 검사 자체가 던졌다» 처럼 **간접으로만** 보였다.
 *  격리 재현(npm 레지스트리 패키지): SDK 0.3.280·0.3.284 × zod 4.5.4/4.6.6/4.6.7 실패 · SDK 0.3.285 부터 정상 ·
 *  zod 4.4.3 은 두 SDK 모두 정상. SDK 가 스키마 변환에 쓰는 자기 번들 zod 와 설치 zod 의 차이로 보인다(기제는 가설).
 *
 * ★등급: 동작 — 어댑터가 쓰는 진짜 서버(`mcp-admin`·`app-tools`)를 브리지로 listTools 해서 **record 자리의 스키마**까지 본다.
 *  + 최소 재현 고정(SDK × zod 만) — 우리 코드가 아니라 의존성 조합이 깨졌을 때 그 사실이 바로 보이게.
 *  + 설치 하한 — 실제로 깔린 SDK·zod 가 깨진 조합(SDK < 0.3.285)·취약 zod(< 4.6.6)가 아니다.
 *  ★선언 범위(`package.json`)의 하한은 여기서 판정하지 않는다 — 정확한 판정기(semver)가 우리 직접 의존성이 아니라 문법 근사가
 *   되고, 근사는 정상 범위를 거짓 빨강으로 만들었다(GPT R1·R2 검토 10-25). 범위를 낮추고 lock 까지 깨진 판으로 바꾸면 위 동작·설치 단언이 잡는다.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createMcpAdminMcpServer } from "../../core/llm-runtime/capabilities/mcp-admin-mcp.js";
import { createExternalToolsMcpServer } from "../../core/llm-runtime/capabilities/external-tools.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { compareVersions } from "../../core/update-availability.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 근거: 위 격리 재현(SDK) · GHSA-mrhx-c7xc-m3w5 first_patched_version(zod). */
const FLOORS = { "@anthropic-ai/claude-agent-sdk": "0.3.285", zod: "4.6.6" } as const;

type Listed = { name: string; inputSchema?: { properties?: Record<string, unknown> } };
type Json = { type?: unknown; additionalProperties?: unknown };

/** 브리지(codex·openai 어댑터 경로)로 그 서버의 도구 목록 — 실패면 메시지를 돌려준다. */
const list = async (cfg: McpSdkServerConfigWithInstance, name: string): Promise<Listed[] | string> => {
  const b = await adaptClaudeMcpServer(cfg, name);
  try {
    return (await b.listTools()) as Listed[];
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await b.close();
  }
};
/** record 모양 — 객체이고 값 스키마(additionalProperties)가 객체로 실려 있다(값 타입을 주면 그것까지). */
const isRecord = (s: unknown, valueType?: string): boolean => {
  const j = s as Json | undefined;
  const v = j?.additionalProperties as Json | undefined;
  return j?.type === "object" && v !== null && typeof v === "object" && (valueType === undefined || v.type === valueType);
};
/** 브리지로 도구를 불러 첫 텍스트 — 던지면 `throw: …`. 검증에 막히면 핸들러 문구가 아닌 오류 문구가 온다. */
const callText = async (cfg: McpSdkServerConfigWithInstance, name: string, toolName: string, args: Record<string, unknown>): Promise<string> => {
  const b = await adaptClaudeMcpServer(cfg, name);
  try {
    const c = (await b.callTool(toolName, args)) as unknown;
    const first = (Array.isArray(c) ? c[0] : c) as { text?: unknown } | undefined;
    return typeof first?.text === "string" ? first.text : JSON.stringify(c);
  } catch (e) {
    return `throw: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await b.close();
  }
};
const propOf = (tools: Listed[] | string, toolName: string, prop: string): unknown =>
  typeof tools === "string" ? undefined : tools.find((t) => t.name === toolName)?.inputSchema?.properties?.[prop];
const show = (tools: Listed[] | string): string => (typeof tools === "string" ? `실패: ${tools}` : tools.map((t) => t.name).join(","));

const atLeast = (v: string, floor: string): boolean => (compareVersions(v, floor) ?? -1) >= 0;
const installed = (pkg: keyof typeof FLOORS): string => {
  // SDK 는 `package.json` 을 exports 에 안 열어 둔다 — 진입점에서 패키지 폴더를 찾는다.
  const file =
    pkg === "zod"
      ? createRequire(import.meta.url).resolve("zod/package.json")
      : path.join(path.dirname(fileURLToPath(import.meta.resolve(pkg))), "package.json");
  return String((JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version);
};

export const check: RegressionCheck = {
  name: "sdk-zod-record-tools-list",
  guards:
    "zod 보안 갱신(4.6.6+)이 claude-agent-sdk 0.3.280 과 만나 z.record 가 든 서버의 도구 목록이 통째로 실패하던 것(mcp-admin 의 add_mcp_server 등 전부 사라짐) — 회귀는 다른 검사가 던지는 모양으로만 간접 노출",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const versions = `설치 SDK=${installed("@anthropic-ai/claude-agent-sdk")} zod=${installed("zod")}`;

    // ① 최소 재현 고정 — 우리 코드 없이 SDK × zod 만.
    const bare = await list(
      createSdkMcpServer({
        name: "record-repro",
        version: "1.0.0",
        tools: [tool("rec", "record 하나", { r: z.record(z.string(), z.string()) }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }))],
      }),
      "record-repro",
    );
    out.push(
      assert(
        "★최소 재현: z.record 도구 하나뿐인 SDK 서버의 tools/list 가 그 도구를 record 스키마로 낸다",
        isRecord(propOf(bare, "rec", "r"), "string"),
        `${versions} · ${show(bare)} · r=${JSON.stringify(propOf(bare, "rec", "r"))}`,
      ),
    );

    // ② 실제 경로 — mcp-admin(add_mcp_server 의 env·headers 가 record).
    const admin = await list(createMcpAdminMcpServer(), "mcp-admin");
    for (const prop of ["env", "headers"]) {
      out.push(
        assert(
          `★mcp-admin 의 도구 목록이 나오고 add_mcp_server.${prop} 가 문자열 record 다`,
          isRecord(propOf(admin, "add_mcp_server", prop), "string"),
          `${versions} · ${show(admin)} · ${prop}=${JSON.stringify(propOf(admin, "add_mcp_server", prop))}`,
        ),
      );
    }

    // ③ 실제 경로 — app-tools(앱 스키마의 properties 없는 object → z.record). 값 제한이 없다는 건 **표현이 아니라 호출로** 본다:
    //  섞인 값(숫자·객체·배열·null·불리언·문자열 — record 의 직접 값으로)이 검증을 지나 핸들러에 닿고, 객체가 아닌 값은 막힌다(검증이 꺼진 거짓 초록 방지).
    const appServer = () =>
      createExternalToolsMcpServer([{ name: "set_opts", parameters: { type: "object", properties: { opts: { type: "object" } } } }]);
    const app = await list(appServer(), "app-tools");
    const HANDLER = "호출 의도가 앱으로 전달되었습니다.";
    const mixed = await callText(appServer(), "app-tools", "set_opts", { opts: { n: -1, o: { deep: [1, "x"] }, a: [1, "x"], z: null, b: false, s: "" } });
    const notObject = await callText(appServer(), "app-tools", "set_opts", { opts: "문자열" });
    out.push(
      assert(
        "★app-tools 의 도구 목록이 나오고 properties 없는 object 인자가 record 로 실린다",
        isRecord(propOf(app, "set_opts", "opts")),
        `${versions} · ${show(app)} · opts=${JSON.stringify(propOf(app, "set_opts", "opts"))}`,
      ),
      assert("★그 record 는 값 제한이 없다 — 숫자·객체·배열·null·불리언·빈 문자열이 직접 값으로 섞여도 핸들러에 닿는다", mixed === HANDLER, mixed.slice(0, 200)),
      assert("대조: 객체가 아닌 값은 입력 검증에 막힌다(검증이 실제로 돈다)", notObject !== HANDLER && /validation/i.test(notObject), notObject.slice(0, 200)),
    );

    // ④ 설치 하한 — 실제로 깔린 판이 깨진 조합·취약 zod 가 아니다.
    for (const [pkg, floor] of Object.entries(FLOORS) as [keyof typeof FLOORS, string][]) {
      out.push(assert(`설치된 ${pkg} 가 ${floor} 이상이다`, atLeast(installed(pkg), floor), `설치=${installed(pkg)}`));
    }
    return out;
  },
};
