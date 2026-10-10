/**
 * 회귀: **MCP 목록은 서버에 건네는 열쇠를 싣지 않는다** (2026-10-09, 전체 적대 검토 P2).
 *
 * ★사고: `collectMcp` 가 `mcp.json` 의 서버 설정을 통째로 펼쳐 `/inventory` 응답에 실었다.
 *  그런데 `env`·`headers` 가 바로 MCP 서버에 열쇠를 건네는 자리다(`API_KEY`·
 *  `Authorization: Bearer …`) — 그 응답은 브라우저로 나간다.
 *
 * 지키는 것 둘:
 *  ① `env`·`headers` 의 **값이 응답 어디에도 없다**.
 *  ② «무엇을 어떻게 띄우나»(command·args·url)는 그대로 보인다(목록이 쓸모없어지면 안 된다).
 *
 * 등급: **동작** — 임시 홈에 `mcp.json` 을 놓고 실제 `collectInventory()` 를 돌린다.
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../../core/paths.js";
import { collectInventory } from "../../core/plugins/inventory.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "inventory-mcp-hides-secrets",
  guards:
    "mcp.json 서버 설정의 env·headers(API 키·Bearer 토큰)가 /inventory 응답에 그대로 실려 브라우저로 나가던 것(2026-10-09 전체 적대 검토)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const file = path.join(getPaths().home, "mcp.json");
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcpServers: {
            "regr-stdio": { command: "regr-mcp-bin", args: ["--x"], env: { API_KEY: "sk-regr-env-leak" } },
            "regr-http": { type: "http", url: "https://mcp.regr.test", headers: { Authorization: "Bearer regr-header-leak" } },
          },
        }),
      );
      const inv = await collectInventory();
      const rows = inv.mcp.filter((m) => m.name.startsWith("regr-"));
      const json = JSON.stringify(inv);
      out.push(
        assert(
          "★★`env`·`headers` 의 값이 /inventory 응답 **어디에도** 없다 — 이 응답은 브라우저로 나간다",
          rows.length === 2 && !json.includes("sk-regr-env-leak") && !json.includes("regr-header-leak"),
          `행 ${String(rows.length)}개 · env 유출=${String(json.includes("sk-regr-env-leak"))} · headers 유출=${String(json.includes("regr-header-leak"))}`,
        ),
      );
      const stdio = rows.find((m) => m.name === "regr-stdio")?.metadata as Record<string, unknown> | undefined;
      const http = rows.find((m) => m.name === "regr-http")?.metadata as Record<string, unknown> | undefined;
      out.push(
        assert(
          "★«무엇을 어떻게 띄우나» 는 그대로 보인다 — command·args·url",
          stdio?.["command"] === "regr-mcp-bin" &&
            JSON.stringify(stdio?.["args"]) === '["--x"]' &&
            http?.["url"] === "https://mcp.regr.test",
          `stdio=${JSON.stringify(stdio)} · http=${JSON.stringify(http)}`,
        ),
      );
    } finally {
      await rm(file, { force: true });
    }
    return out;
  },
};
