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
import { loadModelProfiles, poolSpecs, type ModelProfile } from "./settings.js";
import { listLiveChildJobs } from "./worker-jobs.js";
import { readFileSync } from "node:fs";
import { getPaths } from "./paths.js";
import { parseFile } from "../store/self-growth-md.js";
import { resolveModelProfiles } from "./llm-runtime/builtin-profiles.js";
import {
  inlineSuggestionRule,
  readSuggestionSettings,
} from "./next-message-suggestion.js";

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
/**
 * 매 턴 실리는 메모리 인덱스의 상한. **user 채널이라 캐시가 안 걸린다** — 그래서 상한이 있다.
 *
 * ★40KB 는 **실제 인덱스를 만들어 재서** 나왔다 (2026-08-11):
 *  - 전량 실측 **27,572B / 169줄 / 줄당 163B**. 종전 8,192B 에선 **45줄만 실리고 124줄이
 *    잘렸다** — 73%다.
 *  - 잘리는 쪽이 안 쓰이는 것도 아니었다: 잘린 것 중 최상위가 22·21·21·21·20회 읽힘.
 *  - 40,960B = 전량(27.6KB) + 여유 13.4KB(약 82줄). 증가가 월 ~60건 ≈ 9.8KB 라 1.4개월.
 *    32,768B 면 지금은 0 잘림이지만 **2주면 다시 넘친다** — 그래서 안 골랐다.
 *
 * ★처음엔 SQL 추정식(`name+description+8`)으로 17,449B 라 보고 24KB 를 골랐는데 **틀렸다**.
 *  실제 포맷이 60% 더 크다. 재는 대신 공식을 믿으면 이렇게 된다 — 이 값을 다시 정할 땐
 *  `listMemoriesForIndex(큰 값)` 을 **실제로 불러서** 재라.
 *
 * ★크기를 늘려도 되는 근거: 프롬프트 프리픽스는 실측 입력 200K 토큰의 10%뿐이고
 *  시스템 채널은 캐시 적중 92.8% 다. 이 +19KB 는 5~7K 토큰/턴 ≈ 입력의 3%.
 *  비용 축이 아니라 **도달 축**의 결정이다(prompt-audit ⑩).
 *
 * ★넘치면 `listMemoriesForIndex` 가 **읽힘 순**으로 자른다(hot-first, 2026-08-11) —
 *  실패 모드가 "안 읽힌 것부터" 라 상한이 넘어도 안전하다. 캡을 없애지 않는 이유는
 *  사용자가 계속 쌓으면 무한 증가하기 때문이다.
 */
export const MEMORY_INDEX_CAP_BYTES = 40_960;

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

// ─── 확정 지침(SELF_GROWTH.md) — 자가성장 루프의 마지막 칸 ─────────────────
/**
 * **확정된 지침이 실제 행동으로 돌아오게 한다** (2026-08-02).
 *
 * ★왜 필요했나: self-growth 는 관측→제안→(저위험)자동 확정까지 만들어 놓고, 확정분을
 *  `<home>/SELF_GROWTH.md` 에 적재했다. 그런데 **코어가 그 파일을 프롬프트에 싣지 않았다** —
 *  포인터 메모리가 "작업 착수 전 Read 하라" 고 말할 뿐이었고, 그 포인터조차 메모리 인덱스
 *  캡(8KB / 실제 18.7KB) 안에서 밀려날 수 있었다. 즉 **지침을 읽으라는 지침이 배달 위험에
 *  노출**돼 있었다. 루프의 마지막 칸이 비어 있으면 앞의 관측·확정이 전부 무의미하다.
 *
 * ★안정 조각(system 채널)으로 싣는다 — 확정 지침은 턴마다 바뀌지 않으므로 프리픽스 캐시에
 *  함께 실린다(AGENT.md 와 같은 성질). 비어 있으면 "" 라 비용 0(현재 지침 0건 = 0바이트).
 *
 * ★캡: 지침은 `DIRECTIVE_HARD_CAP`(50) + TTL 로 이미 바운드돼 있지만, 프롬프트에 싣는 쪽도
 *  독립 상한을 둔다 — 한 계층의 상한을 다른 계층이 믿지 않는다(오늘 여러 번 나온 부류).
 */
const DIRECTIVE_INDEX_CAP_BYTES = 4096;

export const formatSelfGrowthDirectives = (): string => {
  let body: string;
  try {
    body = readFileSync(getPaths().selfGrowthMd, "utf8");
  } catch {
    return ""; // 파일 없음 = 확정 0 = 실을 것 없음(정상).
  }
  let directives: ReturnType<typeof parseFile>;
  try {
    directives = parseFile(body);
  } catch {
    return ""; // 손상 파일이 턴을 무르지 않는다.
  }
  if (directives.length === 0) return "";
  // user 확정을 먼저(영구·사용자 의사) — auto 는 TTL 대상이라 뒤로.
  const sorted = [...directives].sort((a, b) =>
    a.source !== b.source ? (a.source === "user" ? -1 : 1) : b.updatedAt - a.updatedAt,
  );
  const out: string[] = ["## 확정 지침 (self-growth)"];
  let bytes = 0;
  let shown = 0;
  for (const d of sorted) {
    const line = `- [${d.source}] ${d.text.split("\n")[0]}`;
    const n = Buffer.byteLength(line) + 1;
    if (bytes + n > DIRECTIVE_INDEX_CAP_BYTES) break;
    out.push(line);
    bytes += n;
    shown += 1;
  }
  if (shown < sorted.length) {
    out.push(`… ${sorted.length - shown}건 더 (상한 — 전문은 SELF_GROWTH.md)`);
  }
  return out.join("\n");
};

// ─── 모델 프로파일 인지 — 에이전트/워커 구성 시 프로파일 선택 (capability-index 패턴) ──
// 비서가 spawn_agent(model)/run_worker(tier) 를 구성/위임할 때 settings.json 에 정의된
// 명명 프로파일을 인지하도록, depth 0 turn 의 system-context 에 주입한다. 스킬·에이전트
// 인덱스와 동일 패턴 — 어댑터 시스템 채널의 *안정* 스캐폴딩으로 실린다(2026-07-30
// splitSystemContext. 그 전엔 user-prompt system-reminder). 어댑터가 depth 0 만 호출.
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
    // ★설정이 0개면 빌트인 조립을 쓴다 (2026-08-19). 종전엔 새 설치에서 이 섹션이 통째로
    //  비어, 비서가 **자기가 쓸 수 있는 모델 등급을 모르는 채** 서브에이전트를 구성했다.
    //  런타임은 빌트인으로 도는데 인벤토리만 비어 있던 것 — 같은 폴백을 `/models` 에만
    //  적었던 대가다. 이제 `resolveModelProfiles` 한 곳이 판정한다.
    profiles = resolveModelProfiles(cwd).profiles;
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
    const shown = poolSpecs(p.pool).slice(0, PROFILE_POOL_SHOW);
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
//  안내는 중립 — "직접 보이면 그걸로, 안 보이면 경로 Read, 그래도 아니면 정직 보고".
//  ★2026-07-31 교정: 07-28(421d067)에 이 문장을 "Read 는 텍스트만 읽는다" 로 뒤집었다.
//   근거는 codex/openai 의 file-ops Read(`fs.readFile(utf8)`)였는데, **claude 는 그 Read 를
//   안 쓴다** — SDK 내장 Read 가 이미지를 vision 으로 반환하고, claude 어댑터엔 inline
//   이미지 주입 경로가 아예 없어 **Read 가 유일한 통로**다. 그래서 claude 가 사진을 못 보게
//   됐다. 실측 A/B(실 SDK 8회): 뒤집은 문구 Read 호출 1/4 · 오답/환각 3건("초록 배경 위
//   빨간 하트" ← 실제는 노란 배경 위 파란 삼각형), 이전 문구 4/4 정답.
//   어느 한쪽 문구도 양쪽에 참이 아니었다 → **행동 지시**로 쓴다("열어보고, 그림이 아니면
//   정직 보고"). 어댑터 분기 0을 유지하면서 양쪽에서 옳게 동작한다.
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
      "첨부 이미지가 직접 보이면 그 내용으로 답하세요. 직접 보이지 않으면 **먼저 그 경로를 `Read` 로 열어보세요** — 어댑터에 따라 `Read` 가 이미지를 그림으로 돌려줍니다. `Read` 결과가 그림이 아니라 텍스트/바이너리면 그때 **보이지 않는다고 말하고** 다시 보내달라고 하세요. ★추측으로 이미지 내용을 지어내지 마세요.",
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
//  있어 안의 imperative 를 메아리치지 않고, 지시어 해석도 태그 밖만 본다 — Anthropic
//  자체 패턴. codex/GPT 는 태그 자체엔 학습 안 됐을 수 있으나 명시 구획 표식이라 raw
//  보다는 강하게 작동.
// 2026-07-30 — 이 함수가 받는 건 이제 **휘발 조각만**이다. 안정 조각(SYSTEM.md·AGENT.md·
//  스킬/에이전트 인덱스·모델 프로파일)은 프리픽스 캐시를 타도록 시스템 채널로 올라갔다
//  (splitSystemContext 주석). 위 메아리 위험은 *user 채널*이라서 생긴 것이라 이동한
//  조각들엔 해당하지 않는다.
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

interface SystemContextInput {
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
  /** 모델 프로파일 인지 블록(depth 0 만) — 미전달/빈 문자열이면 슬롯이 걸러진다. */
  modelProfiles?: string;
  /** claude 전용 — cross-adapter foreign(codex) delta 블록. 다른 어댑터는 미전달. */
  foreignDelta?: string;
  /**
   * 역할 판정의 **재료** — 어댑터가 문구를 조립하지 않는다 (2026-08-21 적대 검토 A-F1).
   *
   * ★종전엔 `role?: string` 이라 어댑터 셋이 각자 `roleContextBlock({subagentDepth…})` 를
   *  불러 넘겼다. 그래서 ①배선이 **세 벌**이고 ②`optional` 이라 통째로 지워도 컴파일이
   *  통과했다 — 실제로 셋 다 지우고 회귀 1,461건이 초록이었다. 한 어댑터만 빠지면 그
   *  어댑터의 매니저만 자기를 메인으로 알고 없는 도구를 찾는다(LLM-agnostic 위반, 무소음).
   *
   * ★고침 둘: **필수**로 만들어 지우면 타입체크가 막고(게이트가 이미 돈다), **객체 하나**를
   *  받아 어댑터가 `roleSource: input` 만 쓰게 한다 — 넘길 값이 하나면 **뒤바꿀 수가 없다**
   *  (depth 두 개를 교차시키는 변이가 정규식 린트로는 안 잡혔다).
   */
  roleSource: { subagentDepth?: number; workerDepth?: number };
}

/**
 * 조각이 실릴 채널.
 *  - `"system"`: 어댑터의 **시스템 채널**(codex/openai `instructions`, claude SDK
 *    `systemPrompt`). 프롬프트 앞머리라 프리픽스 캐시가 걸린다.
 *  - `"user"`: user 프롬프트의 `<system-reminder>` 블록. 캐시 밖.
 */
type ContextChannel = "system" | "user";

interface ContextSlot {
  readonly key: string;
  readonly text: string;
  readonly channel: ContextChannel;
}

/**
 * system-context 조립 *순서*와 **채널 배치**의 단일 정의점 — claude/codex/openai 세
 * 어댑터가 이 배열을 각자 동일 순서로 복제했다(parity #2: 셋이 반드시 같은 순서여야 함).
 * 여기 하나로 모아 순서를 구조적으로 강제한다(같은 걸 두 번 구현 X). 빈 파트는
 * splitSystemContext 가 거르므로, claude 전용 foreignDelta 를 항상 자리에 두어도 다른
 * 어댑터에선 무해(""). agentPathHint() 도 이 순서의 일부라 여기서 호출한다.
 *
 * ★channel 배치 기준 = **턴마다 변하나** (2026-07-30, 프리픽스 캐시 실측 기반):
 *  OpenAI/Anthropic 프리픽스 캐시는 **앞에서만** 매칭한다. 종전엔 조립 프리픽스 48.8KB
 *  전부가 input 배열의 **맨 끝**(현재 턴)에 실려 구조적으로 캐시 불가였다 — codex 실측
 *  `cachedTokens` 가 거의 모든 턴 정확히 3,456(= instructions 뿐), 단일턴 적중률 11.7%.
 *  그래서 턴 사이에 안 변하는 조각(SYSTEM.md·AGENT.md·스킬/에이전트 인덱스·모델 프로파일
 *  ≈ 36.9KB, 76%)만 시스템 채널로 올린다. 나머지(env=날짜, 대화 컨텍스트=진행 중인 잡,
 *  메모리 인덱스=추가 시 변, 메모리 스니펫=질의마다, foreign delta=턴마다)는 user 채널에
 *  남긴다 — 거기 올려봐야 매 턴 캐시를 깨뜨려 앞쪽 조각까지 무효화한다.
 *
 *  ★원저자 의도와 충돌하지 않는다: `<system-reminder>` 래핑은 스캐폴딩을 *user 채널*에
 *  raw 로 깔면 모델이 지시어를 오인하거나 안의 imperative 를 메아리치던 실사고 대응이다
 *  (아래 assembleUserPrompt 주석). 시스템 채널은 애초에 그 위험이 없는 채널이다.
 *
 *  새 조각을 추가할 땐 `channel` 을 반드시 고른다(타입이 강제) — "안 변하면 system".
 */
/**
 * depth → 역할 문구. **판정은 여기 한 곳**(어댑터 셋이 각자 조립하면 세 벌이 된다).
 *
 * ★적는 것은 **그 역할이 실제로 다른 점**뿐이다 — 어떤 도구가 있나, 결과가 어디로 가나.
 *  정직·안전선·검증 같은 실질은 헌법에 있고 셋이 공유한다. 여기에 헌법을 재진술하면
 *  그게 곧 "헌법 세 벌" 이다.
 *
 * ★`subagentDepth` 를 먼저 본다: 매니저 안에서 띄운 서브에이전트는 **서브**다(둘 다 >0 일
 *  수 있고, 그때 자기 정체는 서브에이전트다).
 */
export const roleContextBlock = (opts: {
  subagentDepth?: number;
  workerDepth?: number;
}): string => {
  if ((opts.subagentDepth ?? 0) > 0) {
    return [
      "## 지금 당신의 자리",
      "",
      "당신은 **서브에이전트**입니다 — 부모(메인 비서 또는 매니저)가 한 가지 일을 맡겨 띄웠습니다.",
      "- 결과는 사용자가 아니라 **당신을 부른 쪽**에 돌아갑니다. 그쪽이 읽고 판단할 수 있게 쓰세요.",
      "- 당신은 더 이상 위임할 수 없습니다(서브에이전트도 매니저도 못 띄웁니다) — 맡은 일은 직접 끝냅니다.",
      "- 그래서 위임 갈래를 논하는 지침은 **당신에게 해당하지 않습니다.**",
    ].join("\n");
  }
  if ((opts.workerDepth ?? 0) > 0) {
    return [
      "## 지금 당신의 자리",
      "",
      "당신은 **매니저**입니다 — 메인 비서가 일을 통째로 맡겨 백그라운드로 띄웠습니다.",
      "- 결과는 사용자가 아니라 **메인 비서**에게 돌아가고, 메인이 사용자에게 보고합니다.",
      "- **팬아웃이 필요하면 `spawn_agent` 로 직접 붙이세요** — 여기서는 당신이 지휘자입니다.",
      "  (메인 턴의 '팀 규모면 매니저에게 넘겨라' 는 당신에게 해당하지 않습니다. 이미 그 자리입니다.)",
      "- 새 매니저는 띄울 수 없습니다(`run_in_background` 미제공).",
      "- 이 대화의 history 를 보지 못합니다 — 필요한 맥락은 받은 지시 안에 있습니다.",
    ].join("\n");
  }
  return "";
};

/**
 * 슬롯 키 전체 — 회귀 그물이 "빠진 슬롯이 있나" 를 **파생값으로** 판정하게 한다.
 *
 * ★타입 강제만으로는 안 됐다: 새 슬롯이 **optional**(`foo?: string`)이면 검사의 객체
 *  리터럴에 없어도 컴파일이 통과해, 그물 밖으로 조용히 빠진다(modelProfiles·foreignDelta
 *  가 이미 optional). 이름을 손으로 열거하는 대신 정의점에서 뽑는다.
 */
export const contextSlotKeys = (): string[] =>
  buildContextSlots({
    system: "",
    env: "",
    agent: "",
    agentWarn: "",
    convoContext: "",
    memoryIndex: "",
    memorySnippet: "",
    skillIndex: "",
    agentIndex: "",
    roleSource: {},
  }).map((s) => s.key);

// 회귀가 계산형 슬롯의 **채널 배치**를 직접 단언할 수 있게 export (이름 예외 목록 대신).

/**
 * 인라인 제안 규칙 슬롯 — **메인 턴에만, 켜져 있을 때만** (2026-08-25).
 *
 * ★왜 여기(시스템 채널 꼬리)인가: 규칙이 매 턴 동일하니 안정 조각이고, 꼬리에 두면
 *  기능을 껐다 켤 때 무효화가 자기 자신으로 국한된다(AGENT.md 3인방·role 과 같은 논리).
 * ★왜 메인에만: 서브에이전트·매니저의 결과는 사용자 채팅창이 아니라 **부른 쪽**으로 간다.
 *  거기에 "사용자가 다음에 보낼 말"을 붙이라고 하면 부모가 읽을 본문이 오염된다.
 */
/**
 * 규칙 본문 판정 — **순수 함수**. 설정을 인자로 받는다.
 *
 * ★왜 안에서 안 읽나: 안에서 `readSuggestionSettings()` 를 부르면 검사가 **주변 설정에
 *  기댄다**. 실제로 그렇게 뒀다가 변이 하나가 빠져나갔다 — 기능이 꺼진 레포에서는 역할
 *  가드를 통째로 지워도 슬롯이 "" 라 초록이었다(항상 초록인 가짜 검사).
 *  [[feedback_gate_must_actually_run]] 의 반대편 얼굴이다.
 */
export const inlineSuggestionSlotText = (
  roleSource: { subagentDepth?: number; workerDepth?: number },
  enabled: boolean,
): string => {
  if (!enabled) return "";
  // 서브에이전트·매니저의 결과는 사용자 채팅창이 아니라 **부른 쪽**으로 간다.
  if ((roleSource.subagentDepth ?? 0) > 0 || (roleSource.workerDepth ?? 0) > 0) return "";
  return inlineSuggestionRule();
};

const inlineSuggestionSlot = (roleSource: {
  subagentDepth?: number;
  workerDepth?: number;
}): string => inlineSuggestionSlotText(roleSource, readSuggestionSettings().enabled);

export const buildContextSlots = (input: SystemContextInput): ContextSlot[] => [
  { key: "system", text: input.system, channel: "system" },
  // env 는 오늘 날짜를 포함 → 하루에 한 번 변한다. 0.2KB 라 올려도 이득이 없고, 올리면
  // 자정마다 시스템 채널 전체(30KB)의 캐시를 깨뜨린다. user 채널이 정답.
  { key: "env", text: input.env, channel: "user" },
  { key: "convoContext", text: input.convoContext, channel: "user" },
  // claude 전용 — 그 외 어댑터는 ""(빈 슬롯은 걸러진다).
  { key: "foreignDelta", text: input.foreignDelta ?? "", channel: "user" },
  { key: "memoryIndex", text: input.memoryIndex, channel: "user" },
  { key: "memorySnippet", text: input.memorySnippet, channel: "user" },
  { key: "skillIndex", text: input.skillIndex, channel: "system" },
  { key: "agentIndex", text: input.agentIndex, channel: "system" },
  // depth 0 만 — 그 외/부재는 ""(빈 슬롯은 걸러진다).
  { key: "modelProfiles", text: input.modelProfiles ?? "", channel: "system" },
  // ★AGENT.md 3인방을 시스템 채널의 **꼬리**에 둔다 (2026-07-30 검토 지적):
  //  안정 조각 중 가장 자주 바뀌는 게 AGENT.md 다 — 비서 자신이 정체성·습관을 수시로
  //  Edit 하고 self-growth 도 여기 쓴다. 앞에 두면 한 줄 수정이 뒤따르는 28KB(스킬·
  //  에이전트 인덱스·프로파일)의 캐시까지 통째로 무효화한다. 꼬리에 두면 무효화가
  //  자기 자신으로 국한된다. "프리픽스는 앞에서만 매칭한다"를 블록 *안*에도 적용한 것.
  { key: "selfGrowth", text: formatSelfGrowthDirectives(), channel: "system" },
  { key: "agentPathHint", text: agentPathHint(), channel: "system" },
  { key: "agent", text: input.agent, channel: "system" },
  { key: "agentWarn", text: input.agentWarn, channel: "system" },
  // ★역할 표시 — **시스템 채널의 맨 끝** (2026-08-21).
  //  종전엔 메인·매니저·서브에이전트가 **같은 헌법을 받고 아무도 자기가 누군지 몰랐다.**
  //  헌법엔 이미 역할 조건절이 있는데("이 판정은 메인 턴에만 적용된다") 읽는 쪽이 자기가
  //  어느 쪽인지 모르니 그 조건이 풀리지 않았다. 실제로 매 턴 넛지가 매니저에게
  //  "매니저를 소환하라"고 말하고 있었다 — 매니저 안엔 그 도구가 등록조차 안 되는데.
  //
  //  ★왜 문서를 셋으로 나누지 않았나: 차이가 **원칙이 아니라 상황**이다(어떤 도구가
  //   있나·누구에게 보고하나). 실질은 95% 같아서 나누면 그 95%가 세 벌이 되고, 이 레포엔
  //   헌법 두 벌이 **정반대 지시로 갈린** 기록이 있다(`constitution-single-source`).
  //   가르는 축은 문서가 아니라 **읽는 쪽이 아는가** 다.
  //
  //  ★왜 꼬리인가(캐시): 값이 역할마다 갈리는 조각이라 앞에 두면 뒤따르는 전부가 세 벌이
  //   된다. 꼬리에 두면 무효화가 자기 자신으로 국한된다(AGENT.md 3인방과 같은 논리).
  //   ★메인은 **빈 문자열**이라 기존 바이트가 그대로다 — 메인 캐시는 전혀 안 건드린다.
  //   서브에이전트는 실측상 모델 티어가 달라(claude-opus-5 0건) 이미 별도 캐시다.
  //  ★왜 user 채널이 아닌가: 역할은 대화 내내 안 변한다. 캐시 밖에 두면 매 턴 재전송이다.
  // ★`role` **바로 앞** — 맨 끝은 역할 슬롯 자리다(`role-context-block` 가 지킨다).
  {
    key: "nextSuggestion",
    text: inlineSuggestionSlot(input.roleSource),
    channel: "system",
  },
  { key: "role", text: roleContextBlock(input.roleSource), channel: "system" },
];

/**
 * 시스템 채널로 올라간 스캐폴딩임을 모델에게 알리는 머리말. 시스템 채널은 메아리 위험이
 * 없으니 태그가 아니라 한 줄이면 충분하고, 안정 조각이라 캐시에 함께 실린다.
 */
const STABLE_CONTEXT_HEADER =
  "아래는 하네스가 주입하는 작동 컨텍스트입니다 (사용자 발화 아님 — 상시 배경 정보).";

/**
 * 슬롯을 채널별로 가른다. 빈 텍스트는 양쪽 모두에서 제거.
 *  - `stable`: 시스템 채널에 이어붙일 한 덩어리(없으면 "").
 *  - `volatileParts`: `assembleUserPrompt` 에 그대로 넘길 user 채널 파트들.
 */
export const splitSystemContext = (
  input: SystemContextInput,
): { stable: string; volatileParts: string[] } => {
  const slots = buildContextSlots(input).filter((s) => s.text.length > 0);
  const stableParts = slots
    .filter((s) => s.channel === "system")
    .map((s) => s.text);
  return {
    stable:
      stableParts.length === 0
        ? ""
        : [STABLE_CONTEXT_HEADER, ...stableParts].join("\n\n"),
    volatileParts: slots
      .filter((s) => s.channel === "user")
      .map((s) => s.text),
  };
};

/**
 * 시스템 채널 문자열 = [어댑터 sysprompt] + [안정 스캐폴딩]. 세 어댑터가 같은 방식으로
 * 이어붙이도록 여기 한 곳에 둔다(각자 join 하면 구분자가 갈린다).
 */
export const composeSystemChannel = (
  sysprompt: string,
  stable: string,
): string => (stable === "" ? sysprompt : `${sysprompt}\n\n${stable}`);
