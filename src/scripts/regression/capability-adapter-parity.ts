/**
 * 회귀: **새 능력은 세 어댑터에 다 실린다** — 한 곳을 빠뜨려도 아무도 안 잡던 것 (2026-08-18).
 *
 * 능력(in-process MCP 서버)을 하나 만들면 `claude-agent-sdk`·`openai-agents-sdk`·
 * `openai-codex-oauth` **세 곳에 손으로** 등록해야 한다. 그리고 지금까지 그걸 지키는 검사가
 * 없었다 — 즉 하나를 빠뜨리면 그 어댑터를 쓰는 동안만 도구가 사라진다. **에러도 로그도 없이**,
 * 모델은 "그런 도구가 없네" 하고 우회한다.
 *
 * ★이건 가상의 위험이 아니다. 같은 부류가 이미 두 번 일어났다:
 *  - `models.reasoning` 을 openai 어댑터만 안 읽어, `openai:<모델>` 로 적은 설정이 **아무 신호
 *    없이 무시**됐다(2026-08-15 적대 검토 F10 이 잡음). 그 수정 주석이 원인을 정확히 적어뒀다 —
 *    *"그때 세 번째 어댑터엔 같은 질문을 안 했다(손으로 어댑터를 열거한 대가)."*
 *  - `WebFetch` 의 `prompt` 무시가 codex 에만 있어 20일간 22건 전부 틀렸다(claude 는 SDK 것이라
 *    멀쩡 = 어댑터 간 비대칭).
 *
 * ★**목록이 아니라 판정이다**([[feedback_hand_maintained_lists]]). 능력 이름을 여기 적지
 *  않는다 — `capabilities/` 에서 `create*McpServer` 팩토리를 긁어와 세 어댑터가 **전부
 *  import 하는지**를 본다. 새 능력이 생기면 자동으로 대상이 되고, 빠뜨리면 여기서 걸린다.
 *
 * ★예외는 **선언하고 이유를 적는다**(조용한 통과 금지). 지금 하나뿐이다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CAPS = path.join(REPO, "src/core/llm-runtime/capabilities");
const ADAPTERS = [
  "claude-agent-sdk.ts",
  "openai-agents-sdk.ts",
  "openai-codex-oauth.ts",
] as const;

/**
 * 어댑터 하나에만 있는 것이 **의도**인 경우 — 이유를 함께 적는다.
 * 이유를 못 적겠으면 그건 예외가 아니라 빠뜨린 것이다.
 */
const INTENTIONAL_SINGLE_ADAPTER = new Map<string, string>([
  [
    "createExternalToolsMcpServer",
    "게이트웨이 externalTools 캡처는 claude 전용 경로다 — codex·openai 는 SDK 가 함수 스키마를 그대로 받아 배열 concat 으로 끝나므로 MCP 서버가 필요 없다(external-tools.ts 헤더).",
  ],
]);

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  const factories: { name: string; file: string }[] = [];
  for (const e of await readdir(CAPS, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    const src = await readFile(path.join(CAPS, e.name), "utf8");
    for (const m of src.matchAll(/export const (create\w*McpServer)\b/g)) {
      factories.push({ name: m[1]!, file: e.name });
    }
  }

  // ★"0을 세면 그것도 실패" — 팩토리를 못 찾으면 이 검사는 아무것도 안 지킨 것이다.
  //  (파일 배치가 바뀌거나 명명 규칙이 바뀌면 조용히 빈손 초록이 된다.)
  out.push(
    assert(
      "능력 팩토리를 실제로 긁어왔다(빈손 통과 금지)",
      factories.length >= 12,
      `${factories.length}개 발견`,
    ),
  );
  if (factories.length === 0) return out;

  const sources = new Map<string, string>();
  for (const a of ADAPTERS) {
    sources.set(a, await readFile(path.join(REPO, "src/core/llm-runtime/adapters", a), "utf8"));
  }

  /**
   * 그 어댑터가 이 능력을 **실제로 등록**했나.
   *
   * ★단순 `includes` 로는 부족하다 — 변이 테스트에서 두 구멍이 드러났다:
   *  ①부분일치라 `createFooMcpServerXX` 로 이름이 갈려도 통과했고
   *  ②**import 만** 세니 등록 줄을 지우고 import 를 남기면 통과했다(더 현실적인 실수다).
   *  그래서 단어경계로 **2회 이상**(import 1 + 호출 1 이상)을 요구한다.
   */
  const registrations = (src: string, name: string): number =>
    src.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;

  const missing: string[] = [];
  const unusedExceptions: string[] = [];
  for (const f of factories) {
    const present = ADAPTERS.filter((a) => registrations(sources.get(a)!, f.name) >= 2);
    if (present.length === ADAPTERS.length) continue;
    const reason = INTENTIONAL_SINGLE_ADAPTER.get(f.name);
    if (reason !== undefined) continue;
    missing.push(
      `${f.name}(${f.file}) — 있는 곳: ${present.length === 0 ? "없음" : present.join(", ")}`,
    );
  }
  // 예외가 **낡았는지**도 본다 — 그 사이 세 곳 다 실렸으면 예외를 지워야 한다
  // (안 지우면 "예외가 있다" 는 사실만 남고 그 예외가 뭘 덮는지 아무도 모른다).
  for (const [name] of INTENTIONAL_SINGLE_ADAPTER) {
    const f = factories.find((x) => x.name === name);
    if (f === undefined) {
      unusedExceptions.push(`${name} — 그런 팩토리가 이제 없다(예외를 지워라)`);
      continue;
    }
    if (ADAPTERS.every((a) => registrations(sources.get(a)!, name) >= 2)) {
      unusedExceptions.push(`${name} — 이제 세 어댑터에 다 있다(예외를 지워라)`);
    }
  }

  out.push(
    assert(
      "★모든 능력이 세 어댑터에 전부 등록된다(하나만 빠지면 그 어댑터에선 조용히 사라진다)",
      missing.length === 0,
      missing.length === 0
        ? `${factories.length}개 중 ${factories.length - INTENTIONAL_SINGLE_ADAPTER.size}개 3어댑터 대칭 · 선언된 예외 ${INTENTIONAL_SINGLE_ADAPTER.size}개`
        : `★비대칭 ${missing.length}개:\n  ${missing.join("\n  ")}`,
    ),
  );
  out.push(
    assert(
      "선언된 예외가 아직 유효하다(낡은 예외가 남아 있지 않다)",
      unusedExceptions.length === 0,
      unusedExceptions.length === 0
        ? "예외 최신"
        : `★낡음:\n  ${unusedExceptions.join("\n  ")}`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "capability-adapter-parity",
  guards:
    "새 능력(in-process MCP 서버)을 어댑터 세 곳에 손으로 등록하다 하나를 빠뜨리는 것 — 그 어댑터에선 도구가 에러도 로그도 없이 사라지고 모델은 우회한다. 같은 부류가 models.reasoning(openai 만 안 읽음)·WebFetch prompt(codex 만 무시)로 이미 두 번 일어났다",
  run,
};
