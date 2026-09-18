/**
 * 「이 매니저가 지금 무엇을 하고 있나」를 **한 줄로** 말한다 — 순수.
 *
 * ★★**왜 따로 있나** (2026-09-18, 아스트라 제보). 이 판단은 `list_workers` 핸들러 안에
 *  박혀 있었고, 그래서 아무도 검사하지 않았다. 그사이 그 한 줄이 사람을 **세 번** 틀리게
 *  했다 — 매니저 셋이 21분·2시간·53분 멈췄는데, 목록은 «마지막: Bash 52분 전» 이라고
 *  답했다. 그 문장은 두 가지로 읽힌다:
 *
 *      ① 52분 전에 Bash 를 쓰고 그 뒤로 조용하다   ← 이렇게 읽혔다
 *      ② Bash 가 52분째 실행 중이다                ← 사실이었다
 *
 *  ①로 읽은 결과 «모델이 멈췄다» 는 오진이 나왔고, 엉뚱한 어댑터 가설까지 세워졌다.
 *  약 3시간이 그렇게 갔다.
 *
 * ★기록되는 값은 **도구 시작**이다. 그러니 그렇게 적는다 — 이름이 사실과 같아야 한다.
 * ★그리고 «아직 안 끝났다» 는 증거를 우리는 **이미 갖고 있었다**: 감시자가 내는
 *  `llm.tool_slow` 는 도구가 **도는 동안에만** 나온다. 그게 마지막 활동보다 뒤에 있으면
 *  «그 시각에 그 도구는 실행 중이었다» 가 사실로 확정된다. 그 값이 로그에만 있었다.
 *  **로그에만 있는 진단은 판단하는 자에게 없는 것이다.**
 *  (P1 에서 우리가 남에게 한 말이고, 같은 결함이 우리 쪽에 또 있었다.)
 */
export interface WorkerActivity {
  /** 마지막 `llm.activity` — `kind === "tool"` 이면 그 값은 **도구 시작**이다. */
  readonly last: { label: string; ts: number; kind: string | null } | null;
  /** 마지막 `llm.tool_slow` — 감시자가 «아직 돌고 있다» 를 본 시각. */
  readonly slow: { tool: string; ms: number; ts: number } | null;
  readonly now: number;
  readonly elapsed: (fromMs: number, toMs: number) => string;
}

/** 목록 줄 뒤에 붙는 조각(앞의 `, ` 포함). 말할 것이 없으면 빈 문자열. */
export const workerActivityLine = (a: WorkerActivity): string => {
  // 감시자가 마지막 활동 **이후에** 울렸다 = 그때 그 도구는 아직 반환하지 않았다.
  // ★같은 시각(`>=`)도 «아직» 이다 — 감시자는 도구가 시작한 뒤에만 울릴 수 있으므로,
  //  두 값이 같은 ms 로 찍히는 것은 «직후» 이지 «그전» 이 아니다.
  const stuck = a.slow !== null && (a.last === null || a.slow.ts >= a.last.ts) ? a.slow : null;
  if (stuck !== null) {
    // 도구가 시작한 시각 = 감시자가 울린 시각 − 그때까지의 경과.
    const startedAt = stuck.ts - stuck.ms;
    return (
      `, ★도구 '${stuck.tool}' 이(가) ${a.elapsed(startedAt, a.now)}째 실행 중입니다` +
      `(아직 반환하지 않았습니다)`
    );
  }
  if (a.last === null) return "";
  return a.last.kind === "tool"
    ? `, 마지막 활동: 도구 '${a.last.label}' **시작** ${a.elapsed(a.last.ts, a.now)} 전`
    : `, 마지막 활동: ${a.last.label} ${a.elapsed(a.last.ts, a.now)} 전`;
};
