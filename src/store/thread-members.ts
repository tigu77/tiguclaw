/**
 * **이 대화가 가진 기록** — 소속 판정의 한 곳 (2026-10-15 대화 가지치기 v1 ①단계).
 *
 * 종전엔 «(channel, threadKey) 의 세션 id 들» 을 모델 이력 둘 · 원문 회수(`scopeOf`, 셋이 씀) · 스케줄 발화 판정이 각자 `transcript_index`
 *  에서 모았다. 가지치기는 «부모 기록 중 갈라진 순간까지» 를 더해야 하는데, 여러 벌이면 한 곳이 빠져 갈라진 뒤의 부모 기록이
 *  그 경로로만 샌다. 그래서 판단을 여기 하나로 모은다.
 * ★**소속만** 준다. 활성 경계(`/clear`·`/reset`)는 호출 목적마다 다르므로(모델 이력·원문 회수는 적용, 스케줄 발화는 미적용) 지금처럼
 *  호출부가 적용한다 — 공통화가 경계 정책을 바꾸지 않는다.
 * ★세션 id 를 **값으로 넣지 않는다** — `transcript_index` 를 하위 조회로 고른다(2026-10-15). Codex·OpenAI 는 턴마다 세션이 새로 생겨
 *  오래 쓰는 대화(기본 세션)는 세션이 끝없이 쌓이는데, 값으로 넣으면 SQLite 의 값 개수 상한(32,766)에서 그 대화의 모든 조회가 던진다
 *  (실측: 세션 4만 개 «too many SQL variables» · 하위 조회는 4만 건 정상, 712개에서 속도 같음 34.7 vs 33.8ms · 같은 색인).
 *  넣는 값은 대화당 채널·키 둘 + 조상마다 상한 하나다. 설계: `docs/decisions/2026-10-14-conversation-fork-design.md` §2.
 */
import type { ChannelName } from "../channels/types.js";
import { getDb } from "./sessions.js";

/** 가지 한 행 — 만든 뒤 안 바뀐다(`thread_lineage`). */
export interface ThreadLineage {
  channel: ChannelName;
  threadKey: string;
  parentKey: string;
  /** T — 물려받는 부모 기록의 상한(`transcripts.id`). */
  throughTranscriptId: number;
  /** Tc — 물려받는 화면 기록의 상한(`chat_log.id`). */
  throughChatId: number;
  /** Claude SDK 복제본 sid — 복제하지 않은 가지는 null. */
  sdkSessionId: string | null;
  /** S — 그 복제본이 담은 마지막 행 id. */
  sdkIncludedThrough: number | null;
  /** 갈라진 시각 — 도구 스텝 상한. 옛 행은 null(= createdAt). */
  throughTs: number | null;
  createdAt: number;
}

interface LineageRow {
  channel: string; thread_key: string; parent_key: string; through_transcript_id: number; through_chat_id: number;
  sdk_session_id: string | null; sdk_included_through: number | null; through_ts: number | null; created_at: number;
}

export const getLineage = (channel: ChannelName, threadKey: string): ThreadLineage | undefined => {
  const r = getDb()
    .prepare(`SELECT * FROM thread_lineage WHERE channel = ? AND thread_key = ?`)
    .get(channel, threadKey) as LineageRow | undefined;
  return r === undefined ? undefined : {
    channel: r.channel as ChannelName, threadKey: r.thread_key, parentKey: r.parent_key,
    throughTranscriptId: r.through_transcript_id, throughChatId: r.through_chat_id,
    sdkSessionId: r.sdk_session_id, sdkIncludedThrough: r.sdk_included_through, throughTs: r.through_ts, createdAt: r.created_at,
  };
};

/** 가지 사슬 상한 — 무한 루프 방지(사슬이 이만큼 깊으면 행이 잘못된 것이다). */
const MAX_LINEAGE_DEPTH = 256;

/**
 * 조상 사슬 — 가까운 부모부터, 각 조상까지의 경로상 **최소** 상한과 함께. 가지가 아니면 빈 목록.
 * ★조상의 «현재 소속» 을 재귀로 부르지 않는다 — 고정된 lineage 행만 따라간다(설계 §2 재검토 1).
 */
export const lineageChain = (
  channel: ChannelName,
  threadKey: string,
): { key: string; throughTranscriptId: number; throughChatId: number; forkedAt: number }[] => {
  const out: { key: string; throughTranscriptId: number; throughChatId: number; forkedAt: number }[] = [];
  const seen = new Set<string>([threadKey]);
  let t = Number.POSITIVE_INFINITY;
  let tc = Number.POSITIVE_INFINITY;
  let at = Number.POSITIVE_INFINITY;
  for (let lin = getLineage(channel, threadKey); lin !== undefined && out.length < MAX_LINEAGE_DEPTH; lin = getLineage(channel, lin.parentKey)) {
    if (seen.has(lin.parentKey)) break; // 순환 — 만들 때 막지만 데이터가 깨졌어도 멈춘다
    seen.add(lin.parentKey);
    t = Math.min(t, lin.throughTranscriptId);
    tc = Math.min(tc, lin.throughChatId);
    at = Math.min(at, lin.throughTs ?? lin.createdAt);
    // forkedAt — 그 조상 기록 중 이 대화가 물려받는 시각 상한(시각만 있는 관측 기록 — 도구 스텝 — 을 가를 때).
    out.push({ key: lin.parentKey, throughTranscriptId: t, throughChatId: tc, forkedAt: at });
  }
  return out;
};

/** **이 대화의 범위** — 자기 대화 + 조상(갈라진 순간의 상한과 함께). 가지가 아니면 조상 없음 = 종전과 같다. */
export interface ThreadScope {
  channel: ChannelName;
  key: string;
  ancestors: { key: string; through: number }[];
}

export const threadScope = (channel: ChannelName, threadKey: string): ThreadScope => ({
  channel,
  key: threadKey,
  ancestors: lineageChain(channel, threadKey).map((a) => ({ key: a.key, through: a.throughTranscriptId })),
});

/**
 * SQL 조건 — `transcripts` 행이 이 대화 소속인가: `members(K) = own(K) ∪ ⋃_조상 A { own(A) 의 행 중 id ≤ T_A(K) }`(설계 §2).
 * `alias` 는 transcripts 의 별칭(없으면 빈 문자열). 조상마다 항 하나 — 세션이 몇 개든 항 수·값 수가 늘지 않는다.
 */
export const memberClause = (scope: ThreadScope, alias = ""): { sql: string; params: (string | number)[] } => {
  const col = (c: string): string => (alias === "" ? c : `${alias}.${c}`);
  const sessionsOf = `${col("claude_session_id")} IN (SELECT claude_session_id FROM transcript_index WHERE channel = ? AND thread_key = ?)`;
  const parts = [sessionsOf];
  const params: (string | number)[] = [scope.channel, scope.key];
  for (const a of scope.ancestors) {
    parts.push(`(${sessionsOf} AND ${col("id")} <= ?)`);
    params.push(scope.channel, a.key, a.through);
  }
  return { sql: `(${parts.join(" OR ")})`, params };
};

/** 행 하나가 이 대화 소속인가 — `memberClause` **그 SQL** 로 묻는다(판정 두 벌 금지 — 원문 회수가 쓴다). */
export const scopeHasRow = (scope: ThreadScope, transcriptId: number): boolean => {
  const c = memberClause(scope);
  return getDb().prepare(`SELECT 1 FROM transcripts WHERE id = ? AND ${c.sql}`).get(transcriptId, ...c.params) !== undefined;
};

/**
 * **SDK 세션이 이미 담은 끝** — `includedEnd(X, sid)` (설계 §2). 그 sid 소속 행의 최대 id 와, X 가 그 sid 를 복제로 받은 가지면
 *  복제 때 기록한 S 중 큰 값. 둘 다 없으면 null.
 * ★분기(§4 ④)와 재개 델타(§5)가 **이 한 함수**를 쓴다. 새 복제본 sid 엔 원문 행이 없으므로(적재기 선등록만) 앞 항만 보면
 *  대화 없이 다시 갈랐을 때 S 가 사라진다 — 뒤 항이 이어 준다.
 */
export const includedEnd = (channel: ChannelName, threadKey: string, sid: string): number | null => {
  const scope = memberClause(threadScope(channel, threadKey));
  const own = (getDb()
    // 대화 행(user·assistant)만 센다 — 재개 델타가 자르는 위치를 **같은 행 집합**에서 찾는다(`loadThreadHistory` 의 role 필터).
    //  system·queue-operation 행을 S 로 잡으면 그 위치를 못 찾아 델타가 전체가 되고 복제본 내용이 두 번 들어갔다(적대 검토 P2).
    .prepare(`SELECT MAX(id) AS m FROM transcripts WHERE ${scope.sql} AND claude_session_id = ? AND role IN ('user', 'assistant')`)
    .get(...scope.params, sid) as { m: number | null }).m;
  const lin = getLineage(channel, threadKey);
  const inherited = lin !== undefined && lin.sdkSessionId === sid ? lin.sdkIncludedThrough : null;
  if (own === null) return inherited;
  return inherited === null ? own : Math.max(own, inherited);
};
