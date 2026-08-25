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

// ─── 조합: 정규화 → 조회 → 스니펫 → 총 건수 ─────────────────────────────────
//
// ★한 곳에 둔다 (2026-08-25). 종전엔 이 네 단계가 **브리지 핸들러 안에만** 있었고, 그래서
//  비서에게 대화 검색 도구를 붙이려면 같은 조합을 다시 써야 했다 — `%` 이스케이프 하나만
//  갈려도 도구와 화면이 다른 답을 준다([[feedback_simple_composable_no_duplication]]).
//  실제 증상: 사용자가 "단검 이미지 만들어 달라고 한 게 언제야?" 라고 물었을 때 비서는
//  검색할 길이 없어 **Claude Code 의 jsonl 을 grep 하고 스크립트를 짜서 DB 를 직접 열었다.**
//
// ★DB 는 **함수 안에서** 동적 import 한다 — 위쪽 순수 함수들이 DB 없이 import 되는 성질을
//  지킨다(그 성질이 `chat-search-finds-inside-words` 회귀를 데몬 없이 돌게 한다).

export interface ConversationHit {
  readonly id: number;
  readonly ts: number;
  readonly threadKey: string;
  readonly channel: string;
  readonly role: string;
  readonly sessionLabel: string;
  readonly snippet: string;
  readonly matchStart: number;
  readonly matchLen: number;
}

export interface ConversationSearch {
  /** 정규화된 질의. 너무 짧아 검색하지 않았으면 빈 문자열. */
  readonly query: string;
  /** 질의가 최소 길이에 못 미쳐 **검색을 안 했다**(오류가 아니다). */
  readonly tooShort: boolean;
  readonly hits: readonly ConversationHit[];
  /** 상한과 무관한 **전체** 일치 수 — 잘렸다는 사실을 소비처가 말할 수 있게. */
  readonly total: number;
  readonly limit: number;
  /** 검색 범위 — 특정 세션 키이거나 `"all"`. */
  readonly scope: string;
}

export const searchConversations = async (
  rawQuery: string,
  opts?: { limit?: number; threadKey?: string; beforeTs?: number; beforeId?: number },
): Promise<ConversationSearch> => {
  const limit = opts?.limit !== undefined && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
  const scope = opts?.threadKey ?? "all";
  const q = normalizeChatQuery(rawQuery);
  if (q === null) return { query: "", tooShort: true, hits: [], total: 0, limit, scope };
  const { searchChatLog, countChatLogMatches } = await import("../store/chat-log.js");
  const hits = searchChatLog(q.like, {
    limit,
    ...(opts?.threadKey !== undefined ? { threadKey: opts.threadKey } : {}),
    ...(opts?.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
    ...(opts?.beforeId !== undefined ? { beforeId: opts.beforeId } : {}),
  }).map(({ text, ...rest }) => {
    const s = makeSnippet(text, q);
    return { ...rest, snippet: s.text, matchStart: s.matchStart, matchLen: s.matchLen };
  });
  const total = countChatLogMatches(q.like, {
    ...(opts?.threadKey !== undefined ? { threadKey: opts.threadKey } : {}),
  });
  return { query: q.raw, tooShort: false, hits, total, limit, scope };
};

// ─── 기간 훑기: 키워드가 없을 때의 길 ────────────────────────────────────────
//
// ★검색과 **다른 질문**이라 도구를 나눈다 (2026-08-25). `search_conversations` 는
//  *"언제 X 얘기했지?"* 에, 이쪽은 *"그 무렵 뭘 했지?"* 에 답한다. 이름이 비슷하다고 묶으면
//  한 자리가 두 가지를 말한다([[project_manager_agent_naming]] 의 Q8 렌즈).
//
// ★실측이 근거다: 기간 훑기가 없을 때 비서는 키워드를 짐작해 `search_conversations` 를
//  **한 턴에 56회** 불렀다. 답은 맞았지만 그건 운이었다.

export interface PeriodSession {
  readonly threadKey: string;
  readonly channel: string;
  /** 이 대화의 **주제** — 세션 표시명(커스텀 이름 > 첫 발화). */
  readonly topic: string;
  readonly messages: number;
  readonly firstTs: number;
  readonly lastTs: number;
}

export interface PeriodBrowse {
  readonly sinceTs: number;
  readonly untilTs: number;
  readonly sessions: readonly PeriodSession[];
  /** 기간 전체 세션 수(상한과 무관) — 목록이 잘렸는지 소비처가 말할 수 있게. */
  readonly totalSessions: number;
  /** 기간 전체 메시지 수(상한과 무관). */
  readonly totalMessages: number;
}

/**
 * 날짜 문자열 → epoch ms. `YYYY-MM-DD` 는 **로컬 자정**으로 읽는다.
 *
 * ★`new Date("2026-08-01")` 은 **UTC 자정**이라 한국에선 7월 31일 09시가 된다 — 사용자가
 *  "8월" 이라고 한 기간이 하루 어긋난다. 날짜만 온 경우는 로컬로 해석한다.
 */
export const parseDayBoundary = (v: string, endOfDay = false): number | null => {
  const s = v.trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd !== null) {
    const d = new Date(
      Number(ymd[1]),
      Number(ymd[2]) - 1,
      Number(ymd[3]),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    );
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
};

export const browseConversationPeriod = async (
  sinceTs: number,
  untilTs: number,
  opts?: { limit?: number },
): Promise<PeriodBrowse> => {
  const { listChatPeriods, countChatPeriod } = await import("../store/chat-log.js");
  const rows = listChatPeriods(sinceTs, untilTs, opts);
  // ★총계는 **따로 센다** — 목록은 상한이 있어서 그걸 더하면 그 합도 잘린 값이다.
  //  첫 판에 그렇게 썼다가 고쳤다([[project_hotpath_bound_preserve_record]]: 캡이 있는
  //  자리에서 캡을 안 말하면 조용한 절삭이다).
  const totals = countChatPeriod(sinceTs, untilTs);
  return {
    sinceTs,
    untilTs,
    sessions: rows.map((r) => ({
      threadKey: r.threadKey,
      channel: r.channel,
      topic: r.sessionLabel,
      messages: r.messages,
      firstTs: r.firstTs,
      lastTs: r.lastTs,
    })),
    totalSessions: totals.sessions,
    totalMessages: totals.messages,
  };
};
