/**
 * 회귀: **실패는 실패로 끝나고, 실패한 턴이 사용자 것을 먹지 않는다** — LLM 어댑터 면적 (2026-10-09 전체 적대 검토).
 *
 * 검토가 가짜 fetch/SDK 로 재현한 결함 아홉을 **실행으로** 지킨다(소스 대조가 아니다):
 *  ① codex 토큰 갱신 single-flight 없음 — 동시 3건이 회전형 갱신 토큰으로 3번 POST, 2건 `refresh_token_reused`
 *     → 인증 거부로 분류돼 **갱신은 성공했는데 12시간 인증 쿨다운**. (+ 만료 임박 갱신·다른 프로세스가 먼저 갱신)
 *  ② codex 가 도구 실행 뒤 429·401 을 **성공 답장으로 삼킴** — turn_done 만, 쿨다운 0, 해제 안내 없음.
 *  ③ openai 본 턴 `maxTurns` 미지정 → SDK 기본 10 → 도구 10회 넘는 턴이 `MaxTurnsExceededError` 로 사망.
 *  ④ codex 가 답을 쓰던 도중 과부하(`error`/`response.failed`)를 맞으면 **잘린 문장이 성공 확정**.
 *  ⑤ 끼워넣기를 꺼낸 뒤 턴이 실패하면 메시지 **증발**(세 어댑터 — 장부 `_steering-ledger.ts`).
 *  ⑥ claude resume 실패 → fresh 재시도가 **스티어링 턴에서 기록을 안 실음**(스티어링 기본 켜짐 = 대화 전부).
 *  ⑦ codex 백엔드 실패 재전송 예산이 **턴 누적** — 도구를 오래 쓴 턴은 뒤 요청의 첫 과부하에서 사망.
 *  ⑧ claude `/stop` 뒤 SDK 가 조용히 끝나면 **부분 텍스트가 성공**으로 반환.
 *  ⑨ codex 입력 상한(iteration 0) 배선·토큰 수명주기에 동작 그물 0.
 *
 * 등급: **동작**. codex·facade·토큰은 자식 프로세스(`_adapter-failure-child.ts`)에서 가짜 네트워크로, claude 는
 * `withFakeClaudeQuery`, openai 는 실제 SDK `run()` 에 어댑터의 실행 옵션을 그대로 넣어 돈다. 모델 호출 0.
 * ★openai 어댑터 본체(`runOpenAi`)는 회귀 가드가 스텁과 무관하게 막는다 — 그래서 옵션·장부를 **이름 있는 값**으로
 *  뽑아 그것을 실행한다. 어댑터가 그 값을 쓰는지만 `[린트]` 다.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, within, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "_adapter-failure-child.ts");

type J = Record<string, unknown>;
const child = async (scenario: string, ms = 60_000): Promise<J> => {
  const r = await spawnWithin(ms, `adapter-failure(${scenario})`, ["--import", "tsx", CHILD, scenario], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.timedOut) return { outcome: "timeout" };
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  try {
    return line === undefined ? { outcome: "no-output", err: r.err.slice(-300) } : (JSON.parse(line) as J);
  } catch {
    return { outcome: "bad-json", line };
  }
};
const show = (o: unknown): string => JSON.stringify(o).slice(0, 400);

const claudeChecks = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const { runClaude, withFakeClaudeQuery, SYSTEM_PROMPT_HASH } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  const { createSteeringChannel, UserCancelledError } = await import("../../core/steering.js");
  const { initStore, saveSession } = await import("../../store/sessions.js");
  const { appendTranscript, indexCodexTurn } = await import("../../store/memory.js");
  initStore();
  type Frame = Record<string, unknown>;
  const say = (text: string): Frame => ({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text }] } });
  const result = (text: string): Frame => ({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, session_id: "s-new", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } });
  const firstUserMessage = async (prompt: unknown): Promise<string> => {
    if (typeof prompt === "string") return prompt;
    const it = (prompt as AsyncIterable<{ message: { content: string } }>)[Symbol.asyncIterator]();
    return (await it.next()).value?.message?.content ?? "";
  };

  // ⑧ /stop 뒤 SDK 가 조용히 끝난다 — 부분 텍스트가 성공으로 나가면 안 된다.
  {
    const ac = new AbortController();
    const fake = ((args: { options: { abortController: AbortController } }) => {
      const sig = args.options.abortController.signal;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
        yield say("작업을 시작합니다. 첫째로");
        setTimeout(() => ac.abort(new UserCancelledError()), 20);
        await new Promise((r) => sig.addEventListener("abort", r, { once: true }));
      })();
    }) as never;
    let got: string;
    try {
      const o = await within(10_000, "claude stop", withFakeClaudeQuery(fake, () => runClaude({ text: "해줘", threadKey: "regr:afh-stop", channel: "cli", abortSignal: ac.signal } as never)));
      got = "timedOut" in o ? o.timedOut : `returned:${(o.value as { text: string }).text}`;
    } catch (e) {
      got = `threw:${(e as Error).name}`;
    }
    out.push(assert("★⑧ claude: /stop 뒤 SDK 가 조용히 끝나도 **취소로 올라간다**(부분 텍스트가 성공 답이 되지 않는다)", got === "threw:UserCancelledError", got));
  }

  // ⑥ resume 실패 → fresh 재시도가 **스티어링 턴에서도** 기록을 싣는다.
  for (const steer of [false, true]) {
    const T = `regr:afh-resume-${steer ? "steer" : "plain"}`;
    saveSession({ channel: "cli", threadKey: T, claudeSessionId: `sess-old-${steer}`, model: null, systemPromptHash: SYSTEM_PROMPT_HASH });
    appendTranscript({ claudeSessionId: `sess-old-${steer}`, role: "user", content: "내 프로젝트 암호명은 ZEBRA-42 입니다" });
    appendTranscript({ claudeSessionId: `sess-old-${steer}`, role: "assistant", content: "기억하겠습니다" });
    indexCodexTurn({ channel: "cli", threadKey: T, claudeSessionId: `sess-old-${steer}` });
    let calls = 0;
    let retryPrompt = "";
    const fake = ((args: { prompt: unknown }) => {
      calls += 1;
      const n = calls;
      return (async function* () {
        if (n === 1) throw new Error(`No conversation found with session ID: sess-old-${steer}`);
        retryPrompt = await firstUserMessage(args.prompt);
        yield { type: "system", subtype: "init", session_id: "s-new", model: "claude-fake" };
        yield say("답");
        yield result("답");
      })();
    }) as never;
    const steering = steer ? createSteeringChannel() : undefined;
    try {
      await within(10_000, "claude resume", withFakeClaudeQuery(fake, () => runClaude({ text: "암호명이 뭐였지?", threadKey: T, channel: "cli", ...(steering ? { steering } : {}) } as never)));
    } catch {
      /* 아래 단언이 말한다 */
    } finally {
      steering?.close();
    }
    out.push(
      assert(
        `${steer ? "★⑥" : "⑥ 대조군"} claude: resume 이 죽어 새로 시작할 때 기록을 다시 싣는다 — ${steer ? "스티어링 턴(기본 켜짐)" : "스티어링 없는 턴"}`,
        calls === 2 && retryPrompt.includes("ZEBRA-42"),
        `호출=${calls} · 재시도 첫 메시지에 기록=${retryPrompt.includes("ZEBRA-42")} (${retryPrompt.length}자)`,
      ),
    );
  }

  // ⑤ claude: SDK 에 넘긴 끼워넣기가 있는 채로 턴이 실패하면 채널에 돌아온다.
  {
    const steering = createSteeringChannel();
    steering.push({ text: "[끼워넣기] 그것도 해줘", raw: "그것도 해줘", ts: Date.now() });
    let pulled = 0;
    const fake = ((args: { prompt: unknown }) =>
      (async function* () {
        const it = (args.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await it.next(); // 초기 메시지
        await it.next(); // 끼워넣기 — SDK 가 가져갔다
        pulled += 1;
        yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
        throw new Error("claude-agent-sdk error: API Error: 500 internal");
      })()) as never;
    let threw = false;
    try {
      await within(10_000, "claude steer fail", withFakeClaudeQuery(fake, () => runClaude({ text: "해줘", threadKey: "regr:afh-steerfail", channel: "cli", steering } as never)));
    } catch {
      threw = true;
    }
    const left = steering.drain().map((s) => s.raw);
    steering.close();
    out.push(assert("★⑤ claude: 넘긴 끼워넣기가 있는 채로 턴이 실패하면 **채널에 돌아온다**(코어가 새 턴으로 태운다)", threw && pulled === 1 && left.length === 1 && left[0] === "그것도 해줘", `실패=${threw} · SDK 가 가져감=${pulled} · 채널에 남음=${show(left)}`));
  }

  // ⑤' 실행기가 그 끼워넣기를 **시작**한 뒤 오류 result 로 끝난다 — 어댑터가 result 에서 채널을 닫는 제품 순서다(한도 «hit your
  //  limit» 이 이 길). 종전엔 닫힌 채널이라 되돌릴 곳이 없어 사라졌다(2026-10-11 릴리스 검토 F1).
  // ⑤'' SDK 가 실패 뒤에도 입력을 계속 당긴다(실제 streamInput) — 되돌린 것을 죽은 시도가 다시 꺼내 가면 안 된다(F2).
  for (const mode of ["startedThenError", "throwKeepPulling"] as const) {
    const steering = createSteeringChannel();
    steering.push({ text: "[끼워넣기] 그것도 해줘", raw: "그것도 해줘", ts: Date.now() });
    const deadPulled: string[] = [];
    const fake = ((args: { prompt: unknown }) =>
      (async function* () {
        const it = (args.prompt as AsyncIterable<{ uuid?: string; message?: { content?: unknown } }>)[Symbol.asyncIterator]();
        await it.next();
        const second = await it.next();
        yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
        if (mode === "startedThenError") {
          yield { type: "command_lifecycle", command_uuid: second.value?.uuid, state: "started" };
          yield { type: "result", subtype: "success", is_error: true, result: "API Error: 500 internal server error", num_turns: 1, session_id: "s", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        void (async () => {
          for (;;) {
            const r = await it.next();
            if (r.done === true) break;
            deadPulled.push(String(r.value?.message?.content));
          }
        })();
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("claude-agent-sdk error: API Error: 500 internal");
      })()) as never;
    try {
      await within(10_000, `claude steer ${mode}`, withFakeClaudeQuery(fake, () => runClaude({ text: "해줘", threadKey: `regr:afh-steer-${mode}`, channel: "cli", steering } as never)));
    } catch {
      /* 아래 단언이 말한다 */
    }
    await new Promise((r) => setTimeout(r, 30));
    const left = steering.drain().map((s) => s.raw);
    steering.close();
    out.push(
      assert(
        mode === "startedThenError"
          ? "★⑤' claude: 실행기가 시작한 끼워넣기가 오류 result 로 끝나도(어댑터가 채널을 이미 닫은 순서) 채널에 돌아온다"
          : "★⑤'' claude: 실패 뒤에도 입력을 당기는 SDK 가 되돌린 끼워넣기를 다시 꺼내 가지 않는다",
        show(left) === '["그것도 해줘"]' && deadPulled.length === 0,
        { 채널에남음: left, 죽은시도가꺼냄: deadPulled },
      ),
    );
  }
  return out;
};

const openAiChecks = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const { Agent, run, tool } = await import("@openai/agents");
  const { z } = await import("zod");
  const { openAiTurnRunOptions } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
  // 도구를 14번 부르고 15번째에 답하는 가짜 모델 — 실제 SDK 런루프를 그대로 탄다(네트워크 0).
  const drive = async (opts: Record<string, unknown>): Promise<string> => {
    let calls = 0;
    const model = {
      getResponse: async () => {
        throw new Error("스트림만 쓴다");
      },
      async *getStreamedResponse() {
        calls += 1;
        const output =
          calls < 15
            ? [{ type: "function_call", id: `fc${calls}`, callId: `c${calls}`, name: "noop", arguments: "{}", status: "completed" }]
            : [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "끝" }] }];
        yield { type: "response_started" };
        yield { type: "response_done", response: { id: `r${calls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output } };
      },
    };
    const noop = tool({ name: "noop", description: "아무것도 안 한다", parameters: z.object({}), execute: async () => "ok" });
    const agent = new Agent({ name: "regr", instructions: "x", model: model as never, tools: [noop] });
    try {
      const s = await run(agent, "go", opts as never);
      for await (const _ev of s as unknown as AsyncIterable<unknown>) {
        /* 소비 */
      }
      await (s as unknown as { completed: Promise<void> }).completed;
      return `ok calls=${calls} out=${String((s as { finalOutput?: unknown }).finalOutput)}`;
    } catch (e) {
      return `threw ${(e as Error).name} calls=${calls}`;
    }
  };
  const ac = new AbortController();
  const ours = await drive({ ...openAiTurnRunOptions(ac.signal) });
  const sdkDefault = await drive({ stream: true, signal: ac.signal });
  out.push(assert("대조군 — SDK 기본(maxTurns 미지정)은 도구 15회 턴을 죽인다(이 검사가 이빨이 있다)", sdkDefault.startsWith("threw MaxTurnsExceededError"), sdkDefault));
  out.push(assert("★③ openai: 어댑터의 본 턴 실행 옵션으로는 도구 15회 턴이 **끝까지 간다**(codex 누적 백스톱과 같은 상한)", ours === "ok calls=15 out=끝", ours));
  const src = (await readFile(path.join(HERE, "../../core/llm-runtime/adapters/openai-agents-sdk.ts"), "utf8")).replace(/\/\/[^\n]*/g, "");
  out.push(
    assert(
      "[린트] openai 본 턴 run() 이 그 옵션을 쓰고, 실패하면 장부로 끼워넣기를 되돌린다",
      /run\(agentToRun, runInput, \{\s*\.\.\.openAiTurnRunOptions\(effectiveAc\.signal\),/.test(src) &&
        /drain: \(\) => steeringLedger\.drain\(\)/.test(src) &&
        /const n = steeringLedger\.giveBack\(\);[\s\S]{0,200}?throw e;/.test(src),
      "run 옵션·장부 drain·실패 시 giveBack",
    ),
  );
  return out;
};

const ledgerChecks = async (): Promise<Assertion[]> => {
  const { createSteeringLedger } = await import("../../core/llm-runtime/adapters/_steering-ledger.js");
  const { createSteeringChannel } = await import("../../core/steering.js");
  const ch = createSteeringChannel();
  ch.push({ text: "a", raw: "a", ts: 1 });
  const led = createSteeringLedger(ch);
  const took = led.drain().length;
  led.note({ text: "b", raw: "b", ts: 2 });
  const back = led.giveBack();
  const again = led.giveBack(); // 두 번 되돌리지 않는다
  const inCh = ch.drain().map((s) => s.raw);
  // 닫힌 채널에도 되돌린다 — «닫힘» 은 /stop 만이 아니다(claude 는 result 에서 닫는다). /stop 판정은 턴 출구 한 곳이다(아래).
  const { endTurn } = await import("../../core/entry/turn-lifecycle.js");
  const { UserCancelledError } = await import("../../core/steering.js");
  const exitWith = (stop: boolean): { back: number; reinjected: number } => {
    const c = createSteeringChannel();
    c.push({ text: "c", raw: "c", ts: 3 });
    const l = createSteeringLedger(c);
    l.drain();
    const ac = new AbortController();
    if (stop) ac.abort(new UserCancelledError());
    c.close(); // /stop 의 closeWhenStopped · claude 의 result 닫기
    const back = l.giveBack();
    let reinjected = 0;
    endTurn({ msg: { threadKey: "regr:afh-exit", channel: "cli", text: "x" } as never, entry: 1, inflight: new Map(), steering: c, steeringChannels: new Map(), signal: ac.signal, reinject: () => { reinjected += 1; } });
    return { back, reinjected };
  };
  const exitStop = exitWith(true);
  const exitFail = exitWith(false);
  // 되돌릴 수 없는 도구가 이미 돈 턴 — 끼워넣기를 되돌리면 새 턴이 같은 일을 또 한다(2026-10-09 재검토 P4).
  const { createReplayGuard, markToolDispatch } = await import("../../core/llm-runtime/replay-safety.js");
  const guard = createReplayGuard();
  const ch3 = createSteeringChannel();
  ch3.push({ text: "메모 남겨줘", raw: "메모 남겨줘", ts: 4 });
  const led3 = createSteeringLedger(ch3, guard);
  led3.drain();
  markToolDispatch(guard, "add_memory", false);
  const backAfterSideEffect = led3.giveBack();
  const leftover = ch3.drain().map((s) => s.raw);
  // 읽기 도구만 돈 턴은 종전대로 되돌린다(대조)
  const guardRead = createReplayGuard();
  const ch4 = createSteeringChannel();
  ch4.push({ text: "d", raw: "d", ts: 5 });
  const led4 = createSteeringLedger(ch4, guardRead);
  led4.drain();
  markToolDispatch(guardRead, "Read", true);
  const backReadOnly = led4.giveBack();
  // 부작용이 끝난 **뒤에** 받은 것은 되돌린다 — 그건 아무 일도 일으키지 않았다(2026-10-10 재검토: 턴 단위로 전부 버렸다)
  const guardMix = createReplayGuard();
  const ch5 = createSteeringChannel();
  ch5.push({ text: "메모 남겨줘", raw: "메모 남겨줘", ts: 6 });
  const led5 = createSteeringLedger(ch5, guardMix);
  led5.drain();
  markToolDispatch(guardMix, "add_memory", false);
  ch5.push({ text: "파일명도 알려줘", raw: "파일명도 알려줘", ts: 7 });
  led5.drain();
  const backMix = led5.giveBack();
  const leftMix = ch5.drain().map((s) => s.raw);
  // 부작용 뒤에 받은 것이 **두 번째 부작용**을 불렀으면 그것도 버린다 — 횟수로 보지 않으면 되돌려 같은 일을 또 한다(재검토 G2)
  const guard6 = createReplayGuard();
  const ch6 = createSteeringChannel();
  const led6 = createSteeringLedger(ch6, guard6);
  ch6.push({ text: "m1", raw: "m1", ts: 8 });
  led6.drain();
  markToolDispatch(guard6, "add_memory", false);
  ch6.push({ text: "m2", raw: "m2", ts: 9 });
  led6.drain();
  markToolDispatch(guard6, "Write", false);
  const backSecond = led6.giveBack();
  // claude 경로(note — SDK 입력 스트림이 꺼내 간 것)도 같은 판정(재검토 G3)
  const guard7 = createReplayGuard();
  const ch7 = createSteeringChannel();
  const led7 = createSteeringLedger(ch7, guard7);
  led7.note({ text: "n1", raw: "n1", ts: 10 });
  markToolDispatch(guard7, "add_memory", false);
  led7.note({ text: "n2", raw: "n2", ts: 11 });
  const backNote = led7.giveBack();
  const leftNote = ch7.drain().map((s) => s.raw);
  // 되돌린 것은 아직 안 꺼낸 대기분 **앞**에 선다 — 도착 순서(A 다음 정정 B)가 뒤집히지 않는다(2026-10-10 아스트라 검토: B, A 로 뒤집혔다)
  const ch8 = createSteeringChannel();
  const led8 = createSteeringLedger(ch8, createReplayGuard());
  ch8.push({ text: "A", raw: "빨간색으로 바꿔 주세요", ts: 12 });
  led8.drain();
  ch8.push({ text: "B", raw: "정정합니다. 파란색으로 바꿔 주세요", ts: 13 });
  const back8 = led8.giveBack();
  const order8 = ch8.drain().map((s) => s.text);
  const ch9 = createSteeringChannel();
  const led9 = createSteeringLedger(ch9, createReplayGuard());
  led9.note({ text: "N1", raw: "N1", ts: 14 });
  ch9.push({ text: "N2", raw: "N2", ts: 15 });
  led9.giveBack();
  const order9 = ch9.drain().map((s) => s.text);
  return [
    assert(
      "★⑤ 장부: 되돌린 것은 아직 안 꺼낸 대기분 앞에 선다 — 도착 순서 유지(drain·note 둘 다)",
      back8 === 1 && show(order8) === '["A","B"]' && show(order9) === '["N1","N2"]',
      { 되돌림: back8, drain경로: order8, note경로: order9 },
    ),
    assert(
      "★⑤ 장부: 받은 뒤 두 번째 부작용이 있었던 것도 버린다 · claude(note) 경로도 메시지 단위로 같다",
      backSecond === 0 && backNote === 1 && show(leftNote) === '["n2"]',
      { 두번째부작용뒤: backSecond, note되돌림: backNote, 채널: leftNote },
    ),
    assert(
      "★⑤ 장부: 부작용 **뒤에** 받은 끼워넣기는 되돌리고, 받은 뒤 부작용이 있었던 것만 버린다",
      backMix === 1 && show(leftMix) === '["파일명도 알려줘"]',
      { 되돌림: backMix, 채널: leftMix },
    ),
    assert(
      "★⑤ 장부: 되돌릴 수 없는 도구가 이미 돈 턴의 끼워넣기는 되돌리지 않는다(새 턴이 같은 일을 또 하게 된다) — 읽기만 돈 턴은 되돌린다",
      backAfterSideEffect === 0 && leftover.length === 0 && backReadOnly === 1,
      { 부작용뒤되돌림: backAfterSideEffect, 채널잔여: leftover, 읽기만되돌림: backReadOnly },
    ),
    assert("⑤ 장부: 꺼낸 것·넘긴 것을 **한 번만** 채널에 되돌린다", took === 1 && back === 2 && again === 0 && show(inCh) === '["a","b"]', `꺼냄=${took} 되돌림=${back} 재호출=${again} 채널=${show(inCh)}`),
    assert(
      "★⑤ 장부: 닫힌 채널에도 되돌리고 턴 출구가 판정한다 — 실패면 새 턴으로 다시 태우고, /stop 이면 되살리지 않는다",
      exitFail.back === 1 && exitFail.reinjected === 1 && exitStop.reinjected === 0,
      { 실패: exitFail, 중단: exitStop },
    ),
  ];
};

export const check: RegressionCheck = {
  name: "adapter-failure-honesty",
  guards:
    "토큰 갱신 경합의 가짜 인증 쿨다운 · 도구 뒤 429/401 을 성공으로 삼킴 · openai 도구 10회 사망 · 과부하로 잘린 답의 성공 확정 · 실패 턴의 끼워넣기 증발 · claude resume 재시도의 기록 누락 · 턴 누적 재전송 예산 · /stop 뒤 부분 텍스트 성공 · 입력 상한·토큰 수명주기 그물 0",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ── ① 토큰 수명주기 ─────────────────────────────────────────────────────────
    const race = await child("refresh-race");
    out.push(assert("★① codex: 만료 시 동시 3건이 갱신을 **한 번만** POST 하고 셋 다 새 토큰을 받는다(회전 토큰 재사용 → 가짜 인증 거부 0)", race.posts === 1 && show(race.results) === '["new-access-1","new-access-1","new-access-1"]' && race.envRefresh === "rt-2", show(race)));
    const soon = await child("refresh-soon");
    const fresh = await child("refresh-fresh");
    out.push(assert("① codex: 만료 **임박**(5분 안)이면 미리 갱신하고, 넉넉하면 POST 0", soon.posts === 1 && show(soon.results) === '["new-access-1"]' && fresh.posts === 0 && show(fresh.results) === '["old-access"]', `임박=${show(soon)} · 넉넉=${show(fresh)}`));
    const elsewhere = await child("refresh-reused-elsewhere");
    out.push(assert("① codex: 다른 프로세스가 먼저 갱신했으면(`refresh_token_reused`) 홈 .env 를 다시 읽어 그 토큰을 쓴다", elsewhere.posts === 1 && elsewhere.result === "other-access", show(elsewhere)));

    // ── codex 본 턴 ─────────────────────────────────────────────────────────────
    const pf = await child("partial-fail-then-ok");
    // ★글이 이미 흘러간 뒤의 생성 실패는 재전송하지 않는다(2026-10-09 수정분 재검토) — 다시 보내면 스트림에 «잘린 앞부분 + 새 전체» 가
    //  이어붙는다. 잘린 문장을 성공으로 확정하지도 않는다 → 정직한 실패(요청 1회).
    out.push(assert("★④ codex: 답을 쓰던 도중 과부하면 잘린 문장을 **성공으로 확정하지 않고**, 이미 흘린 글 위에 다시 쓰지도 않는다(실패로 올림 · 요청 1회)", pf.outcome === "threw" && pf.calls === 1 && !String(pf.text).startsWith("결론부터"), show(pf)));
    // ★재전송 가능 여부와 안내는 다른 질문이다(2026-10-10 재검토) — 화면에 안 흘리는 턴은 글이 있어도 재전송하고,
    //  흘린 뒤라 재전송 못 하는 과부하에도 안내는 «잠시 후 다시» 다(종전엔 둘이 한 값이라 «요청을 바꿔서» 를 권했다).
    const pm = await child("partial-fail-manager");
    out.push(assert("★④ codex: 글을 화면에 흘리지 않는 턴(매니저)은 도중 과부하를 같은 요청으로 재전송해 온전한 답을 받는다", pm.outcome === "returned" && pm.text === "온전한 답입니다." && pm.calls === 2, show(pm)));
    const se = await child("side-effect-then-partial-fail");
    out.push(assert("★④ codex: 흘린 뒤라 재전송 못 한 과부하도 안내는 «잠시 후 다시» 다(«요청을 바꿔서» 아님)", se.outcome === "returned" && String(se.text).includes("try again in a moment") && !String(se.text).includes("change the request") && se.calls === 2, show(se)));
    // ★서버가 응답 도중 끊으면(`terminated` ← `other side closed`) 사용자 손 없이 복구한다(2026-10-10 정태님 — 맥·윈도우 돌쇠 하루 1~4건).
    const cb = await child("cut-before-output");
    out.push(assert("★⑩ codex: 첫 출력 전에 끊기면 같은 요청을 그대로 다시 보내 답을 받는다", cb.outcome === "returned" && cb.text === "온전한 답입니다." && cb.calls === 2 && cb.sameBody === true, show(cb)));
    const ct = await child("cut-mid-text");
    out.push(assert("★⑩ codex: 글을 쓰던 중 끊기면 흘린 글을 붙여 이어 쓰게 하고, 최종 답은 앞 + 이어 쓴 것", ct.outcome === "returned" && ct.text === "결론부터 말씀드리면, 첫째는 A 입니다." && ct.calls === 2 && ct.carriesPartial === true, show(ct)));
    const ctool = await child("cut-mid-tool");
    out.push(assert("★⑩ codex: 도구 호출이 담긴 응답이 끊기면 그 호출은 실행하지 않고 다시 묻는다(부작용 한 번)", ctool.outcome === "returned" && ctool.text === "완료" && ctool.calls === 3 && ctool.secondHasNoOutput === true && ctool.thirdOutputs === 1, show(ctool)));
    const ce = await child("cut-after-external-tool-delta");
    out.push(assert("⑩ codex: 게이트웨이 외부 도구 호출 조각이 이미 흘렀으면 복구하지 않는다(반쪽 호출 뒤 새 호출 X)", ce.outcome === "threw" && ce.calls === 1, show(ce)));
    const c2 = await child("cut-twice");
    out.push(assert("★⑩ codex: 두 번 연달아 끊겨도 앞글이 다 남고(1·2·3) 이어 쓰기 입력에 한 번씩만 실린다", c2.outcome === "returned" && c2.text === "ALPHA1 BRAVO2 CHARLIE3" && c2.calls === 3 && c2.gaInThird === 1 && c2.naInThird === 1, show(c2)));
    const c3 = await child("cut-then-tool");
    out.push(assert("⑩ codex: 이어 쓴 응답에 도구가 있으면 다음 요청 입력에 앞글이 한 번만(이어 쓴 글만 이력에 더한다)", c3.outcome === "returned" && c3.calls === 3 && c3.partialInThird === 1, show(c3)));
    const c4 = await child("cut-then-fetch-fail");
    out.push(assert("★⑩ codex: 끊김 뒤 연결 단계 실패가 이어지면 앞 시도의 글을 다시 붙이지 않는다(최종 답·입력에 앞글 중복 X)", !String(c4.text).includes("앞글 앞글") && Number(c4.partialInLast) <= 1, show(c4)));
    const c5 = await child("cut-exhausted-after-side-effect");
    out.push(assert("★⑩ codex: 부작용 뒤 끊김이 소진되면 안내는 흘린 글 전부를 싣고, 붙였던 부분 글은 이력 항목에 안 남는다", c5.outcome === "returned" && String(c5.text).includes("부분보고 이어서 또") && c5.partialItems === 0, show(c5)));
    const c6 = await child("overload-after-external-tool-delta");
    out.push(assert("⑩ codex: 게이트웨이 외부 도구 조각이 나간 뒤 과부하면 재전송하지 않는다(끊김과 같은 규칙)", c6.outcome === "threw" && c6.calls === 1, show(c6)));
    {
      // 판정 함수 단위 — 조건 하나를 빼도 다른 조건이 덮어 통과하던 갭(재검토 M12)
      const { isCodexStreamCut } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
      const err = (msg: string, cause?: unknown, name = "TypeError"): Error => Object.assign(new Error(msg, cause === undefined ? undefined : { cause }), { name });
      const code = (c: string): Error => Object.assign(new Error(c), { code: c });
      const cases: Array<[string, unknown, boolean]> = [
        ["terminated ← other side closed", err("terminated", Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" })), true],
        ["terminated(원인 없음)", err("terminated"), true],
        ["ECONNRESET 직접", code("ECONNRESET"), true],
        ["terminated ← 본문 시한(우리 쪽 무진전 몫)", err("terminated", code("UND_ERR_BODY_TIMEOUT")), false],
        ["다른 TypeError", err("x is not a function"), false],
        ["AbortError", err("aborted", undefined, "AbortError"), false],
      ];
      const wrong = cases.filter(([, e, want]) => isCodexStreamCut(e) !== want).map(([n]) => n);
      out.push(assert("⑩ 끊김 판정: 서버 끊김 모양만 참 · 본문 시한·다른 오류·중단은 거짓", wrong.length === 0, wrong.length === 0 ? `${cases.length}건 맞음` : { 틀림: wrong }));
    }
    const cd = (await child("cut-density")) as Record<string, { outcome: string; recorded: number | null; lastBody: number; firstBody: number }>;
    const densityOk = ["once", "twice", "nopartial"].every((k) => cd[k]?.outcome === "returned" && cd[k]?.recorded === cd[k]?.lastBody);
    out.push(
      assert(
        "★⑩ codex: 끊김 뒤 재전송·이어 쓰기(1회·2회·글 없음) 모두 토큰 밀도의 글자 수 = 실제로 보낸 마지막 본문 길이",
        densityOk && cd.once!.lastBody > cd.once!.firstBody,
        cd,
      ),
    );
    const cx = await child("cut-exhausted");
    out.push(assert("⑩ codex: 계속 끊기면 정해진 횟수(2)만 복구를 시도하고 실패로 올린다(무한 재시도 0)", cx.outcome === "threw" && cx.calls === 3 && /terminated/.test(String(cx.text)), show(cx)));
    const inc = await child("partial-incomplete");
    out.push(assert("④ 대조군: 출력 상한(`response.incomplete`)은 받은 부분을 쓴다(요약 경로와 같은 규칙)", inc.outcome === "returned" && inc.text === "상한까지 쓴 부분 답" && inc.calls === 1, show(inc)));
    const spaced = await child("spaced-overload", 90_000);
    out.push(assert("★⑦ codex: 재전송 예산은 **요청 단위** — 요청마다 한 번씩 과부하가 와도 도구 5회 턴이 끝까지 간다", spaced.outcome === "returned" && spaced.text === "완료" && spaced.calls === 12, show(spaced)));
    const st = await child("steer-then-fail");
    out.push(assert("★⑤ codex: 끼워넣기를 요청에 실은 뒤 턴이 실패하면 **채널에 돌아온다**", st.outcome === "threw" && st.sentInBody === true && show(st.leftover) === '["파일명도 알려줘"]', show(st)));
    const cap = await child("input-cap");
    out.push(assert("★⑨ codex: iteration 0 의 조립 입력이 상한을 넘으면 **보내지 않고** 던진다(다음 후보로 즉시)", cap.outcome === "threw" && cap.calls === 0 && /over the 200-char limit/.test(String(cap.text)), show(cap)));
    const red = await child("swallow-redacts");
    out.push(assert("② codex: 부작용 뒤 일반 실패는 부분 보고를 지키되 답장의 백엔드 원문 비밀은 가린다", red.outcome === "returned" && red.leaked === false && red.redacted === true, show(red)));

    // ── ② facade 경유 — 도구 뒤 계정 축 실패 ────────────────────────────────────
    for (const sc of ["facade-429", "facade-401"] as const) {
      const f = await child(sc);
      out.push(
        assert(
          `★② codex(${sc.slice(7)}): 도구 실행 뒤 ${sc === "facade-429" ? "사용량 한도" : "인증 거부"}는 삼키지 않는다 — turn_error·쿨다운 등록·재실행 차단 사유`,
          f.outcome === "threw" &&
            show(f.events) === '["llm.turn_error"]' &&
            Array.isArray(f.cooldowns) && (f.cooldowns as unknown[]).length === 1 &&
            /had already started running/.test(String(f.text)),
          show(f),
        ),
      );
    }

    out.push(...(await ledgerChecks()));
    // claude 는 인증 키가 있어야 SDK 를 부른다 — 가짜 키를 이 검사 동안만 둔다(다른 claude 실행 검사와 같은 방식).
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "regression-fake-key";
    try {
      out.push(...(await claudeChecks()));
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
    out.push(...(await openAiChecks()));
    return out;
  },
};
