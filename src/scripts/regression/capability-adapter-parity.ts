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
 *  - `WebFetch` 의 `prompt` 무시가 codex 에만 있어 20일간 22건 전부 틀렸다.
 *
 * ★**목록이 아니라 판정이다**([[feedback_hand_maintained_lists]]). 능력 이름을 여기 적지
 *  않는다. 판정 단위는 **파일**이다: `createSdkMcpServer(` 를 부르는 파일이 곧 능력이고,
 *  그 파일의 export 중 **하나라도** 세 어댑터에 닿아야 한다.
 *
 * ★첫 판은 **이름**(`create\w*McpServer`)으로 셌는데 적대 검토가 세 방향으로 뚫었다(F1):
 *  ①주석 안의 이름이 세어져 — 등록을 지우고 `// TODO: createXMcpServer` 한 줄만 남기면
 *    통과했다(18개 팩토리가 전부 정확히 2회라 여유가 0이었다). [[feedback_gate_must_actually_run]]
 *    의 *"검사 대상은 마크업이지 그걸 설명하는 글이 아니다"* 가 방향만 뒤집혀 재현된 것.
 *  ②명명 규칙 밖(`buildXServer`)은 대상에서 조용히 빠졌다.
 *  ③`readdir` 이 비재귀라 `capabilities/<하위폴더>/` 는 존재 자체가 안 보였다.
 *  셋 다 여기서 닫는다 — 주석 제거 · 파일 단위 판정 · 재귀 스캔.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CAPS = path.join(REPO, "src/core/llm-runtime/capabilities");
const ADAPTERS = [
  "claude-agent-sdk.ts",
  "openai-agents-sdk.ts",
  "openai-codex-oauth.ts",
] as const;

/**
 * 어댑터 하나에만 있는 것이 **의도**인 경우 — 파일명 → 이유.
 * 이유를 못 적겠으면 그건 예외가 아니라 빠뜨린 것이다.
 */
const INTENTIONAL_SINGLE_ADAPTER = new Map<string, string>([
  [
    "external-tools.ts",
    "게이트웨이 externalTools 캡처는 claude 전용 경로다 — codex·openai 는 SDK 가 함수 스키마를 그대로 받아 배열 concat 으로 끝나므로 MCP 서버가 필요 없다(external-tools.ts 헤더).",
  ],
]);

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ★주석을 걷어내고 본다 — 주석은 코드가 아니라 코드에 대한 **글**이다.
  const files = new Map<string, string>();
  for (const p of await walk(CAPS)) {
    files.set(path.relative(CAPS, p), stripComments(await readFile(p, "utf8")));
  }

  const capFiles = [...files].filter(([, src]) => src.includes("createSdkMcpServer("));
  const toolFiles = [...files].filter(([, src]) => /\btool\(/.test(src));

  // ★"0을 세면 그것도 실패" — 능력을 못 찾으면 이 검사는 아무것도 안 지킨 것이다.
  out.push(
    assert(
      "능력 파일을 실제로 찾았다(빈손 통과 금지)",
      capFiles.length >= 12,
      `${capFiles.length}개 (도구 정의 파일 ${toolFiles.length}개 중)`,
    ),
  );
  if (capFiles.length === 0) return out;

  // ★완성도 판정 — 도구를 정의하는데 SDK 서버를 안 만드는 파일이 있으면, 그건 이 검사가
  //  **못 보는 방식으로 만들어진 능력**이거나 판정 기준이 낡은 것이다. 어느 쪽이든 말해야 한다.
  const toolButNotCap = toolFiles
    .map(([f]) => f)
    .filter((f) => !capFiles.some(([c]) => c === f));
  out.push(
    assert(
      "★도구를 정의하는 파일은 전부 능력으로 잡힌다(판정을 우회하는 능력이 없다)",
      toolButNotCap.length === 0,
      toolButNotCap.length === 0
        ? `도구 파일 ${toolFiles.length}개 전부 포착`
        : `★안 잡힌 파일: ${toolButNotCap.join(" ")} — 이 검사가 못 보는 방식으로 능력이 만들어졌다`,
    ),
  );

  const sources = new Map<string, string>();
  for (const a of ADAPTERS) {
    sources.set(
      a,
      stripComments(
        await readFile(path.join(REPO, "src/core/llm-runtime/adapters", a), "utf8"),
      ),
    );
  }

  /**
   * 그 어댑터가 이 능력 파일을 **실제로 등록**했나 — 파일의 export 중 하나가 2회 이상
   * (import 1 + 호출 1 이상) 나오면 등록으로 본다.
   *
   * ★2회를 요구하는 이유: import 만 남기고 등록 줄을 지우는 게 가장 현실적인 실수다
   *  (변이 테스트에서 실제로 그것만 통과했다).
   */
  const usesFile = (adapterSrc: string, fileSrc: string): boolean => {
    const exports = [...fileSrc.matchAll(/export const (\w+)/g)].map((m) => m[1]!);
    return exports.some(
      (name) => (adapterSrc.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0) >= 2,
    );
  };

  const missing: string[] = [];
  const staleExceptions: string[] = [];
  for (const [file, src] of capFiles) {
    const present = ADAPTERS.filter((a) => usesFile(sources.get(a)!, src));
    if (present.length === ADAPTERS.length) {
      if (INTENTIONAL_SINGLE_ADAPTER.has(file)) {
        staleExceptions.push(`${file} — 이제 세 어댑터에 다 있다(예외를 지워라)`);
      }
      continue;
    }
    if (INTENTIONAL_SINGLE_ADAPTER.has(file)) continue;
    missing.push(`${file} — 있는 곳: ${present.length === 0 ? "없음" : present.join(", ")}`);
  }
  for (const [file] of INTENTIONAL_SINGLE_ADAPTER) {
    if (!capFiles.some(([f]) => f === file)) {
      staleExceptions.push(`${file} — 그런 능력 파일이 이제 없다(예외를 지워라)`);
    }
  }

  out.push(
    assert(
      "★모든 능력이 세 어댑터에 전부 등록된다(하나만 빠지면 그 어댑터에선 조용히 사라진다)",
      missing.length === 0,
      missing.length === 0
        ? `능력 ${capFiles.length}개 · 3어댑터 대칭 ${capFiles.length - INTENTIONAL_SINGLE_ADAPTER.size}개 · 선언된 예외 ${INTENTIONAL_SINGLE_ADAPTER.size}개`
        : `★비대칭 ${missing.length}개:\n  ${missing.join("\n  ")}`,
    ),
  );
  out.push(
    assert(
      "선언된 예외가 아직 유효하다(낡은 예외가 남아 있지 않다)",
      staleExceptions.length === 0,
      staleExceptions.length === 0 ? "예외 최신" : `★낡음:\n  ${staleExceptions.join("\n  ")}`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "capability-adapter-parity",
  guards:
    "새 능력(in-process MCP 서버)을 어댑터 세 곳에 손으로 등록하다 하나를 빠뜨리는 것 — 그 어댑터에선 도구가 에러도 로그도 없이 사라지고 모델은 우회한다. 같은 부류가 models.reasoning(openai 만 안 읽음)·WebFetch prompt(codex 만 무시)로 이미 두 번 일어났다. 판정은 파일 단위(createSdkMcpServer 를 부르는 파일)라 팩토리를 개명해도 빠져나가지 못하고, 주석은 세지 않는다",
  run,
};
