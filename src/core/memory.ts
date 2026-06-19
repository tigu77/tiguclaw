/**
 * 영역 코어 — 메모리·transcript 검색 코어 (contract `_workspace/memory_round2_architect_contract.md`).
 *
 * 7b 분해(2026-06-19)로 슬림화 — 동작 무변경, 순수 이동. 분리된 모듈:
 *  - 정체성 read(readAgent/readSystem/agentPathHint/agentSizeWarning) → `identity.ts`
 *  - 프롬프트 조립(assembleUserPrompt/format*) → `prompt-assembly.ts`
 *  - in-process MCP memory 서버 + 가드(memoryMcpServer/addMemoryWithGuard/
 *    getInProcessMcpServers) → `memory-mcp.ts`
 *
 * 본 모듈 잔존:
 *  - `retrieveContext`: searchMemories(query) (+ 선택적 transcripts 검색).
 *  - `searchTranscriptsHelper`: §9 transcript 검색 wrapper.
 *  - `resolveJsonlPath`: SDK 가 만든 jsonl 위치 글로빙.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChannelName } from "../channels/types.js";
import {
  listMemories,
  searchMemories,
  searchTranscripts,
  type Memory,
  type TranscriptHit,
} from "../store/memory.js";

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
