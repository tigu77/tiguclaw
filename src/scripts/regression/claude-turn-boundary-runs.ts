/**
 * 회귀: **Claude 턴 경계를 실제로 돌린다** — 가짜 SDK 스트림을 runClaude 루프에 흘린다 (2026-09-29).
 *
 * 왜: `sdk-turn-boundary` 는 판정 함수 실행 + 소스 정규식이다. 적대 검토 두 판에서 그 그물이 변이 14 중 11 을
 *  놓쳤다(`&& 조건` 덧붙이기·줄 하나 끼우기). 경계 로직은 **프레임 순서**가 전부라, 순서를 대본으로 흘려
 *  최종 답을 보는 것이 맞는 검사다.
 * 대본은 실측·SDK 문서에서 왔다:
 *  - 답하는 중 보낸 메시지를 CLI 가 다음 턴으로 줄 세움: result → system/init → (우리 uuid 가 실린) assistant → result
 *  - 백그라운드 알림 턴: result → task_notification → system/init → assistant(우리 uuid 없음) → result
 *  - 마지막 result 가 에러면 CLI 가 종료 코드 1 → SDK 가 iterator 에서 throw
 */
import { createSteeringChannel } from "../../core/steering.js";
import {
  runClaude,
  withFakeClaudeQuery,
  STEER_TURN_FAILED_NOTE,
  STEER_TURN_EMPTY_NOTE,
} from "../../core/llm-runtime/adapters/claude-agent-sdk.js";
import { within, type Assertion, type RegressionCheck } from "./_framework.js";

type Frame = Record<string, unknown>;
type UserMsg = { uuid?: string };

const init = (): Frame => ({ type: "system", subtype: "init", session_id: "sess-fake", model: "claude-fake" });
const say = (text: string, uuids?: string[]): Frame => ({
  type: "assistant",
  session_id: "sess-fake",
  parent_tool_use_id: null,
  message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text }] },
  ...(uuids !== undefined ? { user_message_uuid: uuids[uuids.length - 1], user_message_uuids: uuids } : {}),
});
const done = (text: string, extra: Frame = {}): Frame => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  num_turns: 1,
  session_id: "sess-fake",
  modelUsage: {},
  usage: { input_tokens: 1, output_tokens: 1 },
  ...extra,
});
const notice = (): Frame => ({ type: "system", subtype: "task_notification", status: "completed", summary: "bg" });

/**
 * 가짜 query — 대본 함수가 프롬프트(초기 메시지 + steer)를 당겨 가며 프레임을 낸다.
 * `pullSteer()` 는 우리가 steer 에 단 uuid 를 돌려준다(없으면 undefined).
 */
const fakeQuery =
  (script: (io: { pullSteer: () => Promise<string | undefined> }) => AsyncGenerator<Frame>) =>
  ((args: { prompt: unknown }) => {
    const prompt = args.prompt as AsyncIterable<UserMsg> | string;
    const it = typeof prompt === "string" ? undefined : prompt[Symbol.asyncIterator]();
    const pullSteer = async (): Promise<string | undefined> => {
      if (it === undefined) return undefined;
      const r = await it.next();
      return r.done === true ? undefined : r.value.uuid;
    };
    return (async function* () {
      if (it !== undefined) await it.next(); // 초기 사용자 메시지
      yield* script({ pullSteer });
    })();
  }) as never;

/** steer 를 미리 넣어 둔 채 runClaude 를 돌린다 — 초기 메시지 다음에 곧바로 당겨진다. */
const runWith = async (
  steers: string[],
  script: Parameters<typeof fakeQuery>[0],
): Promise<{ text?: string; error?: string }> => {
  const steering = createSteeringChannel();
  for (const raw of steers) steering.push({ text: raw, raw, ts: Date.now() });
  try {
    // 시한 — 대본·루프가 매달리면 스위트 전체가 멈춘다(변이가 무한 대기를 만들 수 있다).
    const r = await within(
      10_000,
      "가짜 SDK 턴",
      withFakeClaudeQuery(fakeQuery(script), () =>
        runClaude({ text: "첫 질문", threadKey: `regr:turn-boundary:${Math.random()}`, channel: "cli", steering } as never),
      ),
    );
    if ("timedOut" in r) return { error: r.timedOut };
    return { text: (r.value as { text?: string }).text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const run = async (): Promise<Assertion[]> => {
  // 가짜 SDK 라 네트워크는 없다 — 인증 확인만 통과시키는 더미(끝나면 원래대로).
  const prevToken = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "regression-fake-key";
  try {
    return await runScenarios();
  } finally {
    if (prevToken === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevToken;
  }
};

const runScenarios = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const note = STEER_TURN_FAILED_NOTE;

  // ① 줄 선 두 번째 메시지의 턴 → 이어 붙인다 (09-28 실사고: 이게 버려졌다)
  const queued = await runWith(["두 번째"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    const u = await pullSteer();
    yield done("A1");
    yield init();
    yield say("B2", u !== undefined ? [u] : []);
    yield done("B2");
  });
  out.push({
    name: "★답하는 중 보낸 메시지의 턴(우리 uuid)은 이어 붙인다 — 버리지 않는다",
    ok: queued.text === "A1\n\nB2",
    got: JSON.stringify(queued),
  });

  // ② 백그라운드 알림이 연 턴 → 버린다 (08-06 실사고: 알림 답이 섞였다)
  const noticeTurn = await runWith([], async function* () {
    yield init();
    yield say("A1");
    yield done("A1");
    yield notice();
    yield init();
    yield say("알겠습니다, 멈추겠습니다");
    yield done("알겠습니다, 멈추겠습니다");
  });
  out.push({
    name: "★알림이 연 턴(우리 uuid 없음)은 답에 섞지 않는다",
    ok: noticeTurn.text === "A1",
    got: JSON.stringify(noticeTurn),
  });

  // ③ 두 번째 턴이 에러로 끝나 SDK 가 **던진다** → 첫 답 유지 + 안내 (09-29 재검토 F1, P3)
  const thrown = await runWith(["두 번째"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    const u = await pullSteer();
    yield done("A1");
    yield init();
    yield say("API Error: 529 overloaded", u !== undefined ? [u] : []);
    throw new Error("Claude Code returned an error result: API Error: 529 overloaded");
  });
  out.push({
    name: "★이어 받던 턴에서 SDK 가 던져도 첫 답은 남고 실패 안내가 붙는다(합성 오류 문구는 싣지 않는다)",
    ok: thrown.text === `A1\n\n${note}`,
    got: JSON.stringify(thrown),
  });

  // ④ 두 번째 턴이 is_error success result 로 끝남 → 같은 결과
  const isErr = await runWith(["두 번째"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    const u = await pullSteer();
    yield done("A1");
    yield init();
    yield say("API Error: 400", u !== undefined ? [u] : []);
    yield done("API Error: 400", { is_error: true });
  });
  out.push({
    name: "이어 받던 턴의 에러 result 도 첫 답을 지우지 않는다",
    ok: isErr.text === `A1\n\n${note}`,
    got: JSON.stringify(isErr),
  });

  // ⑤ 메시지 셋 — 가운데 턴만 실패 → 답·안내·답 (재검토 F2)
  const three = await runWith(["둘째", "셋째"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    const u2 = await pullSteer();
    const u3 = await pullSteer();
    yield done("A1");
    yield init();
    yield say("API Error: 529", u2 !== undefined ? [u2] : []);
    yield done("API Error: 529", { is_error: true });
    yield init();
    yield say("A3", u3 !== undefined ? [u3] : []);
    yield done("A3");
  });
  out.push({
    name: "★가운데 턴만 실패하면 그 자리엔 안내, 셋째 답은 그대로 이어진다",
    ok: three.text === `A1\n\n${note}\n\nA3`,
    got: JSON.stringify(three),
  });

  // ⑦ 이어 받은 턴의 result 본문이 **비어** 조각으로 마감해야 할 때 — 앞 턴의 답·조각이 섞이면 안 된다
  //  (SDK 는 빈 result 를 보낸다 — 08-09 합성 턴·0.3.274 묶인 알림에서 실측). 재개 때 resultText·조각 기준선을 안 옮기면
  //  «A1 + A1» 이나 «A1 + A1B2» 가 된다.
  const emptyResult = await runWith(["두 번째"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    const u = await pullSteer();
    yield done("A1");
    yield init();
    yield say("B2", u !== undefined ? [u] : []);
    yield done("");
  });
  out.push({
    name: "★이어 받은 턴의 result 가 비면 **그 턴의 조각만**으로 마감한다(앞 답 중복·섞임 없음)",
    ok: emptyResult.text === "A1\n\nB2",
    got: JSON.stringify(emptyResult),
  });

  // ⑧ 이어 받은 턴이 result 없이 스트림이 끝남 — 앞 답(result)을 지금 턴 답으로 다시 쓰면 안 된다
  const noResult = await runWith(["두 번째"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    const u = await pullSteer();
    yield done("A1");
    yield init();
    yield say("B2", u !== undefined ? [u] : []);
  });
  out.push({
    name: "이어 받은 턴이 result 없이 끝나도 그 턴의 조각으로 마감한다(앞 답을 두 번 싣지 않는다)",
    ok: noResult.text === "A1\n\nB2",
    got: JSON.stringify(noResult),
  });

  // ⑨ steer 가 **첫 result 뒤에** 당겨짐(백프레셔 창) — 채널은 result 에서 이미 닫혀 되돌릴 곳이 없다.
  //  종전(08-11 «되돌려 놓기»)엔 push 가 false 라 **메시지가 사라졌다**(적대 검토 재현: drain 0). 버리지 말고 SDK 에
  //  넘겨 CLI 가 다음 턴으로 답하게 하고, 그 턴을 uuid 로 이어 받는다.
  const lateSteer = await runWith(["늦게 당겨진 메시지"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    yield done("A1");
    const u = await pullSteer();
    if (u === undefined) return; // 버려졌다 — 아래 단언이 «A1» 만 보게 된다
    yield init();
    yield say("B2", [u]);
    yield done("B2");
  });
  out.push({
    name: "★첫 result 뒤에 당겨진 steer 도 버리지 않는다 — SDK 에 넘겨 그 답을 이어 붙인다",
    ok: lateSteer.text === "A1\n\nB2",
    got: JSON.stringify(lateSteer),
  });

  // ⑩ 이어 받은 턴이 **텍스트 없이** 끝남(도구만 쓰고 말 없음·빈 result) — 조용히 첫 답만 나가면 사용자에겐
  //  «두 번째 메시지 무시» 와 같다. 그리고 경계가 안 닫히면 뒤따르는 알림 턴이 섞인다(재검토 F5).
  const silent = await runWith(["두 번째"], async function* ({ pullSteer }) {
    yield init();
    yield say("A1");
    const u = await pullSteer();
    yield done("A1");
    yield init();
    yield done("", u !== undefined ? { user_message_uuid: u, user_message_uuids: [u] } : {});
    yield notice();
    yield init();
    yield say("알림에 대한 대답");
    yield done("알림에 대한 대답");
  });
  out.push({
    name: "★이어 받은 턴이 말 없이 끝나면 안내를 붙이고 경계를 닫는다 — 뒤따르는 알림 턴은 섞지 않는다",
    ok: silent.text === `A1\n\n${STEER_TURN_EMPTY_NOTE}`,
    got: JSON.stringify(silent),
  });

  // ⑪ 턴 **시작**의 합성(알림) 턴이 우리 steer 를 접어 넣고 말 없이 끝남 → 그 뒤 진짜 답 A1 (적대 검토 S14).
  //  이어 받기 전(`settledAnswer` 없음)의 우리 uuid result 로 경계를 닫으면 08-09 사고(진짜 답 통째 폐기)가 돌아온다.
  const foldedAtStart = await runWith(["두 번째"], async function* ({ pullSteer }) {
    yield notice();
    const u = await pullSteer();
    yield init();
    yield done("", u !== undefined ? { user_message_uuid: u, user_message_uuids: [u] } : {});
    yield say("A1");
    yield done("A1");
  });
  out.push({
    name: "★시작 합성 턴이 우리 steer 를 접어 말 없이 끝나도 경계를 닫지 않는다 — 진짜 답을 버리지 않는다(08-09)",
    ok: foldedAtStart.text === "A1",
    got: JSON.stringify(foldedAtStart),
  });

  // ⑫ 가짜 SDK 주입구는 겹쳐 쓸 수 없다 — 먼저 끝난 쪽이 진짜 SDK 로 되돌리면 다른 쪽이 가드 없이 진짜 CLI 를 띄운다.
  let nestedError = "";
  try {
    await withFakeClaudeQuery((() => ({})) as never, () => withFakeClaudeQuery((() => ({})) as never, async () => 1));
  } catch (e) {
    nestedError = e instanceof Error ? e.message : String(e);
  }
  out.push({
    name: "★가짜 SDK 주입구 중첩·동시 사용은 거부한다(실모델 금지 가드 우회 차단)",
    ok: nestedError.includes("중첩"),
    got: nestedError || "거부 안 됨",
  });

  // ⑥ 첫 답 전에 실패 → 종전대로 실패(폴백이 받는다) — 붙잡을 답이 없으면 삼키지 않는다
  const early = await runWith([], async function* () {
    yield init();
    throw new Error("Claude Code returned an error result: boom");
  });
  out.push({
    name: "답이 생기기 전 실패는 그대로 실패다(조용히 빈 답으로 끝내지 않는다)",
    ok: early.error !== undefined && early.text === undefined,
    got: JSON.stringify(early),
  });

  return out;
};

export const check: RegressionCheck = {
  name: "claude-turn-boundary-runs",
  guards:
    "턴 경계를 소스 정규식으로만 지켜 `&& 조건` 하나로 뚫리던 것 — 답하는 중 보낸 메시지의 답 폐기(09-28) · 알림 턴 혼입(08-06) · 두 번째 턴 실패가 첫 답까지 지우던 것(09-29)을 실제 루프로 돌린다",
  run,
};
