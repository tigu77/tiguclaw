/**
 * 영역 코어 — 메모리 헬퍼 (contract `_workspace/memory_round2_architect_contract.md` region 부분).
 *
 * V1+V2:
 *  - `addMemoryWithGuard`: store.addMemory thin wrapper. UPSERT 결과 분류만.
 *  - `retrieveContext`: searchMemories(query) (+ 선택적 transcripts 검색).
 *  - `formatMemorySnippet`: user prompt 앞에 prepend 할 텍스트 블록 생성.
 *
 * V3 (Round 2):
 *  - `readBrain` / `brainSizeWarning`: 1층 self markdown (`data/brain/BRAIN.md`).
 *  - `formatMemoryIndex`: 모든 memories 의 1줄 인덱스 (LLM-as-retriever 의 progressive disclosure).
 *  - `memoryTools`: SDK in-process MCP server 의 4 도구 (read/add/update/delete).
 *
 *  V2 fire-and-forget haiku 자동 추출은 deprecate (contract §2.5) — LLM 자기 도구 호출로 대체.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, ChannelName } from "../channels/types.js";
import {
  addMemory,
  deleteMemory,
  getMemory,
  listMemories,
  listMemoriesForIndex,
  searchMemories,
  searchTranscripts,
  updateMemory,
  type Memory,
  type MemoryType,
  type TranscriptHit,
} from "../store/memory.js";
import { getPaths } from "./paths.js";
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

// ─── retrieveContext ─────────────────────────────────────────────────────
export interface RetrieveContextOptions {
  limit?: number;
  includeTranscripts?: boolean;
}

export interface RetrievedContext {
  memories: Memory[];
  transcripts?: TranscriptHit[];
}

const DEFAULT_LIMIT = 5;
const ALWAYS_RECENT_MEMS = 10;

// V2.5 trigram 이 한국어 3-gram 부분 매치를 회복했지만 2자 미만 쿼리는
// trigram 의 본질적 한계로 매치 0 (store-auth spike §4). listMemories 합집합 안전망 유지.
const mergeMemories = (
  searched: readonly Memory[],
  recent: readonly Memory[],
  cap: number,
): Memory[] => {
  const out: Memory[] = [];
  const seen = new Set<number>();
  for (const m of searched) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length >= cap) return out;
  }
  for (const m of recent) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length >= cap) return out;
  }
  return out;
};

// V8 통합 — recentMessages(messages 테이블) 경로 제거. channel/threadKey 는
// 호출부 무변경(회귀 0)을 위해 시그니처에 남기지만 본문에선 미사용 (대화 연속성은
// 어댑터의 SDK 세션 resume + transcripts 검색이 보장).
export const retrieveContext = (
  _channel: ChannelName,
  _threadKey: string,
  query: string,
  opts?: RetrieveContextOptions,
): RetrievedContext => {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const searched =
    query.trim().length > 0 ? searchMemories(query, limit) : [];
  const recent = listMemories({ limit: ALWAYS_RECENT_MEMS, orderBy: "updated" });
  const memories = mergeMemories(searched, recent, ALWAYS_RECENT_MEMS);

  const out: RetrievedContext = { memories };
  if (opts?.includeTranscripts === true) {
    out.transcripts = searchTranscripts(query, { limit });
  }
  return out;
};

// ─── formatMemorySnippet — user prompt prepend 본문 ──────────────────────
const SNIPPET_HARD_CAP = 1500;
const PER_ITEM_BODY_CAP = 240;
const PER_MSG_CAP = 200;

const truncate = (s: string, cap: number): string =>
  s.length <= cap ? s : `${s.slice(0, cap - 1)}…`;

export const formatMemorySnippet = (ctx: RetrievedContext): string => {
  const parts: string[] = [];

  if (ctx.memories.length > 0) {
    const lines = ["## 관련 메모리"];
    for (const m of ctx.memories) {
      lines.push(`- [${m.name}] ${m.description}`);
      if (m.body.trim().length > 0) {
        lines.push(`  ${truncate(m.body.replace(/\s+/g, " "), PER_ITEM_BODY_CAP)}`);
      }
    }
    parts.push(lines.join("\n"));
  }

  if (ctx.transcripts !== undefined && ctx.transcripts.length > 0) {
    const lines = ["## 관련 과거 대화"];
    for (const t of ctx.transcripts) {
      lines.push(`[${t.role}] ${truncate(t.content, PER_MSG_CAP)}`);
    }
    parts.push(lines.join("\n"));
  }

  if (parts.length === 0) return "";

  let snippet = parts.join("\n\n");
  if (snippet.length > SNIPPET_HARD_CAP) {
    snippet = `${snippet.slice(0, SNIPPET_HARD_CAP - 1)}…`;
  }
  return snippet;
};

// ─── AGENT.md (1층 self markdown) — 런타임 홈의 인격 hub ──────────────────
// CC 의 CLAUDE.md 와 동형 패턴. 매 turn 자동 prepend. 비서가 SDK Read 도구로
// 본문 안에서 reference 한 하위 markdown 을 lazy import — AGENT.md 는 hub.
// V9.4 — 경로를 `getPaths().agentMd`(런타임 홈) 로 lazy 호출. 이전 `process.cwd()/AGENT.md`
//  const 는 모듈 로드 시점(ensureHome 이전) 평가 위험이 있어 제거. readAgent 가 매 turn
//  런타임 시점에 호출되고 getPaths 는 freeze 캐시라 재계산 비용 0.
export const AGENT_SIZE_WARN_BYTES = 4096;

/** 파일이 없으면 빈 문자열, 있으면 본문. fs 예외는 빈 문자열로 swallow. */
export const readAgent = (): string => {
  try {
    return fs.readFileSync(getPaths().agentMd, "utf8");
  } catch {
    return "";
  }
};

// ─── SYSTEM.md (작동 헌법) — 언제나 로드 (2026-05-27) ──────────────────────
// 사용자 결정: SYSTEM.md 는 on-demand Read 가 아니라 *매 turn 항상* user prompt 앞에
// prepend 되는 소스다 (AGENT.md 와 동급 상시 컨텍스트). 부팅 시 syncSystemMd 가 앱
// 정본을 `<home>/SYSTEM.md` 로 미러하므로 그 미러를 읽는다. 양 어댑터(claude·codex)가
// 동일하게 prepend 해 LLM parity 유지. 부재 시 빈 문자열 (헌법 미러 실패해도 turn 생존).
export const readSystem = (): string => {
  try {
    return fs.readFileSync(getPaths().systemMd, "utf8");
  } catch {
    return "";
  }
};

/**
 * AGENT.md 실제 경로 1줄 안내 — 매 turn prepend.
 * V9.4 후 readAgent 는 `<home>/AGENT.md` 를 읽는데, 비서의 파일 도구 cwd 는
 * `process.cwd()`(데몬 cwd) 라 "AGENT.md" 만으로 Edit 하면 엉뚱한 파일에 써질 수
 * 있다(home ≠ cwd 시). 데몬만 아는 절대 경로를 알려줘 자기 정체성 편집이 실제로
 * readAgent 가 읽는 파일에 반영되게 한다. (prod 에서 home 이 file-ops 샌드박스 밖이면
 * 편집 제약 — V10 file-ops 샌드박스 분리 후속.)
 */
export const agentPathHint = (): string =>
  `> [system] 당신의 AGENT.md 실제 경로: \`${getPaths().agentMd}\` — 이름·말투·습관 등 정체성 갱신은 *이 경로* 를 \`Edit\`/\`Write\` 하세요 (데몬이 매 turn 이 파일을 읽어 prepend). 레포 루트의 AGENT.md 가 아닙니다.`;

/** body 가 4096B 초과 시 한 줄 경고, 그 외 빈 문자열. */
export const agentSizeWarning = (body: string): string => {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= AGENT_SIZE_WARN_BYTES) return "";
  return `> [system] AGENT.md 가 ${AGENT_SIZE_WARN_BYTES}B 초과합니다 (현재 ${bytes}B). 하위 markdown(예: \`<TIGUCLAW_HOME>/data/agent/<topic>.md\`)으로 분할하고 AGENT.md 본문에서 reference 만 남기는 것을 고려하세요. 비서가 필요 시 \`Read\` 도구로 자동 불러옵니다.`;
};

// ─── V3 인덱스 — 전체 memories 1줄 요약 (contract §2.3) ─────────────────
export const MEMORY_INDEX_CAP_BYTES = 8192;

export const formatMemoryIndex = (
  maxBytes: number = MEMORY_INDEX_CAP_BYTES,
): string => {
  const { lines, total, truncated } = listMemoriesForIndex(maxBytes);
  if (total === 0) return "";
  const out = [`## 메모리 인덱스 (전체 ${total}건, body 는 read_memory 로 fetch)`];
  out.push(...lines);
  if (truncated > 0) {
    out.push(`… ${truncated}건 더 (오래된 순으로 절단)`);
  }
  return out.join("\n");
};

// ─── 현재 대화 컨텍스트 (채널/dest_target) prompt prepend ────────────────
// 비서가 "지금 이 대화로 보내줘"(스케줄·알림 dest 등) 류 작업을 정확히 하려면
// 자기가 어느 채널·어느 대상과 대화 중인지 알아야 한다. 어댑터 input 의
// channel/threadKey 는 prompt 에 안 노출되어 있어 비서가 chatId 를 몰랐고,
// add_schedule dest_target 오기입 → telegram 403 dispatch 실패의 근본 원인이었다.
//
// threadKey 형식 (채널별): telegram=`tg:<chatId>`, cli=`cli:<id>`,
// http-bridge=`<id>`. telegram 만 dest_target 으로 쓸 chatId 추출이 의미 있다.
export const formatConversationContext = (
  channel: string,
  threadKey: string,
): string => {
  const lines = [`- 채널 (dest_channel): ${channel}`];
  if (channel === "telegram" && threadKey.startsWith("tg:")) {
    const chatId = threadKey.slice("tg:".length).trim();
    if (chatId !== "") {
      lines.push(`- 이 대화 대상 (dest_target): ${chatId}`);
    }
  }
  return [
    "## 현재 대화 컨텍스트",
    ...lines,
    '스케줄·알림 등을 "지금 이 대화로" 보낼 때 위 dest_channel/dest_target 를 사용하세요.',
  ].join("\n");
};

// ─── 멀티모달 입력 V1 — 첨부 placeholder 블록 prepend ──────────────────────
// 첨부=파일 통찰 (contract §0). Attachment[] → SDK 무관 text 로 변환해 양 어댑터
// prefixParts 에 prepend (경로+메타 = 인지 parity, 전 어댑터 대칭).
//
// vision (2026-05-28 — 양 어댑터 parity 확정, 실측 기반): 이미지는 두 어댑터 모두 본다.
//  - codex: 현재 turn 이미지를 input_image(data URI)로 inline 전달 → 직접 봄
//    (실측: /responses HTTP 200 + 로고 정확 인식. 구 "codex vision 불확실" 가정 폐기).
//  - claude: SDK 내장 Read 가 이미지를 vision 으로 반환 → 경로 Read 로 봄 (실측 확인).
//  안내는 중립 — "직접 보이면 그걸로, 안 보이면 경로 Read" (어댑터 분기 0, LLM-agnostic).
//
// 미지정/빈 배열 → "" (prefixParts 에 아무것도 안 붙음 → text-only 회귀 0).
export const formatAttachments = (
  atts: Attachment[] | undefined,
): string => {
  if (atts === undefined || atts.length === 0) return "";
  const lines = atts.map((a) => {
    const cap =
      a.caption !== undefined && a.caption !== "" ? ` — "${a.caption}"` : "";
    return `- [${a.kind} | ${a.mimeType} | ${a.bytes}B] ${a.filename} → ${a.path}${cap}`;
  });
  const hasImage = atts.some((a) => a.kind === "image");
  const out = [
    "## 첨부 파일",
    "사용자가 아래 파일을 첨부했습니다. 필요하면 native file 도구(Read 등)로 절대경로를 읽어 내용을 확인하세요.",
    "",
    lines.join("\n"),
  ];
  if (hasImage) {
    // 양 어댑터 vision parity (2026-05-28 실측). 중립 안내 — 어댑터 분기 없음.
    out.push(
      "",
      "첨부 이미지가 직접 보이면 그 내용으로 답하세요. 직접 보이지 않으면 그 경로를 `Read` 도구로 열어 확인하세요 (file 도구가 이미지를 시각으로 반환합니다). 정말 해석이 안 될 때만 그 사실을 사용자에게 알리세요.",
    );
  }
  return out.join("\n");
};

// ─── user 프롬프트 조립 — Claude Code 컨벤션 (system-reminder 래핑) ──────────
// 문제(2026-05-28까지): SYSTEM.md·AGENT.md·메모리·스킬 인덱스 등 매 turn 주입되는
//  스캐폴딩은 *본질이 시스템 정보*(사용자 발화 아님)인데, user 채널에 그냥 raw 로
//  깔리면 모델이 (a) 「이거/이게」 지시어를 스캐폴딩 전체로 오인(딴소리), (b) 안에
//  든 imperative 를 사용자 발화로 읽고 그대로 메아리침. 슬림 구분선(`━━━` + 라벨)
//  로도 (a)는 어느 정도 막히지만 (b)는 잔존 — 위치만 다른 같은 echo-bait.
// 해결(Claude Code 슈퍼셋답게): Claude Code 본가가 CLAUDE.md·환경·도구 안내를
//  user 채널에 깔 때 쓰는 컨벤션 — `<system-reminder>` 태그 래핑 — 을 그대로 채용.
//  Claude 는 이 태그를 "하네스가 주는 배경 정보, 사용자 발화 아님" 으로 학습돼
//  있어 안의 imperative 를 메아리치지 않고, 지시어 해석도 태그 밖만 본다. 한 어댑터
//  옵션 안 건드리고(API system 채널은 정적·캐시 친화 그대로) user 채널 안에서
//  텍스트 컨벤션으로 channel 효과를 낸다 — Anthropic 자체 패턴. codex/GPT 는 태그
//  자체엔 학습 안 됐을 수 있으나 명시 구획 표식이라 raw 보다는 강하게 작동.
// 양 어댑터 공통 헬퍼 → 분기 0, parity 유지.
export const assembleUserPrompt = (
  systemContextParts: string[],
  userTurnParts: string[],
): string => {
  const ctx = systemContextParts.filter((p) => p.length > 0);
  const turn = userTurnParts.filter((p) => p.length > 0).join("\n\n");
  if (ctx.length === 0) return turn;
  return `<system-reminder>\n${ctx.join("\n\n")}\n</system-reminder>\n\n${turn}`;
};

// ─── §9 transcript 검색 wrapper ─────────────────────────────────────────
export const searchTranscriptsHelper = (
  query: string,
  opts?: Parameters<typeof searchTranscripts>[1],
): TranscriptHit[] => searchTranscripts(query, opts);

// ─── resolveJsonlPath — SDK 가 만든 jsonl 위치 글로빙 ────────────────────
// SDK 는 ~/.claude/projects/<cwd-key>/<sessionId>.jsonl 에 저장. cwd-key 변환 규칙은
// SDK 내부 — 정확 매핑에 의존하지 않고 sessionId.jsonl 을 walk 해 발견.
export const resolveJsonlPath = (
  cwd: string,
  sessionId: string,
): string | undefined => {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return undefined;

  const cwdAbs = path.resolve(cwd);
  const candidateKeys = [
    cwdAbs.replace(/[\\/:]/g, "-"),
    cwdAbs.replace(/[\\/]/g, "-"),
    cwdAbs.replace(/[:\\/]/g, "-").replace(/^-+/, "-"),
  ];
  for (const key of candidateKeys) {
    const p = path.join(root, key, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const p = path.join(root, ent.name, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
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

/** SDK in-process MCP server 인스턴스. claude.ts 의 `mcpServers` 옵션에 그대로 주입. */
export const memoryMcpServer: McpSdkServerConfigWithInstance =
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
