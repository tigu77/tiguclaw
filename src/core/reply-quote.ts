/**
 * **답글 인용** — 사용자가 어떤 메시지에 답글로 보냈을 때 그 원문을 비서에게 붙이는 **유일한 자리** (2026-10-06).
 *
 * ★세 경로가 이 함수를 쓴다 — 새 턴 · 진행 중 끼워넣기(steer) · 미소비 끼워넣기의 재주입.
 *  종전엔 새 턴에서만 붙였다. 그래서 비서가 답하는 **중에** 답글을 보내면(응답 중 «이거 말고 저거» 가 흔한 사용법)
 *  원문이 빠져 무엇에 대한 말인지 몰랐고, 재주입은 그 턴을 연 **다른 메시지의** 원문을 붙였다.
 * ★길이도 여기서만 자른다 — 종전엔 채널(텔레그램·대시보드)이 각자 앞 1,500자만 남겨 긴 답의 **끝**(결론·질문)이
 *  잘렸다. 앞과 끝을 남기고 가운데를 버린다.
 * 이 글은 모델이 읽는 지시라 한국어다(서버 고정 문구 영어 통일의 제외 범위).
 */

/** 인용 원문 상한(자). 넘으면 앞·끝을 남긴다. */
export const REPLY_QUOTE_MAX_CHARS = 1_500;
/** 넘을 때 앞에서 남기는 몫 — 나머지는 끝. */
const REPLY_QUOTE_HEAD_CHARS = 900;

/** 서로게이트 쌍을 쪼개지 않게 자른다. */
const cutHead = (s: string, n: number): string => (/[\uD800-\uDBFF]/.test(s.charAt(n - 1)) ? s.slice(0, n - 1) : s.slice(0, n));
const cutTail = (s: string, n: number): string => {
  const t = s.slice(s.length - n);
  return /^[\uDC00-\uDFFF]/.test(t) ? t.slice(1) : t;
};

/** 인용할 원문을 상한 안으로 — 앞과 끝을 남기고 가운데를 버린다. */
export const clipReplyQuote = (quoted: string): string => {
  const q = quoted.trim();
  if (q.length <= REPLY_QUOTE_MAX_CHARS) return q;
  const head = cutHead(q, REPLY_QUOTE_HEAD_CHARS);
  const tail = cutTail(q, REPLY_QUOTE_MAX_CHARS - REPLY_QUOTE_HEAD_CHARS);
  return `${head}\n…(가운데 ${q.length - head.length - tail.length}자 생략)…\n${tail}`;
};

/** 사용자 메시지 앞에 답글 대상 원문을 붙인다. 원문이 없으면 그대로. */
export const withReplyQuote = (text: string, replyToText: string | undefined): string => {
  const q = (replyToText ?? "").trim();
  if (q === "") return text;
  return (
    "〔사용자가 다음 메시지에 답글로 보냈습니다 — 이 내용에 이어 아래 요청을 처리하세요〕\n" +
    `${clipReplyQuote(q)}\n` +
    "〔/답글 대상 메시지〕\n\n" +
    text
  );
};
