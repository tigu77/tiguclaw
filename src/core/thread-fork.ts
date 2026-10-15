/**
 * **대화 가지치기** — 지금 대화의 끝에서 새 대화를 갈라낸다 (2026-10-15 v1 ②단계).
 * 설계: `docs/decisions/2026-10-14-conversation-fork-design.md` §4 (아스트라 3차 검토 반영).
 *
 * 가지는 부모 기록을 **복사하지 않는다** — 부모 기록을 «갈라진 순간까지» 로 참조한다(`thread_lineage` 의 T·Tc, 소속 판정 `memberClause`).
 *  Claude 는 SDK 세션이 따로 있어서 그것만 SDK 로 복제한다(`forkSession`). Codex·OpenAI 는 공통 기록만 읽으므로 복제할 것이 없다.
 * 대시보드 버튼과 `/fork` 가 **이 함수 하나**를 부른다(채널은 바인딩 이동만 한다).
 *
 * 절차(전부 부모 대화의 줄 안 — 진행 중인 답이 끝난 뒤):
 *  ③ 멱등 → ④ 좌표(Claude 적재 따라잡기 뒤 T·Tc·S) → ⑤ SDK 복제(진짜 Claude 세션일 때만) + 같은 완료 경계 확인 → ⑥ 한 트랜잭션.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEventBus } from "./eventbus.js";
import { deliverOutbound } from "./outbound.js";
import { enqueueThreadTurn, mainMessageHandler } from "./worker-jobs.js";
import { translate } from "./i18n.js";
import type { ChannelName, IncomingMessage, ReplyOptions } from "../channels/types.js";
import { findTurnRow, firstUserTextAfterKind, getFirstUserText, latestClaudeMarkUpTo } from "../store/chat-log.js";
import { indexJsonlIfNeeded } from "../store/memory.js";
import { getContextBoundary, getDb, getSession, isUserConversationThread, sessionDisplayName, SESSION_STORAGE_CHANNEL } from "../store/sessions.js";
import { forkExists, forkName, ForkRecordRejected, sessionNames, writeForkRecords } from "../store/thread-fork.js";
import { getLineage, includedEnd, memberClause, threadScope } from "../store/thread-members.js";

/** SDK 쪽 — 회귀가 가짜로 갈아 끼운다(데몬·실제 Claude 세션 없이 동작 검사). */
export interface ForkSdk {
  /** `upToMessageId` 까지(포함) 복제한 새 세션 id. */
  forkSession: (sessionId: string, opts: { upToMessageId: string }) => Promise<{ sessionId: string }>;
  /** SDK 가 그 세션을 아는가 — 복제가 실패했을 때 «부모 세션도 못 쓰는 상태» 인지 가르는 로컬 증거. */
  sessionKnown: (sessionId: string) => Promise<boolean>;
}

const realSdk: ForkSdk = {
  forkSession: async (sid, opts) => (await import("@anthropic-ai/claude-agent-sdk")).forkSession(sid, opts),
  sessionKnown: async (sid) => (await (await import("@anthropic-ai/claude-agent-sdk")).getSessionInfo(sid)) !== undefined,
};

export type ForkResult =
  | {
      ok: true;
      childKey: string;
      name: string;
      /** copied = Claude 세션 복제 · none = Claude 세션이 원래 없음 · rebuilt = 부모 Claude 세션도 못 써서 기록으로 다시 짓는다(L1·L2 한계). */
      claude: "copied" | "none" | "rebuilt";
    }
  | {
      ok: false;
      reason:
        | "not_forkable" | "empty" | "catch_up" | "sdk_copy" | "boundary" | "write"
        // 메시지 지점(v2): 그 답에 완료 턴 표식이 없다 · 그 답이 이미 요약된 구간 · 그 답 뒤에 대화를 비웠다
        | "not_turn" | "summarized" | "cleared_after";
      detail: string;
    };

/** 새 가지 키 — 대시보드 새 탭과 같은 모양(`dashboard:<uuid>`). */
export const newForkKey = (): string => `dashboard:${randomUUID()}`;

interface JsonlMessage { uuid: string; role: string; contentHash: string; hasToolUse: boolean; ts: number }

/** 세션 파일의 **완전한 줄**에서 메시지(사용자·비서)만. 복제본은 uuid·시각을 새로 매기므로(실측) 비교는 역할·본문으로 한다. */
const jsonlMessages = (file: string): { messages: JsonlMessage[]; completeBytes: number; lines: number } => {
  const raw = fs.readFileSync(file, "utf8");
  const end = raw.lastIndexOf("\n");
  const complete = end >= 0 ? raw.slice(0, end + 1) : "";
  const lines = complete === "" ? [] : complete.split("\n").slice(0, -1);
  const messages: JsonlMessage[] = [];
  for (const line of lines) {
    let o: { type?: string; uuid?: string; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } };
    try { o = JSON.parse(line) as typeof o; } catch { continue; }
    if ((o.type === "user" || o.type === "assistant") && typeof o.uuid === "string" && o.isSidechain !== true) {
      const content = o.message?.content;
      const hasToolUse = Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "tool_use");
      messages.push({ uuid: o.uuid, role: o.type, contentHash: JSON.stringify(content ?? null), hasToolUse, ts: typeof o.timestamp === "string" ? Date.parse(o.timestamp) || 0 : 0 });
    }
  }
  return { messages, completeBytes: Buffer.byteLength(complete, "utf8"), lines: lines.length };
};

/**
 * 부모 대화의 줄에 넣는다 — 진행 중인 답이 있으면 그게 끝난 뒤 갈라진다(미완료 호출·결과 반쪽 없음).
 * `childKey` 는 호출자가 만든다(재시도 멱등 키 — 같은 키로 다시 부르면 두 번째 가지를 만들지 않는다).
 */
export const forkThread = (parentKey: string, childKey: string, sdk: ForkSdk = realSdk, atTurn?: string): Promise<ForkResult> =>
  enqueueThreadTurn(parentKey, () => forkNow(parentKey, childKey, sdk, atTurn));

/**
 * **이미 부모 대화의 줄 안에 있는** 호출자용 — 채팅 명령(`/fork`)은 그 세션의 턴으로 처리되므로 줄에 다시 넣으면 자기 자신을 기다린다.
 * ★줄 밖에서 부르지 마라 — 진행 중인 답의 반쪽이 가지에 들어갈 수 있다.
 */
export const forkThreadHeld = (parentKey: string, childKey: string, sdk: ForkSdk = realSdk, atTurn?: string): Promise<ForkResult> =>
  forkNow(parentKey, childKey, sdk, atTurn);

/** 실패도 로그에 남긴다 — 사유·상세가 응답으로만 가면 원격 인스턴스에서 원인을 못 잡는다(적대 검토 P2, «로그만으로 잡을 수 있어야»). */
const forkNow = async (parentKey: string, childKey: string, sdk: ForkSdk, atTurn?: string): Promise<ForkResult> => {
  const r = await forkSteps(parentKey, childKey, sdk, atTurn);
  if (!r.ok) console.warn(`[fork] 실패 ${parentKey} → ${childKey}${atTurn !== undefined ? ` (턴 ${atTurn})` : ""}: ${r.reason} — ${r.detail}`);
  return r;
};

/** SDK 복제 대상 — 어느 세션의 어느 메시지까지. S·hash 는 **그 지점의 값**이다(현재 부모 값을 다시 구하지 않는다, 아스트라 2차 회신 1·3). */
interface ClaudeCheckpoint {
  sid: string;
  jsonlPath: string;
  /** 이 uuid 까지(포함). 없으면 파일의 마지막 메시지(끝에서 가르기). */
  uuid?: string;
  includedThrough: number | null;
  systemPromptHash: string | null;
}

/**
 * Claude SDK 복제 — 체크포인트까지 복사하고 같은 완료 경계인지 확인한다. 실패 사유는 v1 그대로: SDK 가 그 세션을 모르면 «기록으로 다시 짓기»
 *  (`rebuilt`), 그 밖은 생성 실패. 메시지 지점이면 그 메시지가 **도구 호출 없는 비서 메시지**여야 한다(반쪽 턴 금지 — 보조 검사).
 */
const copyClaude = async (
  cp: ClaudeCheckpoint,
  sdk: ForkSdk,
): Promise<{ kind: "copied"; sdk: NonNullable<Parameters<typeof writeForkRecords>[0]["sdk"]>; copyPath: string } | { kind: "rebuilt" } | { kind: "none" } | { kind: "fail"; reason: "sdk_copy" | "boundary"; detail: string }> => {
  if (!fs.existsSync(cp.jsonlPath)) return { kind: "rebuilt" }; // 기록은 있다고 하는데 파일이 없다 — 부모도 지금 다시 짓는다
  const file = jsonlMessages(cp.jsonlPath);
  if (file.messages.length === 0) return { kind: "none" };
  const idx = cp.uuid === undefined ? file.messages.length - 1 : file.messages.findIndex((m) => m.uuid === cp.uuid);
  if (idx < 0) return { kind: "fail", reason: "boundary", detail: `체크포인트 메시지가 세션 파일에 없습니다: ${cp.uuid}` };
  const at = file.messages[idx]!;
  if (cp.uuid !== undefined && (at.role !== "assistant" || at.hasToolUse)) {
    return { kind: "fail", reason: "boundary", detail: `완료된 답 메시지가 아닙니다(${at.role}${at.hasToolUse ? "·tool_use" : ""})` };
  }
  let forked: string;
  try {
    forked = (await sdk.forkSession(cp.sid, { upToMessageId: at.uuid })).sessionId;
  } catch (e) {
    // 부모 세션을 SDK 도 모른다 = 부모도 지금 다시 짓는다 → 같은 상태의 가지. 그 밖(쓰기·권한·디스크·원인 불명)은 생성 실패.
    const known = await sdk.sessionKnown(cp.sid).catch(() => true);
    if (known) return { kind: "fail", reason: "sdk_copy", detail: e instanceof Error ? e.message : String(e) };
    return { kind: "rebuilt" };
  }
  const copyPath = path.join(path.dirname(cp.jsonlPath), `${forked}.jsonl`);
  if (!fs.existsSync(copyPath)) return { kind: "fail", reason: "sdk_copy", detail: `복제본 파일이 없습니다: ${forked}` };
  // 같은 완료 경계 — 복제본의 메시지 수·마지막 메시지(역할·본문)가 부모의 그 지점과 같아야 한다. 어긋나면 버린다.
  const copy = jsonlMessages(copyPath);
  const cl = copy.messages.at(-1);
  if (copy.messages.length !== idx + 1 || cl?.role !== at.role || cl.contentHash !== at.contentHash) {
    fs.rmSync(copyPath, { force: true });
    return { kind: "fail", reason: "boundary", detail: `메시지 ${copy.messages.length}/${idx + 1}` };
  }
  return {
    kind: "copied",
    copyPath,
    sdk: { sessionId: forked, jsonlPath: copyPath, lines: copy.lines, bytes: copy.completeBytes, includedThrough: cp.includedThrough, systemPromptHash: cp.systemPromptHash },
  };
};

/** 세션 파일 경로 — 그 sid 를 적재한 기록에서(조상 대화가 적재했어도 같은 파일). Codex 표식(`(codex)`)은 제외. */
const jsonlPathOf = (sid: string): string | undefined =>
  (getDb().prepare(`SELECT jsonl_path FROM transcript_index WHERE claude_session_id = ? AND jsonl_path <> '(codex)' LIMIT 1`).get(sid) as { jsonl_path: string } | undefined)?.jsonl_path;

const forkSteps = async (parentKey: string, childKey: string, sdk: ForkSdk, atTurn?: string): Promise<ForkResult> => {
  const channel = SESSION_STORAGE_CHANNEL;
  // 사용자 대화만 — 스케줄·매니저·서브에이전트 실행 맥락은 가지 대상이 아니다(설계 §3).
  if (!isUserConversationThread(parentKey) || !childKey.startsWith("dashboard:") || childKey === parentKey) {
    return { ok: false, reason: "not_forkable", detail: `${parentKey} → ${childKey}` };
  }
  if (forkExists(channel, childKey)) {
    const name = (getDb().prepare(`SELECT name FROM threads WHERE channel = ? AND channel_thread_id = ?`).get(channel, childKey) as { name: string | null } | undefined)?.name ?? "";
    const lin = getDb().prepare(`SELECT sdk_session_id FROM thread_lineage WHERE channel = ? AND thread_key = ?`).get(channel, childKey) as { sdk_session_id: string | null };
    return { ok: true, childKey, name, claude: lin.sdk_session_id !== null ? "copied" : "none" };
  }
  const prior = getSession(channel, parentKey);
  if (prior === undefined) return { ok: false, reason: "empty", detail: "아직 대화가 없는 세션" };

  // ── 자르는 지점 — 끝(v1) 또는 완료 턴 표식(v2, 설계 «유효 계약 — 구현 기준» §3) ──
  let T: number;
  let Tc: number;
  let throughTs: number | undefined;
  let cp: ClaudeCheckpoint | undefined;
  let claude: "copied" | "none" | "rebuilt" = "none";
  // ④ 진짜 Claude 세션인가 + 적재 따라잡기 — `threads.claude_session_id` 만 보면 안 된다(Codex 로 시작한 대화는 그 칸에 Codex sid, 설계 §4).
  //  ★메시지 지점에서도 먼저 따라잡는다(2026-10-15 적대 검토 P2) — 늦게 적재된 Claude 답이 고른 답의 T 밖으로 밀려 가지에서 빠졌다.
  const s = prior.claudeSessionId;
  const idx = s === "" ? undefined : getDb()
    .prepare(`SELECT jsonl_path FROM transcript_index WHERE channel = ? AND thread_key = ? AND claude_session_id = ?`)
    .get(channel, parentKey, s) as { jsonl_path: string } | undefined;
  let current: ClaudeCheckpoint | undefined;
  /** 현재 Claude 세션 파일 끝에 덜 쓴 줄이 남아 있다 — 끝에서 가르면 거절, 메시지 지점이면 그 꼬리가 고른 답 **뒤**인지 보고 정한다. */
  let partialTail: { messages: JsonlMessage[]; detail: string } | undefined;
  if (idx !== undefined && idx.jsonl_path !== "(codex)") {
    if (!fs.existsSync(idx.jsonl_path)) {
      claude = "rebuilt";
    } else {
      try {
        indexJsonlIfNeeded({ channel, threadKey: parentKey, claudeSessionId: s, jsonlPath: idx.jsonl_path });
      } catch (e) {
        return { ok: false, reason: "catch_up", detail: e instanceof Error ? e.message : String(e) };
      }
      const file = jsonlMessages(idx.jsonl_path);
      const completeBytes = file.completeBytes;
      const indexed = (getDb()
        .prepare(`SELECT bytes_indexed FROM transcript_index WHERE channel = ? AND thread_key = ? AND claude_session_id = ?`)
        .get(channel, parentKey, s) as { bytes_indexed: number | null }).bytes_indexed;
      const size = fs.statSync(idx.jsonl_path).size;
      const detail = `적재 ${String(indexed)}B · 완전한 줄 ${completeBytes}B · 파일 ${size}B`;
      // 완전한 줄까지는 반드시 다 읽었어야 한다(적재가 못 따라왔으면 거절).
      if (indexed !== completeBytes) return { ok: false, reason: "catch_up", detail };
      // 덜 쓴 꼬리 — 끝에서 가르면 T(지금)가 그 줄을 놓치므로 거절(v1). 메시지 지점은 아래에서 고른 답과 견줘 정한다(아스트라 마무리 검토).
      if (size !== completeBytes) {
        if (atTurn === undefined) return { ok: false, reason: "catch_up", detail };
        partialTail = { messages: file.messages, detail };
      }
      current = { sid: s, jsonlPath: idx.jsonl_path, includedThrough: includedEnd(channel, parentKey, s), systemPromptHash: prior.systemPromptHash };
    }
  }
  if (atTurn === undefined) {
    cp = current;
    // T·Tc — 지금 시각의 전역 최대 id. 부모(와 조상) 기록은 전부 그 이하이고, 갈라진 뒤 생기는 행은 전부 그보다 크다(id 는 단조 증가).
    T = (getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM transcripts`).get() as { m: number }).m;
    Tc = (getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM chat_log`).get() as { m: number }).m;
  } else {
    // 지금 탭 화면 범위(자기 + 조상의 갈라진 순간까지) 안의 그 답 — 표식이 없으면(오류 안내·명령 답·옛 답·저장 미확인) 갈라낼 수 없다.
    const row = findTurnRow(parentKey, atTurn);
    if (row === undefined) return { ok: false, reason: "not_turn", detail: `완료 턴 표식 없음: ${atTurn}` };
    T = row.turn.through;
    Tc = row.id;
    throughTs = row.ts;
    claude = "none"; // 메시지 지점은 현재 세션 상태가 아니라 그 지점의 체크포인트로 정한다(아래)
    // 안전망 — 이 답보다 이른데 상한 T 밖에 있는 소속 대화 행 = 늦게 적재된 기록(따라잡기로도 못 잡은 적재 실패·건너뛴 저장).
    //  정상 흐름에선 생기지 않는다(Codex 행은 그 턴 저장 시각 · Claude 다음 턴은 답 전달 뒤 시작). 있으면 그 답까지를 정확히 못 자른다.
    const sc = memberClause(threadScope(channel, parentKey), "t");
    const late = getDb()
      .prepare(`SELECT t.id, t.ts, t.role, t.claude_session_id AS sid FROM transcripts t WHERE ${sc.sql} AND t.id > ? AND t.ts <= ? AND t.role IN ('user', 'assistant') ORDER BY t.id LIMIT 5`)
      .all(...sc.params, T, throughTs) as { id: number; ts: number; role: string; sid: string }[];
    if (late.length > 0) {
      return { ok: false, reason: "catch_up", detail: `이 답(T=${T} · ${throughTs})보다 이른데 늦게 적재된 기록 — ${late.map((r) => `#${r.id} ${r.role} ts=${r.ts} sid=${r.sid.slice(0, 12)}`).join(", ")}` };
    }
    // 덜 쓴 꼬리는 그것이 고른 답 **뒤**라는 게 확실할 때만 무시한다 — 파일 안에 고른 답의 메시지가 있거나(그 뒤 줄은 다음 턴·비메시지),
    //  고른 답보다 늦은 메시지가 이미 있다(꼬리는 그보다도 뒤). 아니면 그 꼬리가 고른 답보다 **앞선** 대화일 수 있다(늦게 쓰인 Claude 답 —
    //  적대 검토 P2 탐침 A) — 거절한다. 복제는 고른 uuid 까지라 뒤 꼬리는 결과와 무관하다.
    if (partialTail !== undefined) {
      const selectedHere = row.turn.claude !== undefined && row.turn.claude.sid === s && partialTail.messages.some((m) => m.uuid === row.turn.claude!.uuid);
      const laterHere = partialTail.messages.some((m) => m.ts > row.ts);
      if (!selectedHere && !laterHere) return { ok: false, reason: "catch_up", detail: `${partialTail.detail} — 덜 쓴 꼬리가 고른 답보다 앞선 기록일 수 있다` };
    }
    // Claude 체크포인트 = 그 턴, 아니면 그보다 앞선 가장 가까운 Claude 턴(Codex 답을 골랐으면 그 뒤는 재개 델타로). 상속 카드면 표식이
    //  **원래 조상의 sid·uuid** 를 가리킨다(복제본의 바뀐 시각·uuid 를 거치지 않는다, 아스트라 회신 2).
    const mark = row.turn.claude !== undefined ? { ts: row.ts, claude: row.turn.claude } : latestClaudeMarkUpTo(parentKey, Tc);
    // 그 사이에 대화를 비웠으면(활성 경계가 체크포인트 뒤) 그 Claude 세션은 쓰지 않는다 — 지운 맥락이 되살아난다.
    if (mark !== undefined && getContextBoundary(channel, parentKey) <= mark.ts) {
      const p = jsonlPathOf(mark.claude.sid);
      if (p === undefined) claude = "rebuilt";
      else cp = { sid: mark.claude.sid, jsonlPath: p, uuid: mark.claude.uuid, includedThrough: mark.claude.includedThrough, systemPromptHash: mark.claude.systemPromptHash };
    }
  }

  // ── ⑤ SDK 복제 ──
  let sdkRec: Parameters<typeof writeForkRecords>[0]["sdk"];
  let copyPath: string | undefined;
  if (cp !== undefined) {
    const c = await copyClaude(cp, sdk);
    if (c.kind === "fail") return { ok: false, reason: c.reason, detail: c.detail };
    claude = c.kind;
    if (c.kind === "copied") { sdkRec = c.sdk; copyPath = c.copyPath; }
  }

  // ── ⑥ 한 트랜잭션 — 요약·활성 경계 검사도 여기 안에서(검사한 것 = 복사하는 것) ──
  const parentName = forkSessionName(parentKey);
  const name = forkName(parentName, sessionNames(channel));
  try {
    writeForkRecords({ channel, parentKey, childKey, throughTranscriptId: T, throughChatId: Tc, ...(throughTs !== undefined ? { throughTs } : {}), name, ...(sdkRec !== undefined ? { sdk: sdkRec } : {}) });
  } catch (e) {
    if (copyPath !== undefined) fs.rmSync(copyPath, { force: true }); // 남아도 DB 가 안 가리켜 안 보인다 — 그래도 치운다
    if (e instanceof ForkRecordRejected) return { ok: false, reason: e.reason, detail: e.message };
    return { ok: false, reason: "write", detail: e instanceof Error ? e.message : String(e) };
  }
  console.log(`[fork] ${parentKey} → ${childKey} «${name}» · Claude=${claude} · T=${T} Tc=${Tc}${atTurn !== undefined ? ` · 턴 ${atTurn}` : ""}${sdkRec !== undefined ? ` · S=${String(sdkRec.includedThrough)}` : ""}`);
  // 가지 화면의 «여기서 갈라짐» 구분선 — 대화 가시 이벤트라 가지의 기록에 남고(`event-persist`) 화면이 그린다. 문구는 화면이 짓는다.
  try {
    getEventBus().publish({ type: "thread.forked", ts: Date.now(), payload: { threadKey: childKey, channel, parentKey, parentName, name, claude } });
  } catch {
    // 구분선은 표시일 뿐이다 — 가지는 이미 만들어졌다.
  }
  return { ok: true, childKey, name, claude };
};

const getSessionName = (threadKey: string): string | null =>
  (getDb().prepare(`SELECT name FROM threads WHERE channel_thread_id = ? AND name IS NOT NULL LIMIT 1`).get(threadKey) as { name: string } | undefined)?.name ?? null;

// ─── 가지 결론을 원래 대화로 (2026-10-15 정태님 «이번에 넣자») ──────────────────────
//
// 대화 **합치기는 안 한다**(갈라진 두 맥락의 충돌을 기계가 못 가르고, Claude SDK 세션은 합칠 수 없다). 대신 가지에서 정해진 것만
//  원래 대화에 넘긴다: ①가지 비서가 (자기 맥락 전부를 아는 채로) 결론을 정리하고 — 그 답은 가지 화면에 남는다 — ②그 결론을
//  원래 대화의 비서에게 합성 알림으로 전한다(받은 것을 사용자에게 알리고 맥락으로 이어받는다). 두 턴 모두 **메인 핸들러**(세션 줄)를 탄다 —
//  매니저 결과 재주입과 같은 문이라 어댑터 무관(Claude·Codex·OpenAI)이다.

/** 갈라진 뒤 첫 메시지를 가리키는 인용 길이 — 경계를 알아볼 만큼만. */
const CARRY_ANCHOR_CHARS = 80;

/**
 * 가지 비서에게 주는 정리 지시 — 모델이 읽는 글이다(사용자에게 안 보인다: 합성 턴).
 * ★정리는 **빠짐없이**다 (10-15 정태님 «충분히 정리해서 넘기는 거지?») — 원래 대화의 비서는 이 글 하나로 가지에서 한 일을 이어받는다.
 *  종전엔 «짧게» 라고 시켜, 결정·산출물이 많은 가지에서 세 줄로 줄어들 수 있었다.
 * ★경계를 알려 준다 — 가지의 기록엔 갈라지기 전 대화도 다 있는데 표시가 없어서, 모델이 «갈라진 뒤» 를 짐작으로 골랐다.
 *  가지에서 처음 보낸 메시지(가지 자신의 화면 기록 첫 줄 — 물려받은 기록은 원래 대화 키로 남는다)를 인용한다.
 */
const carryAsk = (parentName: string, firstSince: string, sentBefore: boolean): string => {
  const head = firstSince.replace(/\s+/g, " ").trim();
  const quote = `«${head.length > CARRY_ANCHOR_CHARS ? `${head.slice(0, CARRY_ANCHOR_CHARS)}…` : head}»`;
  // ★두 번째부터는 **지난번 보낸 뒤**만 — 이미 보낸 것을 다시 쓰면 원래 대화에 겹쳐 쌓인다(10-15 정태님 «다시 보내면 그 이후의 내용을»).
  const anchor = sentBefore
    ? `이 가지의 결론은 이미 한 번 이상 원래 대화로 보냈습니다. 지난번 보낸 뒤 사용자가 처음 보낸 메시지는 ${quote} 입니다 — 거기서부터 지금까지만 정리하고, 이미 보낸 내용은 다시 쓰지 마세요. `
    : `갈라진 뒤 사용자가 처음 보낸 메시지는 ${quote} 입니다 — 거기서부터 지금까지가 정리 범위입니다. `;
  return (
    `[가지 결론 정리] 이 대화는 «${parentName}» 에서 갈라진 가지입니다. 사용자가 이 가지의 결론을 원래 대화로 보내려 합니다. ${anchor}` +
    `그 범위에서 한 일을 **빠짐없이** 정리하세요(항목마다 간결하게): 정해진 것(기존 결정을 바꿨으면 무엇에서 무엇으로) · 알아낸 것 · ` +
    `만든 것과 그 위치 · 확인한 것과 확인하지 못한 것 · 남은 할 일. 갈라지기 전 내용·인사·배경 설명은 빼고, ` +
    `원래 대화의 비서가 이것 하나로 그대로 이어받을 수 있게 씁니다. 이 답이 그대로 원래 대화로 전달됩니다. 사용자가 쓰는 언어로 답하세요.`
  );
};

export interface CarryOrigin {
  /** 요청이 온 채널 — 두 턴의 답이 여기로 나간다(대시보드는 화면만, 텔레그램은 그 방). */
  channel: ChannelName;
  /** 배달 좌표(텔레그램 chatId 등) — 없으면 화면 관측만(대시보드). */
  address?: string;
}

export type CarryResult =
  | { ok: true; parentKey: string; parentName: string; conclusion: string }
  | { ok: false; reason: "not_fork" | "no_handler" | "busy" | "empty" | "nothing_new" | "failed"; detail: string };

export interface CarryDeps {
  runTurn?: ((msg: IncomingMessage) => Promise<unknown>) | undefined;
  /** 답 배달 — 회귀가 갈아 끼운다. 기본은 코어 단일 통로(`deliverOutbound`, 관측은 핸들러가 한다). */
  deliver?: (input: { channel: ChannelName; target: string | null; text: string; originThreadKey: string }) => Promise<unknown>;
}

/** 지금 결론을 보내는 중인 가지 — 같은 가지를 두 번 겹쳐 보내면 같은 결론이 원래 대화에 두 번 들어간다(적대 검토 P2). */
const carrying = new Set<string>();
export const isCarrying = (childKey: string): boolean => carrying.has(childKey);

/**
 * 가지의 결론을 원래 대화로 보낸다. ①을 **기다리고**(결론이 있어야 ②를 만든다) ②는 **줄에 넣고 돌아온다**(원래 대화의 답은 그쪽 화면에 뜬다).
 * ★가지 대화의 줄 **밖에서** 불러야 한다 — ①이 가지 줄에 턴을 넣는다(`/fork back` 은 명령이 그 줄 안이라 백그라운드로 부른다).
 * ★②는 원래 대화가 답하는 중이면 그 턴에 끼어든다(steering) — 사용자가 그 대화에 말을 건 것과 같은 규칙이다(설계 문서).
 */
/** 세션의 사람이 읽는 이름 — 결론 보내기 안내(명령 답·알림)가 같은 규칙으로 부른다. */
export const forkSessionName = (k: string): string => sessionDisplayName(k, getSessionName(k), getFirstUserText(k), k);

export const carryForkConclusion = async (childKey: string, origin: CarryOrigin, deps: CarryDeps = {}): Promise<CarryResult> => {
  const runTurn = "runTurn" in deps ? deps.runTurn : mainMessageHandler();
  const deliver = deps.deliver ?? ((i) => deliverOutbound({ ...i, label: "fork", observe: false }));
  const channel = SESSION_STORAGE_CHANNEL;
  const lin = getLineage(channel, childKey);
  if (lin === undefined) return { ok: false, reason: "not_fork", detail: childKey };
  if (runTurn === undefined) return { ok: false, reason: "no_handler", detail: "메인 핸들러 미등록" };
  if (carrying.has(childKey)) return { ok: false, reason: "busy", detail: "이미 보내는 중" };
  carrying.add(childKey);
  try {
    const parentName = forkSessionName(lin.parentKey);
    const childName = forkSessionName(childKey);
    // 답 배달 — **그 턴의 세션 이름으로** 귀속한다(답장하면 그 세션으로 간다). 종전엔 `/fork back` 명령의 답 클로저(가지)를 같이 써서
    //  원래 대화의 답까지 가지 것으로 기록됐다(적대 검토 P2). 대시보드는 관측 전용 채널이라 여기선 아무것도 안 나간다(화면은 핸들러가).
    const replyFor = (threadKey: string) => async (t: string): Promise<void> => {
      await deliver({ channel: origin.channel, target: origin.address ?? null, text: t, originThreadKey: threadKey });
    };
    const turn = (threadKey: string, text: string, synthetic: boolean, reply: (t: string, o?: ReplyOptions) => Promise<void>): IncomingMessage => {
      const address = origin.address ?? threadKey;
      return {
        channel: origin.channel,
        channelUserId: "fork-carry",
        threadKey,
        channelAddress: address,
        // 세션을 **지정**한다 — 대화방 바인딩이 어디를 가리키든 이 두 턴은 이 세션들로 간다.
        session: { explicitSessionId: threadKey, channelAddress: address },
        synthetic,
        turnOrigin: "synthetic-other",
        receivedAt: Date.now(),
        text,
        reply,
      };
    };
    // ① 가지 비서가 정리한다 — 지시는 합성(사용자 버블 없음), 답은 가지 화면(또는 그 방)에 남는다.
    //  ★실패 답(`turnFailed` — 한도·장애·훅 차단·중단 안내)은 **결론이 아니다**. 종전엔 그 문구가 결론으로 원래 대화에 들어갔다(적대 검토 P3).
    // 정리 범위의 시작 — 지난번 보낸 표식(`thread.carried`) 뒤 첫 사용자 메시지, 표식이 없으면 갈라진 뒤 첫 메시지(가지 자신의 화면 기록 —
    //  물려받은 기록은 원래 대화 키로 남는다). ★없으면 **보낼 새 내용이 없다** — 가지 비서를 부르지 않는다(헛턴·같은 결론 중복 방지).
    const since = firstUserTextAfterKind(childKey, "thread.carried");
    if (since.text === "") return { ok: false, reason: "nothing_new", detail: since.marked ? "지난번 보낸 뒤 새 대화 없음" : "갈라진 뒤 대화 없음" };
    let conclusion = "";
    let failed = "";
    const sendBranch = replyFor(childKey);
    try {
      await runTurn(turn(childKey, carryAsk(parentName, since.text, since.marked), true, async (t, o) => {
        if (o?.turnFailed === true) failed = t;
        else conclusion = t;
        await sendBranch(t);
      }));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.warn(`[fork] 결론 정리 실패 ${childKey}: ${detail}`);
      return { ok: false, reason: "failed", detail };
    }
    if (failed !== "") {
      console.warn(`[fork] 결론 정리 턴 실패 ${childKey}: ${failed.slice(0, 160)} — 원래 대화로 보내지 않음`);
      return { ok: false, reason: "failed", detail: failed.slice(0, 160) };
    }
    if (conclusion.trim() === "") {
      console.warn(`[fork] 결론 정리가 빈 답 ${childKey} — 원래 대화로 보내지 않음`);
      return { ok: false, reason: "empty", detail: "빈 답" };
    }
    // ② 원래 대화의 비서에게 **알림으로** 전한다 — 합성 턴(사용자 말풍선 없음)이고, 화면에는 비서가 «무엇을 받았는지» 알리는 답만 남는다.
    //  백그라운드 작업 완료 알림과 같은 모양이다. 줄에 넣고 돌아온다.
    //  ★종전엔 보이는 메시지(사용자 말풍선)였다 — 비서에게 하는 당부(«맥락으로 받아 두세요 … 저에게 확인해 주세요»)가 **사용자 이름으로**
    //   떠서 시스템 공지처럼 부자연스러웠다(10-15 정태님). 읽는 이가 둘(사람·모델)인 글을 한 메시지에 쓴 것이 원인.
    //  ★본문은 가지 **비서**가 쓴 글이다 — 알림이 «참고 맥락, 새 지시 아님» 을 밝힌다(사용자 권위로 올라가지 않게, 적대 검토 P2).
    const carried = translate("srv.fork.carried", { name: childName, conclusion: conclusion.trim() });
    void Promise.resolve(runTurn(turn(lin.parentKey, carried, true, replyFor(lin.parentKey)))).catch((e: unknown) => {
      console.warn(`[fork] 결론 전달 턴 실패 ${lin.parentKey}: ${e instanceof Error ? e.message : String(e)}`);
    });
    // 가지 화면에 «여기까지 보냈다» 구분선 — 다음 보내기의 범위 시작 표식이기도 하다(대화 가시 이벤트 → chat_log).
    try {
      getEventBus().publish({ type: "thread.carried", ts: Date.now(), payload: { threadKey: childKey, channel, parentKey: lin.parentKey, parentName } });
    } catch {
      /* 관측 발행 실패가 보내기를 무르지 않는다 — 다음 보내기가 조금 겹칠 뿐이다. */
    }
    console.log(`[fork] 결론 전달 ${childKey} → ${lin.parentKey} (${conclusion.length}자)`);
    return { ok: true, parentKey: lin.parentKey, parentName, conclusion };
  } finally {
    carrying.delete(childKey);
  }
};
