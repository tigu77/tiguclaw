/**
 * 회귀: **줄 선 입력이 남은 동안 입력(stdin)이 열려 있는가 — 실제로 돌려서 본다** (2026-09-30 적대 검토 G1).
 *
 * 왜: `queued-steer-keeps-input-open` 은 판정 모듈 + 소스 정규식이라 어댑터의 판단을 실행하지 않는다 — 적대 검토에서
 *  핵심을 끄는 변이(M3·M12)가 살아남았고, 그 판에 찾은 결함 셋(P1 안전장치가 도는 턴을 닫음 · P2 되돌려 놓기가
 *  stdin 을 닫음 · 안전장치 로그 모순)이 원리적으로 안 보였다.
 * 방법: 가짜 SDK 가 **실제 SDK 처럼 프롬프트를 끝까지 계속 당기고**(streamInput), 이터러블이 끝나는 순간을
 *  «stdin 닫힘» 으로 기록한다. 대본엔 실측한 `command_lifecycle`(queued→started→completed)을 넣는다.
 *  «줄 선 턴이 도구를 부르는 순간 stdin 이 열려 있었나» 가 판정이다(닫혀 있었으면 실제 CLI 는 도구를 취소한다).
 */
import { createSteeringChannel, type SteeringChannel } from "../../core/steering.js";
import { runClaude, SYSTEM_PROMPT_HASH, withFakeClaudeQuery, withSteerBackstopMs } from "../../core/llm-runtime/adapters/claude-agent-sdk.js";
import { initStore, saveSession } from "../../store/sessions.js";
import { assertIsolated, within, type Assertion, type RegressionCheck } from "./_framework.js";

type Frame = Record<string, unknown>;

const init = (): Frame => ({ type: "system", subtype: "init", session_id: "sess-fake", model: "claude-fake" });
const say = (text: string, uuids?: string[]): Frame => ({
  type: "assistant",
  session_id: "sess-fake",
  parent_tool_use_id: null,
  message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text }] },
  ...(uuids !== undefined && uuids.length > 0 ? { user_message_uuid: uuids[uuids.length - 1], user_message_uuids: uuids } : {}),
});
const done = (text: string): Frame => ({
  type: "result", subtype: "success", is_error: false, result: text, num_turns: 1,
  session_id: "sess-fake", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 },
});
const life = (uuid: string | undefined, state: string): Frame => ({ type: "command_lifecycle", command_uuid: uuid, state, uuid: "frame" });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Io {
  /** 몇 번째 시도인가(0부터) — resume 폴백 재시도는 같은 가짜 SDK 를 한 번 더 부른다. */
  attempt: number;
  /** 이 시도의 입력 스트림이 지금까지 당겨 간 uuid 전부(재시도 뒤 옛 시도가 가로채는지 본다). */
  pulled: string[];
  /** 실제 SDK 처럼 당겨 간 우리 입력 uuid(도착 순). 없으면 잠깐 기다린다. */
  nextUuid: () => Promise<string | undefined>;
  /** 지금 stdin 이 닫혔나 — 어댑터가 반응할 틈을 준 뒤 본다. */
  closedNow: () => Promise<boolean>;
  steering: SteeringChannel;
}

const fakeQuery = (script: (io: Io) => AsyncGenerator<Frame>, steering: SteeringChannel, attempts: Io[] = []) =>
  ((args: { prompt: unknown }) => {
    const prompt = args.prompt as AsyncIterable<{ uuid?: string }>;
    const uuids: string[] = [];
    const pulled: string[] = [];
    let closed = false;
    // SDK streamInput 처럼 끝까지 당긴다 — 이터러블이 끝나면 SDK 가 stdin 을 닫는다.
    void (async () => {
      let first = true;
      for await (const m of prompt) {
        if (first) { first = false; continue; } // 초기 사용자 메시지
        if (typeof m.uuid === "string") { uuids.push(m.uuid); pulled.push(m.uuid); }
      }
      closed = true;
    })();
    const io: Io = {
      attempt: attempts.length,
      pulled,
      nextUuid: async () => {
        for (let i = 0; i < 50 && uuids.length === 0; i++) await sleep(2);
        return uuids.shift();
      },
      closedNow: async () => { await sleep(15); return closed; },
      steering,
    };
    attempts.push(io);
    return (async function* () { yield* script(io); })();
  }) as never;

const drive = async (
  steers: string[],
  script: (io: Io) => AsyncGenerator<Frame>,
  opts: { threadKey?: string; attempts?: Io[] } = {},
): Promise<{ text?: string; error?: string; leftover: number }> => {
  const steering = createSteeringChannel();
  const threadKey = opts.threadKey ?? `regr:steer-open:${Math.random()}`;
  for (const raw of steers) steering.push({ text: raw, raw, ts: Date.now() });
  try {
    const r = await within(
      10_000,
      "가짜 SDK 턴",
      withFakeClaudeQuery(fakeQuery(script, steering, opts.attempts), () =>
        runClaude({ text: "첫 질문", threadKey, channel: "cli", steering } as never),
      ),
    );
    if ("timedOut" in r) return { error: r.timedOut, leftover: steering.drain().length };
    return { text: (r.value as { text?: string }).text, leftover: steering.drain().length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), leftover: steering.drain().length };
  }
};

const scenarios = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ① 원 사고: 줄 선 입력이 있는 채 첫 result → 줄 선 턴이 도구를 부를 때 stdin 이 열려 있어야 한다
  let atTool1: boolean | undefined;
  let afterAll1: boolean | undefined;
  const r1 = await drive(["사진"], async function* ({ nextUuid, closedNow }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield say("A1");
    yield done("A1");
    yield life(u, "started");
    yield init();
    atTool1 = await closedNow(); // 여기서 실제 CLI 는 Read → 훅 → 제어 통로
    yield say("B2", u !== undefined ? [u] : []);
    yield life(u, "completed");
    yield done("B2");
    afterAll1 = await closedNow();
  });
  out.push({ name: "★① 줄 선 턴이 도구를 부르는 순간 stdin 이 열려 있다(닫혀 있으면 도구가 «사용자 거부» 로 취소된다)", ok: atTool1 === false, got: `닫힘=${String(atTool1)} ${JSON.stringify(r1)}` });
  out.push({ name: "① 그 턴의 result 에서 닫혀 턴이 끝난다(매달리지 않는다) · 답은 이어 붙는다", ok: afterAll1 === true && r1.text === "A1\n\nB2", got: `끝 닫힘=${String(afterAll1)} ${JSON.stringify(r1)}` });

  // ② P2: 열어 둔 사이에 새 메시지가 오면 되돌려 놓되 stdin 은 닫지 않는다(사진 여러 장)
  let atTool2: boolean | undefined;
  const r2 = await drive(["사진1"], async function* ({ nextUuid, closedNow, steering }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield say("A1");
    yield done("A1");
    steering.push({ text: "사진2", raw: "사진2", ts: Date.now() }); // result 직후 도착
    yield life(u, "started");
    yield init();
    atTool2 = await closedNow();
    yield say("B2", u !== undefined ? [u] : []);
    yield life(u, "completed");
    yield done("B2");
  });
  out.push({ name: "★② 열어 둔 사이 온 메시지가 stdin 을 닫지 않는다", ok: atTool2 === false, got: `닫힘=${String(atTool2)} ${JSON.stringify(r2)}` });
  out.push({ name: "② 그 메시지는 버퍼에 남아 다음 턴으로 회수된다(유실 0)", ok: r2.leftover === 1 && r2.text === "A1\n\nB2", got: JSON.stringify(r2) });

  // ③ P1: 안전장치는 이미 집은(도는) 턴을 닫지 않는다 — 시한을 50ms 로 줄이고 그보다 오래 도구를 돌린다
  let atTool3: boolean | undefined;
  const r3 = await withSteerBackstopMs(50, () => drive(["사진"], async function* ({ nextUuid, closedNow }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield say("A1");
    yield done("A1");
    yield life(u, "started");
    yield init();
    yield say("도구 부름", u !== undefined ? [u] : []); // 실제 순서: 도구 호출이 실린 assistant 프레임(우리 uuid)이 먼저 온다
    await sleep(150); // 시한의 세 배 동안 도구가 돈다
    atTool3 = await closedNow();
    yield say("B2", u !== undefined ? [u] : []);
    yield life(u, "completed");
    yield done("B2");
  }));
  out.push({ name: "★③ 안전장치 시한이 지나도 이미 시작된 줄 선 턴의 stdin 은 닫지 않는다", ok: atTool3 === false, got: `닫힘=${String(atTool3)} ${JSON.stringify(r3)}` });

  // ④ 안전장치 자체는 돈다 — 실행기가 줄 선 입력을 끝내 안 집으면(신호 없음) 시한 뒤 닫는다(종전 동작)
  let atEnd4: boolean | undefined;
  const r4 = await withSteerBackstopMs(50, () => drive(["사진"], async function* ({ nextUuid, closedNow }) {
    yield init();
    await nextUuid();
    yield say("A1");
    yield done("A1");
    await sleep(150);
    atEnd4 = await closedNow();
  }));
  out.push({ name: "④ 신호가 없으면 시한 뒤 닫는다(턴이 영영 매달리지 않는다)", ok: atEnd4 === true && r4.text === "A1", got: `닫힘=${String(atEnd4)} ${JSON.stringify(r4)}` });

  // ⑤ 도구 결과에 섞여 들어간 입력(result 전 started) → 종전처럼 result 에서 바로 닫는다
  let atResult5: boolean | undefined;
  const r5 = await drive(["곁들임"], async function* ({ nextUuid, closedNow }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield life(u, "started");
    yield say("A1");
    yield life(u, "completed");
    yield done("A1");
    atResult5 = await closedNow();
  });
  out.push({ name: "⑤ 이미 집힌 입력만 있으면 result 에서 바로 닫는다(종전 동작 유지)", ok: atResult5 === true && r5.text === "A1", got: `닫힘=${String(atResult5)} ${JSON.stringify(r5)}` });

  // ⑥ 재검토 P-A(S1): 줄 선 입력이 시작 전에 끝났다(cancelled) — 이어 받을 턴이 없으니 안전장치가 닫아야 한다
  let atEnd6: boolean | undefined;
  await withSteerBackstopMs(50, () => drive(["사진"], async function* ({ nextUuid, closedNow }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield say("A1");
    yield done("A1");
    yield life(u, "cancelled");
    await sleep(150);
    atEnd6 = await closedNow();
  }));
  out.push({ name: "★⑥ 줄 선 입력이 시작 전에 끝나면(cancelled) 안전장치가 닫는다 — 영영 안 닫히지 않는다", ok: atEnd6 === true, got: `닫힘=${String(atEnd6)}` });

  // ⑦ 재검토 P-A(S2): started 는 왔는데 그 턴 프레임에 우리 uuid 가 없다 — 그 result 는 판정에 안 닿는다
  let atEnd7: boolean | undefined;
  await withSteerBackstopMs(50, () => drive(["사진"], async function* ({ nextUuid, closedNow }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield say("A1");
    yield done("A1");
    yield life(u, "started");
    yield init();
    yield say("B2"); // uuid 없음(SDK: delivery-failure·zeroed result 에선 빠진다)
    yield done("B2");
    await sleep(150);
    atEnd7 = await closedNow();
  }));
  out.push({ name: "★⑦ 우리 uuid 없는 턴으로 끝나도 안전장치가 닫는다", ok: atEnd7 === true, got: `닫힘=${String(atEnd7)}` });

  // ⑧ 재검토 G2: 안전장치가 도는 턴 중에 한 번 터진(닫지 않은) 뒤에도, 그 턴의 result 에서 새 줄이 생기면 다시 걸린다
  let atEnd8: boolean | undefined;
  await withSteerBackstopMs(50, () => drive(["사진1"], async function* ({ nextUuid, closedNow, steering }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield say("A1");
    yield done("A1");
    yield life(u, "started");
    yield init();
    yield say("B2", u !== undefined ? [u] : []); // 이어 받음 — 이 턴이 도는 중
    await sleep(150); // 안전장치가 한 번 터진다(도는 턴이라 닫지 않는다)
    steering.push({ text: "사진2", raw: "사진2", ts: Date.now() }); // 도는 턴에 들어가 줄을 선다
    await nextUuid();
    yield life(u, "completed");
    yield done("B2"); // 새 줄(사진2)이 남아 다시 미룬다 — 실행기는 끝내 안 집는다
    await sleep(150);
    atEnd8 = await closedNow();
  }));
  out.push({ name: "⑧ 안전장치는 한 번 터진 뒤에도 다음 미룸에서 다시 걸린다", ok: atEnd8 === true, got: `닫힘=${String(atEnd8)}` });

  // ⑨ 재검토 P-B: resume 폴백 재시도 — 옛 시도의 입력 스트림이 새 시도의 메시지를 가로채지 않는다
  initStore();
  const TK = `regr:steer-retry:${Math.random()}`;
  saveSession({ channel: "cli", threadKey: TK, claudeSessionId: "sess-dead", model: null, systemPromptHash: SYSTEM_PROMPT_HASH });
  const attempts: Io[] = [];
  let atEnd9: boolean | undefined;
  const r9 = await drive(["첫 시도 중 메시지"], async function* ({ attempt, nextUuid, closedNow, steering }) {
    yield init();
    if (attempt === 0) {
      await nextUuid(); // 첫 시도가 입력 하나를 이미 넘겼다 — 그 프로세스는 죽는다(시작 신호 없음)
      throw new Error("Claude Code process exited with code 1");
    }
    // ★죽은 시도에 넘긴 메시지는 **새 시도가 다시 받는다**(2026-10-09 전체 적대 검토 P3 — 종전엔 죽은 프로세스와 함께 사라졌다).
    //  그래서 새 시도는 되돌려 받은 것 1 + 새로 온 것 1 = 둘을 당긴다.
    const u0 = await nextUuid();
    steering.push({ text: "추가", raw: "추가", ts: Date.now() }); // 새 시도 중에 온 사용자 메시지
    const u = await nextUuid();
    const both = [u0, u].filter((x): x is string => x !== undefined);
    for (const x of both) yield life(x, "queued");
    yield say("A1");
    yield done("A1");
    for (const x of both) yield life(x, "started");
    yield init();
    yield say("B2", both);
    for (const x of both) yield life(x, "completed");
    yield done("B2");
    atEnd9 = await closedNow();
  }, { threadKey: TK, attempts });
  const oldPulled = attempts[0]?.pulled.length ?? -1;
  const newPulled = attempts[1]?.pulled.length ?? -1;
  out.push({
    name: "★⑨ 재시도 뒤 온 메시지는 새 시도가 받는다(옛 시도가 가로채 죽은 프로세스에 쓰지 않는다) · 죽은 시도에 넘긴 것도 새 시도가 다시 받는다",
    ok: attempts.length === 2 && oldPulled === 1 && newPulled === 2 && r9.text === "A1\n\nB2",
    got: `시도 ${attempts.length}회 · 옛 시도가 당김=${oldPulled}(재시도 전 1) · 새 시도가 당김=${newPulled}(되돌린 1 + 새 1) ${JSON.stringify(r9)}`,
  });
  out.push({
    name: "⑨ 죽은 시도에 넘긴 입력이 새 시도의 줄에 남지 않는다 — 새 시도의 result 에서 바로 닫힌다",
    ok: atEnd9 === true,
    got: `끝 닫힘=${String(atEnd9)}`,
  });

  // ⑩ 줄 선 턴이 첫 프레임 전에 오래 생각한다(높은 추론 강도) — 안전장치 시한이 지나도 닫지 않는다
  let atTool10: boolean | undefined;
  await withSteerBackstopMs(50, () => drive(["사진"], async function* ({ nextUuid, closedNow }) {
    yield init();
    const u = await nextUuid();
    yield life(u, "queued");
    yield say("A1");
    yield done("A1");
    yield life(u, "started");
    yield init();
    await sleep(150); // 첫 프레임 전 긴 생각 — 아직 이어 받기 전이다
    atTool10 = await closedNow();
    yield say("도구 부름", u !== undefined ? [u] : []);
    yield life(u, "completed");
    yield done("B2");
  }));
  out.push({ name: "★⑩ 줄 선 턴이 첫 프레임 전에 오래 생각해도 입력을 닫지 않는다(시간이 아니라 신호로 닫는다)", ok: atTool10 === false, got: `닫힘=${String(atTool10)}` });
  return out;
};

export const check: RegressionCheck = {
  name: "queued-steer-input-stays-open-runs",
  guards:
    "줄 선 입력이 남았는데 stdin 이 닫혀 그 턴의 도구가 취소되던 것 — 첫 result·되돌려 놓기(사진 연달아)·안전장치(60초 넘는 턴) 세 경로 모두",
  run: async (): Promise<Assertion[]> => {
    assertIsolated(); // ⑨ 가 세션 저장소를 쓴다 — 라이브 홈·DB 를 절대 안 만진다.
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "regression-fake-key";
    try {
      return await scenarios();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  },
};
