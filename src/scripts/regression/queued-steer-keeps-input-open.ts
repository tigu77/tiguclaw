/**
 * 회귀: **실행기에 줄 선 입력이 남아 있으면 첫 result 에서 입력을 닫지 않는다** (2026-09-30).
 *
 * ★사고(회사돌쇠 09-29·09-30 3건): 매니저 완료 보고를 쓰는 중에 사진이 들어와 실행기 큐에 섰다. 첫 result 에서
 *  어댑터가 stdin 을 닫았고, 실행기가 줄 선 턴에서 `Read` 를 부르자 5~9ms 만에 `toolDenialKind=cancelled`
 *  («The user doesn't want to take this action right now. STOP …»). 모델은 «멈췄습니다» 라고 답했다.
 * ★뿌리: 훅(PreToolUse)·내장 MCP 는 stdin/stdout 제어 통로로 답한다 — 닫히면 도구가 취소된다. 가짜 모델 서버로
 *  재현했다(훅+닫음 = 취소 / 이 판정 적용 = 정상). 회귀는 실제 실행기를 못 띄우므로 ①판정을 실행하고 ②배선을 본다.
 *
 * 지키는 것:
 *  ① 줄 선 입력은 실행기가 `queued` 이외 상태(started·completed·cancelled·dropped)를 알릴 때까지 남는다
 *  ② 모르는 uuid·다른 종류 메시지는 판정을 흔들지 않는다
 *  ③ 어댑터가 result 에서 **판정을 거쳐** 닫는다(직접 닫지 않는다) · 넘긴 입력을 등록하고 · 모든 메시지를 판정에 보인다
 */
import { createSteerQueue } from "../../core/llm-runtime/adapters/_claude-steer-queue.js";
import { readSource } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const lc = (uuid: string, state: string): unknown => ({ type: "command_lifecycle", command_uuid: uuid, state, uuid: "frame" });

export const check: RegressionCheck = {
  name: "queued-steer-keeps-input-open",
  guards:
    "답하는 중에 들어온 메시지가 실행기 큐에 선 채로 첫 답이 끝나면 입력이 닫혀, 그 턴의 도구(사진 Read 등)가 전부 «사용자 거부» 문구로 취소되고 모델이 «멈췄습니다» 로 끝내던 것",
  run: async (): Promise<Assertion[]> => {
    const q = createSteerQueue();
    q.sent("a");
    q.sent("b");
    q.observe(lc("a", "queued"));
    const afterQueued = q.size();
    q.observe({ type: "assistant", command_uuid: "a", state: "started" });
    q.observe(lc("zzz", "started"));
    const afterNoise = q.size();
    q.observe(lc("a", "started"));
    const afterStartA = q.size();
    q.observe(lc("b", "completed"));
    const afterB = q.size();
    const c = createSteerQueue();
    c.sent("x");
    c.observe(lc("x", "cancelled"));
    const d = createSteerQueue();
    d.sent("y");
    d.observe(lc("y", "dropped"));

    const src = await readSource("../../core/llm-runtime/adapters/claude-agent-sdk.ts");
    const resultBranch = src.slice(src.indexOf('msg.type === "result"'), src.indexOf("const emptyQueuedResult"));
    const sentWired = /queuedSteer\.sent\(uuid\)/.test(src);
    const observeWired = /queuedSteer\.observe\(msg\)/.test(src);
    const emptyCloses = /if \(queuedSteer\.size\(\) === 0\) return closeSteering\(\);/.test(src);
    const at = src.indexOf("const closeSteeringUnlessQueued");
    const backstop = at >= 0 && /setTimeout\(/.test(src.slice(at, at + 1500));
    return [
      assert("① 넘긴 입력 둘은 queued 신호로는 빠지지 않는다", afterQueued === 2, `size=${afterQueued}`),
      assert("② 다른 종류 메시지·모르는 uuid 는 판정을 흔들지 않는다", afterNoise === 2, `size=${afterNoise}`),
      assert("① started 를 받으면 그 입력은 줄에서 빠진다", afterStartA === 1, `size=${afterStartA}`),
      assert("① completed 로 마지막이 빠지면 0 — 이제 닫아도 된다", afterB === 0, `size=${afterB}`),
      assert("① cancelled·dropped 도 «집었다» 로 본다(영영 안 닫히는 일 없음)", c.size() === 0 && d.size() === 0, `cancelled=${c.size()} dropped=${d.size()}`),
      assert(
        "③ result 에서 판정을 거쳐 닫는다(직접 close 하면 줄 선 턴의 도구가 취소된다)",
        resultBranch.includes("closeSteeringUnlessQueued()") && !resultBranch.includes("steering?.close()"),
        `판정 경유=${resultBranch.includes("closeSteeringUnlessQueued()")} 직접 닫기=${resultBranch.includes("steering?.close()")} (result 분기 ${resultBranch.length}자)`,
      ),
      assert("③ 실행기에 넘긴 입력을 등록한다", sentWired, `queuedSteer.sent(uuid) 발견=${sentWired}`),
      assert("③ 모든 SDK 메시지를 판정에 보인다", observeWired, `queuedSteer.observe(msg) 발견=${observeWired}`),
      assert(
        "③ 판정이 비었을 때만 닫고, 안 비면 안전장치를 건다",
        emptyCloses && backstop,
        `빈 판정에서 닫기=${emptyCloses} 안전장치=${backstop}`,
      ),
    ];
  },
};
