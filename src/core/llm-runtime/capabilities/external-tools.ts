/**
 * externalTools 패스스루 — **claude 어댑터용 캡처 경로** (2026-08-09).
 *
 * LLM 게이트웨이가 앱의 `tools[]` 를 넘기면, 모델이 고른 호출 **의도만** caller 에 돌려준다
 * (tiguclaw 는 실행하지 않는다). codex/openai 어댑터는 SDK 가 함수 스키마를 그대로 받으므로
 * 배열 concat 이면 끝이었지만, claude 는 agent loop 를 SDK 가 소유해 "실행 말고 반환하고
 * 멈춤" 이 없다 — ADR 2026-07-25 §Decision-3 이 그 이유로 **스코프아웃**했다.
 *
 * ★그 판단을 뒤집은 근거 두 가지(2026-08-09, 실사용 사고에서):
 *  ① 개입점이 allow/deny 뿐이라는 전제가 틀렸다. 앱 스키마를 **우리 in-process MCP 서버**로
 *    등록하면 그 도구의 주인이 우리다 — SDK 에 원시기능이 없어도 된다. 같은 기법을 이미
 *    file-ops·memory 가 쓰고, 셸·검색 일원화(같은 날)가 그 배관을 넓혀 놨다.
 *  ② "abort 후 재개는 resume jsonl 오염" 은 **게이트웨이엔 해당 없다.** 게이트웨이 스레드는
 *    `gateway:<uuid>` 로 요청마다 새로 나고 `internal:true`(영속 0) — 아무도 재개하지 않는다.
 *
 * ★캡처는 **핸들러가 아니라 스트림**에서 한다. 핸들러에서 잡고 abort 하면 같은 assistant
 *  메시지의 **병렬 호출 형제를 잃는다**(모델은 한 메시지에 tool_use 를 여러 개 낸다).
 *  assistant 메시지 하나에 든 tool_use 블록을 통째로 읽으면 병렬 호출이 원자적으로 잡힌다.
 *
 * ★이 파일이 어댑터 밖에 있는 이유: 판정(`collectExternalToolCalls`)이 **순수 함수**여야
 *  데몬·SDK·네트워크 없이 검사된다. 어댑터 안에 두면 검사가 "소스에 문자열이 있나" 로
 *  약해진다([[feedback_gate_must_actually_run]] 의 그 부류).
 */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * ★중립 턴(게이트웨이·restricted 엔드포인트)의 **격리 작업폴더**.
 *
 * `systemPromptOverride` 는 tiguclaw 컨텍스트 조립을 정확히 건너뛰고 있었다. 그런데도 앱이
 * 소유자 개인정보를 받았다 — 실측(2026-08-09): `cwd` 를 홈으로 두면 "내 이름이 뭐야?" 에
 * **소유자 이름을 그대로** 답했고, 홈 밖 빈 폴더로 바꾸자 "알지 못합니다" 가 됐다. **SDK 가 cwd 에서
 * `AGENT.md`·`SYSTEM.md` 를 스스로 주워간다** — 우리가 프롬프트를 비워도 파일이 남아 있으면
 * 소용없다.
 *
 * 그래서 중립 턴은 **아무것도 없는 폴더**에서 돈다. 도구 정책이 none 이고 앱 도구는 우리가
 * 실행하지 않으므로 cwd 가 필요 없다 — 잃는 능력 0.
 *
 * README 계약: *"비서가 아니라 내 앱으로 답한다 — tiguclaw 인격도, 도구도, 스킬도, **기억도
 * 없다**"*. 이 폴더가 그 문장의 집행 수단이다.
 */
export const NEUTRAL_CWD_DIRNAME = "tiguclaw-neutral-cwd";

/**
 * 중립 턴이 돌 격리 폴더를 보장하고 경로를 준다.
 *
 * ★생성 실패해도 **홈으로 폴백하지 않는다.** 폴백하면 조용히 다시 새고, 그건 이 함수가 막으려는
 *  바로 그 일이다. 못 만들면 턴이 시끄럽게 실패하는 편이 낫다 — 누수보다 에러가 낫다.
 */
export const neutralCwd = (): string => {
  // ★홈 **밖**이어야 한다. 처음엔 `<home>/data/` 아래 뒀는데 그래도 샜다 — SDK 는 cwd 에서
  //  **상위 디렉터리를 거슬러 올라가며** AGENT.md 를 찾으므로, 홈의 하위 폴더는 결국 홈의
  //  파일을 만난다. (첫 실험이 깨끗했던 건 폴더가 비어서가 아니라 `/tmp` 라 홈 밖이어서였다 —
  //  변인을 잘못 일반화했다.) 그래서 tmp 아래에 둔다: 어떤 tiguclaw 트리에도 안 걸린다.
  const dir = path.join(os.tmpdir(), NEUTRAL_CWD_DIRNAME);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 실패해도 이 경로를 그대로 준다(위 ★) */
  }
  return dir;
};

/** 게이트웨이가 넘긴 앱 함수 스키마 1건. */
export interface ExternalToolSpec {
  name: string;
  description?: string;
  parameters: unknown;
}

/** 모델이 호출을 선택한 결과 1건 — `RegionASdkOutput.externalToolCalls` 와 같은 모양. */
export interface ExternalToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * in-process MCP 서버 이름. 도구는 모델에게 `mcp__<서버>__<도구>` 로 보인다 —
 * 캡처 판정이 그 접두를 벗겨야 앱이 준 원래 이름으로 돌려줄 수 있다(아래 stripServerPrefix).
 */
export const EXTERNAL_TOOLS_SERVER = "app-tools";

/** `mcp__app-tools__foo` → `foo`. 접두가 없으면 그대로(어댑터가 이름을 바꿔도 안전). */
export const stripServerPrefix = (toolName: string): string => {
  const prefix = `mcp__${EXTERNAL_TOOLS_SERVER}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
};

/**
 * ★판정(순수) — assistant 메시지 content 에서 **앱 도구 호출만** 뽑는다.
 *
 * `names` 는 앱이 준 원래 이름 집합. tiguclaw 자기 도구(Read/Bash/memory…)는 이름이 안 맞아
 * 자연히 걸러진다 — 그래서 게이트웨이가 아닌 일반 턴에서 이 함수가 불려도 항상 빈 배열이다
 * (호출부가 externalTools 유무로 이미 가드하지만, 판정 자체도 안전해야 한다).
 *
 * 방어적으로 읽는다: content 가 배열이 아니거나, 블록이 객체가 아니거나, id/name 이 비면
 * 그 블록만 건너뛴다(부분 캡처가 전무 캡처보다 낫다 — 나머지 호출은 살린다).
 */
export const collectExternalToolCalls = (
  content: unknown,
  names: ReadonlySet<string>,
): ExternalToolCall[] => {
  if (!Array.isArray(content) || names.size === 0) return [];
  const calls: ExternalToolCall[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if ((block as { type?: unknown }).type !== "tool_use") continue;
    const rawName = (block as { name?: unknown }).name;
    if (typeof rawName !== "string" || rawName === "") continue;
    const name = stripServerPrefix(rawName);
    if (!names.has(name)) continue; // tiguclaw 자기 도구 — 캡처 대상 아님.
    const id = (block as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    const rawInput = (block as { input?: unknown }).input;
    let argumentsJson: string;
    try {
      argumentsJson = JSON.stringify(rawInput ?? {});
    } catch {
      argumentsJson = "{}"; // 순환참조 등 — 인자를 잃더라도 호출 사실은 살린다.
    }
    calls.push({ id, name, argumentsJson });
  }
  return calls;
};

/**
 * ★앱 JSON Schema 의 **최상위 프로퍼티**를 그대로 zod shape 으로 옮긴다.
 *
 * 처음엔 `{ args: z.record(...) }` 하나로 열어 뒀는데, 실측에서 모델이 인자를 그 키 **안에**
 * 넣어 `{"args":{"layers":[1,2,3]}}` 가 나왔다 — 앱은 `{"layers":[1,2,3]}` 를 기대하므로
 * **계약이 깨진다.** 도구 스키마의 모양이 곧 모델이 뱉는 모양이라, 여기가 앱 계약의 자리다.
 *
 * 타입은 전부 `unknown` 으로 느슨하게 둔다(검증 책임은 실행 주체인 **앱**에 있다 — 우리는
 * 실행하지 않는다). 대신 원본 JSON Schema 를 description 에 실어 모델이 타입·필수를 안다.
 * 프로퍼티가 없으면 빈 shape = 인자 없는 도구.
 */
/**
 * JSON Schema 노드 → zod 타입. 흔한 타입만 옮기고 나머지는 `z.unknown()` 로 안전 degrade.
 *
 * ★타입을 옮기는 게 **핵심**이다. 처음엔 전부 `z.unknown()` 으로 뒀는데, 실측에서 모델이
 *  `layers: [1,2,3]` 을 문자열 `"[1, 2, 3]"` 로 보냈다 — 모델은 description 의 설명글이 아니라
 *  **형식 스키마**를 보고 모양을 정한다. 앱은 배열을 기대하므로 그대로면 파싱에서 깨진다.
 */
const jsonSchemaToZod = (node: unknown, depth = 0): z.ZodTypeAny => {
  if (node === null || typeof node !== "object" || depth > 6) return z.unknown();
  const n = node as { type?: unknown; items?: unknown; properties?: unknown; enum?: unknown };
  if (Array.isArray(n.enum) && n.enum.length > 0) {
    const literals = n.enum.filter((v): v is string => typeof v === "string");
    if (literals.length === n.enum.length && literals.length > 0) {
      return z.enum(literals as [string, ...string[]]);
    }
    return z.unknown();
  }
  // union 타입(["string","null"] 등)은 정확히 옮기기보다 열어 두는 게 안전하다.
  const t = typeof n.type === "string" ? n.type : undefined;
  switch (t) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZod(n.items, depth + 1));
    case "object": {
      const props = n.properties;
      if (props === null || typeof props !== "object") return z.record(z.string(), z.unknown());
      const inner: Record<string, z.ZodTypeAny> = {};
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        inner[k] = jsonSchemaToZod(v, depth + 1).optional();
      }
      return z.object(inner);
    }
    default:
      return z.unknown();
  }
};

export const jsonSchemaToShape = (parameters: unknown): Record<string, z.ZodTypeAny> => {
  const props =
    parameters !== null && typeof parameters === "object"
      ? (parameters as { properties?: unknown }).properties
      : undefined;
  if (props === null || typeof props !== "object") return {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, node] of Object.entries(props as Record<string, unknown>)) {
    // 전부 optional — 필수 여부는 앱이 검증한다. 여기서 required 로 조이면 모델이 한 번
    // 빠뜨렸을 때 SDK 가 호출 자체를 막아 **앱은 아무것도 못 받는다**(캡처 0).
    shape[key] = jsonSchemaToZod(node).optional();
  }
  return shape;
};

/**
 * 앱 스키마를 노출하는 임시 MCP 서버.
 *
 * ★핸들러는 **의도적으로 아무 일도 안 한다.** 모델이 도구를 *부를 수 있게* 목록에 띄우는 게
 *  유일한 목적이고, 실제 캡처는 스트림에서 일어난다(위 주석 ★). 실측상 abort 와 경합해
 *  핸들러가 도달하는 경우가 있으므로(모델이 결과를 보고 한 마디 더 함) 부작용 0 이어야 한다.
 *  그 뒤 텍스트는 게이트웨이가 버린다 — `externalToolCalls` 가 있으면 OpenAI 계약상
 *  `finish_reason:"tool_calls"` + `content:null` 이다.
 */
export const createExternalToolsMcpServer = (
  specs: readonly ExternalToolSpec[],
): ReturnType<typeof createSdkMcpServer> =>
  createSdkMcpServer({
    name: EXTERNAL_TOOLS_SERVER,
    version: "1.0.0",
    tools: specs.map((s) =>
      tool(
        s.name,
        `${s.description ?? `앱이 제공하는 도구 ${s.name}`}\n` +
          `인자 스키마(JSON Schema): ${JSON.stringify(s.parameters ?? {})}`,
        jsonSchemaToShape(s.parameters),
        () =>
          Promise.resolve({
            content: [{ type: "text" as const, text: "호출 의도가 앱으로 전달되었습니다." }],
          }),
      ),
    ),
  });
