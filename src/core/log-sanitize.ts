// src/core/log-sanitize.ts
/**
 * `/logs` 로 나가는 데몬 로그를 **채널 경계에서** 소독한다 (2026-07-31).
 *
 * ★계층 선택: 파일 로그(`<home>/logs/daemon-*.log`)는 **손대지 않는다.** 로컬 디스크·소유자
 *  전용이고 스택 트레이스·객체 덤프가 진단 자산이다. 유출은 그걸 **채널로 내보내는 지점**
 *  에서 생기므로 소독도 거기서 한다(경계에서만 검증 — principle-check Q6).
 *
 * ★1차 판정 = **구조**, 열거가 아니다.
 *  처음엔 캐리어 접두사 5종(`tail:`·`userText=`·`raw=`…)을 열거했는데, **실로그의 주력
 *  형상을 통째로 놓쳤다**: `console.error("...", err)` 가 만드는 `util.format` 다중 줄
 *  덤프는 계속 줄에 **접두사가 아예 없다**. 실측(검토 2인 독립 확인) — 텔레그램 502 직후
 *  `/logs 40` 의 표시 40줄 중 **29줄이 chat_id + 발송 본문 전문**이었다.
 *  손으로 관리하는 목록의 전형적 구멍이라, 자명한 구조로 바꾼다:
 *    **데몬 로그 접두사(`[YYYY-MM-DD HH:MM:SS] [level] `)가 없는 줄 = 본문 계속 줄**
 *  실측(3,137줄): 계속 줄 17.2%, 사고 당일은 28.5%. 버리고 개수만 남긴다.
 *  → 스택 트레이스도 같이 사라진다(사용자 결정). 스택이 필요하면 파일을 직접 본다.
 *
 * ★2차 = 접두사 있는 줄 안의 캐리어(아래 5종). 3차 = 길이 상한.
 *  길이 상한은 **분류기가 아니라 경계**다: 한 줄로 들어가는 작은 객체 덤프는 구조로 못
 *  가르므로, "진짜 진단 줄은 짧다" 는 실측에 기대 상한을 둔다.
 *  실측 104,067줄 — p50=74 · p99=256 · **p99.9=286** · max=405. 400자 초과는 2줄(0.00%).
 *
 * 지우면 안 되는 것 = **진단 수치**(`model=`·`req=`·`iter=`·`closing=`). `/logs` 를 만든
 * 이유가 그것이므로 회귀가 양쪽(지워짐·남음)을 함께 본다.
 */

/** 데몬 로그 한 줄의 접두사 — `logging.ts` 의 `[${localStamp}] [${level}] ` 와 짝. */
// ★레벨을 **열거하지 않는다**. 같은 날 `logFatal` 이 `[fatal]` 레벨을 새로 만들었는데
//  이 목록에 없어서 `/logs` 가 크래시 원인 줄을 통째로 버렸다 — 두 수정이 서로를 무력화했고,
//  `logFatal` 의 존재 이유("/logs 로도 원인을 볼 수 있게")가 정확히 안 닫혔다(검토 실측).
//  형태(소문자 레벨 토큰)로 판정하면 새 레벨이 생겨도 자동으로 따라온다.
const LOG_LINE_PREFIX =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[[a-z]+\] /;

/**
 * 접두사 있는 줄의 길이 상한. p99.9=286 위, 관측 최대(405) 아래 — 진짜 진단 줄은 사실상
 * 안 걸리고(104,067줄 중 2줄), 인라인 객체 덤프만 잘린다. 상한이지 판정이 아니다.
 */
const MAX_LINE_CHARS = 400;

/** 접두사 있는 줄 안의 캐리어 제거 — 구조로 못 가르는 것만 이름으로 잡는다. */
const stripInlineCarriers = (line: string): string =>
  line
    // `tail: …` 이후는 모델·사용자 발화 서술이다(stream-trace·codex-turn-end).
    .replace(/\btail:\s.*$/u, "tail: <생략>")
    // 빈 응답 진단이 싣는 사용자 원문.
    .replace(/\buserText=.*$/u, "userText=<생략>")
    // 백엔드 원문 payload.
    .replace(/\braw=.*$/u, "raw=<생략>")
    // 텔레그램 chatId 등 채널 좌표(PII).
    .replace(/\b(addr|target)=\d{6,}/gu, "$1=<가림>")
    .replace(/\btg:\d{6,}/gu, "tg:<가림>");

/**
 * 채널로 내보낼 줄들을 만든다. 계속 줄은 **연속 구간마다 한 줄**로 접어, 어디가 생략됐는지
 * 보이게 한다(총합 한 줄이면 위치 정보를 잃는다).
 */
export const sanitizeLogTail = (
  lines: readonly string[],
): { readonly out: string[]; readonly dropped: number } => {
  const out: string[] = [];
  let dropped = 0;
  let run = 0;
  const flushRun = (): void => {
    if (run > 0) {
      out.push(`… (본문 ${run}줄 생략)`);
      run = 0;
    }
  };
  for (const line of lines) {
    if (!LOG_LINE_PREFIX.test(line)) {
      run += 1;
      dropped += 1;
      continue;
    }
    flushRun();
    const stripped = stripInlineCarriers(line);
    out.push(
      stripped.length > MAX_LINE_CHARS
        ? `${stripped.slice(0, MAX_LINE_CHARS)}… <${stripped.length - MAX_LINE_CHARS}자 생략>`
        : stripped,
    );
  }
  flushRun();
  return { out, dropped };
};
