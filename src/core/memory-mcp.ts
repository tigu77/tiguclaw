/**
 * 영역 코어 — in-process MCP memory 서버 + 쓰기 가드.
 *
 * memory.ts 분해(7b)로 추출 — 동작 무변경, 순수 이동.
 *  - `addMemoryWithGuard`: store.addMemory thin wrapper. UPSERT 결과 분류 + 이벤트 발행.
 *  - `memoryMcpServer`: SDK in-process MCP server 의 도구(read/add/update/delete +
 *    list_installed_plugins).
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
  searchMemories,
  updateMemory,
  type Memory,
  type MemoryType,
  archiveMemory,
  unarchiveMemory,
  listMemories,
} from "../store/memory.js";
import { getEventBus } from "./eventbus.js";
import { MEMORY_INDEX_CAP_BYTES } from "./prompt-assembly.js";
import { readMemoryIndexCapBytes } from "./settings.js";
import {
  searchConversations,
  browseConversationPeriod,
  parseDayBoundary,
  MIN_QUERY_LEN,
} from "./chat-search.js";
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

const searchMemoryTool = tool(
  "search_memory",
  "키워드·구절로 메모리를 능동 검색합니다(FTS, 관련도 순). 이름을 모르거나, 매 턴 자동 " +
    "주입되는 메모리에 원하는 게 안 보일 때 직접 찾는 용도. 아카이브·인덱스 캡에 밀린 콜드 " +
    "메모리도 도달. 반환 = 관련 메모리 배열(이름·설명·본문). 특정 이름의 전문이 필요하면 " +
    "read_memory 로 다시 fetch.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  },
  async (args) => {
    const hits = searchMemories(args.query, args.limit ?? 8);
    return okJson({
      ok: true,
      count: hits.length,
      memories: hits.map(memoryToJson),
    });
  },
);

/**
 * 지난 **대화**를 찾는다 — 메모리가 아니라 실제로 오간 말.
 *
 * ★왜 필요했나 (2026-08-25 사용자 신고): *"단검 이미지 만들어 달라고 한 게 언제였더라?"*
 *  에 비서가 **검색할 길이 없어** Claude Code 의 jsonl 을 grep 하고, 스크립트를 짜서 DB 를
 *  직접 열었다(29초). 대화 검색은 이미 만들어져 있었고 회귀도 있었지만 **화면에만** 붙어
 *  있었다 — 능력이 있는데 도구가 없으면 비서에겐 없는 것과 같다.
 * ★`search_memory` 의 형제로 둔다 — 둘은 같은 질문("전에 뭐라고 했지?")에 서로 다른
 *  저장소로 답한다([[project_capability_self_awareness]]).
 */
const searchConversationsTool = tool(
  "search_conversations",
  "지난 대화에서 실제로 오간 말을 검색합니다(전 세션·전 채널 가로질러, 최근 순). " +
    "「언제 ~라고 했지?」·「그때 뭐라고 답했더라?」·「전에 이 얘기 한 적 있나?」에 쓰는 " +
    "도구. 부분일치라 조사·어미가 붙어도 찾습니다. 반환 = 시각·세션·발화자·일치 주변 조각 " +
    "+ 전체 일치 수(목록엔 상한이 있으니 잘렸는지 알 수 있습니다). " +
    "★대화 기록을 찾을 땐 파일 검색이나 DB 접근을 직접 하지 말고 이 도구를 쓰세요.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional(),
    threadKey: z.string().optional(),
  },
  async (args) => {
    const r = await searchConversations(args.query, {
      limit: args.limit ?? 20,
      ...(args.threadKey !== undefined ? { threadKey: args.threadKey } : {}),
    });
    if (r.tooShort) {
      return okJson({ ok: false, error: "query_too_short", minLength: MIN_QUERY_LEN });
    }
    return okJson({
      ok: true,
      query: r.query,
      count: r.hits.length,
      total: r.total,
      truncated: r.total > r.hits.length,
      scope: r.scope,
      hits: r.hits.map((h) => ({
        at: new Date(h.ts).toISOString(),
        session: h.sessionLabel,
        threadKey: h.threadKey,
        channel: h.channel,
        role: h.role,
        text: h.snippet,
      })),
    });
  },
);

/**
 * **그 무렵 무슨 얘기를 했나** — 키워드가 없을 때의 길 (2026-08-25 사용자 요청).
 *
 * ★`search_conversations` 와 **다른 질문**이라 도구를 나눈다. 저쪽은 *"언제 X 얘기했지?"*,
 *  이쪽은 *"2주 전에 주로 뭘 했지?"* 다. 실측: 기간 훑기가 없을 때 비서는 키워드를 짐작해
 *  `search_conversations` 를 **한 턴에 56회** 불렀다(답은 맞았지만 그건 운이다).
 * ★요약 LLM 을 부르지 않는다 — **세션 표시명이 곧 그 대화의 주제**다(커스텀 이름 > 첫 발화).
 *  이미 있는 판단으로 답이 서는데 새 판단을 만들 이유가 없다.
 */
const listConversationsTool = tool(
  "list_conversations",
  "기간을 주면 그때 오간 대화를 **세션(주제)별로 묶어** 보여줍니다. 많이 오간 순. " +
    "「2주 전에 주로 무슨 얘기 했지?」·「저번 달에 집중한 주제는?」·「지난주에 뭐 했더라?」처럼 " +
    "**키워드가 없는** 회상에 쓰는 도구 — 그럴 때 search_conversations 로 단어를 짐작해 " +
    "여러 번 두드리지 마세요. 반환 = 주제(세션 이름)·메시지 수·기간·채널 + 전체 세션 수. " +
    "구체적인 대목이 필요하면 그 다음에 search_conversations 로 파고드세요. " +
    "날짜는 `YYYY-MM-DD`(로컬 날짜) 또는 ISO 시각.",
  {
    since: z.string().min(4),
    until: z.string().min(4).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async (args) => {
    const sinceTs = parseDayBoundary(args.since);
    if (sinceTs === null) return okJson({ ok: false, error: "bad_since", got: args.since });
    const untilTs =
      args.until === undefined ? Date.now() : parseDayBoundary(args.until, true);
    if (untilTs === null) return okJson({ ok: false, error: "bad_until", got: args.until });
    if (untilTs < sinceTs) return okJson({ ok: false, error: "until_before_since" });
    const r = await browseConversationPeriod(sinceTs, untilTs, { limit: args.limit ?? 30 });
    const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    return okJson({
      ok: true,
      period: { from: day(r.sinceTs), to: day(r.untilTs) },
      totalSessions: r.totalSessions,
      totalMessages: r.totalMessages,
      shown: r.sessions.length,
      truncated: r.totalSessions > r.sessions.length,
      sessions: r.sessions.map((x) => ({
        topic: x.topic,
        messages: x.messages,
        from: day(x.firstTs),
        to: day(x.lastTs),
        channel: x.channel,
        threadKey: x.threadKey,
      })),
    });
  },
);

const addMemoryTool = tool(
  "add_memory",
  // ★설명은 **판정만** 담는다 — 이유·실측은 헌법 §4 가 정본이다(2026-09-02 감사 축①).
  //  종전엔 이 설명이 헌법의 근거 문단을 통째로 복창해서 «같은 판단이 세 곳» 이었다.
  //  판정은 결정 지점에 있어야 지켜지고(축⑩ 도달), 이유는 한 곳에만 있으면 된다.
  "새 메모리 추가 또는 동일 name 존재 시 UPSERT. 사용자에게 「기억할까요?」 묻지 말고 즉시 호출. " +
    "★**여기는 «사실» 자리다.** 두 질문으로 가른다: ①필요한 순간에 대화에 **그걸 찾을 낱말이 " +
    "있나** ②안 실렸을 때 **사용자가 겪나**. 「등산 취미」=여기. 「항상 존댓말」·「자동 푸시 " +
    "금지」처럼 둘 다 아니면 **전역은 `<home>/AGENT.md`, 프로젝트 것은 그 폴더** " +
    "(근거는 헌법 §4 「규범은 여기 두지 마라」). 애매하면 규범 쪽으로 — 잘못 올리면 조금 " +
    "커질 뿐이지만 잘못 넣으면 조용히 사라진다.",
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

/**
 * **인덱스 재기 — 정리의 첫 걸음** (2026-09-02).
 *
 * ★없어서 스킬이 못 돌았다. `memory-tidy` 를 만들고 **실제로 돌려보니** 첫 단계(«먼저
 *  잰다»)에서 멈췄다 — 비서에게 열린 건 `read_memory`(이름 하나)·`search_memory`(질의)
 *  뿐이라 **전체를 셀 방법이 없었고**, 셸로 DB 를 직접 읽으려다 승인 게이트에 걸렸다.
 *  스킬은 있는데 도달 경로가 0이었던 것이다.
 *
 * ★**읽기 전용**이다 — `bumpAccess` 를 부르지 않는다(`getMemory` 와 다르다). 세는 행위가
 *  hot 순위를 바꾸면 «재는 것이 재는 대상을 바꾸는» 상태가 되고, 인덱스가 시스템 채널에
 *  실린 지금은 그게 곧 **캐시 무효화**다.
 * ★본문(`body`)은 안 싣는다 — 정리 판단에 필요한 건 «무엇이 얼마나 차지하나» 이고,
 *  본문까지 실으면 이 도구 한 번이 인덱스보다 커진다(197건 × 본문 = 수십 KB).
 */
const listMemoriesTool = tool(
  "list_memories",
  "메모리 인덱스를 **세어서** 반환(읽기 전용, 본문 제외). 이름·종류·설명·읽힌 횟수·" +
    "인덱스 바이트 + 총량·캡. 정리(memory-tidy)·용량 점검에 쓴다. " +
    "`includeArchived:true` 면 아카이브분도 본다.",
  { includeArchived: z.boolean().optional() },
  async (args) => {
    const rows = listMemories({
      limit: 10_000,
      ...(args.includeArchived === true ? { includeArchived: true } : {}),
    });
    const line = (m: { type: string; name: string; description?: string }): number =>
      Buffer.byteLength(`- [${m.type}] ${m.name}: ${m.description ?? ""}`, "utf8") + 1;
    const items = rows.map((m) => ({
      type: m.type,
      name: m.name,
      description: m.description ?? "",
      accessCount: (m as { accessCount?: number }).accessCount ?? 0,
      indexBytes: line(m),
    }));
    const totalBytes = items.reduce((a, b) => a + b.indexBytes, 0);
    return okJson({
      ok: true,
      total: items.length,
      totalIndexBytes: totalBytes,
      capBytes: readMemoryIndexCapBytes(MEMORY_INDEX_CAP_BYTES),
      items,
    });
  },
);

/**
 * **아카이브 — 정리의 안전한 원시 동작** (2026-09-02).
 *
 * ★왜 필요한가: 메모리 정리(중복 병합·만료 정리)를 하려는데 비서에게 열려 있는 건
 *  `delete_memory` **물리 삭제뿐**이었다. 그러면 정리 스킬이 구조적으로 되돌릴 수 없는
 *  길을 쓰게 된다 — 「이건 중복이다」가 한 번 틀리면 규칙이 조용히 사라진다.
 *
 * ★아카이브는 **인덱스에서만 빼고 도달은 유지**한다: `listMemoriesForIndex` 는
 *  `archived_at IS NULL` 만 싣지만 FTS(`searchMemories`)는 아카이브분도 계속 찾는다.
 *  즉 «매 턴 실리지 않을 뿐 잃지는 않는다» — 정리에 정확히 맞는 성질이다.
 * ★그리고 되돌릴 수 있다(`unarchive`). 파괴적 행위는 승인이 필요하지만, 되돌릴 수 있는
 *  행위는 그 문턱이 낮아진다([[project_self_observation_sweep]] — 기준은 확신이 아니라
 *  «되돌릴 수 있는가»).
 * ★self-growth 는 이미 같은 판단을 했다(회귀 `growth-loop-closes` 가 «물리 삭제 아님» 을
 *  못 박는다). 사람이 쓴 메모리에도 같은 규범을 준다.
 */
const archiveMemoryTool = tool(
  "archive_memory",
  "메모리를 인덱스에서 내린다(삭제 아님 — 검색으로는 계속 찾히고 되돌릴 수 있다). " +
    "중복 병합·만료 정리에 쓴다. `restore:true` 면 되돌린다. 없는 name 은 멱등.",
  { name: z.string().min(1), restore: z.boolean().optional() },
  async (args) => {
    const m = args.restore === true ? unarchiveMemory(args.name) : archiveMemory(args.name);
    return okJson({
      ok: true,
      found: m !== undefined,
      archived: args.restore !== true,
      name: args.name,
    });
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
 * 쪽 callTool 을 죽인다(부모 턴 종료 finally 가 매니저 인스턴스 close → 매니저 도구 hang).
 * 그래서 어댑터는 턴/쿼리마다 이 팩토리로 전용 인스턴스를 만든다. 도구는 무상태
 * 클로저(모듈/DB 상태 참조)라 재생성 비용 0. 형제 서버 9종과 동일한 팩토리 패턴.
 */
const MEMORY_TOOLS = [
  readMemoryTool,
  searchMemoryTool,
  searchConversationsTool,
  listConversationsTool,
  addMemoryTool,
  updateMemoryTool,
  deleteMemoryTool,
  listMemoriesTool,
  archiveMemoryTool,
  listInstalledPluginsTool,
];

/**
 * 이 서버가 내보내는 도구 이름 — **인벤토리가 이걸 읽는다.**
 *
 * ★종전엔 `plugins/inventory.ts` 에 같은 이름 여섯 개가 **손으로** 적혀 있었다. 도구를
 *  하나 더 붙이면서 그 목록을 안 고치면 인벤토리가 조용히 거짓말을 한다 — 이름을 열거하려는
 *  순간 정의점에서 파생시킨다([[feedback_hand_maintained_lists]]).
 */
export const memoryToolNames = (): string[] => MEMORY_TOOLS.map((t) => t.name);

export const createMemoryMcpServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({ name: "memory", version: "1.0.0", tools: MEMORY_TOOLS });
