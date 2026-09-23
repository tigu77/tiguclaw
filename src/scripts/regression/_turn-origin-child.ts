import { fileURLToPath } from "node:url";
/**
 * 턴 출처가 **router 를 지나 어댑터 로그까지** 닿는지 실제 경로로 본다. 네트워크 0.
 *
 * ★`route` 본문을 복제한 가짜 빌더를 쓰지 않는다 — 진짜 `route` 를 부른다.
 *  출처를 검사에서 손으로 어댑터에 넣으면 «전달» 을 재는 게 아니라 «찍기» 를 재게 된다.
 */
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
assertIsolated();
// ★★**모델을 환경에서 고정한다** (2026-09-22, 배포 트리 회귀가 잡음).
//  종전엔 `route(msg, { specs: [...] })` 로 넘겼는데 `route` 는 그 이름을 **안 받는다**
//  (`modelProfile` 만 받는다) — 인자가 **조용히 무시**되고 기본 풀로 떨어졌다.
//  개발 레포엔 Claude 인증이 있어 우연히 통과했고, **배포 트리에서만** 「Claude 인증 없음」
//  으로 터졌다. 검사가 **주변 환경에 기댄 것**이다.
process.env.REGION_A_MODELS = "codex:gpt-5.6-sol";
initStore();
process.env.CODEX_CACHE_CURVE = "1";
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

/** 직렬화된 요청 본문·헤더 — payload 불변 비교의 원본. */
let scenario: "normal" | "loop" | "flush" = "normal";
let scenarioCalls = 0;
const requests: Array<{ body: string; headers: string }> = [];
globalThis.fetch = fakeNetwork(async (_url, init) => {
  requests.push({
    body: String(init?.body ?? ""),
    // ★인증 헤더는 빼고 비교한다(토큰은 매번 같지만 기록에 남기지 않는다).
    headers: JSON.stringify(
      Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).filter(
          ([k]) => !/authorization|cookie|account/i.test(k),
        ),
      ),
    ),
  });
  scenarioCalls += 1;
  const body = JSON.parse(String(init?.body)) as { tools?: unknown[] };
  const toolItem = { type: "function_call", id: "fc-probe", call_id: "call-probe", name: "Read", arguments: JSON.stringify({ path: fileURLToPath(import.meta.url), limit: 8 }) };
  const toolRound = scenario === "loop" && scenarioCalls === 1;
  const blank = scenario === "flush" && (body.tools?.length ?? 0) > 0;
  const inputTokens = scenario === "loop" ? scenarioCalls * 100 : 100;
  return new Response(
    [
      ...(toolRound ? [
        { type: "response.output_item.added", item: toolItem },
        { type: "response.output_item.done", item: toolItem },
      ] : blank ? [] : [{ type: "response.output_text.delta", delta: "끝" }]),
      {
        type: "response.completed",
        response: { id: "synthetic", usage: { input_tokens: inputTokens, output_tokens: 1, input_tokens_details: { cached_tokens: inputTokens / 2 }, ...(scenario === "loop" && scenarioCalls === 2 ? {} : { attribution: { request_fields: { instructions: { input_tokens: 80, cached_tokens: 40, text: "PRIVATE_ATTRIBUTION" } }, items: { PRIVATE_ID: { input_tokens: 20, cached_tokens: 10 } } } }) } },
      },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { status: 200 },
  );
});

// ★어댑터가 찍는 줄을 가로챈다 — 우리가 재려는 결합점이 바로 그 줄이다.
const lines: string[] = [];
const realLog = console.log.bind(console);
console.log = (...a: unknown[]): void => {
  const s = a.map((x) => String(x)).join(" ");
  if (s.startsWith("[codex-turn-end]") || s.startsWith("[cache-curve]")) lines.push(s);
};

const { route } = await import("../../core/router.js");
const base = {
  channel: "dashboard" as const,
  channelUserId: "u",
  receivedAt: Date.now(),
  reply: async () => {},
};
const send = async (m: Partial<IncomingMessage> & { threadKey: string; text: string }): Promise<void> => {
  await route({ ...base, ...m } as IncomingMessage);
};

// ① 정규 인입 — 콜백 있음
await send({ threadKey: "regr:o1", text: "사용자 입력", sendAttachment: async () => ({ ok: true }) } as never);
// ② 완료 재주입 — 생산부가 채운 값이 그대로 가야 한다(콜백 없음)
await send({ threadKey: "regr:o2", text: "완료", synthetic: true, turnOrigin: "worker-completion" } as never);
// ③ 점검 재주입
await send({ threadKey: "regr:o3", text: "점검", synthetic: true, turnOrigin: "worker-checkin" } as never);
// ④ 기타 합성 — 표식 없이 synthetic 만
await send({ threadKey: "regr:o4", text: "기타", synthetic: true } as never);
// ⑤ 같은 스레드 연속 실행 — run 이 달라야 한다
await send({ threadKey: "regr:o1", text: "두 번째" } as never);
// 같은 스레드·동일 초기 이력의 직접 어댑터 호출. facade 저장을 거치지 않으므로
// 첫 결과가 두 번째 입력의 이력이 되지 않는다. 본문과 헤더를 정규화 없이 비교한다.
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
const pairStart = requests.length;
const pairInput = { text: "같은 말 같은 이력", channel: "cli" as const, threadKey: "regr:same-pair", model: "gpt-5.6-sol" };
await runOpenAiCodex({ ...pairInput, turnOrigin: "worker" });
await runOpenAiCodex({ ...pairInput, turnOrigin: "subagent" });
const pairBodySame = requests[pairStart]?.body === requests[pairStart + 1]?.body;
const pairHeadersSame = requests[pairStart]?.headers === requests[pairStart + 1]?.headers;

// ⑥ router 우회(직접 호출) — unknown 이어야 한다
await runOpenAiCodex({ text: "직접", channel: "cli", threadKey: "regr:o6", model: "gpt-5.6-sol" } as never);

// ★**동시 실행 격리** (설계 §6). 두 스레드를 **병렬로** 돌려 run·origin·콜백이 섞이지
//  않는지 본다. `run`·`origin` 은 지역 변수라 구조적으로 안 섞이지만, «전역 현재 출처
//  변수를 쓰지 않는다» 는 이 설계의 전제이므로 **실행으로** 못 박는다.
const parStart = lines.filter((l) => l.startsWith("[codex-turn-end]")).length;
await Promise.all([
  send({ threadKey: "regr:parA", text: "병렬A", sendAttachment: async () => ({ ok: true }) } as never),
  send({ threadKey: "regr:parB", text: "병렬B", synthetic: true, turnOrigin: "worker-checkin" } as never),
]);
const parLines = lines.filter((l) => l.startsWith("[codex-turn-end]")).slice(parStart);
const pick = (thread: string): string | undefined => parLines.find((l) => l.includes(`thread=${thread}`));
const fieldOf = (l: string | undefined, k: string): string =>
  l === undefined ? "" : (new RegExp(`${k}=([^ ]+)`).exec(l)?.[1] ?? "");
const a = pick("regr:parA");
const b = pick("regr:parB");
const parallelClean =
  parLines.length === 2 &&
  fieldOf(a, "origin") === "inbound" &&
  fieldOf(a, "attachmentCallback") === "1" &&
  fieldOf(b, "origin") === "worker-checkin" &&
  fieldOf(b, "attachmentCallback") === "0" &&
  fieldOf(a, "run") !== fieldOf(b, "run");

// 한 실행 안의 두 요청과 tools=[] 최종 마무리까지 실제 어댑터 루프를 지난다.
const loopStart = lines.length;
scenario = "loop"; scenarioCalls = 0;
await runOpenAiCodex({ text: "파일 확인", channel: "cli", threadKey: "regr:loop", model: "gpt-5.6-sol", turnOrigin: "worker-checkin", sendAttachment: async () => ({ ok: true }) });
const loopLines = lines.slice(loopStart);
const loopCurves = loopLines.filter(l => l.startsWith("[cache-curve]"));
const loopEnds = loopLines.filter(l => l.startsWith("[codex-turn-end]"));
const loopPayloads = requests.map(r => JSON.parse(r.body) as { prompt_cache_key?: string; input?: Array<{ type?: string; output?: string }> }).filter(b => b.prompt_cache_key === "regr:loop");
const readResultDelivered = loopPayloads.at(-1)?.input?.some(i => i.type === "function_call_output" && i.output?.includes("턴 출처가")) === true;
const loopLinked = readResultDelivered && loopCurves.length === 2 && loopEnds.length === 1 &&
  new Set([...loopCurves, ...loopEnds].map(l => fieldOf(l, "run"))).size === 1 &&
  [...loopCurves, ...loopEnds].every(l => fieldOf(l, "origin") === "worker-checkin") &&
  loopCurves[0]?.includes("in=100 cached=50") && loopCurves[1]?.includes("in=200 cached=100") &&
  loopEnds[0]?.includes("turn 150/300");
const flushStart = requests.length;
const flushLineStart = lines.length;
scenario = "flush"; scenarioCalls = 0;
await runOpenAiCodex({ text: "마무리", channel: "cli", threadKey: "regr:flush", model: "gpt-5.6-sol", turnOrigin: "worker-completion", sendAttachment: async () => ({ ok: true }) });
const flushEnd = lines.slice(flushLineStart).filter(l => l.startsWith("[codex-turn-end]")).at(-1);
const flushRequests = requests.slice(flushStart).map(r => JSON.parse(r.body) as { tools?: unknown[] });
const flushSeparated = flushRequests.length > 1 && flushRequests.at(-1)?.tools?.length === 0 &&
  fieldOf(flushEnd, "attachmentCallback") === "1" && fieldOf(flushEnd, "lastSendFileTool") === "0";

// ★origins 경계를 **알려진 fixture** 로 잰다 (2026-09-23 독립검토 공백). 합계 불변식만으로는
//  경계를 아예 안 넘겨 전부 current 로 떨어져도 초록이었다. 요약 1 + 원문 이력 2(+ 요약에 접힌
//  1턴)를 심고, 기대치는 **실제로 나간 payload 의 내용**에서 뽑는다 — 구현이 낸 경계 값을
//  기대치로 쓰면 «찍기» 를 재게 된다. 두 요청(도구 왕복)이라 루프가 덧붙인 항목도 current 인지 본다.
const { appendTranscript, indexCodexTurn, loadThreadHistoryWithIds } = await import("../../store/memory.js");
const { upsertThreadSummary } = await import("../../store/thread-summaries.js");
const BOUNDARY_TK = "regr:boundary";
const SUMMARY_MARK = "BOUNDARY_FIXTURE_SUMMARY 이전 대화 요약";
const FOLDED_TEXT = "BOUNDARY_FIXTURE_FOLDED 요약에 접힌 옛 턴";
const HISTORY_TEXTS = ["BOUNDARY_FIXTURE_H1 사용자 이력", "BOUNDARY_FIXTURE_H2 비서 이력"];
indexCodexTurn({ channel: "cli", threadKey: BOUNDARY_TK, claudeSessionId: "regr-boundary-sid" });
if (loadThreadHistoryWithIds("cli", BOUNDARY_TK).length === 0) {
  let ts = 1_700_000_000_000;
  for (const [role, content] of [["user", FOLDED_TEXT], ["user", HISTORY_TEXTS[0]!], ["assistant", HISTORY_TEXTS[1]!]] as const) {
    appendTranscript({ claudeSessionId: "regr-boundary-sid", role, content, ts: (ts += 60_000) });
  }
}
upsertThreadSummary({ threadKey: BOUNDARY_TK, summary: SUMMARY_MARK, compactedThrough: loadThreadHistoryWithIds("cli", BOUNDARY_TK)[0]!.id });
const boundaryLineStart = lines.length;
scenario = "loop"; scenarioCalls = 0;
await runOpenAiCodex({ text: "경계 확인", channel: "cli", threadKey: BOUNDARY_TK, model: "gpt-5.6-sol", turnOrigin: "worker" });
type Item = { type?: string; content?: Array<{ text?: string }> };
const textOf = (i: Item): string => i.type === "message" ? (i.content ?? []).map(c => c.text ?? "").join("") : "";
const boundaryPayloads = requests.map(r => JSON.parse(r.body) as { prompt_cache_key?: string; input: Item[] }).filter(b => b.prompt_cache_key === BOUNDARY_TK);
const boundaryCurves = lines.slice(boundaryLineStart).filter(l => l.startsWith(`[cache-curve] ${BOUNDARY_TK} `));
const boundaryChecks = boundaryPayloads.map((p, i) => {
  const expected = { summary: { count: 0, chars: 0 }, history: { count: 0, chars: 0 }, current: { count: 0, chars: 0 } };
  for (const item of p.input) {
    const text = textOf(item);
    const key = text.includes(SUMMARY_MARK) ? "summary" : HISTORY_TEXTS.includes(text) ? "history" : "current";
    expected[key].count += 1;
    expected[key].chars += JSON.stringify(item).length;
  }
  const raw = boundaryCurves[i]?.split(" inputComposition=")[1]?.split(" attribution=")[0];
  const actual = raw ? (JSON.parse(raw) as { origins?: unknown }).origins : undefined;
  return { expected, actual, items: p.input.length, folded: p.input.some(it => textOf(it).includes(FOLDED_TEXT)) };
});
const boundaryOriginsMatch =
  boundaryPayloads.length === 2 && boundaryCurves.length === 2 &&
  // fixture 가 실제 payload 에 닿았다 — 이게 없으면 «전부 current» 기대치로 공허하게 통과한다.
  boundaryChecks.every(c => c.expected.summary.count === 1 && c.expected.history.count === 2 && !c.folded) &&
  boundaryChecks[1]!.expected.current.count > boundaryChecks[0]!.expected.current.count &&
  boundaryChecks.every(c => JSON.stringify(c.actual) === JSON.stringify(c.expected));
// 요청 순서와 curve 순서는 병렬 실행에서 달라질 수 있다. 캐시 키(스레드)별로 대조한다.
const curveQueues = new Map<string, string[]>();
for (const line of lines.filter(l => l.startsWith("[cache-curve]"))) {
  const key = line.split(" ")[1]!;
  const q = curveQueues.get(key) ?? []; q.push(line); curveQueues.set(key, q);
}
let compositionsMatch = true;
// ★origins.summary/history/current — 모든 요청에 대해선 **불변식**만 잰다(경계 의미는 위
//  `boundaryOriginsMatch` 가 fixture 로 따로 잰다): 세 구간의 count/chars 합이 각각 전체 items/chars 와 같아야 한다
//  (경계가 어디든 그 분할은 항상 전수를 덮어야 한다) — origins 자체가 실제로 로그에 왔는지,
//  숫자만으로 이뤄졌는지도 함께 본다.
let originsSound = true;
const toolsMatch = requests.every(r => {
  const body = JSON.parse(r.body) as { prompt_cache_key: string; tools?: Array<{type?: string; name?: string}> };
  const curve = curveQueues.get(body.prompt_cache_key)?.shift();
  const rawComposition = curve?.split(" inputComposition=")[1]?.split(" attribution=")[0];
  const composition = rawComposition ? JSON.parse(rawComposition) : undefined;
  const sent = JSON.parse(r.body).input;
  compositionsMatch &&= composition?.chars === JSON.stringify(sent).length && composition?.items === sent.length;
  const origins = composition?.origins as { summary: {count:number;chars:number}; history: {count:number;chars:number}; current: {count:number;chars:number} } | undefined;
  originsSound &&= origins !== undefined &&
    origins.summary.count + origins.history.count + origins.current.count === composition.items &&
    origins.summary.chars + origins.history.chars + origins.current.chars === composition.chars - 2 - Math.max(0, composition.items - 1);
  const expected = body.tools?.some(t => t.type === "function" && t.name === "send_file") ? "1" : "0";
  return curve !== undefined && fieldOf(curve, "sendFileTool") === expected;
}) && [...curveQueues.values()].every(q => q.length === 0);
const endsMatch = lines.filter(l => l.startsWith("[codex-turn-end]")).every(end => {
  const run = fieldOf(end, "run");
  const curves = lines.filter(l => l.startsWith("[cache-curve]") && fieldOf(l, "run") === run);
  // closing 중간 보고도 있을 수 있으므로 해당 end 이전 가장 최근 curve를 찾는다.
  const latest = lines.slice(0, lines.indexOf(end)).filter(l => l.startsWith("[cache-curve]") && fieldOf(l, "run") === run).at(-1);
  return curves.length > 0 && latest !== undefined && fieldOf(end, "lastSendFileTool") === fieldOf(latest, "sendFileTool");
});

console.log = realLog;
const ends = lines.filter((l) => l.startsWith("[codex-turn-end]"));
const field = (l: string, k: string): string => new RegExp(`${k}=([^ ]+)`).exec(l)?.[1] ?? "";
console.log(
  "ORIGIN_RESULT " +
    JSON.stringify({
      origins: ends.map((l) => field(l, "origin")),
      // ★**어느 모델로 돌았나** — 고정이 실제로 먹었는지는 «결과» 로만 알 수 있다.
      //  위 `REGION_A_MODELS` 고정이 빠지면 기본 풀로 떨어지고, 그 순간 이 값이 갈린다.
      models: [...new Set(ends.map((l) => field(l, "model")))],
      callbacks: ends.map((l) => field(l, "attachmentCallback")),
      sendFileTools: ends.map((l) => field(l, "lastSendFileTool")),
      runs: ends.filter(l => !l.includes("thread=regr:loop") && !l.includes("thread=regr:flush")).map((l) => field(l, "run")),
      // 같은 스레드의 전용 짝: 원문 요청 본문·헤더가 같아야 한다.
      bodySameAcrossOrigin: pairBodySame,
      headersSameAcrossOrigin: pairHeadersSame,
      // ★진단 값이 payload 로 새지 않았나
      leaked: requests.some((r) => /turnOrigin|worker-checkin|worker-completion|attachmentCallback/.test(r.body)),
      requestCount: requests.length,
      parallelClean,
      attributionLogged: loopCurves[0]?.includes('attribution={"instructions":{"input_tokens":80,"cached_tokens":40},"items":{"count":1,"input_tokens":20,"cached_tokens":10}}') === true && loopCurves[1]?.endsWith("attribution=unavailable") === true && !lines.some(l => /PRIVATE_ATTRIBUTION|PRIVATE_ID/.test(l)) && !requests.some(r => r.body.includes("attribution")),
      compositionsMatch, originsSound, boundaryOriginsMatch, loopLinked, toolsMatch, endsMatch, flushSeparated,
      boundaryDetail: boundaryChecks.map(({ expected, actual, items }) => ({ expected, actual, items })),
    }),
);
process.exit(0);
