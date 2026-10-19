/**
 * `catalog-tool-search-refresh` 의 자식 — 실제 `refreshModelCatalog` 를 가짜 네트워크로 돌린다(아스트라 10-19).
 * ★자식인 이유: 홈 캐시 파일·인증 전역·`fetch` 를 바꾼다. 모드: ok(조회 성공) · fail(조회 실패). 출력: 마지막 줄 JSON.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const mode = process.argv[2] ?? "ok";
const main = async (): Promise<void> => {
  assertIsolated();
  process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "catalog-"));
  const file = path.join(process.env.TIGUCLAW_HOME, "model-catalog.json");
  // 옛 캐시 — 둘 다 지원(true) · 다른 공급자 키 하나.
  writeFileSync(file, JSON.stringify({ fetchedAt: Date.now() - 86_400_000, models: { codex: ["m1", "m2"] }, toolSearch: { "codex:m1": true, "codex:m2": true, "other:x": true } }));
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: unknown): Promise<Response> => {
    if (!String(url).includes("/models")) return new Response("not found", { status: 404 });
    if (mode === "fail") return new Response("busy", { status: 500 });
    // m1 은 필드가 **사라졌고** m2 는 명시적 false.
    return new Response(JSON.stringify({ models: [{ slug: "m1" }, { slug: "m2", supports_search_tool: false }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression.fake.token", isAuthenticated: () => true });
  const cat = await import("../../core/llm-runtime/model-catalog.js");
  await cat.refreshModelCatalog();
  const disk = (JSON.parse(readFileSync(file, "utf8")) as { toolSearch?: Record<string, boolean> }).toolSearch ?? {};
  console.log(JSON.stringify({
    m1: cat.catalogSupportsToolSearch("codex", "m1") ?? null,
    m2: cat.catalogSupportsToolSearch("codex", "m2") ?? null,
    other: cat.catalogSupportsToolSearch("other", "x") ?? null,
    disk,
  }));
  process.exit(0);
};
main().catch((e) => {
  console.log(JSON.stringify({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
  process.exit(0);
});
