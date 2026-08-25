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

/*
 * ★삭제 기록 — `shouldSuggestForTurn` 은 없앴다 (2026-08-25).
 *
 * 2026-08-24 사용자 지정: *"워커 완료턴에 제안이 나갈 이유가 없지 — 무조건 내 입력에 대한
 * 첫 응답 1회."* 그래서 좌표(threadKey)에 더해 `synthetic` 까지 보는 래퍼가 있었다.
 *
 * **그 지정이 다음 날 뒤집혔다**: *"메인턴이 응답을 보낼 때마다 제안을 받는 게 맞을 것
 * 같은데"* — 워커 완료 정리 턴도 메인 턴이다. 그리고 제안이 메인 턴 안에서 같이 나오게
 * 되면서(별도 호출 제거) 걸러야 할 **추가 호출 자체가 없어졌다.**
 *
 * ★이 자리를 비워두지 않고 적는 이유: 함수만 지우고 설명을 남겼더니 **뒤집힌 지정이
 *  코드에 살아남아** 다음 사람에게 반대를 가르쳤다(적대 검토 P-4 가 그걸 잡았다).
 *  결정이 바뀌면 근거도 같이 바꿔야 한다 — 지우는 것도 근거를 남기는 일이다.
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
  if (firstLine.length <= SUGGESTION_MAX_CHARS) return firstLine;
  let cut = firstLine.slice(0, SUGGESTION_MAX_CHARS);
  // ★서로게이트 페어를 쪼개면 고스트에 `�` 가 뜬다(적대 검토 P4 실측). 반쪽이면 버린다.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
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

export const NEXT_TAG_OPEN = "<next-message>";
export const NEXT_TAG_CLOSE = "</next-message>";

/**
 * 태그 매칭은 **관용적**이다 (2026-08-25 적대 검토 P3).
 *
 * 종전엔 `<next-message>` **정확 일치**만 봤다. 실측으로 이런 변종이 전부 안 벗겨졌다:
 * `<next-message >`(공백) · `<Next-Message>`(대소문자) · `<next_message>`(언더스코어).
 * 모델은 형식을 미세하게 흔든다 — 그때 원문이 **그대로 사용자에게 간다.** 벗기는 쪽은
 * 넓게 잡는 게 맞다(막을 것은 유출이지 문법이 아니다).
 * ★전각(`＜`)은 **일부러 안 받는다**: 그건 사용자가 실제로 쓸 수 있는 문자다.
 *
 * ★그런데 넓히는 데도 대가가 있다 (2026-08-25 재검토 P-1). 처음엔 구분자를 **선택**으로
 *  뒀더니 `<NextMessage />` 같은 **정상 마크업**을 먹었다 — 실측: `"컴포넌트는
 *  <NextMessage /> 입니다. 그 다음 문장."` 에서 뒤 21자가 삭제됐다. 유출을 막으려다
 *  **답변을 지우는 쪽이 더 나쁘다.** 그래서 구분자(`-`·`_`·공백)를 **필수**로 좁혔다:
 *  우리가 실제로 본 변종은 전부 구분자를 갖는다.
 */
const NEXT_OPEN_RE_G = /<\s*next[-_ ]message\s*[^>]*>/gi;
const NEXT_TAG_RE = /<\s*next[-_ ]message\s*[^>]*>([\s\S]*?)<\s*\/\s*next[-_ ]message\s*>/gi;

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
  if (typeof raw !== "string") return { text: "", suggestion: null };
  NEXT_OPEN_RE_G.lastIndex = 0;
  if (!NEXT_OPEN_RE_G.test(raw)) return { text: raw, suggestion: null };
  const found: string[] = [];
  const stripped = raw.replace(NEXT_TAG_RE, (_m, inner: string) => {
    found.push(inner);
    return "";
  });
  // 닫는 태그 없이 잘린 출력 — 여는 태그부터 끝까지가 제안이고, 화면에선 지운다.
  let tail: string | null = null;
  let text = stripped;
  NEXT_OPEN_RE_G.lastIndex = 0;
  const m = NEXT_OPEN_RE_G.exec(stripped);
  // ★**꼬리 근처일 때만** 버린다 (재검토 P-1). 닫는 태그가 없는 건 "스트림이 잘렸다" 는
  //  뜻이고, 그러면 남은 건 제안 한 줄 정도다. 상한 없이 버리면 오탐 한 번에 답변 전부가
  //  사라진다 — 유출보다 나쁜 실패다. 제안 상한의 두 배까지만 인정한다.
  const UNCLOSED_TAIL_MAX = SUGGESTION_MAX_CHARS * 2;
  if (m !== null && stripped.length - (m.index + m[0].length) <= UNCLOSED_TAIL_MAX) {
    tail = stripped.slice(m.index + m[0].length);
    text = stripped.slice(0, m.index);
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

/**
 * 어댑터 출력에서 표식을 **뜯어 제자리에 반영**한다 (2026-08-25 적대 검토 A2).
 *
 * ★왜 함수인가: 종전엔 호출부에 `const picked = extract(...)` 와 `output.text = picked.text`
 *  **두 문장**이 있었다. 적대 검토가 뒤 문장만 지우자 — 태그가 답변·transcripts·텔레그램·
 *  이벤트 전부로 새는데 — 스위트가 초록이었다. 검사가 앞 문장의 **존재**만 봤기 때문이다.
 *  한 함수로 묶으면 반쪽 적용이 불가능해지고, 그 함수는 실행으로 검사된다.
 */
export const applyInlineSuggestion = <T extends { text?: string; nextSuggestion?: string }>(
  output: T,
): T => {
  const picked = extractInlineSuggestion(output.text ?? "");
  output.text = picked.text;
  if (picked.suggestion !== null) output.nextSuggestion = picked.suggestion;
  return output;
};
