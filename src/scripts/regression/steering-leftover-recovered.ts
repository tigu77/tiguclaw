/**
 * 회귀: **턴 끝에 끼어든 메시지는 답을 받거나 다음 턴으로 넘어간다 — 증발하지 않는다.**
 *
 * 사고 (2026-08-11, 회사돌쇠): 비서가 마지막 답을 쓰는 중에 보낸 메시지에 **반응이 영영
 *  없었다**. 대기중 표시도, 다음 턴도 없었다.
 *
 * 근본은 **소비 방식이 어댑터마다 다른데 코어가 한쪽만 가정한 것**이다:
 *   - codex·openai … `drain()` 으로 당겨 쓴다 → 안 쓴 것은 buffer 에 **남는다**
 *   - claude ……… `stream()` 이 도착 즉시 **꺼내간다** → buffer 에 **안 남는다**
 *  코어(index.ts)의 재주입은 "턴 끝에 buffer 에 남아 있으면 회수"(`drain()`)이고 그 주석은
 *  손실 0 을 단언했는데, 그 단언은 **claude 에서 거짓**이었다. 마지막 model-call 이후에 온
 *  메시지는 ①stream 이 꺼내 SDK stdin 으로 넣고 ②SDK 가 새 턴을 열고(`system/init`)
 *  ③턴 경계 가드가 그 턴의 답을 버리고 ④`drain()` 이 빈 배열이라 재주입도 안 됐다.
 *
 * ★2026-08-06 주석이 이 결말을 예고해 뒀다 — "버리되 조용히 버리지 않는다 … **대응은 후속
 *  결정**". 미뤄둔 그 결정이 5일 뒤에 사용자 메시지 유실로 돌아왔다. 그때 그물을 안 건 것이
 *  아니라 **그물을 걸 자리를 후속으로 미룬 것**이다.
 *
 * 고침은 보정을 얹지 않는다 — **코어의 전제를 참으로 만든다**: 첫 result 이후 stream 이
 *  받은 입력은 소비하지 않고 `push` 로 **되돌려 놓고** 제너레이터를 끝낸다. 그러면 기존
 *  `drain()`→재주입 경로가 그대로 회수한다(새 복구 경로 0개).
 *
 * ★검사 등급 — ①~④는 **행동**(채널과 어댑터 판정을 실제로 돌린다), ⑤만 배선 린트다.
 *  초안에선 ④도 소스 대조였는데 그런 검사는 `if (false && …)` 하나로 통과한다. 그래서
 *  판정을 어댑터 함수 안 클로저에서 **모듈 스코프 제너레이터**(`steeringContents`)로 뽑아
 *  실행한다 — 검사가 껄끄러웠던 건 코드가 잘못 놓여 있다는 진술이었다(원칙 게이트 Q7).
 */
import { createSteeringChannel, type SteeringInput } from "../../core/steering.js";
import { steeringContents } from "../../core/llm-runtime/adapters/claude-agent-sdk.js";
import { sourceOrder } from "./_wiring.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const ADAPTER = "../../core/llm-runtime/adapters/claude-agent-sdk.ts";

const input = (raw: string): SteeringInput => ({
  raw,
  text: `[사용자 개입] ${raw}`,
  ts: 1_700_000_000_000, // 고정값 — 검사는 결정적이어야 한다.
});

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 버그의 전제 — stream 이 소비하면 drain 은 빈다 ──────────────────────
  //  이게 거짓이 되면(예: stream 이 peek 로 바뀌면) 고침 자체가 무의미해진다. 전제를
  //  검사에 박아 둬야 다음 사람이 "왜 되돌려놓지?" 를 묻지 않는다.
  {
    const ch = createSteeringChannel();
    const ac = new AbortController();
    const it = ch.stream(ac.signal);
    ch.push(input("끼어든 말"));
    const first = await it.next();
    const leftover = ch.drain();
    out.push({
      name: "★stream 이 꺼내가면 buffer 엔 안 남는다(코어 drain 전제가 깨지는 지점)",
      ok: first.done === false && leftover.length === 0,
      got: `stream 수신=${first.done === false} · drain=${leftover.length}건 (기대 수신 · 0건)`,
    });
    ac.abort();
  }

  // ── ② 고침이 기대는 성질 — 되돌려 놓으면 drain 이 회수한다 ────────────────
  {
    const ch = createSteeringChannel();
    const ac = new AbortController();
    const it = ch.stream(ac.signal);
    const msg = input("이거 마저 봐줘");
    ch.push(msg);
    const got = await it.next();
    const taken = got.value as ReturnType<typeof input>;
    const requeued = ch.push(taken); // ← 어댑터가 첫 result 이후에 하는 일.
    void it.return(undefined); // 제너레이터 종료 = stdin close.
    const recovered = ch.drain();
    out.push({
      name: "★소비한 입력을 되돌려 놓으면 turn 끝 drain 이 회수한다(재주입 경로 성립)",
      ok:
        requeued === true &&
        recovered.length === 1 &&
        recovered[0]?.raw === "이거 마저 봐줘",
      got: `push=${requeued} · drain=${recovered.length}건 raw=${JSON.stringify(recovered[0]?.raw ?? null)}`,
    });
    ac.abort();
  }

  // ── ③ 경합 경로 — close 뒤엔 push=false → 코어가 새 턴으로 넘긴다 ─────────
  //  되돌려놓기가 close 와 경합해도 **양쪽 어디로도** 회수돼야 한다(손실 0).
  {
    const ch = createSteeringChannel();
    ch.close();
    out.push({
      name: "close 후 되돌려놓기는 false — 호출자가 새 턴으로 흘린다(손실 0 유지)",
      ok: ch.push(input("경합")) === false && ch.drain().length === 0,
      got: `push=${ch.push(input("경합"))} · drain=${ch.drain().length}건 (기대 false / 0건)`,
    });
  }

  // ── ④ ★어댑터의 실제 판정을 **실행**한다 ─────────────────────────────────
  //  종전 초안은 여기서 소스를 대조했는데, 그런 검사는 `if (false && …)` 하나로 통과한다.
  //  그래서 판정을 모듈 스코프 제너레이터로 뽑아 돌린다 — 아래는 실제로 도는 코드다.
  {
    // 턴이 **안** 끝났을 때: 정상 소비 → 렌더된 내용이 SDK 로 간다.
    const live = createSteeringChannel();
    const ac1 = new AbortController();
    const it1 = steeringContents({
      steering: live,
      signal: ac1.signal,
      turnEnded: () => false,
      render: (s) => `<<${s.raw}>>`,
    });
    live.push(input("진행 중 개입"));
    const yielded = await it1.next();
    out.push({
      name: "턴이 도는 중엔 그대로 소비된다(mid-turn steering 회귀 0)",
      ok: yielded.value === "<<진행 중 개입>>",
      got: `yield=${JSON.stringify(yielded.value ?? null)} (기대 "<<진행 중 개입>>")`,
    });
    void it1.return(undefined);
    ac1.abort();

    // ★턴이 끝난 뒤: yield 하지 않고 되돌려 놓고 제너레이터가 끝나야 한다.
    const ended = createSteeringChannel();
    const ac2 = new AbortController();
    let reported: { chars: number; requeued: boolean } | undefined;
    const it2 = steeringContents({
      steering: ended,
      signal: ac2.signal,
      turnEnded: () => true,
      render: (s) => `<<${s.raw}>>`,
      onReturned: (s, requeued) => {
        reported = { chars: s.raw?.length ?? 0, requeued };
      },
    });
    ended.push(input("답 쓰는 중에 보낸 말"));
    const after = await it2.next();
    const recovered = ended.drain();
    out.push({
      name: "★첫 result 이후 도착분은 SDK 로 안 가고 제너레이터가 끝난다(답 2개 발산 0)",
      ok: after.done === true && after.value === undefined,
      got: `done=${after.done} value=${JSON.stringify(after.value ?? null)} (기대 done=true)`,
    });
    out.push({
      name: "★그리고 buffer 로 돌아와 있다 — 코어 drain() 이 회수해 다음 턴이 된다",
      ok:
        recovered.length === 1 && recovered[0]?.raw === "답 쓰는 중에 보낸 말",
      got: `drain=${recovered.length}건 raw=${JSON.stringify(recovered[0]?.raw ?? null)} (기대 1건)`,
    });
    out.push({
      name: "조용히 넘기지 않는다 — 판정 수치와 함께 보고한다",
      ok: reported?.requeued === true && reported.chars === 12,
      got: `보고=${JSON.stringify(reported ?? null)} (기대 requeued=true chars=12)`,
    });
    ac2.abort();
  }

  // ── ⑤ 배선 — 선언 순서(TDZ 를 SDK 내부 동작 가정에 안 맡긴다) ────────────
  {
    const order = await sourceOrder(ADAPTER, [
      /let turnResultSeen = false;/,
      /const buildSteeringPrompt =/,
    ]);
    out.push({
      name: "turnResultSeen 선언이 steering 제너레이터보다 먼저다(TDZ 를 가정에 안 맡김)",
      ok: order.ok,
      got: order.detail,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "steering-leftover-recovered",
  guards:
    "턴의 마지막 model-call 이후 도착한 사용자 메시지를 claude 의 stream() 이 꺼내가 SDK 새 턴으로 넣고, 턴 경계 가드가 그 답을 버리고, drain() 은 빈 배열이라 재주입도 안 돼 메시지가 통째로 증발하던 것",
  run,
};
