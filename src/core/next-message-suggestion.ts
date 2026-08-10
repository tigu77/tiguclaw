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

/** 제안 1건의 상한 — 한 문장이면 충분하고, 길면 고스트가 입력창을 덮는다. */
export const SUGGESTION_MAX_CHARS = 120;

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

/** 프롬프트에 실을 최근 대화 턴 수·턴당 길이 — 여기가 이 기능의 **비용 상한**이다. */
export const SUGGESTION_CONTEXT_TURNS = 6;
export const SUGGESTION_CONTEXT_CHARS_PER_TURN = 600;

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
): string =>
  turns
    .slice(-SUGGESTION_CONTEXT_TURNS)
    .map((t) => {
      const who = t.role === "assistant" ? "비서" : "사용자";
      const body = String(t.content ?? "").trim();
      const cut =
        body.length > SUGGESTION_CONTEXT_CHARS_PER_TURN
          ? `${body.slice(0, SUGGESTION_CONTEXT_CHARS_PER_TURN)}…`
          : body;
      return `${who}: ${cut}`;
    })
    .filter((line) => line.length > 4)
    .join("\n");

/**
 * 시스템 프롬프트 override — tiguclaw 헌법·페르소나·메모리·스킬 인덱스를 **전부 뺀다**.
 * 이 호출은 비서가 말하는 자리가 아니라 한 줄짜리 유틸이라, 25KB 짜리 인격을 실을 이유가
 * 없다(`systemPromptOverride` 계약: 지정 시 모든 tiguclaw context prefix 미주입).
 */
export const SUGGESTION_SYSTEM_PROMPT =
  "너는 대화를 보고 사용자가 다음에 보낼 만한 메시지 한 줄을 만드는 도구다. 설명하지 말고 그 한 줄만 출력한다.";

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
