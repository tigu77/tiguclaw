/**
 * **이 대화에서 앞서 실행한 도구의 결과를 다시 읽는다** (2026-09-30, 압축 후 업무 연속성 단계 A).
 *
 * ★왜: 이력이 요약되면 도구 결과 원문은 모델 입력에서 빠진다. 요약이 그 안의 사실을 놓치면 모델은 «기억나지 않는다» 고
 *  답했다(09-29 재현 — 1턴에 읽은 파일 속 값). 원문은 `turn_items` 에 그대로 남아 있으니(정리 ≠ 삭제) 다시 읽을 길만 있으면 된다.
 * ★범위 = **이 대화**뿐이다: 같은 (channel, threadKey) 의 세션이고 `/clear`·스케줄 경계 뒤. 다른 대화는 `search_conversations` 의
 *  몫이다 — 자동 회수와 섞으면 남의 대화 결과가 이 대화 기억처럼 들어온다.
 * ★돌려주는 것은 **저장된 그대로**다(가린 보존본 — 보존 상한 100,000자, 넘으면 앞·뒤와 «회수 불가» 표식 · `collectTurnItems`). 그 뒤 파일이 바뀌었을 수 있다.
 *  (2026-11-19 전엔 진입 상한 16K 로 자른 값이 저장돼 가운데를 되찾을 수 없었다 — 그 시기 기록은 그대로다.)
 * ★참조 두 가지: 저장 참조 `<기록id>#<순번>` · 실행 참조 `r<토큰>.<순번>`(그 턴에 모델 입력에서 생략된 결과 — 저장 항목의 `ref`).
 *  실행 참조는 진행 중인 턴이면 어댑터의 실행 보관함(`tool-recall-mcp.ts`)이, 끝난 턴이면 여기가 읽는다.
 * ★응답 한 번의 크기는 **응답 JSON 전체**로 맞춘다(`toolRecallResponse`) — 본문만 맞추면 인자·메타·이스케이프로 진입 상한을 넘어 다시 잘린다.
 * ★참조는 `<기록 id>#<저장 순번>`(transcript_id·seq) — 한 턴에 같은 call_id 가 둘이어도 갈리지 않는다(적대 검토). 요약 접기가 같은
 *  함수(`toolResultRef`)로 만든다. 틀린 참조·다른 대화·경계 이전은 **비슷한 것으로 대신하지 않고** 사유와 함께 거절한다.
 */
import type { ChannelName } from "../channels/types.js";
import { getContextBoundary, getDb } from "./sessions.js";
import { memberClause, scopeHasRow, threadScope, type ThreadScope } from "./thread-members.js";
import type { CodexTurnItem } from "./memory.js";
import { RUN_REF_RE } from "../core/llm-runtime/tool-output-ledger.js";
import { fitsToolEntry, TOOL_OUTPUT_ENTRY_CAP } from "../core/llm-runtime/tool-output-limits.js";
import { redactSecrets } from "../core/outbound-sanitize.js";

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

export type ToolRecallFailure = { ok: false; reason: "bad_ref" | "not_found" | "other_conversation" | "before_boundary" | "not_tool_result"; ref: string };

/** 결과 한 건 전부(페이지 전) — 실행 보관함과 저장본이 같은 모양으로 넘긴다. */
export type ToolRecallLoaded = { ok: true; ref: string; at: number; tool: string; args: string; text: string } | ToolRecallFailure;

export type ToolRecallRead =
  | { ok: true; ref: string; at: number; tool: string; args: string; chars: number; offset: number; text: string; nextOffset?: number }
  | ToolRecallFailure;

/** 재조회 응답에 인자를 전문으로 싣는 상한 — 넘으면 앞부분 + `part:"args"` 로 이어 읽기. 예산의 1/16 을 넘지 않는다(이스케이프 6배여도 응답 안). */
export const TOOL_RECALL_ARGS_INLINE = 1_000;
/** 검색 목록의 기본 상한. */
export const TOOL_RECALL_LIST_LIMIT = 10;
/** 전체 적중 수를 세는 상한 — 넘으면 «이 수 이상» 으로만 알린다(큰 대화에서 끝까지 세느라 루프를 멈추지 않게, 적대 재검토 P2). */
export const TOOL_RECALL_COUNT_CAP = 1_000;
/** 검사용 계수 — 턴 읽기·조각 만들기 횟수(N+1 이 되살아나면 검사가 본다). */
const stats = { turnLoads: 0, snippets: 0, resultLoads: 0 };
export const __toolRecallStatsForTest = (): { turnLoads: number; snippets: number; resultLoads: number } => ({ ...stats });
const ARGS_PREVIEW = 200;
const SNIPPET_SIDE = 150;

/** 참조 문자열 — 요약 입력(`foldBody`)과 이 도구가 **같은 함수**로 만든다(두 벌이면 갈린다). */
export const toolResultRef = (transcriptId: number, seq: number): string => `${transcriptId}#${seq}`;

interface Scope { members: ThreadScope; boundary: number }

// 소속은 `memberClause`(한 곳) · 경계는 원문 회수 목적이라 적용한다. ★아래 셋은 **자체 SQL** 이라 소속 조건을 `memberClause` 로
//  SQL 안에 넣는다 — sid 목록만 넘기면 물려받은 기록의 상한(가지치기)이 빠진다.
const scopeOf = (channel: ChannelName, threadKey: string): Scope =>
  ({ members: threadScope(channel, threadKey), boundary: getContextBoundary(channel, threadKey) });

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
  const { members, boundary } = scopeOf(channel, threadKey);
  if (query.trim() === "") return { total: 0, totalCapped: false, hits: [] };
  const scope = memberClause(members, "t");
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
        WHERE ${scope.sql} AND t.ts > ?
          AND ti.item NOT LIKE '{"type":"message"%'
          AND (${forms.map(() => `${col} LIKE ? ESCAPE '\\' OR ${col} LIKE ? ESCAPE '\\'`).join(" OR ")})
        ORDER BY ti.transcript_id DESC, ti.seq DESC`,
    )
    .iterate(...scope.params, boundary, ...forms.flatMap((q) => [like(enc(q)), like(enc(enc(q)))])) as IterableIterator<{ tid: number; seq: number; item: string; ts: number }>;

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

/**
 * **요약에 접힌 긴 도구 결과의 목록** — 이 대화·경계 뒤, 요약 워터마크(`throughTid`) 이하에서 결과가 `minChars` 보다 긴 것, 최근 `limit` 건.
 * 돌려줄 때는 **오래된 순**(같은 입력이면 같은 출력 — 프롬프트 프리픽스가 흔들리지 않게).
 * ★왜(2026-10-05): 접을 때 긴 결과는 «참조 + 앞부분» 만 요약기에 들어가고, 참조를 요약에 남기는 건 **요약 모델의 재량**이었다.
 *  압축을 자주 겪은 벤치 런에서 요약이 참조를 0개 남기자 모델이 이 도구를 떠올리지 못했고(접힌 채 실린 도구다), 1턴에 읽은 회의록 값을
 *  «확인할 수 없다» 로 답했다(v0.65.0·현재 두 버전 동일 7/14). 목록은 요약과 따로 **기록에서** 만든다 — 요약이 무엇을 빠뜨려도 남는다.
 */
export const listFoldedToolResults = (
  channel: ChannelName,
  threadKey: string,
  throughTid: number,
  minChars: number,
  limit: number,
): { ref: string; tool: string; args: string; chars: number }[] => {
  const { members, boundary } = scopeOf(channel, threadKey);
  if (throughTid <= 0 || limit <= 0) return [];
  const scope = memberClause(members);
  // ★최근 턴부터 거꾸로 읽고 `limit` 을 채우면 멈춘다 (2026-10-05 적대 검토 F2). 첫 판은 대화의 워터마크 이하 항목을 **전부** 읽고
  //  정렬했다(실측 10만 행 ≈250ms, 요청마다 동기 — 그동안 모든 채널이 멈춘다). 지금은 캐시가 빗나갈 때(접을 때·재시작 뒤)만 여기 온다.
  // ★창은 **도구 기록이 있는 턴**으로 센다 (재검토 A). assistant 행으로 세면 Claude 턴(턴당 행 여러 개·도구 기록 없음)이 창을 먹어,
  //  Claude 턴 수십 개가 섞이면 앞서 읽은 긴 결과가 목록에서 조용히 빠졌다 — 목록이 비면 회수 안내까지 사라진다. 기록 없는 행은
  //  PK 조회 한 번으로 지나간다. ★턴 id 정렬은 대화 행 전체를 한 번 정렬한다(10만 행 ≈27ms, 재검토 B) — 바운드가 아니라 선형이다.
  const tids = getDb()
    .prepare(
      `SELECT id FROM transcripts WHERE ${scope.sql} AND id <= ? AND ts > ? AND role = 'assistant'
        ORDER BY id DESC`,
    )
    .iterate(...scope.params, throughTid, boundary) as IterableIterator<{ id: number }>;
  const hasItems = getDb().prepare(`SELECT 1 FROM turn_items WHERE transcript_id = ? LIMIT 1`);
  const out: { ref: string; tool: string; args: string; chars: number }[] = [];
  let scanned = 0;
  for (const { id } of tids) {
    if (hasItems.get(id) === undefined) continue;
    if (++scanned > FOLDED_SCAN_TURNS) break;
    const tools = turnTools(id);
    for (const seq of [...tools.outputs.keys()].sort((x, y) => y - x)) {
      const pair = tools.outputs.get(seq)!;
      // 회수 도구 자신의 결과는 원본의 사본이다 — 목록 칸을 차지해 원본을 밀어내지 않게 뺀다.
      if (pair.out.output.length <= minChars || pair.call?.name === TOOL_RECALL_NAME) continue;
      out.push({ ref: toolResultRef(id, seq), tool: pair.call?.name ?? "", args: pair.call?.arguments ?? "", chars: pair.out.output.length });
      if (out.length >= limit) return out.reverse();
    }
  }
  return out.reverse();
};
/** 접힌 결과 목록을 찾으며 거꾸로 훑을 **도구 기록이 있는** 최대 턴 수 — 긴 결과가 드문 대화에서도 파싱량이 묶인다. */
export const FOLDED_SCAN_TURNS = 400;

/**
 * 대상 결과와 **짝 호출** — JS 로는 같은 `call_id` 행만 파싱한다. 짝 규칙은 `turnTools` 와 같다(같은 `call_id` 중 먼저 열린 호출) —
 *  같은 `call_id` 행만 보면 같은 답이다.
 * ★비용(2026-11-19 구현 검토 R1 ②): `call_id` 색인이 없어 SQLite 는 그 턴의 대상 앞 행을 읽고 `json_extract` 한다 — **턴 크기에 비례**한다
 *  (색인·열 추가는 스키마 변경이라 이번 범위 밖). 그래서 이어 읽기마다 반복하지 않게 재조회 도구가 한 실행 안에서 꺼낸 결과를 들고 있다
 *  (`tool-recall-mcp.ts`) — 한 결과를 끝까지 읽는 데 이 조회는 한 번이다.
 */
const pairOf = (tid: number, seq: number): { out: Output; call?: Call } | undefined => {
  const item = getDb().prepare(`SELECT item FROM turn_items WHERE transcript_id = ? AND seq = ?`).get(tid, seq) as { item: string } | undefined;
  const out = item === undefined ? undefined : parse(item.item);
  if (out?.type !== "function_call_output") return undefined;
  const rows = getDb()
    .prepare(`SELECT seq, item FROM turn_items WHERE transcript_id = ? AND seq <= ? AND json_extract(item, '$.call_id') = ? ORDER BY seq`)
    .all(tid, seq, out.call_id) as { seq: number; item: string }[];
  const open: Call[] = [];
  for (const r of rows) {
    const it = parse(r.item);
    if (it?.type === "function_call") open.push(it);
    else if (it?.type === "function_call_output") {
      const c = open.shift();
      if (r.seq === seq) return { out, ...(c !== undefined ? { call: c } : {}) };
    }
  }
  return { out };
};

const loadAt = (tid: number, seq: number, ref: string, ts: number): ToolRecallLoaded => {
  stats.resultLoads += 1;
  const item = getDb().prepare(`SELECT item FROM turn_items WHERE transcript_id = ? AND seq = ?`).get(tid, seq) as { item: string } | undefined;
  if (item === undefined) return { ok: false, reason: "not_found", ref };
  if (parse(item.item)?.type !== "function_call_output") return { ok: false, reason: "not_tool_result", ref };
  const pair = pairOf(tid, seq);
  if (pair === undefined) return { ok: false, reason: "not_found", ref };
  return { ok: true, ref, at: ts, tool: pair.call?.name ?? "", args: pair.call?.arguments ?? "", text: pair.out.output };
};

/**
 * 참조로 결과 한 건 전부를 꺼낸다 — 이 대화·경계 뒤의 도구 결과만. 인자도 **전문**(접기가 인자도 참조로 줄인다).
 * 실행 참조(`r<토큰>.<순번>`)는 **끝난 턴의 저장본**에서 찾는다(진행 중인 턴은 실행 보관함 몫) — 저장 항목의 `ref` 를 행 머리로
 *  찾는다(`collectTurnItems` 가 `type` 바로 뒤에 둔다). 다른 대화·경계 이전은 사유와 함께 거절한다.
 */
export const loadThreadToolResult = (channel: ChannelName, threadKey: string, ref: string): ToolRecallLoaded => {
  const r = ref.trim();
  const { members, boundary } = scopeOf(channel, threadKey);
  if (RUN_REF_RE.test(r)) {
    const scope = memberClause(members, "t");
    const hit = getDb()
      .prepare(
        `SELECT ti.transcript_id AS tid, ti.seq AS seq, t.ts AS ts FROM turn_items ti JOIN transcripts t ON t.id = ti.transcript_id
          WHERE ${scope.sql} AND ti.item LIKE ? ORDER BY ti.transcript_id DESC LIMIT 1`,
      )
      .get(...scope.params, `{"type":"function_call_output","ref":${JSON.stringify(r)},%`) as { tid: number; seq: number; ts: number } | undefined;
    if (hit === undefined) return { ok: false, reason: "not_found", ref };
    if (hit.ts <= boundary) return { ok: false, reason: "before_boundary", ref };
    return loadAt(hit.tid, hit.seq, ref, hit.ts);
  }
  const m = /^(\d+)#(\d+)$/.exec(r);
  if (m === null) return { ok: false, reason: "bad_ref", ref };
  const tid = Number(m[1]), seq = Number(m[2]);
  const row = getDb()
    .prepare(`SELECT ts, claude_session_id AS sid FROM transcripts WHERE id = ?`)
    .get(tid) as { ts: number; sid: string } | undefined;
  if (row === undefined) return { ok: false, reason: "not_found", ref };
  if (!scopeHasRow(members, tid)) return { ok: false, reason: "other_conversation", ref };
  if (row.ts <= boundary) return { ok: false, reason: "before_boundary", ref };
  // 성공하면 **정규형 참조**를 돌려준다 — `0012#03` 처럼 앞에 0 을 붙인 긴 참조(query 칸은 200자까지)를 그대로 되돌리면 응답 뼈대가
  //  커져 낮은 상한에서 최소 응답도 넘쳤다(구현 검토 R9).
  return loadAt(tid, seq, toolResultRef(tid, seq), row.ts);
};

const clipArgs = (s: string, n: number): string => {
  let head = s.slice(0, n);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
};

/** 결과 진입 크기 판정 — 정의는 크기 계약 자리 한 곳(`tool-output-limits.ts`). 재조회 응답·예약 목록 페이지가 같이 쓴다. */
export { fitsToolEntry };

/**
 * **재조회 응답 한 번** — 결과 본문(또는 `part:"args"` 면 인자)의 `offset` 부터, 응답 JSON **전체**가 `budget` 자 안에 드는 만큼
 * (2026-11-19 설계 §3-1). 메타·인자·JSON 이스케이프를 다 넣어 잰다 — 본문만 맞추면 진입 상한에서 다시 잘린다(개발클로드 회신 §1-5).
 * 끝 표지: 더 있으면 `truncated:true`·`nextOffset`, 끝이면 `eof:true`. 서로게이트 쌍을 쪼개지 않고, 한 번에 최소 1자 나아간다.
 * 길이·offset 은 저장된(가린) 보존본 기준이다.
 */
export const toolRecallResponse = (
  r: Extract<ToolRecallLoaded, { ok: true }>,
  opts: { offset?: number; part?: "output" | "args" } = {},
  budget: number = TOOL_OUTPUT_ENTRY_CAP,
): Record<string, unknown> => {
  const part = opts.part ?? "output";
  const body = part === "args" ? r.args : r.text;
  const start = Math.max(0, Math.min(opts.offset ?? 0, body.length));
  const inline = Math.min(TOOL_RECALL_ARGS_INLINE, Math.floor(budget / 16));
  const argsField = part === "args"
    ? {}
    : r.args.length <= inline
      ? { args: r.args }
      : { args: clipArgs(r.args, inline), argsChars: r.args.length, argsTruncated: true, argsNote: '인자 전문은 part:"args" 로 이어 읽습니다' };
  // `lean` = 메타가 예산을 다 먹을 때의 최소 응답(시각·도구·인자 미리보기 없이, 인자 길이만) — 상한을 아주 낮게 둔 설정에서도 응답이 상한 안(구현 검토 R8).
  let lean = false;
  const build = (end: number): Record<string, unknown> => ({
    ok: true,
    ref: r.ref,
    ...(lean ? (part === "args" ? {} : { argsChars: r.args.length }) : {
      at: new Date(r.at).toISOString(),
      // 도구 이름은 저장 때 가리지 않는다(호출 항목의 `name`) — 되돌려 줄 땐 가린다(구현 검토 R3·R4).
      tool: redactSecrets(r.tool),
      ...argsField,
    }),
    part,
    chars: body.length,
    offset: start,
    ...(end < body.length ? { truncated: true, nextOffset: end } : { eof: true }),
    text: body.slice(start, end),
  });
  const fits = (end: number): boolean => fitsToolEntry(JSON.stringify(build(end)), budget);
  const pick = (): Record<string, unknown> | undefined => {
    if (fits(body.length)) return build(body.length);
    // 서로게이트 쌍을 쪼개지 않는 끝 — 후보를 **고친 뒤에** 잰다(고친 끝을 다시 안 재면 가린 뒤 길이가 상한을 넘을 수 있었다 — 구현 검토 R7).
    // 원문 길이는 끝 위치에 단조지만 가린 뒤 길이는 아니다 — 이분 탐색은 «상한 안인 후보» 만 고르고(최대가 아닐 수 있다), 고른 후보는 늘 잰 것이다.
    let lo = start + 1, hi = body.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(safeEnd(mid))) { best = safeEnd(mid); lo = mid + 1; } else hi = mid - 1;
    }
    // 이분 탐색이 못 찾으면 앞에서부터 몇 글자만 더 찾는다(판정마다 응답 전체를 가려 재므로 바운드).
    if (best < 0) for (let e = start + 1; e < Math.min(body.length, start + 65) && best < 0; e++) if (fits(safeEnd(e))) best = safeEnd(e);
    return best < 0 ? undefined : build(best);
  };
  const safeEnd = (end: number): number => (end - 1 > start && /[\uD800-\uDBFF]/.test(body.charAt(end - 1)) ? end - 1 : end);
  const full = pick();
  if (full !== undefined) return full;
  lean = true;
  // 최소 응답으로도 한 글자가 안 들어가면 상한이 응답 뼈대보다 작은 설정이다(지원 밖) — 그래도 한 글자 나아가는 응답을 낸다.
  return pick() ?? build(start + 1);
};
/**
 * **검색 응답** — 적중 목록을 응답 JSON 전체(원문·가린 뒤 둘 다)가 `budget` 안에 들 때까지 뒤에서부터 줄인다(전체 수는 그대로, 잘림 표시).
 *  요청에서 온 검색어와 저장된 도구 이름은 가려서 돌려준다(구현 검토 R2·R4). 적중을 다 빼도 넘치면(상한을 아주 낮게 둔 설정) 검색어·안내 없이
 *  수만 낸다(R8). 0건이면 그 뜻을 말한다 — 기록은 Codex·OpenAI 턴의 도구 결과만 남아, 순수 Claude 대화에선 언제나 0건이다(적대 재검토 P2).
 */
export const toolRecallSearchResponse = (
  s: ReturnType<typeof searchThreadToolResults>,
  query: string,
  budget: number = TOOL_OUTPUT_ENTRY_CAP,
): Record<string, unknown> => {
  const hits = s.hits.map((h) => ({ ...h, tool: redactSecrets(h.tool), at: new Date(h.at).toISOString() }));
  const respond = (shown: typeof hits): Record<string, unknown> => ({
    ok: true,
    query: redactSecrets(query),
    total: s.total,
    ...(s.totalCapped ? { totalAtLeast: true } : {}),
    truncated: s.totalCapped || s.total > shown.length,
    hits: shown,
    ...(s.total === 0 ? { note: "이 대화에 보관된 도구 결과 중에는 없습니다(보관은 Codex·OpenAI 모델이 실행한 도구 결과만 — Claude 로 실행한 결과는 여기 없습니다)." } : {}),
  });
  let shown = hits;
  while (shown.length > 0 && !fitsToolEntry(JSON.stringify(respond(shown)), budget)) shown = shown.slice(0, -1);
  if (fitsToolEntry(JSON.stringify(respond(shown)), budget)) return respond(shown);
  return { ok: true, total: s.total, ...(s.totalCapped ? { totalAtLeast: true } : {}), truncated: s.total > 0, hits: [] };
};

/**
 * **실패 응답** — 요청에서 온 참조는 가리고 짧게 되돌린다(구현 검토 R2·R9). 응답 JSON 전체가 상한을 넘으면(낮은 상한·이스케이프가 많은 참조)
 *  참조 되돌림을 빼고, 그래도 넘치면 사유만 — 재조회 응답은 실패도 상한 안이다(R10).
 */
export const toolRecallFailureResponse = (r: ToolRecallFailure, note: string | undefined, budget: number = TOOL_OUTPUT_ENTRY_CAP): Record<string, unknown> => {
  const echo = redactSecrets(r.ref);
  const tries: Record<string, unknown>[] = [
    { ok: false, unavailable: r.reason, ref: echo.length > 48 ? `${echo.slice(0, 48)}…` : echo, ...(note !== undefined ? { note } : {}) },
    { ok: false, unavailable: r.reason, ...(note !== undefined ? { note } : {}) },
    { ok: false, unavailable: r.reason },
  ];
  return tries.find((t) => fitsToolEntry(JSON.stringify(t), budget)) ?? tries[tries.length - 1]!;
};

/** 참조로 결과를 한 페이지 읽는다 — `loadThreadToolResult` + `toolRecallResponse` 와 같은 페이지(검사·내부 호출용). 인자는 전문. */
export const readThreadToolResult = (
  channel: ChannelName,
  threadKey: string,
  ref: string,
  offset = 0,
): ToolRecallRead => {
  const r = loadThreadToolResult(channel, threadKey, ref);
  if (!r.ok) return r;
  const page = toolRecallResponse(r, { offset });
  return {
    ok: true,
    ref,
    at: r.at,
    tool: r.tool,
    args: r.args,
    chars: r.text.length,
    offset: page.offset as number,
    text: page.text as string,
    ...(typeof page.nextOffset === "number" ? { nextOffset: page.nextOffset } : {}),
  };
};
