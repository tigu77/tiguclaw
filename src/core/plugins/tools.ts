// src/core/plugins/tools.ts
/**
 * **플러그인이 SDK 없이 도구를 선언하는 길** (2026-08-29).
 *
 * ★사고: 레포 **밖에서** 가이드만 보고 플러그인을 만들어 홈에 깔았더니 첫 부팅에서 죽었다.
 *
 *  ```
 *  [plugin-loader] hello-board load:
 *    Cannot find package '@anthropic-ai/claude-agent-sdk'
 *    imported from /tmp/tiguclaw-tp-home/plugins/hello-board/index.js
 *  ```
 *
 *  가이드가 `import { tool } from "@anthropic-ai/claude-agent-sdk"` 를 시켰는데 **홈에 깔린
 *  플러그인엔 `node_modules` 가 없다.** 번들 플러그인은 이걸 영영 못 겪는다 — 레포
 *  `node_modules` 가 상위에 있어 저절로 잡히기 때문이다([[feedback_dev_machine_config_leak]]
 *  과 같은 형태: 내 기계 배치가 제품 계약으로 승격됐다).
 *
 * ★**해결로 `npm i` 를 문서화하는 건 답이 아니다** — 실측 **247MB**다. 도구 하나 선언하는
 *  값으로 SDK 전체를 플러그인마다 복사하게 만들 수는 없다.
 *
 * ★그래서 도구를 **평범한 데이터**로 받는다. 플러그인은 아무것도 import 하지 않고, 코어가
 *  MCP 서버로 만든다. 공개 면이 **타입 전용**인 이유와 같은 뿌리다(값을 내보내면 런타임
 *  해석이 필요해진다) — 그 원칙을 도구에도 끝까지 민 것이다.
 *
 * ★`getMcpServer()` 는 **그대로 산다.** 번들 플러그인과 SDK 를 이미 쓰는 사람은 안 바뀌고,
 *  둘 다 내면 둘 다 실린다(이름이 겹치면 그건 작성자 몫이다 — 우리가 단속하지 않는다).
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { PluginHost } from "./host.js";

/** 인자 한 칸 — JSON Schema 의 아주 작은 부분집합. 이걸로 안 되면 `getMcpServer()` 를 쓴다. */
export interface PluginToolParam {
  readonly type: "string" | "number" | "boolean";
  /** 모델이 읽는 설명. 없으면 이름만 보고 짐작한다 — 적는 편이 낫다. */
  readonly description?: string;
  /** `type: "string"` 일 때만. 값을 이 중 하나로 좁힌다. */
  readonly enum?: readonly string[];
  /** 기본 `true`. `false` 면 모델이 생략할 수 있다. */
  readonly required?: boolean;
}

/** 도구 하나. */
export interface PluginToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Readonly<Record<string, PluginToolParam>>;
  /**
   * 실행. **문자열을 돌려주면 그게 답**이다(대부분 이걸로 끝난다).
   *
   * ★던져도 데몬은 안 죽는다 — 그 도구 호출만 오류로 모델에게 돌아간다.
   */
  handler(
    args: Readonly<Record<string, unknown>>,
    host: PluginHost,
  ): Promise<string | { text: string; isError?: boolean }>;
}

/** 한 칸을 zod 로. **여기가 유일한 변환점**이다 — 두 곳에 두면 갈린다. */
const zodOf = (p: PluginToolParam): z.ZodTypeAny => {
  let base: z.ZodTypeAny;
  if (p.type === "number") base = z.number();
  else if (p.type === "boolean") base = z.boolean();
  else if (p.enum !== undefined && p.enum.length > 0) {
    base = z.enum([...p.enum] as [string, ...string[]]);
  } else base = z.string();
  if (p.description !== undefined) base = base.describe(p.description);
  return p.required === false ? base.optional() : base;
};

/**
 * 선언이 쓸 만한가 — **순수 판정**. 나쁜 칸 하나는 **그 도구만** 떨어뜨리고 이유를 남긴다.
 *
 * ★플러그인 하나의 오타가 나머지 도구까지 죽이면 안 된다(§D.1 폭발 반경).
 */
export const readToolSpecs = (
  raw: unknown,
): { specs: PluginToolSpec[]; problems: string[] } => {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { specs: [], problems };
  if (!Array.isArray(raw)) return { specs: [], problems: ["getTools() 는 배열을 돌려줘야 합니다"] };
  const specs: PluginToolSpec[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const t = item as Partial<PluginToolSpec> | null;
    const at = `getTools()[${String(i)}]`;
    if (t === null || typeof t !== "object") {
      problems.push(`${at} 가 객체가 아닙니다`);
      continue;
    }
    if (typeof t.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(t.name)) {
      problems.push(`${at}.name 은 소문자·숫자·밑줄이어야 합니다(받은 값: ${String(t.name)})`);
      continue;
    }
    if (seen.has(t.name)) {
      problems.push(`${at}.name '${t.name}' 이 중복입니다`);
      continue;
    }
    if (typeof t.description !== "string" || t.description.trim() === "") {
      // ★설명 없는 도구는 모델이 못 고른다 — 있으나 마나다.
      problems.push(`${at}('${t.name}') 에 description 이 필요합니다 — 모델이 그걸로 고릅니다`);
      continue;
    }
    if (typeof t.handler !== "function") {
      problems.push(`${at}('${t.name}').handler 가 함수가 아닙니다`);
      continue;
    }
    let bad: string | undefined;
    for (const [k, p] of Object.entries(t.parameters ?? {})) {
      if (p === null || typeof p !== "object" || !["string", "number", "boolean"].includes(p.type)) {
        bad = `${at}('${t.name}').parameters.${k}.type 은 string·number·boolean 만 됩니다`;
        break;
      }
    }
    if (bad !== undefined) {
      problems.push(bad);
      continue;
    }
    seen.add(t.name);
    specs.push(t as PluginToolSpec);
  }
  return { specs, problems };
};

/**
 * 도구 하나를 돌리고 **MCP 응답 모양**으로 바꾼다 — 따로 세운 이유는 검사 때문이다.
 *
 * ★이게 `buildToolServer` 안의 익명 함수로 있으면, 예외 격리를 검사하려고 MCP 프로토콜을
 *  띄워야 한다. 그러면 회귀가 약해진다("검사가 껄끄러우면 코드가 잘못 놓인 것",
 *  principle-check Q7). 순수 함수로 빼면 그물이 **실제로 돌려본다.**
 *
 * ★**던져도 턴이 안 죽는다** — 그 도구 호출만 오류로 모델에게 돌아가고, 모델은 그걸 읽고
 *  다시 시도하거나 사람에게 말할 수 있다. 여기서 새면 서드파티 도구 하나가 대화를 끊는다.
 */
export const runToolHandler = async (
  spec: PluginToolSpec,
  args: Readonly<Record<string, unknown>>,
  host: PluginHost,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> => {
  try {
    const r = await spec.handler(args, host);
    const text = typeof r === "string" ? r : r.text;
    const isError = typeof r === "string" ? false : r.isError === true;
    return { content: [{ type: "text", text }], ...(isError ? { isError: true as const } : {}) };
  } catch (e) {
    return {
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      isError: true as const,
    };
  }
};

/**
 * 선언 → MCP 서버. 호스트는 **턴마다** 밖에서 만들어 넣는다(좌표가 턴마다 다르므로).
 */
export const buildToolServer = (
  plugin: string,
  specs: readonly PluginToolSpec[],
  host: PluginHost,
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: plugin,
    tools: specs.map((s) =>
      tool(
        s.name,
        s.description,
        Object.fromEntries(
          Object.entries(s.parameters ?? {}).map(([k, p]) => [k, zodOf(p)]),
        ),
        async (args: Record<string, unknown>) => runToolHandler(s, args, host),
      ),
    ),
  });
