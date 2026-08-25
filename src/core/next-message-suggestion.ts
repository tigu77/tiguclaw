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
 * 제안을 **보여줄 자리**인가 — 파생 턴(스케줄러·워커·엔드포인트·에이전트)은 사람이 보는
 * 세션이 아니다. 판정 기준은 좌표 접두사 하나뿐이라 이름 목록을 들지 않는다.
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

// ─────────────────────────────────────────────────────────────────────────────
// 인라인 제안 (2026-08-25) — **별도 LLM 호출을 없앤다**
//
// 종전엔 답을 보낸 뒤 `runRegionA` 를 한 번 더 불러 제안 한 줄을 만들었다. 재보니 그
// 호출의 컨텍스트 상한이 **39,600자(≈13~20K 토큰)** 였고(8턴 × (3,000+1,200) + 6,000),
// 매 턴 바뀌는 대화라 프리픽스 캐시도 못 탔다. (그런데 코드 주석엔 "최근 6턴 × 600자"
// 라고 적혀 있었다 — 상수가 실측으로 올라갈 때 주석이 안 따라와 **11배**가 벌어져 있었다.)
//
// 메인 턴은 **이미 그 맥락을 들고 있고 캐시도 태웠다.** 거기서 한 줄 더 받으면 출력 토큰
// 스무 개 남짓이다(사용자 판단: "끼워서 같이 받는 게 낫겠다").
//
// ★계약은 **선택적**이다. 모델이 안 붙이면 제안이 없을 뿐 실패가 아니다 — 종전 동작도
//  "확신 없으면 빈 줄"이었으므로 관용의 폭이 같다. 강제하면 억지 제안이 나온다.
// ★벗기는 자리는 **코어 한 곳**(`callAdapter` 반환 직후, persist·publish 보다 앞)이다.
//  어댑터마다 벗기면 세 곳이 갈리고, 그건 이 레포가 반복해서 당한 부류다.
// ★덤: 조립이 사라지면서 옛 실패 모드 하나가 **구조적으로** 없어졌다 — 발화를 잘라 마지막
//  물음이 유실되던 것(2026-08-10). 이제 그 물음을 쓴 모델이 제안도 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

const NEXT_TAG_OPEN = "<next-message>";
const NEXT_TAG_CLOSE = "</next-message>";
const NEXT_TAG_RE = /<next-message>([\s\S]*?)<\/next-message>/g;

/**
 * 메인 턴 시스템 프롬프트에 실리는 규칙. 자리 판정(메인인가·켜졌나)은 `prompt-assembly` 의
 * `inlineSuggestionSlotText` 가 한다 — 여기선 **본문만** 만든다.
 */
export const inlineSuggestionRule = (): string =>
  [
    "## 다음 메시지 제안",
    "",
    `답변을 다 쓴 **맨 끝**에, 사용자가 다음에 보낼 만한 메시지를 ${NEXT_TAG_OPEN}한 줄${NEXT_TAG_CLOSE} 로 덧붙이세요.`,
    "이 태그는 사용자에게 보이지 않고 입력창의 흐린 제안으로만 뜹니다.",
    "",
    "- **당신이 뭔가 물었으면 그 물음에 대한 사용자의 대답**을 쓰세요. 선택지를 줬으면 그중 하나를 고르는 말로, 확인을 구했으면 승인/거절하는 말로. ★새 화제를 꺼내지 마세요.",
    "- 묻지 않았으면 방금 흐름에서 자연스럽게 이어질 다음 지시나 질문을 쓰세요.",
    "- 비서의 말이 아니라 **사용자의 말**로, 사용자의 말투로. **짧게** — 대개 한 문장, 20자 안팎.",
    "- **확신이 안 서면 태그를 아예 붙이지 마세요.** 억지 제안보다 없는 게 낫습니다.",
    "- 답변 본문에서는 이 태그를 절대 언급하지 마세요.",
  ].join("\n");

/**
 * 답변에서 인라인 제안을 뜯어낸다. **항상 전부 제거**하고, 쓸 만한 마지막 것만 돌려준다.
 *
 * ★"마지막"인 이유: 모델이 실수로 중간에 하나 더 붙였다면 꼬리 쪽이 진짜 결론이다.
 * ★제거는 위치를 안 가린다 — 중간에 있어도 사용자 화면엔 안 보여야 한다.
 * ★닫는 태그가 없어도(스트림이 잘려도) 열린 태그부터 끝까지를 걷어낸다.
 */
export const extractInlineSuggestion = (
  raw: string,
): { text: string; suggestion: string | null } => {
  if (typeof raw !== "string" || !raw.includes(NEXT_TAG_OPEN)) {
    return { text: typeof raw === "string" ? raw : "", suggestion: null };
  }
  const found: string[] = [];
  const stripped = raw.replace(NEXT_TAG_RE, (_m, inner: string) => {
    found.push(inner);
    return "";
  });
  let tail: string | null = null;
  let text = stripped;
  const openAt = stripped.indexOf(NEXT_TAG_OPEN);
  if (openAt >= 0) {
    tail = stripped.slice(openAt + NEXT_TAG_OPEN.length);
    text = stripped.slice(0, openAt);
  }
  const candidates = tail !== null ? [...found, tail] : found;
  let suggestion: string | null = null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const one = normalizeSuggestion(candidates[i] ?? "");
    if (one !== null) {
      suggestion = one;
      break;
    }
  }
  return { text: text.trimEnd(), suggestion };
};
