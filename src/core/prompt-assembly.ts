/**
 * 영역 코어 — user 프롬프트 조립 (양 어댑터 공통, 분기 0).
 *
 * memory.ts 분해(7b)로 추출 — 동작 무변경, 순수 이동.
 *  - `formatMemorySnippet`: RetrievedContext → prompt prepend 텍스트 블록.
 *  - `formatMemoryIndex`: 전체 memories 1줄 인덱스 (progressive disclosure).
 *  - `formatConversationContext`: 현재 채널/dest_target prepend.
 *  - `formatAttachments`: 첨부 placeholder 블록 prepend.
 *  - `assembleUserPrompt`: system-reminder 래핑 (Claude Code 컨벤션).
 */
import type { Attachment } from "../channels/types.js";
import { listMemoriesForIndex } from "../store/memory.js";
import type { RetrievedContext } from "./memory.js";

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
