/**
 * `codex-default-official-priority` 의 자식 — 실제 `refreshModelCatalog` 를 가짜 `/models` 로 돌리고, **새 프로세스**로
 * 재시작 직후(갱신 전) 첫 선택을 본다. ★자식인 이유: 홈 캐시 파일·인증 전역·`fetch`·모듈 캐시를 바꾼다.
 * 인자: <mode> <home> — home 은 부모가 만든 격리 홈 하위 폴더(모드끼리 디스크를 이어 쓴다). 출력: 마지막 줄 JSON.
 * 모드: 응답 모드(아래 RESPONSES — 그 응답으로 갱신) · 시각 모드(seed-old·age-global·age6·age8 — 디스크만 고치고 갱신 안 함) ·
 *  restart(아무것도 안 하고 갱신 없이 본다).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const mode = process.argv[2] ?? "";
const home = process.argv[3] ?? "";
const DAY = 86_400_000;

type Row = Record<string, unknown>;
/** 공식 번들 카탈로그와 같은 모양 — 배열 첫 원소가 priority 최소가 아니다. */
const BASE: Row[] = [
  { slug: "m-astra", priority: 2, visibility: "list" },
  { slug: "m-sol", priority: 1, visibility: "list" },
  { slug: "m-terra", priority: 7, visibility: "list" },
  { slug: "auto-review", priority: 0, visibility: "hide" },
];
/** BASE 에서 한 모델만 바꾼다 — 각 전이가 **그 필드 하나만** 바꾸게. */
const edit = (slug: string, f: (r: Row) => Row): Row[] => BASE.map((r) => (r["slug"] === slug ? f({ ...r }) : r));
const RESPONSES: Record<string, Row[] | "fail"> = {
  first: BASE,
  // 부수 메타(설계 강도·최저 강도·도구 검색)를 실은 기준 — 빈 성공 응답이 이것까지 교체하는지 볼 때만 쓴다.
  // ★BASE 에는 싣지 않는다: 최저 강도는 디스크에서 복원되지 않아(기존 `ensureLoaded`) 매 갱신이 «변경» 이 되고,
  //  그러면 «같은 응답 재성공도 성공 시각을 기록한다» 검사가 가려진다(독립 변이 M10 이 그렇게 살아남았다).
  "first-rich": edit("m-sol", (r) => ({ ...r, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }], supports_search_tool: true })),
  same: BASE,
  reprioritize: edit("m-terra", (r) => ({ ...r, priority: 0 })),
  hide: edit("m-sol", (r) => ({ ...r, visibility: "hide" })),
  "withdraw-priority": edit("m-astra", ({ priority: _p, ...r }) => r),
  "withdraw-visibility": edit("m-astra", ({ visibility: _v, ...r }) => r),
  "hidden-only": BASE.map((r) => ({ ...r, visibility: "hide" })),
  empty: [],
  fail: "fail",
};

const rewrite = (file: string, f: (o: Record<string, unknown>) => Record<string, unknown>): void =>
  writeFileSync(file, JSON.stringify(f(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)));
const withCodexSucceeded = (at: number) => (o: Record<string, unknown>): Record<string, unknown> =>
  ({ ...o, succeededAt: { ...((o["succeededAt"] as Record<string, number> | undefined) ?? {}), codex: at } });

const main = async (): Promise<void> => {
  assertIsolated();
  process.env.TIGUCLAW_HOME = home;
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) delete process.env[k];
  const file = path.join(home, "model-catalog.json");
  // 옛 캐시(메타·성공 시각 없음) + 다른 provider 의 키 하나(교체가 남의 키를 지우지 않는지 보려고).
  if (mode === "seed-old") {
    writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), models: { codex: ["m-astra", "m-sol"] }, priority: { "other:x": 3 }, visibility: { "other:x": "list" } }));
  }
  // 전역 fetchedAt 만 8일 전으로 — codex 신선도는 마지막 성공 시각으로 잰다.
  if (mode === "age-global") rewrite(file, (o) => ({ ...o, fetchedAt: Date.now() - 8 * DAY }));
  if (mode === "age6") rewrite(file, withCodexSucceeded(Date.now() - 6 * DAY));
  if (mode === "age8") rewrite(file, withCodexSucceeded(Date.now() - 8 * DAY));
  // 빈 성공 응답 — 다른 provider(anthropic)도 같은 빈 응답을 받는다. 그쪽은 종전처럼 «모름» 으로 건너뛰어야 한다.
  if (mode === "empty") {
    process.env.ANTHROPIC_API_KEY = "regression-fake-key";
    rewrite(file, (o) => ({
      ...o,
      models: { ...(o["models"] as Record<string, string[]>), anthropic: ["claude-opus-9"] },
      reasoning: { ...((o["reasoning"] as Record<string, string> | undefined) ?? {}), "anthropic:claude-opus-9": "high" },
      succeededAt: { ...((o["succeededAt"] as Record<string, number> | undefined) ?? {}), anthropic: 12_345 },
    }));
  }
  const response = RESPONSES[mode];
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: unknown): Promise<Response> => {
    if (!String(url).includes("/models") || response === undefined) return new Response("not found", { status: 404 });
    if (response === "fail") return new Response("busy", { status: 500 });
    return new Response(JSON.stringify({ models: response }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression.fake.token", isAuthenticated: () => true });
  const cat = await import("../../core/llm-runtime/model-catalog.js");
  // 선택은 갱신 **전**에 한 번 본다(재시작 직후 첫 턴) — 응답 모드면 갱신 뒤도 본다.
  const before = cat.catalogDefaultModel("codex") ?? null;
  if (response !== undefined) await cat.refreshModelCatalog();
  const { builtinPool, builtinModelProfiles, resolveModelProfiles } = await import("../../core/llm-runtime/builtin-profiles.js");
  const { resolveModelSpecs } = await import("../../core/llm-runtime/index.js");
  const codexOf = (specs: string[]): string | null => specs.find((s) => s.startsWith("codex:")) ?? null;
  const disk = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown> | undefined>;
  console.log(JSON.stringify({
    before,
    selected: cat.catalogDefaultModel("codex") ?? null,
    // 실행(첫 호출 풀) · `/models` 화면 · 대시보드 프로파일 — 셋이 같은 값이어야 한다.
    runtime: codexOf(resolveModelSpecs(undefined, home).map((s) => `${s.provider}:${s.model ?? ""}`)),
    pool: codexOf(builtinPool(home)),
    screen: codexOf((builtinModelProfiles(home)["default"]?.pool ?? []).map((e) => e.spec)),
    dashboard: codexOf((resolveModelProfiles(home).profiles["default"]?.pool ?? []).map((e) => e.spec)),
    // 표시 목록은 백엔드 순서 그대로(레코드 보존).
    models: (disk["models"]?.["codex"] as string[] | undefined) ?? null,
    diskPriority: disk["priority"] ?? null,
    diskVisibility: disk["visibility"] ?? null,
    diskSucceededAt: (disk["succeededAt"]?.["codex"] as number | undefined) ?? null,
    diskReasoning: disk["reasoning"] ?? null,
    diskFloor: disk["reasoningFloor"] ?? null,
    diskToolSearch: disk["toolSearch"] ?? null,
    diskAnthropic: { models: disk["models"]?.["anthropic"] ?? null, succeededAt: disk["succeededAt"]?.["anthropic"] ?? null },
    memReasoning: cat.resolveReasoningEffort("codex", "m-sol") ?? null,
    memToolSearch: cat.catalogSupportsToolSearch("codex", "m-sol") ?? null,
    now: Date.now(),
  }));
  process.exit(0);
};
main().catch((e) => {
  console.log(JSON.stringify({ error: String((e as Error)?.message ?? e).slice(0, 300) }));
  process.exit(0);
});
