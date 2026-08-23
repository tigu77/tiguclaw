// src/core/chat-search.ts
/**
 * 채팅 검색의 **판단**만 담는다 — 질의 정규화와 스니펫 생성. DB 접근·HTTP 는 여기 없다.
 *
 * ★왜 분리하나 (원칙 게이트 Q7): 이 판단을 브리지 핸들러 안에 두면 검사하려고 **데몬을
 *  띄워야 한다**. 그러면 회귀가 동작 대신 정규식 grep 으로 약해진다 — 이 레포가 `/logs`
 *  유출 규칙에서 이미 겪은 일이다("검사가 껄끄러우면 코드가 잘못 놓인 것").
 *  순수 함수로 두면 그물이 진짜 동작을 잡는다.
 *
 * ★왜 FTS 가 아니라 LIKE 인가 (실측, 2026-08-22):
 *  - **한국어에서 FTS5 가 더 못 찾는다.** 기본 토크나이저는 `윈도우에서` 를 한 토큰으로
 *    잘라 `윈도우` 검색에 안 걸린다(통제 실험: FTS `"윈도우"` → 0건, LIKE → 1건).
 *    조사가 붙는 언어에선 부분일치가 곧 사용자의 기대다.
 *  - **규모가 그걸 허락한다.** 실측 chat_log 3,947행·2MB 에서 LIKE 스캔 14ms.
 *    여기에 FTS 색인·트리거·동기화를 새로 만들면 SQLite 가 이미 주는 것을 재구현하는
 *    것이고(원칙 #5), 부품만 늘어난다.
 *  ★규모가 크게 달라지면(수십만 행) 다시 재라 — 그때의 판단 재료는 "느리다는 체감" 이
 *   아니라 **측정한 밀리초**다.
 *
 * ★위 첫 줄을 정정한다 (2026-08-23 전체 검토). "FTS5 가 한국어를 못 찾는다" 는 **기본
 *  토크나이저** 얘기였다. FTS5 엔 부분일치 전용 `tokenize='trigram'` 이 있고, 그건
 *  조사가 붙어도 찾는다 — 실측: `'윈도우에서 업데이트가 실패해'` 에 `MATCH '윈도우'` → **1건**
 *  (sqlite 3.53). 즉 문이 닫혀 있는 게 아니라 우리가 안 열어봤을 뿐이다.
 *  그래도 **지금은 LIKE 가 맞다** — 14ms 에 색인·트리거·재색인 비용을 더할 이유가 없다.
 *  ★언제 갈아탈까: `chat_log` 는 프루닝이 없어(대화 기록 = 의도된 보존) 선형으로 자란다.
 *   게다가 목록과 **총 건수**로 스캔이 두 번이다(2026-08-23 절삭 고지 추가분).
 *   지금 3,995행 14ms → 10만 행이면 키 입력마다 수백 ms 가 된다. 그 지점에서 trigram
 *   FTS 가 첫 후보다(전문 검색이 아니라 **substring 색인**으로 쓰는 것).
 */

/** 이보다 짧은 질의는 받지 않는다 — 한 글자는 사실상 전체 스캔이고 결과도 쓸모없다. */
export const MIN_QUERY_LEN = 2;

/** 스니펫 총 길이(문자). 앞뒤 맥락을 합쳐 이 안에 담는다. */
export const SNIPPET_LEN = 120;

export interface NormalizedQuery {
  /** LIKE 패턴에 넣을 안전한 항 — 와일드카드가 이스케이프돼 있다. */
  readonly like: string;
  /** 원문(하이라이트 위치 계산용). */
  readonly raw: string;
}

/**
 * 질의 정규화 — 공백 정리 + LIKE 와일드카드 무력화.
 *
 * ★`%`·`_` 를 안 막으면 사용자가 `100%` 를 검색할 때 `%` 가 **와일드카드로** 동작해
 *  엉뚱한 것이 잡힌다. 검색창에 친 글자는 **글자 그대로** 찾는 게 사용자의 기대다.
 *  `\` 를 이스케이프 문자로 쓰므로 `\` 자신도 먼저 막는다(순서가 중요 — 나중에 하면
 *  앞서 넣은 이스케이프까지 다시 이스케이프한다).
 */
export const normalizeChatQuery = (raw: string): NormalizedQuery | null => {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length < MIN_QUERY_LEN) return null;
  const like = trimmed
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return { like, raw: trimmed };
};

export interface Snippet {
  /** 보여줄 조각(앞뒤가 잘렸으면 `…` 이 붙는다). */
  readonly text: string;
  /** `text` 안에서 일치가 시작하는 위치. 못 찾으면 -1. */
  readonly matchStart: number;
  /** 일치 길이. */
  readonly matchLen: number;
}

/**
 * 일치 지점 **주변**을 잘라 낸다 — 앞부분만 보여주면 왜 걸렸는지 알 수 없다.
 *
 * 대소문자 무시로 찾되(사용자가 `Windows` 라 쳐도 `windows` 를 찾는다) 자르기는 원문
 * 기준이다. 줄바꿈은 한 칸으로 접는다(목록에서 한 줄로 보여야 한다).
 */
export const makeSnippet = (
  content: string,
  q: NormalizedQuery,
  len = SNIPPET_LEN,
): Snippet => {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(q.raw.toLowerCase());
  if (at === -1) {
    const cut = flat.slice(0, len);
    return {
      text: cut.length < flat.length ? `${cut}…` : cut,
      matchStart: -1,
      matchLen: 0,
    };
  }
  // 일치를 가운데 두되, 문자열 양끝에선 그쪽으로 붙인다(빈 여백 대신 맥락을 더 준다).
  const half = Math.max(0, Math.floor((len - q.raw.length) / 2));
  let start = Math.max(0, at - half);
  const end = Math.min(flat.length, start + len);
  start = Math.max(0, Math.min(start, end - len));
  const body = flat.slice(start, end);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return {
    text: `${head}${body}${tail}`,
    matchStart: head.length + (at - start),
    matchLen: q.raw.length,
  };
};
