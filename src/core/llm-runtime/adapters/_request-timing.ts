/**
 * 모델 요청 한 번의 **벽시계 분해** — 「도구 밖 시간」이 어디서 나는지 가른다 (2026-10-02). 세 어댑터 공용.
 *
 * 회사돌쇠 실측: 같은 범위의 시범 제작이 Claude 517초 · GPT 1,221초였는데 도구 시간은 229 대 281초로 비슷했고
 * 차이의 93%가 **도구 밖**이었다. 그 «밖» 이 서버가 생각한 시간인지, 요청을 조립·전송한 시간인지, 무진전 재개인지
 * 가를 기록이 없었다(회사돌쇠 보고서 둘 · 아스트라 검토가 모두 이것을 1순위로 꼽았다).
 * ★어댑터마다 다른 기록이면 «모델을 바꾸면 무엇이 달라지나» 를 못 잰다 — 그래서 구간 정의를 한 곳에 둔다.
 *
 * 어댑터는 시각만 찍고, 구간 계산·표기는 여기서 한다(순수 함수 — 회귀가 동작으로 잰다).
 *
 * 구간 (모델 요청 한 번):
 *  - `between` 직전 요청 끝 → 이번 요청 준비됨 = 도구 실행 + 그 뒤 처리(첫 요청은 0)
 *  - `prep`    준비됨 → 첫 전송 = 요청 조립(이력·압축·직렬화)           ┐ 직접 fetch 하는 어댑터(codex)만 안다.
 *  - `stalled` 첫 전송 → 마지막 시도 전송 = 무진전으로 버린 시도 + 대기  │ SDK 어댑터(claude·openai)는 이 셋이
 *  - `headers` 마지막 시도 전송 → 응답 헤더 = 연결·서버 접수·전송 재시도 ┘ 아래 `wait` 에 합쳐진다.
 *  - `wait`    (헤더|준비됨) → 첫 이벤트(응답 시작) = 서버가 응답을 열기까지
 *  - `think`   첫 이벤트 → 첫 진전(글자·도구 인자) = 서버가 생각한 시간(추론·큐 — 둘은 못 가른다)
 *  - `output`  첫 진전 → 끝 = 출력이 흘러나온 시간
 * 진전이 한 번도 없으면(빈 응답) `think` 가 끝까지를 갖고 `output` 은 0 이다. 첫 이벤트가 없으면 `wait` 가 0 이다.
 */

export type RequestMarks = {
  /** 요청이 보낼 준비가 된 시각 — codex 는 루프 시작, SDK 어댑터는 직전 도구 결과를 받은 시각(첫 요청은 턴 시작) */
  readyAt: number;
  /** codex 전용 — 첫 시도 전송 */
  firstSendAt?: number;
  /** codex 전용 — 마지막(성공) 시도 전송 */
  sendAt?: number;
  /** codex 전용 — 응답 헤더 수신 */
  headersAt?: number;
  /** 응답 시작 이벤트(response.created · message_start · response_started) */
  firstEventAt?: number;
  /** 첫 진전(글자·도구 인자 델타) */
  firstOutputAt?: number;
  /** 응답을 다 받은 시각 */
  endAt: number;
};

export type RequestSpans = {
  index: number;
  between: number;
  prep?: number;
  stalled?: number;
  headers?: number;
  wait: number;
  think: number;
  output: number;
};

const nonNeg = (n: number): number => (n > 0 ? n : 0);

export const requestSpans = (index: number, m: RequestMarks, prevEndAt: number | undefined): RequestSpans => {
  const direct = m.firstSendAt !== undefined && m.sendAt !== undefined && m.headersAt !== undefined;
  // 응답이 열리기를 기다리기 시작한 시각 — 직접 전송이면 헤더, 아니면 준비됨.
  const waitFrom = direct ? m.headersAt! : m.readyAt;
  const opened = m.firstEventAt ?? waitFrom;
  const firstOut = m.firstOutputAt ?? m.endAt;
  return {
    index,
    between: prevEndAt === undefined ? 0 : nonNeg(m.readyAt - prevEndAt),
    ...(direct
      ? { prep: nonNeg(m.firstSendAt! - m.readyAt), stalled: nonNeg(m.sendAt! - m.firstSendAt!), headers: nonNeg(m.headersAt! - m.sendAt!) }
      : {}),
    wait: nonNeg(opened - waitFrom),
    think: nonNeg(firstOut - opened),
    output: m.firstOutputAt === undefined ? 0 : nonNeg(m.endAt - m.firstOutputAt),
  };
};

const KEYS = ["between", "prep", "stalled", "headers", "wait", "think", "output"] as const;
type Key = (typeof KEYS)[number];
const LABEL: Record<Key, string> = {
  between: "도구·후처리",
  prep: "조립",
  stalled: "무진전",
  headers: "헤더",
  wait: "응답열림",
  think: "첫출력",
  output: "출력",
};

const sec = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const val = (s: RequestSpans, k: Key): number => s[k] ?? 0;
const spanTotal = (s: RequestSpans): number => KEYS.reduce((a, k) => a + val(s, k), 0);
// 표시할 구간 — 그 어댑터가 모르는 구간(undefined)은 빼고, 무진전은 있을 때만.
const shown = (keys: readonly Key[], has: (k: Key) => boolean, amount: (k: Key) => number): Key[] =>
  keys.filter((k) => has(k) && (k !== "stalled" || amount(k) > 0));

/** 요청 한 번 — 상세 진단 줄에 붙인다. */
export const formatRequestSpans = (s: RequestSpans): string =>
  `시간(${shown(KEYS, (k) => s[k] !== undefined, (k) => val(s, k)).map((k) => `${LABEL[k]} ${sec(val(s, k))}`).join("·")})`;

/**
 * 턴 줄의 칸 — **어댑터끼리 같은 것을 재는 칸만** 둔다 (2026-10-02 실측으로 정함).
 * ★`headers`·`wait`·`think` 를 따로 두면 어댑터마다 다른 걸 잰다: Claude 는 출력을 시작할 때 `message_start` 를 보내
 *  생각이 «응답열림» 에 들어가고(실측 응답열림 5.1s·첫출력 0.0s), codex 는 접수 즉시 `response.created` 를 보내 생각이
 *  «첫출력» 에 들어간다(실측 응답열림 0.0s·첫출력 7.6s). 그래서 턴 줄은 셋을 «첫출력까지» 하나로 묶는다 — 요청이
 *  준비된 뒤(조립 제외) 첫 글자·도구 인자가 나오기까지. 세분은 요청별 상세 줄(`formatRequestSpans`)에만 남긴다.
 */
const TURN_COLS = [
  { key: "betweenMs", label: "도구·후처리", of: (s: RequestSpans) => s.between, has: () => true },
  { key: "prepMs", label: "조립", of: (s: RequestSpans) => s.prep ?? 0, has: (s: RequestSpans) => s.prep !== undefined },
  { key: "stalledMs", label: "무진전", of: (s: RequestSpans) => s.stalled ?? 0, has: (s: RequestSpans) => (s.stalled ?? 0) > 0 },
  { key: "firstOutputMs", label: "첫출력까지", of: (s: RequestSpans) => (s.headers ?? 0) + s.wait + s.think, has: () => true },
  { key: "outputMs", label: "출력", of: (s: RequestSpans) => s.output, has: () => true },
] as const;

/**
 * 턴 바깥 시각 — 요청 루프 **밖**에서 쓴 시간을 칸으로 남기는 재료 (2026-10-03, 회사돌쇠 후속 보고).
 *  - `turnStartAt` 어댑터 입구 · `setupDoneAt` 첫 요청이 준비된 시각(그 사이 = «턴 준비»: 이력 로딩·**압축 잠금 대기**·도구 준비)
 *  - `endAt` 이 줄을 찍는 시각 — 분해 합계와의 차이가 «그 밖»(마지막 응답 뒤 처리 · 실패면 끝나지 않은 요청)
 */
export type TurnBounds = { turnStartAt: number; setupDoneAt?: number; endAt: number };

/** 턴 요약 — 로그 줄과 `llm.turn_done` 저장이 **같은 값**을 쓴다(두 벌로 계산하지 않는다). 단위 ms. */
export type TurnTimingSummary = {
  requests: number;
  setupMs?: number;
  betweenMs: number;
  prepMs?: number;
  stalledMs?: number;
  firstOutputMs: number;
  outputMs: number;
  residualMs?: number;
  wallMs?: number;
  slowest: { index: number; ms: number; part: string; partMs: number }[];
};

export const summarizeTurnTiming = (all: readonly RequestSpans[], bounds?: TurnBounds): TurnTimingSummary => {
  const cols = TURN_COLS.filter((c) => all.some((s) => c.has(s)));
  const sum = (c: (typeof TURN_COLS)[number]): number => all.reduce((a, s) => a + c.of(s), 0);
  const out: TurnTimingSummary = { requests: all.length, betweenMs: 0, firstOutputMs: 0, outputMs: 0, slowest: [] };
  for (const c of cols) (out as unknown as Record<string, number>)[c.key] = sum(c);
  out.slowest = [...all]
    .sort((a, b) => spanTotal(b) - spanTotal(a))
    .slice(0, 3)
    .map((s) => {
      // 그 요청에서 가장 큰 칸 하나 — «무엇이 길었나» 가 한눈에 보이게.
      const top = cols.reduce((a, c) => (c.of(s) > a.of(s) ? c : a), cols[0] ?? TURN_COLS[0]);
      return { index: s.index, ms: spanTotal(s), part: top.label, partMs: top.of(s) };
    });
  if (bounds !== undefined) {
    const wall = nonNeg(bounds.endAt - bounds.turnStartAt);
    const setup = bounds.setupDoneAt === undefined ? undefined : nonNeg(bounds.setupDoneAt - bounds.turnStartAt);
    const spanned = all.reduce((a, s) => a + spanTotal(s), 0);
    out.wallMs = wall;
    if (setup !== undefined) out.setupMs = setup;
    out.residualMs = nonNeg(wall - (setup ?? 0) - spanned);
  }
  return out;
};

/**
 * 턴 한 줄 — 칸별 합계와 **가장 긴 요청 셋**(긴 공백이 무엇이었는지가 이 줄의 목적이다).
 * 합계만 보면 82회 중 한두 번의 5분이 평균에 묻힌다. `bounds` 를 주면 앞에 «턴 준비», 뒤에 «그 밖» 이 붙는다.
 */
export const formatTurnTiming = (all: readonly RequestSpans[], bounds?: TurnBounds): string => {
  const t = summarizeTurnTiming(all, bounds);
  const cells: string[] = [];
  if (t.setupMs !== undefined) cells.push(`턴 준비 ${sec(t.setupMs)}`);
  if (all.length > 0) {
    for (const c of TURN_COLS) {
      const v = (t as unknown as Record<string, number | undefined>)[c.key];
      if (v !== undefined && all.some((s) => c.has(s))) cells.push(`${c.label} ${sec(v)}`);
    }
  }
  if (t.residualMs !== undefined) cells.push(`그 밖 ${sec(t.residualMs)}`);
  if (cells.length === 0) return "시간=없음";
  const slowest = t.slowest.map((x) => `#${x.index} ${sec(x.ms)}(${x.part} ${sec(x.partMs)})`).join(" ");
  return `시간=${cells.join("·")} 요청=${t.requests}회${slowest === "" ? "" : ` 긴순=${slowest}`}`;
};

/**
 * SDK 어댑터(claude·openai)용 수집기 — 스트림 이벤트를 받는 자리에서 시각만 넘긴다.
 * 요청 경계는 «응답 시작 이벤트» 로 열고 «응답 끝 이벤트» 로 닫는다. 도구 결과가 오면 다음 요청의 준비 시각이 된다.
 */
export const createRequestTimeline = (turnStartAt: number) => {
  const spans: RequestSpans[] = [];
  let readyAt = turnStartAt;
  let setupDoneAt: number | undefined;
  let prevEndAt: number | undefined;
  let open: { readyAt: number; firstEventAt: number; firstOutputAt?: number } | undefined;
  return {
    /** 턴 준비가 끝났다(첫 요청을 내보낼 참) — 이 앞은 «턴 준비», 첫 요청의 응답 대기는 여기서부터. */
    setupDone(at: number): void {
      if (setupDoneAt !== undefined) return;
      setupDoneAt = at;
      if (spans.length === 0 && open === undefined) readyAt = at;
    },
    /** 도구 결과를 받았다 — 다음 요청은 이 뒤에 나간다(병렬 도구면 마지막 결과가 이긴다). */
    toolResult(at: number): void {
      if (open === undefined) readyAt = at;
    },
    responseStart(at: number): void {
      if (open !== undefined) return; // 이미 열린 응답 안의 중복 신호
      open = { readyAt: Math.max(readyAt, prevEndAt ?? readyAt), firstEventAt: at };
    },
    output(at: number): void {
      if (open !== undefined) open.firstOutputAt ??= at;
    },
    responseEnd(at: number): void {
      if (open === undefined) return;
      spans.push(requestSpans(spans.length + 1, { readyAt: open.readyAt, firstEventAt: open.firstEventAt, ...(open.firstOutputAt !== undefined ? { firstOutputAt: open.firstOutputAt } : {}), endAt: at }, prevEndAt));
      prevEndAt = at;
      readyAt = at;
      open = undefined;
    },
    mark(kind: StreamMark | undefined, at: number): void {
      if (kind === "start") this.responseStart(at);
      else if (kind === "output") this.output(at);
      else if (kind === "end") this.responseEnd(at);
    },
    format: (endAt: number = Date.now()): string => {
      const bounds: TurnBounds = { turnStartAt, endAt, ...(setupDoneAt !== undefined ? { setupDoneAt } : {}) };
      // 끝나지 않은 요청이 있으면(실패·취소) 어디서 멈췄는지 덧붙인다 — 응답이 열리기 전인가, 출력 중인가.
      const pending = open === undefined ? "" : ` 미완=${sec(nonNeg(endAt - open.readyAt))}(${open.firstOutputAt === undefined ? "첫출력 대기" : "출력 중"})`;
      return formatTurnTiming(spans, bounds) + pending;
    },
    summary: (endAt: number = Date.now()): TurnTimingSummary =>
      summarizeTurnTiming(spans, { turnStartAt, endAt, ...(setupDoneAt !== undefined ? { setupDoneAt } : {}) }),
    spans: (): readonly RequestSpans[] => spans,
  };
};

/** 어댑터 스트림 이벤트가 요청 경계의 무엇인가 — 판정은 여기 한 곳(어댑터는 넘기기만 한다). */
export type StreamMark = "start" | "output" | "end";

/**
 * Claude SDK `stream_event.event` → 경계. 진전 = 글자·도구 인자 델타.
 * ★thinking 델타는 «생각» 이라 첫 출력으로 치지 않는다 — codex 는 추론을 흘리지 않으므로, 이걸 세면 두 어댑터의
 *  «첫출력» 이 다른 것을 재게 된다.
 */
export const claudeStreamMark = (event: unknown): StreamMark | undefined => {
  if (event === null || typeof event !== "object") return undefined;
  const t = (event as { type?: unknown }).type;
  if (t === "message_start") return "start";
  if (t === "message_stop") return "end";
  if (t === "content_block_delta") {
    const d = (event as { delta?: { type?: unknown } }).delta?.type;
    if (d === "text_delta" || d === "input_json_delta") return "output";
  }
  return undefined;
};

/**
 * OpenAI Agents SDK `raw_model_stream_event.data` → 경계. 도구 인자는 정규화 이벤트가 없어 원시 provider 이벤트
 * (`model` → `response.function_call_arguments.delta`)로만 온다 — Responses 가 아닌 provider 면 도구 인자는 진전으로
 * 안 잡히고, 그 요청의 «첫출력» 이 끝까지로 잡힌다.
 */
export const openAiStreamMark = (data: unknown): StreamMark | undefined => {
  if (data === null || typeof data !== "object") return undefined;
  const t = (data as { type?: unknown }).type;
  if (t === "response_started") return "start";
  if (t === "response_done") return "end";
  if (t === "output_text_delta") return "output";
  if (t === "model" && (data as { event?: { type?: unknown } }).event?.type === "response.function_call_arguments.delta") return "output";
  return undefined;
};
