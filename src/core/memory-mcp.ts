/**
 * 영역 코어 — in-process MCP memory 서버 + 쓰기 가드.
 *
 * memory.ts 분해(7b)로 추출 — 동작 무변경, 순수 이동.
 *  - `addMemoryWithGuard`: store.addMemory thin wrapper. UPSERT 결과 분류 + 이벤트 발행.
 *  - `memoryMcpServer`: SDK in-process MCP server 의 도구(read/add/update/delete +
 *    list_installed_plugins).
 *  - `getInProcessMcpServers`: in-process MCP server 메타 (inventory 용 단일 진실 소스).
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  addMemory,
  deleteMemory,
  getMemory,
  updateMemory,
  type Memory,
  type MemoryType,
} from "../store/memory.js";
import { getEventBus } from "./eventbus.js";
import {
  collectInventory,
  formatInventoryForLlm,
} from "./plugins/inventory.js";

// ─── addMemoryWithGuard ──────────────────────────────────────────────────
// store 의 addMemory 가 UPSERT(name) — 여기서는 결과 분류만.
// V1 publish 범위: 가장 흔한 경로(add/update)만. delete/extract 는 V2.
export const addMemoryWithGuard = async (
  input: Parameters<typeof addMemory>[0],
): Promise<{ memory: Memory; updated: boolean }> => {
  const before = getMemory(input.name);
  const memory = addMemory(input);
  getEventBus().publish({
    type: "memory.write",
    ts: Date.now(),
    payload: {
      name: memory.name,
      memoryType: memory.type,
      action: before === undefined ? "add" : "update",
    },
  });
  return { memory, updated: before !== undefined };
};

// ─── V3 도구 4종 — SDK in-process MCP server (contract §2.1·§2.2) ────────
// SDK 결정 (c): `createSdkMcpServer` + `tool` helper. 별 프로세스 0, schema 자연 노출.
// SDK 가 노출하는 외부 이름은 `mcp__memory__{tool_name}` — 권한 게이트가
// disallowedTools 에 그 이름으로 추가하면 차단 가능 (V1 권한 게이트 호환).

const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

const okJson = (
  obj: unknown,
): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: JSON.stringify(obj) }],
});

const memoryToJson = (m: Memory) => ({
  type: m.type,
  name: m.name,
  description: m.description,
  body: m.body,
  created_at: m.createdAt,
  updated_at: m.updatedAt,
});

const readMemoryTool = tool(
  "read_memory",
  "단일 메모리의 전체 본문(body 포함)을 반환합니다. name 은 인덱스에서 확인한 정확한 slug.",
  { name: z.string().min(1) },
  async (args) => {
    const m = getMemory(args.name);
    if (m === undefined) return okJson({ ok: false, error: "not_found" });
    return okJson({ ok: true, memory: memoryToJson(m) });
  },
);

const addMemoryTool = tool(
  "add_memory",
  "새 메모리 추가 또는 동일 name 존재 시 UPSERT. 사용자에게 「기억할까요?」 묻지 말고 즉시 호출.",
  {
    type: z.enum(MEMORY_TYPES),
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case slug (영문 소문자/숫자/하이픈)"),
    description: z.string().min(1).max(80),
    body: z.string().max(4096),
  },
  async (args) => {
    // self-growth 발동 경로: addMemoryWithGuard 가 before 유무로 add/update
    // action 을 판별해 `memory.write` 이벤트를 발행한다 (raw addMemory 는 발행 0).
    const { memory, updated } = await addMemoryWithGuard({
      type: args.type as MemoryType,
      name: args.name,
      description: args.description,
      body: args.body,
    });
    return okJson({ ok: true, name: memory.name, updated });
  },
);

const updateMemoryTool = tool(
  "update_memory",
  "기존 메모리 부분 갱신. patch 에 명시된 필드만 변경, 누락 필드는 보존.",
  {
    name: z.string().min(1),
    patch: z.object({
      description: z.string().min(1).max(80).optional(),
      body: z.string().max(4096).optional(),
      type: z.enum(MEMORY_TYPES).optional(),
    }),
  },
  async (args) => {
    const patch: {
      description?: string;
      body?: string;
      type?: MemoryType;
    } = {};
    if (args.patch.description !== undefined)
      patch.description = args.patch.description;
    if (args.patch.body !== undefined) patch.body = args.patch.body;
    if (args.patch.type !== undefined) patch.type = args.patch.type as MemoryType;
    const m = updateMemory(args.name, patch);
    if (m === undefined) return okJson({ ok: false, error: "not_found" });
    // self-growth drift 발동 경로: update 시 `memory.write`(action:"update") 발행.
    // updateMemory 는 partial patch 시그니처라 addMemoryWithGuard(full add input)와
    // 맞지 않아, 동일 payload shape (name/memoryType/action) 로 직접 발행한다.
    getEventBus().publish({
      type: "memory.write",
      ts: Date.now(),
      payload: {
        name: m.name,
        memoryType: m.type,
        action: "update",
      },
    });
    return okJson({ ok: true, name: m.name, updated_at: m.updatedAt });
  },
);

const deleteMemoryTool = tool(
  "delete_memory",
  "메모리 영구 삭제. 없는 name 도 멱등 (deleted:false).",
  { name: z.string().min(1) },
  async (args) => {
    const deleted = deleteMemory(args.name);
    return okJson({ ok: true, deleted });
  },
);

// ─── Phase B Inventory V1 — list_installed_plugins 도구 ──────────────────
// contract `_workspace/phaseB_inventory_architect_contract.md` §4. 단일 in-process
// MCP server 일관 — V3 memoryTools 옆에 같은 server 로 추가. SDK 외부 노출 이름:
// `mcp__memory__list_installed_plugins`.
const listInstalledPluginsTool = tool(
  "list_installed_plugins",
  "tiguclaw 의 설치·활성 플러그인 전체 목록을 반환. 채널·외부 plugin·스킬·에이전트·MCP 5 카테고리.",
  {},
  async () => {
    const inv = await collectInventory();
    return {
      content: [{ type: "text", text: formatInventoryForLlm(inv) }],
    };
  },
);

/**
 * SDK in-process MCP server 팩토리 — **호출마다 새 인스턴스**.
 *
 * ★공유 금지 (2026-07-03): McpServer 인스턴스는 transport 를 하나만 물 수 있어,
 * 하나의 싱글턴을 여러 브리지/쿼리가 동시에 connect/close 하면 한쪽 close 가 다른
 * 쪽 callTool 을 죽인다(부모 턴 종료 finally 가 워커 인스턴스 close → 워커 도구 hang).
 * 그래서 어댑터는 턴/쿼리마다 이 팩토리로 전용 인스턴스를 만든다. 도구는 무상태
 * 클로저(모듈/DB 상태 참조)라 재생성 비용 0. 형제 서버 9종과 동일한 팩토리 패턴.
 */
export const createMemoryMcpServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: [
      readMemoryTool,
      addMemoryTool,
      updateMemoryTool,
      deleteMemoryTool,
      listInstalledPluginsTool,
    ],
  });

// ─── in-process MCP server 메타 — inventory.ts (e) (ii) 의 hardcode 대신
// 향후 다중 server 도입 시 본 export 가 단일 진실 소스가 되도록 미리 export.
// V1 단계 inventory.ts 는 contract §결정 5 (단방향 import) 로 hardcode 사용.
export const getInProcessMcpServers = (): {
  name: string;
  tools: string[];
}[] => [
  {
    name: "memory",
    tools: [
      "read_memory",
      "add_memory",
      "update_memory",
      "delete_memory",
      "list_installed_plugins",
    ],
  },
];
