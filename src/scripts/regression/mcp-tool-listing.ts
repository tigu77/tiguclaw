/**
 * 회귀: **인벤토리가 광고하는 MCP 도구 목록이 실제 서버와 일치한다** (2026-07-29).
 *
 * 사고: in-process MCP 도구 이름이 **두 곳에 하드코딩**돼 있었고 조용히 갈라졌다
 * (`memory-mcp.ts` 5개 — `search_memory` 누락 / `inventory.ts` 6개). 아무도 안 부르는
 * 쪽이라 타입체크·빌드·부팅 어디서도 안 걸렸고, 대시보드가 "이 서버는 이런 도구를
 * 제공합니다" 라고 **틀린 목록**을 보여줄 수 있는 상태였다.
 *
 * 하드코딩 자체는 남는다(inventory 는 단방향 import 계약상 memory-mcp 를 못 부른다).
 * 대신 **여기서 실제 서버에 물어보고 대조**한다 — 드리프트가 생기면 즉시 빨간불.
 */
import { collectInventory } from "../../core/plugins/inventory.js";
import { createMemoryMcpServer } from "../../core/memory-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "mcp-tool-listing",
  guards: "인벤토리의 MCP 도구 목록이 실제 서버와 갈라져 틀린 목록을 광고하던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const server = await adaptClaudeMcpServer(createMemoryMcpServer(), "memory");
    const tools = await server.listTools();
    const live = tools.map((t: { name: string }) => t.name).sort();
    const entry = (await collectInventory()).mcp.find((c) => c.name === "memory");
    const advertised = [...((entry?.metadata?.tools as string[] | undefined) ?? [])].sort();
    return [
      assert("memory MCP 항목이 인벤토리에 있다", entry !== undefined, String(entry?.source)),
      assert("실제 서버가 도구를 노출한다", live.length > 0, live.join(",")),
      assert(
        "광고 목록 == 실제 목록(드리프트 0)",
        advertised.length === live.length && advertised.every((n, i) => n === live[i]),
        `광고=[${advertised.join(",")}] 실제=[${live.join(",")}]`,
      ),
      assert(
        "도구마다 설명이 있다(대시보드 상세가 빈 칸이 되지 않게)",
        tools.every(
          (t: { description?: string }) =>
            typeof t.description === "string" && t.description.trim() !== "",
        ),
        `${live.length}개`,
      ),
    ];
  },
};
