/**
 * **인용 표식을 본문에서 걷어낸다** (2026-10-01 — 회사돌쇠 실사용: 답 끝에 `. citeturn0search1turn0search6`).
 *
 * Codex 백엔드는 웹 검색을 쓴 답에 출처 자리를 **유니코드 사설 영역 문자**로 감싼 표식으로 끼운다:
 * `U+E200 cite U+E202 turn0search1 U+E202 turn0search6 U+E201`. 공식 클라이언트는 이걸 출처 칩으로 그리지만
 * 우리는 그대로 흘려, 제어 문자는 안 보이고 `citeturn0search…` 글자만 화면·텔레그램·기록에 남았다.
 *
 * ★판정은 **여기 한 곳**이다 — 최종 답(코어, 세 어댑터 공통)과 실시간 조각(`_delta-stream`)이 같이 쓴다.
 * ★출처 종류(`cite`·`filecite`)만 덩어리째 지운다 — 본문 낱말이 없는 자리 표시라서다. 그 밖의 종류는 안에 본문이
 *  들어 있을 수 있어(이름 등) 지우지 않고 **제어 문자만** 뺀다 — 본문을 잃는 쪽이 더 나쁘다.
 */
const SPAN = String.raw`\uE200(?:cite|filecite)(?:\uE202[^\uE200\uE201]*)*\uE201`;
/**
 * 안 닫힌 출처 표식 — 표식 글자(영숫자·`_`·구분자 U+E202)가 끝나는 곳까지만. 스트림이 끊기거나 출력 상한에 걸리면 닫는 문자가
 * 안 온다. 그 뒤 본문은 **살린다**(종전엔 스트림이 뒤 본문 256자를 통째로 버리고, 최종본은 `citeturn…` 을 남겼다 — 적대 검토).
 */
const TOKEN = String.raw`\uE200(?:cite|filecite)[A-Za-z0-9_\uE202]*`;
/** 문장 중간 — 표식과 **뒤** 공백을 지운다. 앞 공백은 실시간 조각으로 이미 나갔을 수 있어(스트림은 미리 알 수 없다) 남겨 둔다. */
const MID_RE = new RegExp(`${SPAN}[ \t]*`, "g");
const UNCLOSED_RE = new RegExp(`${TOKEN}[ \t]*`, "g");
/** 글 맨 끝 — 앞 공백까지 지운다(최종본에만). 닫힌 것·안 닫힌 것 둘 다. */
const END_RE = new RegExp(`[ \t]*(?:${SPAN}|${TOKEN})[ \t]*$`);
/** 조각이 표식으로 끝나는가 — 그러면 다음 조각의 맨 앞 공백이 그 표식의 «뒤 공백» 이다. */
const TAIL_SPAN_RE = new RegExp(`(?:${SPAN}|${TOKEN}[ \t]+)[ \t]*$`);
/** 아직 표식 글자만 이어지는 꼬리 — 다음 조각에서 닫히거나 끝날 수 있다. */
const PARTIAL_RE = /^\uE200[A-Za-z0-9_\uE202]*$/;
const CONTROL_RE = /[\uE200-\uE202]/g;
const ANY_RE = /[\uE200-\uE202]/;

/** 스트림·최종 공통 — 닫힌 표식(뒤 공백까지) · 안 닫힌 출처 표식 · 남은 제어 문자. */
const stripMid = (text: string): string =>
  ANY_RE.test(text) ? text.replace(MID_RE, "").replace(UNCLOSED_RE, "").replace(CONTROL_RE, "") : text;

/** 최종 답 — 끝에 붙은 표식은 앞 공백까지, 중간 것은 표식과 뒤 공백을. */
export const stripCitationMarkers = (text: string): string =>
  ANY_RE.test(text) ? stripMid(text.replace(END_RE, "")) : text;

/** 붙들어 두는 상한 — 출처 25개 묶음도 수백 자다. 넘으면 표식이 아니었던 것으로 보고 같은 판정으로 내보낸다. */
const HOLD_MAX = 1024;

/**
 * 스트림 한 조각 — 닫힌 표식은 걷어 내보내고, **표식 글자만 이어지는 꼬리**는 다음 조각과 이어 판정하려 붙든다(조각 경계에서
 * `U+E200cite` 와 `U+E202turn0…U+E201` 이 갈라져 오면 반쪽이 새어 나간다). 표식 글자가 아닌 것이 오면 그 표식은 안 닫힌 채
 * 끝난 것이다 — 같은 판정으로 걷고 뒤 본문은 내보낸다. 순수 함수 — 검사가 실행으로 본다.
 */
export const stepCitationStream = (
  pending: string,
  eatSpace = false,
): { emit: string; hold: string; eatSpace: boolean } => {
  // 앞 조각 끝에서 표식을 지웠다 — 그 **뒤** 공백이 이 조각 맨 앞으로 왔다(중간 규칙의 «뒤 공백까지» 를 조각 경계 너머로).
  let p = pending;
  if (eatSpace) {
    p = p.replace(/^[ \t]+/, "");
    if (p === "") return { emit: "", hold: "", eatSpace: true };
  }
  const at = p.lastIndexOf("\uE200");
  if (at >= 0 && p.indexOf("\uE201", at) < 0 && p.length - at <= HOLD_MAX && PARTIAL_RE.test(p.slice(at))) {
    return { emit: stripMid(p.slice(0, at)), hold: p.slice(at), eatSpace: false };
  }
  return { emit: stripMid(p), hold: "", eatSpace: TAIL_SPAN_RE.test(p) };
};

/** 스트림이 끝났는데 표식이 안 닫혔다 — 최종본과 **같은 판정**(출처 표식은 지우고 그 밖은 제어 문자만 뺀다). */
export const releaseCitationHold = (hold: string): string => stripCitationMarkers(hold);
