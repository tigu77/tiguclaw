/**
 * 다음 메시지 제안 (2026-08-10) — 턴이 끝나면 "사용자가 이어서 할 만한 말" 을 한 줄
 * 만들어 대시보드 입력창에 **회색 고스트**로 띄운다. Tab 이면 입력창에 채워지고,
 * 보내는 건 여전히 사용자다(Enter 로 수락하지 않는다 — 오발신은 되돌릴 수 없다).
 *
 * ★기본 꺼짐. 이건 **매 턴 토큰을 쓰는 기능**이라, 켜는 것은 사용자의 명시적 선택이어야
 *  한다. 그래서 값은 브라우저가 아니라 `settings.json`(서버)에 둔다 — 화면 설정이 아니라
 *  동작·비용 설정이고, 브라우저 캐시를 지웠다고 되살아나면 안 된다.
 *  (`settings.json` 은 매 턴 fresh 로 읽히므로 껐다 켜는 게 재시작 없이 즉시 반영된다.)
 *
 * ★생성은 기존 런타임(`runRegionA`)을 그대로 쓴다. 전용 단발 호출 경로를 새로 만들면
 *  어댑터마다 구현이 생기고(=멀티 LLM 대칭이 깨지고), 그게 이 레포가 반복해서 피해 온
 *  형상이다. 대신 **가장 가벼운 입력**으로 부른다: 도구 없음·메모리 lean·짧은 출력.
 *
 * ★비용을 측정 가능하게 남긴다. "얼마나 드는지 모르겠다" 는 이번에 압축에서 이미 한 번
 *  겪었다(경과를 아무도 안 재고 있었다). 여기선 처음부터 토큰·소요를 로그와 이벤트에 싣는다.
 */
import { getEventBus } from "./eventbus.js";
import { loadSettingsLayers } from "./settings.js";
import { TurnTimeoutError } from "./llm-runtime/turn-timeout.js";

/** 제안 1건의 상한 — 한 문장이면 충분하고, 길면 고스트가 입력창을 덮는다. */
export const SUGGESTION_MAX_CHARS = 120;

/**
 * 이 호출의 **데드라인** (2026-08-24).
 *
 * ★범용 턴 wall-clock 상한의 부활이 **아니다.** 그건 2026-06-23 에 일부러 없앴다 —
 *  정상적으로 긴 작업을 시계로 자르면 되돌릴 수 없기 때문이다(`turn-timeout.ts` 참조).
 *  여기엔 그 논리가 안 맞는다: 제안은 **사용자가 입력창을 볼 때 거기 있어야** 값이 있고,
 *  늦게 도착한 제안은 값이 0이 아니라 **음수**다(이미 다음 말을 친 사람에게 엉뚱한 고스트).
 *
 * ★값은 직감이 아니라 실측이다 — 이 기능 자신의 수치다(2026-08-18, `ghost-suggest.js`):
 *  턴→제안 간격 **중앙 3.9초 · 최대 11.9초**. 30초는 그 최대의 2.5배라 정상 동작은
 *  하나도 안 자른다. 자르는 건 딱 병리적인 쪽이다 — 2026-08-24 회사 인스턴스 실측:
 *  529 과부하에서 claude-opus-5 가 SDK 내부 재시도로 **199,146ms · 200,599ms ·
 *  194,271ms** 를 쓰고 매 턴 반복했다(그러고 codex 로 폴백해 3분 늦은 제안을 냈다).
 *
 * ★abort 사유로 `TurnTimeoutError` 를 **재사용**한다(새 타입 안 만든다). 그 타입이
 *  정확히 이 일을 하도록 남아 있다 — `runPool`·`runRegionA` 둘 다 이 사유를 보면
 *  폴백을 **명시 단락**한다. 데드라인을 넘긴 뒤 다음 모델로 또 200초를 쓰면 데드라인이
 *  아니다. `isModelRejected` 비매칭도 그 타입이 보장한다(TT-I3).
 */
export const SUGGESTION_DEADLINE_MS = 30_000;

export interface SuggestionSettings {
  enabled: boolean;
  /** 사용할 모델 프로파일 이름(미지정 = 기본 프로파일). 작고 빠른 것을 권장. */
  profile?: string;
}

/**
 * `settings.json` 의 `suggestions.nextMessage` 를 읽는다.
 * 부재·형식오류 = 꺼짐(안전 기본값 — 토큰 쓰는 기능은 명시적으로만 켜진다).
 */
export const readSuggestionSettings = (cwd?: string): SuggestionSettings => {
  try {
    for (const layer of loadSettingsLayers(cwd)) {
      const s = (layer as { suggestions?: unknown }).suggestions;
      if (typeof s !== "object" || s === null) continue;
      const n = (s as { nextMessage?: unknown }).nextMessage;
      if (typeof n !== "object" || n === null) continue;
      const enabled = (n as { enabled?: unknown }).enabled === true;
      const profileRaw = (n as { profile?: unknown }).profile;
      const profile =
        typeof profileRaw === "string" && profileRaw.trim() !== ""
          ? profileRaw.trim()
          : undefined;
      return profile !== undefined ? { enabled, profile } : { enabled };
    }
  } catch {
    /* 읽기·파싱 실패 = 꺼짐(never throw — 설정 하나가 턴을 죽이면 안 된다) */
  }
  return { enabled: false };
};

/**
 * 이 호출이 쓸 **풀 체인** — 설정의 `profile` 을 실제 체인으로 바꾼다 (2026-08-24).
 *
 * ★판정을 여기 둔 이유(Q7): 종전엔 이 결정이 `index.ts` 의 핸들러 안에 있어서 **동작을
 *  검사하려면 데몬을 띄워야** 했다. 그래서 그물이 소스 grep 밖에 못 됐고, 실제로 이
 *  기능은 **`profile` 을 읽고도 안 쓰는 채로** 살아 있었다. 순수 함수로 빼면 그물이
 *  동작을 본다.
 * ★`resolve` 를 주입받는다 — llm-runtime 을 import 하지 않으려는 것이다(이 모듈은 설정과
 *  프롬프트만 아는 자리다). 제네릭이라 타입 의존도 없다.
 *
 * @returns `chain` 빈 배열 = 기본 프로파일로 돌라는 뜻(미지정이거나 이름이 없거나).
 *          `missing` 이 non-null = **이름은 적혔는데 그런 프로파일이 없다**(호출자가 말해야 한다).
 */
export const resolveSuggestionChain = <T>(
  profile: string | undefined,
  resolve: (name: string) => T[],
): { chain: T[]; missing: string | null } => {
  if (profile === undefined || profile.trim() === "") {
    return { chain: [], missing: null };
  }
  const chain = resolve(profile);
  return chain.length > 0
    ? { chain, missing: null }
    : { chain: [], missing: profile };
};

/**
 * 데드라인 abort 사유 — **타입이 곧 계약**이다.
 *
 * ★`runPool`·`runRegionA` 는 `TurnTimeoutError` 를 보면 폴백을 **명시 단락**한다. 평범한
 *  `Error` 로 바꾸면 abort 는 되지만 폴백이 살아나서, 30초 뒤 다음 모델로 또 200초를
 *  쓴다 — 데드라인이 데드라인이 아니게 된다. 그래서 이걸 함수로 두고 검사가 본다.
 */
export const suggestionDeadlineReason = (): Error =>
  new TurnTimeoutError(SUGGESTION_DEADLINE_MS);

/**
 * 제안을 만들 자리인가 — **사용자가 실제로 보고 쓸 수 있는 세션**만.
 *
 * 스케줄러·워커·서브에이전트·엔드포인트 턴에도 만들면 아무도 안 보는 제안에 매번
 * 토큰을 쓴다(고스트는 대시보드 입력창에만 뜬다). 이름 목록이 아니라 **성질**로 가른다:
 * 사람이 앉아 있는 대화 세션인가.
 */
export const shouldSuggestForThread = (threadKey: string): boolean => {
  const tk = typeof threadKey === "string" ? threadKey : "";
  if (tk === "") return false;
  // 파생 턴은 전부 접두사로 자기 출신을 밝힌다 — 그게 판정 기준이다.
  for (const derived of ["scheduler:", "worker:", "endpoint:", "agent:", "gateway:"]) {
    if (tk.startsWith(derived)) return false;
  }
  return true;
};

/**
 * 제안을 만들 **턴**인가 — 자리(위)에 더해 **누가 말했나**를 본다 (2026-08-24).
 *
 * ★사용자 지정: *"워커 완료턴에 제안이 나갈 이유가 없지 — 무조건 내 입력에 대한 첫 응답 1회."*
 *
 * 종전엔 좌표(threadKey)만 봤다. 그래서 파생 **스레드**(`worker:`·`agent:`…)는 걸렀지만,
 * 워커가 끝나고 그 결과를 **소환한 세션 좌표로 재주입**하는 합성 턴은 못 걸렀다 —
 * `dashboard:…` 로 들어오니 접두사 검사를 그냥 통과한다. 사용자는 아무것도 안 쳤는데
 * 제안 호출이 한 번 더 나갔다(백그라운드 작업이 몰리면 그만큼 더).
 *
 * ★이 판정을 **위 함수에 합치지 않고 감싼** 이유: 둘은 다른 질문에 답한다(Q8) —
 *  위는 *"이 자리가 사람이 보는 세션인가"*, 여기는 *"이번 턴을 사람이 열었나"*.
 *  합치면 좌표만 아는 호출자가 쓸 수 없게 되고, 나누면 각자 자기 질문에만 답한다.
 *  대신 **호출부는 이 함수 하나만** 쓴다 — 두 검사를 손으로 나열하면 한쪽이 빠진다.
 */
export const shouldSuggestForTurn = (msg: {
  threadKey: string;
  synthetic?: boolean;
}): boolean => shouldSuggestForThread(msg.threadKey) && msg.synthetic !== true;

/** 모델이 뱉은 것을 고스트에 쓸 수 있는 한 줄로 정리. 못 쓰겠으면 `null`. */
export const normalizeSuggestion = (raw: string): string | null => {
  let t = typeof raw === "string" ? raw.trim() : "";
  if (t === "") return null;
  // 모델이 따옴표로 감싸거나 "제안:" 같은 머리말을 붙이는 경우가 흔하다 — 벗긴다.
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  t = t.replace(/^(제안|다음\s*메시지|suggestion)\s*[:：-]\s*/i, "").trim();
  // 여러 줄이면 첫 줄만 — 고스트는 한 줄짜리 자리다.
  const firstLine = t.split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length > SUGGESTION_MAX_CHARS
    ? firstLine.slice(0, SUGGESTION_MAX_CHARS)
    : firstLine;
};

/** 대시보드가 고스트로 그릴 수 있게 발행. 실패는 삼킨다(편의 기능). */
export const publishSuggestion = (
  threadKey: string,
  text: string,
  meta: { elapsedMs: number; adapter?: string },
): void => {
  try {
    getEventBus().publish({
      type: "chat.suggestion",
      ts: Date.now(),
      payload: {
        threadKey,
        text,
        elapsedMs: meta.elapsedMs,
        ...(meta.adapter !== undefined ? { adapter: meta.adapter } : {}),
      },
    });
  } catch {
    /* 관측 발행 실패가 턴을 무르지 않는다(원칙 3). */
  }
};

/**
 * 프롬프트에 실을 최근 대화 — 여기가 이 기능의 **비용 상한**이다.
 *
 * ★값은 직감이 아니라 실측이다 (2026-08-10, 최근 7일 각 200턴):
 *   비서 발화 중앙값 129자 · p75 1,386 · p90 2,812 · p95 5,712 · 최대 45,064
 *   사용자 발화 중앙값 7,595자(대부분 로그·코드 붙여넣기) · p90 44,575
 *  종전 600자는 **비서 턴 넷 중 셋을 잘랐고**, 그것도 앞을 남겨 물음이 있는 끝을 버렸다.
 *  그 결과 "비서가 물으면 답하라" 는 규칙이 볼 재료가 없었다(실증: 18:50 제안이 되묻기).
 *
 *  역할별로 예산이 다른 이유: 사용자 턴은 길어도 대개 붙여넣기라 맥락 밀도가 낮다.
 *  마지막 비서 발화만 크게 주는 이유: **물음이 거기 있다**(p95 를 덮는다).
 */
export const SUGGESTION_CONTEXT_TURNS = 8;
export const SUGGESTION_CHARS_ASSISTANT = 3_000; // p90(2,812) 덮음
export const SUGGESTION_CHARS_USER = 1_200;
export const SUGGESTION_CHARS_LAST_ASSISTANT = 6_000; // p95(5,712) 덮음

/**
 * 최근 대화를 **프롬프트에 인라인으로** 담는다 — 스레드 히스토리를 로드시키지 않는다.
 *
 * ★이렇게 하는 이유: 호출 비용이 여기 이 두 상수로 **완전히 결정된다**(최대 6턴 ×600자).
 *  스레드를 붙이면 대화가 길어질수록 제안 호출도 같이 비싸지는데, 그건 조용히 커지는
 *  축이라 이 레포가 반복해서 데인 형상이다. 제안은 "방금 흐름" 만 알면 되고 그 이상은
 *  값이 없다.
 */
export const buildRecentContext = (
  turns: { role: "user" | "assistant"; content: string }[],
): string => {
  const window = turns.slice(-SUGGESTION_CONTEXT_TURNS);
  const lastAssistantIdx = (() => {
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i]?.role === "assistant") return i;
    }
    return -1;
  })();
  return window
    .map((t, i) => {
      const who = t.role === "assistant" ? "비서" : "사용자";
      const body = String(t.content ?? "").trim();
      const budget =
        i === lastAssistantIdx
          ? SUGGESTION_CHARS_LAST_ASSISTANT
          : t.role === "assistant"
            ? SUGGESTION_CHARS_ASSISTANT
            : SUGGESTION_CHARS_USER;
      // ★자를 땐 **뒤를 남긴다**. 발화의 값은 끝에 있다 — 질문·요청·결론이 거기 있고,
      //  이 기능이 가장 먼저 봐야 하는 것이 "비서가 방금 뭘 물었나" 다. 앞을 남기면
      //  서론만 오고 물음이 사라진다(종전 동작 · 실증 18:50).
      const cut = body.length > budget ? `…${body.slice(-budget)}` : body;
      return `${who}: ${cut}`;
    })
    .filter((line) => line.length > 4)
    .join("\n");
};

/**
 * 시스템 프롬프트 override — tiguclaw 헌법·페르소나·메모리·스킬 인덱스를 **전부 뺀다**.
 * 이 호출은 비서가 말하는 자리가 아니라 한 줄짜리 유틸이라, 25KB 짜리 인격을 실을 이유가
 * 없다(`systemPromptOverride` 계약: 지정 시 모든 tiguclaw context prefix 미주입).
 */
/** 생성 프롬프트 — 짧게, 그리고 **사용자 목소리로**. */
export const buildSuggestionPrompt = (): string =>
  [
    "위 대화에 이어서 **사용자가 다음에 보낼 만한 메시지**를 딱 한 줄로 써라.",
    "",
    "★가장 중요한 규칙 — 순서대로 본다:",
    "1. **비서의 마지막 말이 사용자에게 뭔가 물었으면, 그 질문에 대한 대답을 써라.**",
    "   선택지를 제시했으면 그중 하나를 고르는 말로. 확인을 구했으면 승인/거절하는 말로.",
    "   ★이때 **새 화제를 꺼내지 마라** — 물음을 받아놓고 딴 얘기를 하는 건 대화가 아니다.",
    "2. 묻지 않았으면, 방금 흐름에서 자연스럽게 이어질 다음 지시나 질문을 써라.",
    "",
    "형식:",
    "- 비서(너)의 말이 아니라 **사용자의 말**을 쓴다. 사용자의 말투를 따른다.",
    "- **짧게.** 사용자는 길게 안 쓴다 — 대개 한 문장, 20자 안팎이면 충분하다.",
    "- 설명·따옴표·머리말 없이 그 문장만 출력한다.",
    "- 확신이 안 서면 빈 줄을 출력해라(억지 제안보다 없는 게 낫다).",
  ].join("\n");

const SUGGESTION_ROLE =
  "너는 대화를 보고 사용자가 다음에 보낼 만한 메시지 한 줄을 만드는 도구다. 설명하지 말고 그 한 줄만 출력한다.";

/**
 * ★안정 조각은 **시스템 채널**에 둔다 (프리픽스 캐시 원칙, 2026-07-30 정착).
 *  종전엔 `text` 에 `컨텍스트 + 지시문` 순으로 실었다 — **휘발이 앞, 안정이 뒤**라
 *  지시문이 영원히 캐시 프리픽스가 못 됐다. 규칙은 매 호출 동일하니 여기로 옮긴다.
 *  (claude 는 이미 적중률 99%라 이득 여지가 거의 없다 — 이득은 codex 쪽이고, 어느 쪽이든
 *   순서를 바로잡는 건 공짜다. 절감 수치는 재보기 전엔 주장하지 않는다.)
 */
export const SUGGESTION_SYSTEM_PROMPT = `${SUGGESTION_ROLE}\n\n${buildSuggestionPrompt()}`;
