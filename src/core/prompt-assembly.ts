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
import { agentPathHint } from "./identity.js";
import { extractTelegramChatId } from "./threadkey.js";
import { listMemoriesForIndex } from "../store/memory.js";
import type { RetrievedContext } from "./memory.js";
import { loadModelProfiles, type ModelProfile } from "./settings.js";
import { listLiveChildJobs } from "./worker-jobs.js";

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
    // 인덱스 티어링(효율감사 P2a 계약 §3.6) — 소실 오인 방지 재프레이밍. 절단분은
    // 데이터 소실이 아니라 "지도에 안 실렸을 뿐": (1) 관련 대화가 오면 자동 검색
    // (retrieveContext)이 여전히 찾아 스니펫으로 되살리고, (2) 정확한 이름을 알면
    // `read_memory` 로 바로 fetch 가능(FTS 는 아카이브·절단 무관 전 메모리를 계속
    // findable 하게 유지).
    out.push(
      `… ${truncated}건 더 (인덱스 캡 — 소실 아님: 관련 대화 시 자동 검색으로 도달, 이름 알면 read_memory 로 직접 fetch)`,
    );
  }
  return out.join("\n");
};

// ─── 모델 프로파일 인지 — 에이전트/워커 구성 시 프로파일 선택 (capability-index 패턴) ──
// 비서가 spawn_agent(model)/run_worker(tier) 를 구성/위임할 때 settings.json 에 정의된
// 명명 프로파일을 인지하도록, depth 0 turn 의 system-context 에 주입한다. 스킬·에이전트
// 인덱스와 동일 패턴 — 정적 sysprompt(claude SYSTEM_PROMPT_HASH 보존)가 아니라
// user-prompt system-reminder 로 prepend(어댑터가 depth 0 만 호출).
//  - §0(코어가 모델명 하드코딩 X): loadModelProfiles(settings.json) 데이터만 읽어 렌더.
//    코어엔 default/high/mid/low 같은 이름·pool 이 하나도 박혀 있지 않다.
//  - #2(LLM-agnostic): 세 어댑터가 이 동일 텍스트를 동일 순서로 prepend. 프로파일
//    해석(resolveModelChain)은 이미 3어댑터 대칭이라 인지도 대칭.
//  - 바운드: 프로파일 수는 본질적으로 소수(홈+프로젝트 소수). description/pool 은 캡.
//  - graceful: 프로파일 부재(settings.json 없음)·loadModelProfiles throw → "" (섹션 생략).
const PROFILE_DESC_CAP = 120;
const PROFILE_POOL_SHOW = 3;

export const formatModelProfiles = (
  cwd: string = process.cwd(),
): string => {
  let profiles: Record<string, ModelProfile>;
  try {
    profiles = loadModelProfiles(cwd);
  } catch {
    // never-throw — 프로파일 렌더 실패가 턴을 죽이지 않게(원칙 3, settings.ts 동형).
    return "";
  }
  const names = Object.keys(profiles);
  if (names.length === 0) return "";
  const lines = ["## 모델 프로파일 (에이전트·매니저 구성 시 model/tier 로 지정)"];
  for (const name of names) {
    const p = profiles[name];
    const desc =
      p.description !== undefined && p.description.trim() !== ""
        ? ` — ${truncate(p.description.replace(/\s+/g, " "), PROFILE_DESC_CAP)}`
        : "";
    const shown = p.pool.slice(0, PROFILE_POOL_SHOW);
    const more = p.pool.length > PROFILE_POOL_SHOW ? ", …" : "";
    const pool = shown.length > 0 ? ` [${shown.join(", ")}${more}]` : "";
    lines.push(`- \`${name}\`${desc}${pool}`);
  }
  lines.push(
    "에이전트·매니저를 구성/위임할 때 `model`(spawn_agent)·`tier`(run_worker) 에 위 프로파일 이름 중 **작업 성격에 어울리는 걸** 고르세요 — 고난도 설계·분석=high, 구현=mid, 요약·분류=low, 기본=default. 커스텀 프로파일이 있으면 그 description 에 맞춰. 지정한 이름의 풀+폴백으로 실행됩니다. `provider:model` 직접 지정도 가능합니다.",
    "(claude 네이티브 Task 서브에이전트는 opus/sonnet/haiku 3등급으로 축약되고, 프로파일 풀·폴백 전체는 codex/openai 서브에이전트·매니저에서 적용됩니다.)",
  );
  return lines.join("\n");
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
  channelAddress?: string,
): string => {
  // ★자기 세션 정체성 (2026-07-29 사용자 질문 "메인비서가 현재 세션을 알고 있나?" → 몰랐다).
  //  종전 블록엔 **배달 좌표**(dest_channel/dest_target)만 있고 "나는 어느 대화인가"가
  //  없었다. 그래서 전 세션 통합 목록(옛 list_workers)을 봐도 어느 줄이 자기 것인지
  //  판단할 근거가 아예 없었고, 남의 대화 워커를 자기 것으로 오인했다(실사고). 도구를
  //  세션 스코프로 좁히는 것과 짝이다 — 좁힌 범위가 무엇인지 본인이 알아야 한다.
  const lines = [`- 이 대화(세션) id: ${threadKey}`, `- 채널 (dest_channel): ${channel}`];
  // 채널/세션 분리(ADR 2026-07-15 §D3): dest_target 은 세션 id 파싱이 아니라 **캡처된
  // 배달 좌표**(channelAddress)를 우선 쓴다 — 세션 id 가 채널 무관(dashboard:*)이 되면
  // threadKey 파싱으로 chatId 를 못 얻기 때문. 미지정이면 telegram threadKey "tg:<chatId>"
  // 파싱 폴백(회귀 0). ★여긴 *실채널* 좌표 — 세션-정체성 채널(canonical)과 무관(2분리).
  const captured = channelAddress?.trim();
  const chatId =
    captured !== undefined && captured !== ""
      ? captured
      : channel === "telegram"
        ? extractTelegramChatId(threadKey)
        : null;
  if (chatId !== null) {
    lines.push(`- 이 대화 대상 (dest_target): ${chatId}`);
  }
  // ★진행 중인 백그라운드 작업 (2026-07-29) — 이 대화가 띄워 **지금 돌고 있는** 잡.
  //  실사고: 워커가 아직 도는데 메인이 같은 일로 워커를 하나 더 띄웠다(23:41 시작한 잡이
  //  살아있는 채 23:43 에 또 발사 — DB 실측). 원인은 모델이 게을러서가 아니라 **자기가 뭘
  //  띄웠는지 턴 안에서 볼 수단이 없었기** 때문이다. 규칙으로 훈계하는 대신 사실을 준다
  //  (판단 근거를 가진 쪽이 판단한다). 없으면 줄 자체를 안 넣는다 = 평시 토큰 0.
  const live = liveChildJobsLine(threadKey);
  return [
    "## 현재 대화 컨텍스트",
    ...lines,
    ...(live !== "" ? [live] : []),
    '스케줄·알림 등을 "지금 이 대화로" 보낼 때 위 dest_channel/dest_target 를 사용하세요.',
  ].join("\n");
};

/**
 * 이 대화가 띄워 진행 중인 잡 한 줄. 없으면 "".
 * 손자까지 포함(잡 좌표는 원 세션으로 환원 — hasLiveChildJob 과 같은 기준).
 */
const liveChildJobsLine = (threadKey: string): string => {
  try {
    const jobs = listLiveChildJobs(threadKey);
    if (jobs.length === 0) return "";
    const now = Date.now();
    const items = jobs
      .slice(0, 5)
      .map((j) => {
        const mins = Math.max(0, Math.round((now - j.startedAt) / 60000));
        return `${j.kind === "agent" ? "서브에이전트" : "매니저"} '${j.label}'(${mins}분째)`;
      })
      .join(", ");
    const more = jobs.length > 5 ? ` 외 ${jobs.length - 5}건` : "";
    return (
      `- **진행 중인 백그라운드 작업**: ${items}${more}\n` +
      "  같은 일을 또 띄우지 마세요 — 끝나면 결과가 이 대화로 돌아옵니다. 상태는 list_workers(이 대화 것만) 로 확인하세요."
    );
  } catch {
    return ""; // 조회 실패는 컨텍스트 누락일 뿐 — 턴을 막지 않는다.
  }
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
    const base = `- [${a.kind} | ${a.mimeType} | ${a.bytes}B] ${a.filename} → ${a.path}${cap}`;
    // 오디오/음성: 전사(runRegionA seam 이 채움) 있으면 텍스트로 실어 모델이 바로 이해.
    // 없으면(미설정/실패) 현행 path-reference + 중립 노트. "전사" 라벨로 원문 아님 명시(환각 완화).
    if (a.kind === "audio" || a.kind === "voice") {
      return a.transcript !== undefined && a.transcript !== ""
        ? `${base}\n  전사: "${truncate(a.transcript.replace(/\s+/g, " "), 4000)}"`
        : `${base}\n  (오디오는 파일로만 첨부됨 — 전사 미설정/실패)`;
    }
    return base;
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
      "첨부 이미지가 직접 보이면 그 내용으로 답하세요. 보이지 않으면 **보이지 않는다고 말하고** 사용자에게 다시 보내달라고 하세요 — `Read` 는 텍스트 파일만 읽습니다(이미지는 첨부로 전달된 것만 볼 수 있습니다). 정말 해석이 안 될 때만 그 사실을 사용자에게 알리세요.",
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

/**
 * system-context 조립 *순서*의 단일 정의점 — claude/codex/openai 세 어댑터가 이 배열을
 * 각자 동일 순서로 복제했다(parity #2: 셋이 반드시 같은 순서여야 함). 여기 하나로 모아
 * 순서를 구조적으로 강제한다(같은 걸 두 번 구현 X). 빈 파트는 assembleUserPrompt 가
 * 거르므로, claude 전용 foreignDelta 를 항상 자리에 두어도 다른 어댑터에선 무해("").
 * agentPathHint() 도 이 순서의 일부라 여기서 호출한다.
 */
export const buildSystemContextParts = (input: {
  system: string;
  /** 환경 자기인지(env 블록, runtime-env.ts formatEnvContext) — depth 게이트 없음(전 depth). */
  env: string;
  agent: string;
  agentWarn: string;
  convoContext: string;
  memoryIndex: string;
  memorySnippet: string;
  skillIndex: string;
  agentIndex: string;
  /** 모델 프로파일 인지 블록(depth 0 만) — 미전달/빈 문자열이면 assembleUserPrompt 가 필터. */
  modelProfiles?: string;
  /** claude 전용 — cross-adapter foreign(codex) delta 블록. 다른 어댑터는 미전달. */
  foreignDelta?: string;
}): string[] => [
  input.system,
  input.env,
  input.agent,
  input.agentWarn,
  agentPathHint(),
  input.convoContext,
  input.foreignDelta ?? "", // claude 전용 — 그 외 어댑터는 ""(assembleUserPrompt 가 필터).
  input.memoryIndex,
  input.memorySnippet,
  input.skillIndex,
  input.agentIndex,
  input.modelProfiles ?? "", // depth 0 만 — 그 외/부재는 ""(assembleUserPrompt 가 필터).
];
