/**
 * **이 대화에서 앞서 실행한 도구의 결과를 다시 읽는다** (2026-09-30, 압축 후 업무 연속성 단계 A).
 *
 * ★왜: 이력이 요약되면 도구 결과 원문은 모델 입력에서 빠진다. 요약이 그 안의 사실을 놓치면 모델은 «기억나지 않는다» 고
 *  답했다(09-29 재현 — 1턴에 읽은 파일 속 값). 원문은 `turn_items` 에 그대로 남아 있으니(정리 ≠ 삭제) 다시 읽을 길만 있으면 된다.
 * ★범위 = **이 대화**뿐이다: 같은 (channel, threadKey) 의 세션이고 `/clear`·스케줄 경계 뒤. 다른 대화는 `search_conversations` 의
 *  몫이다 — 자동 회수와 섞으면 남의 대화 결과가 이 대화 기억처럼 들어온다.
 * ★돌려주는 것은 **저장된 그대로**다(진입 상한 16K — 아주 긴 결과는 앞·뒤만 · 비밀값 가림, `collectTurnItems`). 그 뒤 파일이 바뀌었을 수 있다.
 * ★참조는 `<기록 id>#<저장 순번>`(transcript_id·seq) — 한 턴에 같은 call_id 가 둘이어도 갈리지 않는다(적대 검토). 요약 접기가 같은
 *  함수(`toolResultRef`)로 만든다. 틀린 참조·다른 대화·경계 이전은 **비슷한 것으로 대신하지 않고** 사유와 함께 거절한다.
 */
import type { ChannelName } from "../channels/types.js";
import { getContextBoundary, getDb } from "./sessions.js";
import type { CodexTurnItem } from "./memory.js";

type Call = Extract<CodexTurnItem, { type: "function_call" }>;
type Output = Extract<CodexTurnItem, { type: "function_call_output" }>;

/** 이 도구 자신 — 검색에서 뺀다. 회수 결과엔 검색어·조각이 들어 있어 다음 검색에 걸려 원본을 밀어낸다(적대 검토 실측). */
export const TOOL_RECALL_NAME = "read_past_tool_result";

export interface ToolRecallHit {
  ref: string;
  at: number;
  tool: string;
  args: string;
  chars: number;
  snippet: string;
}

export type ToolRecallRead =
  | { ok: true; ref: string; at: number; tool: string; args: string; chars: number; offset: number; text: string; nextOffset?: number }
  | { ok: false; reason: "bad_ref" | "not_found" | "other_conversation" | "before_boundary" | "not_tool_result"; ref: string };

/** 한 번에 돌려주는 본문 상한 — 저장본은 건당 16K자 안팎이라 대개 한 번에 끝난다. */
export const TOOL_RECALL_READ_CHARS = 20_000;
/** 검색 목록의 기본 상한. */
export const TOOL_RECALL_LIST_LIMIT = 10;
/** 전체 적중 수를 세는 상한 — 넘으면 «이 수 이상» 으로만 알린다(큰 대화에서 끝까지 세느라 루프를 멈추지 않게, 적대 재검토 P2). */
export const TOOL_RECALL_COUNT_CAP = 1_000;
/** 검사용 계수 — 턴 읽기·조각 만들기 횟수(N+1 이 되살아나면 검사가 본다). */
const stats = { turnLoads: 0, snippets: 0 };
export const __toolRecallStatsForTest = (): { turnLoads: number; snippets: number } => ({ ...stats });
const ARGS_PREVIEW = 200;
const SNIPPET_SIDE = 150;

/** 참조 문자열 — 요약 입력(`foldBody`)과 이 도구가 **같은 함수**로 만든다(두 벌이면 갈린다). */
export const toolResultRef = (transcriptId: number, seq: number): string => `${transcriptId}#${seq}`;

interface Scope { sids: string[]; boundary: number }

const scopeOf = (channel: ChannelName, threadKey: string): Scope => {
  const sids = (getDb()
    .prepare(`SELECT claude_session_id FROM transcript_index WHERE channel = ? AND thread_key = ?`)
    .all(channel, threadKey) as { claude_session_id: string }[]).map((r) => r.claude_session_id);
  return { sids, boundary: getContextBoundary(channel, threadKey) };
};

const parse = (s: string): CodexTurnItem | undefined => {
  try { return JSON.parse(s) as CodexTurnItem; } catch { return undefined; }
};

/** 한 기록 행의 도구 항목 — 결과 순번 → {결과, 짝 호출}. 호출은 **앞선 같은 call_id** 중 가장 먼저 열린 것(중복 call_id 대비). */
interface TurnTools { outputs: Map<number, { out: Output; call?: Call }>; callToOutput: Map<number, number> }
const turnTools = (tid: number): TurnTools => {
  stats.turnLoads += 1;
  const rows = getDb().prepare(`SELECT seq, item FROM turn_items WHERE transcript_id = ? ORDER BY seq`).all(tid) as { seq: number; item: string }[];
  const outputs = new Map<number, { out: Output; call?: Call }>();
  const callToOutput = new Map<number, number>();
  const open: { seq: number; call: Call }[] = [];
  for (const r of rows) {
    const it = parse(r.item);
    if (it?.type === "function_call") open.push({ seq: r.seq, call: it });
    else if (it?.type === "function_call_output") {
      const k = open.findIndex((c) => c.call.call_id === it.call_id);
      const c = k >= 0 ? open.splice(k, 1)[0] : undefined;
      outputs.set(r.seq, { out: it, ...(c !== undefined ? { call: c.call } : {}) });
      if (c !== undefined) callToOutput.set(c.seq, r.seq);
    }
  }
  return { outputs, callToOutput };
};

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** 인자 JSON 의 문자열 값들 — 윈도우 경로(`C:\Users`)·따옴표가 든 값을 **풀린 모양**으로도 찾게(적대 검토: JSON 텍스트로만 비교해 놓쳤다). */
const argValues = (args: string): string => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(args)); } catch { /* JSON 이 아니면 원문 비교만 */ }
  return out.join("\n");
};

const snippetAround = (text: string, needle: string): string => {
  stats.snippets += 1;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return clip(text, SNIPPET_SIDE * 2);
  const from = Math.max(0, i - SNIPPET_SIDE);
  const to = Math.min(text.length, i + needle.length + SNIPPET_SIDE);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
};

/** 행 소문자화 SQL 함수 — 연결마다 한 번 등록한다(대소문자 있는 비ASCII 검색어 전용, 위 `casedNonAscii`). */
const folded = new WeakSet<object>();
const ensureFoldFunction = (db: ReturnType<typeof getDb>): void => {
  if (folded.has(db)) return;
  db.function("tc_fold", { deterministic: true }, (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v));
  folded.add(db);
};

/**
 * 이 대화의 도구 결과를 찾는다 — 도구 이름·인자·결과 본문 부분일치(대소문자 무시), 최근 순.
 * ★SQL 은 **후보만** 거른다(JSON 이스케이프한 검색어로 LIKE). 판정은 풀어 낸 값으로 다시 한다.
 * ★기록 행마다 한 번만 읽는다 — 적중마다 그 턴을 다시 읽던 N+1 이 흔한 검색어 한 번에 데몬을 수 초 멈췄다(적대 검토 실측 6.8초).
 *  better-sqlite3 는 동기라 그동안 모든 채널이 멈춘다.
 */
export const searchThreadToolResults = (
  channel: ChannelName,
  threadKey: string,
  query: string,
  limit = TOOL_RECALL_LIST_LIMIT,
): { total: number; totalCapped: boolean; hits: ToolRecallHit[] } => {
  const { sids, boundary } = scopeOf(channel, threadKey);
  if (sids.length === 0 || query.trim() === "") return { total: 0, totalCapped: false, hits: [] };
  // SQLite LIKE 는 ASCII 만 대소문자를 무시한다 — 비ASCII 는 원래·소문자·대문자 세 모양으로 거른다(«Ärger» 를 «ärger»·«ÄRGER» 로
  //  찾는다). 종전엔 이런 검색어면 사전 거르기를 통째로 건너뛰어 대화 전체를 읽었다(적대 재검토 P2).
  // ★대소문자가 있는 비ASCII 글자가 **둘 이상** 섞인 저장값(«ÄöÜ»)은 세 모양 어디에도 안 맞는다(외부 검토). 그런 검색어일 때만
  //  행을 소문자로 바꿔 거른다 — 행마다 JS 를 부르므로 모든 검색에 걸지 않는다(한국어·ASCII 검색은 종전 그대로).
  const casedNonAscii = [...query].some((c) => c > "\u007f" && c.toLowerCase() !== c.toUpperCase());
  const forms = casedNonAscii ? [query.toLowerCase()] : [...new Set([query, query.toLowerCase(), query.toUpperCase()])];
  // 저장 모양은 두 겹이다 — 결과 글은 항목 JSON 에 한 번, 인자는 «인자 JSON 문자열» 이 다시 항목 JSON 에 들어가 **두 번** 인코딩된다
  //  (윈도우 경로 `C:\Users` 의 역슬래시가 넷이 된다 — 한 겹으로만 거르면 인자 적중이 후보에서 빠졌다).
  const enc = (q: string): string => JSON.stringify(q).slice(1, -1);
  const like = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const db = getDb();
  if (casedNonAscii) ensureFoldFunction(db);
  const col = casedNonAscii ? "tc_fold(ti.item)" : "ti.item";
  const rows = db
    .prepare(
      `SELECT ti.transcript_id AS tid, ti.seq AS seq, ti.item AS item, t.ts AS ts FROM turn_items ti
         JOIN transcripts t ON t.id = ti.transcript_id
        WHERE t.claude_session_id IN (${sids.map(() => "?").join(", ")}) AND t.ts > ?
          AND ti.item NOT LIKE '{"type":"message"%'
          AND (${forms.map(() => `${col} LIKE ? ESCAPE '\\' OR ${col} LIKE ? ESCAPE '\\'`).join(" OR ")})
        ORDER BY ti.transcript_id DESC, ti.seq DESC`,
    )
    .iterate(...sids, boundary, ...forms.flatMap((q) => [like(enc(q)), like(enc(enc(q)))])) as IterableIterator<{ tid: number; seq: number; item: string; ts: number }>;

  const needle = query.toLowerCase();
  const turns = new Map<number, TurnTools>();
  const toolsOf = (tid: number): TurnTools => {
    let t = turns.get(tid);
    if (t === undefined) { t = turnTools(tid); turns.set(tid, t); }
    return t;
  };
  const seen = new Set<string>();
  const hits: ToolRecallHit[] = [];
  let total = 0;
  let totalCapped = false;
  // ★흘려 읽는다(`.iterate()`) — 적중 행을 전부 메모리에 올리지 않는다(125MB 대화에서 RSS +600MB 실측).
  for (const r of rows) {
    if (total >= TOOL_RECALL_COUNT_CAP) { totalCapped = true; break; }
    const it = parse(r.item);
    if (it === undefined || it.type === "message") continue;
    const tools = toolsOf(r.tid);
    // 참조는 언제나 결과 항목이다 — 호출이 걸렸으면 그 짝 결과를, 결과가 걸렸으면 자기 자신을.
    const outSeq = it.type === "function_call_output" ? r.seq : tools.callToOutput.get(r.seq);
    if (outSeq === undefined) continue;
    const pair = tools.outputs.get(outSeq);
    if (pair === undefined || pair.call?.name === TOOL_RECALL_NAME) continue;
    const matched = it.type === "function_call_output"
      ? it.output.toLowerCase().includes(needle)
      : `${it.name}\n${it.arguments}\n${argValues(it.arguments)}`.toLowerCase().includes(needle);
    if (!matched) continue;
    const ref = toolResultRef(r.tid, outSeq);
    if (seen.has(ref)) continue;
    seen.add(ref);
    total += 1;
    if (hits.length >= limit) continue; // 넘친 것은 **세기만** 한다(조각·미리보기를 만들지 않는다).
    hits.push({
      ref,
      at: r.ts,
      tool: pair.call?.name ?? "",
      args: clip(pair.call?.arguments ?? "", ARGS_PREVIEW),
      chars: pair.out.output.length,
      snippet: snippetAround(pair.out.output, query),
    });
  }
  return { total, totalCapped, hits };
};

/** 참조로 결과 전문을 읽는다 — 이 대화·경계 뒤의 도구 결과만. 인자도 **전문**을 돌려준다(접기가 인자도 참조로 줄인다). */
export const readThreadToolResult = (
  channel: ChannelName,
  threadKey: string,
  ref: string,
  offset = 0,
): ToolRecallRead => {
  const m = /^(\d+)#(\d+)$/.exec(ref.trim());
  if (m === null) return { ok: false, reason: "bad_ref", ref };
  const tid = Number(m[1]), seq = Number(m[2]);
  const row = getDb()
    .prepare(`SELECT ts, claude_session_id AS sid FROM transcripts WHERE id = ?`)
    .get(tid) as { ts: number; sid: string } | undefined;
  if (row === undefined) return { ok: false, reason: "not_found", ref };
  const { sids, boundary } = scopeOf(channel, threadKey);
  if (!sids.includes(row.sid)) return { ok: false, reason: "other_conversation", ref };
  if (row.ts <= boundary) return { ok: false, reason: "before_boundary", ref };
  const item = getDb().prepare(`SELECT item FROM turn_items WHERE transcript_id = ? AND seq = ?`).get(tid, seq) as { item: string } | undefined;
  if (item === undefined) return { ok: false, reason: "not_found", ref };
  if (parse(item.item)?.type !== "function_call_output") return { ok: false, reason: "not_tool_result", ref };
  const pair = turnTools(tid).outputs.get(seq);
  if (pair === undefined) return { ok: false, reason: "not_found", ref };
  const text = pair.out.output;
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + TOOL_RECALL_READ_CHARS);
  return {
    ok: true,
    ref,
    at: row.ts,
    tool: pair.call?.name ?? "",
    args: pair.call?.arguments ?? "",
    chars: text.length,
    offset: start,
    text: text.slice(start, end),
    ...(end < text.length ? { nextOffset: end } : {}),
  };
};
