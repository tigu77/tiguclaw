/**
 * 회귀: **`/stop` 으로 멈추면 그 턴에 끼워 넣었던 메시지는 버리고, 몇 건이었는지 알린다** — 어댑터와 무관하게 (2026-10-06).
 *
 * 배경(회사 PC 3일 무응답): Bash 가 멈춘 턴에 동료 메시지 9건이 «진행 턴에 끼움» 으로 쌓였다. 정태님 질문 «멈추면 대기열은?»
 * 에 코드를 보니 어댑터마다 달랐다 — claude 는 SDK 안쪽 대기열과 함께 **조용히 사라지고**, codex·openai 는 턴 끝 재주입으로
 * **멈추자마자 그 메시지들로 새 턴이 열렸다**(«Tell me what to do next» 라고 해 놓고 «??» 에 답한다). 결정(정태님): 버리는 게 맞다 —
 * 단 조용히 버리지 않고 건수를 알린다.
 *
 * ★적대 검토(같은 날): 통로가 턴의 finally 에서야 닫혀, `/stop` 직후 보낸 «아니, 이렇게 해 줘» 가 끼워넣기로 받혔다가 버려졌다
 *  (건수에도 안 잡힌 조용한 유실). 그래서 `/stop` 이 걸리는 순간 통로를 닫는다 — 이후 메시지는 새 턴이 된다. 그리고 취소 판정
 *  문자열이 다섯 곳에 흩어져 있었고 이 검사는 이름을 손으로 만들어 써서 하나가 바뀌어도 초록이었다 — 이제 **실제 클래스**로 본다.
 *
 * 등급: **동작** — 판정·문구·통로 순수 함수 실행 + 배선.
 */
import { readFileSync } from "node:fs";
import {
  closeWhenStopped,
  createSteeringChannel,
  reinjectUnlessStopped,
  stopReplyText,
  toSteeringInput,
  UserCancelledError,
} from "../../core/steering.js";
import { isCancelled } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const stoppedSignal = (): AbortSignal => {
  const ac = new AbortController();
  ac.abort(new UserCancelledError());
  return ac.signal;
};
const abortedWith = (name: string): AbortSignal => {
  const ac = new AbortController();
  const e = new Error(name);
  e.name = name;
  ac.abort(e);
  return ac.signal;
};

export const check: RegressionCheck = {
  name: "stop-drops-steered-messages",
  guards:
    "/stop 뒤 끼워 넣었던 메시지가 claude 에선 조용히 사라지고 codex·openai 에선 곧바로 새 턴으로 처리되던 것(어댑터마다 다름) + 버렸다는 사실을 아무도 몰랐던 것",
  run: async (): Promise<Assertion[]> => {
    const opener = { channel: "telegram", threadKey: "dashboard:x", text: "처음 요청" } as never;
    const left = [toSteeringInput({ channel: "telegram", threadKey: "dashboard:x", text: "왜 답이 없어?" } as never)];
    const stopped = reinjectUnlessStopped(stoppedSignal(), opener, left, 1);
    const idle = reinjectUnlessStopped(abortedWith("IdleTimeoutError"), opener, left, 1);
    const normal = reinjectUnlessStopped(new AbortController().signal, opener, left, 1);
    const none = stopReplyText(0, 0);
    const three = stopReplyText(0, 3);
    const both = stopReplyText(2, 1);
    const idx = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const life = readFileSync(new URL("../../core/entry/turn-lifecycle.ts", import.meta.url), "utf8"); // 턴 출구 판정(2026-10-09 index.ts 에서 옮김)
    const facade = readFileSync(new URL("../../core/llm-runtime/index.ts", import.meta.url), "utf8");
    // 통로: 돌던 턴에 /stop · 통로를 열기 전에 이미 /stop · 무응답 시한으로 끝남
    const input = left[0]!;
    const live = new AbortController();
    const chLive = createSteeringChannel();
    closeWhenStopped(chLive, live.signal);
    const beforeStop = chLive.push(input);
    live.abort(new UserCancelledError());
    const afterStop = chLive.push(input);
    const chLate = createSteeringChannel();
    closeWhenStopped(chLate, stoppedSignal());
    const lateOpened = chLate.push(input);
    const idleAc = new AbortController();
    const chIdle = createSteeringChannel();
    closeWhenStopped(chIdle, idleAc.signal);
    const idleErr = new Error("idle");
    idleErr.name = "IdleTimeoutError";
    idleAc.abort(idleErr);
    const afterIdle = chIdle.push(input);
    return [
      assert(
        "★/stop 으로 끝난 턴의 남은 끼워넣기는 다시 태우지 않는다(어댑터 무관)",
        stopped === null,
        stopped === null ? "버림" : `★재주입: ${stopped.text.slice(0, 40)}`,
      ),
      assert(
        "그 밖의 끝(정상 종료 · 무응답 시한 등)은 종전대로 새 턴으로 다시 태운다(사용자 메시지 손실 0)",
        normal !== null && idle !== null && normal.text.includes("왜 답이 없어?"),
        `정상=${normal === null ? "null" : "재주입"} · 시한=${idle === null ? "null" : "재주입"}`,
      ),
      assert(
        "★/stop 답이 끼워 넣었던 메시지 건수를 알린다(조용히 버리지 않는다) · 없으면 언급하지 않는다",
        /3 messages/.test(three) && /send again/.test(three) && !/message/.test(none.replace("Tell me", "")) &&
          /2 background tasks/.test(both) && /1 message /.test(both),
        three.slice(0, 120),
      ),
      assert(
        "★/stop 이 걸리는 순간 끼워넣기 통로가 닫힌다 — 그 뒤 메시지는 새 턴으로 간다(버려지지 않는다) · 이미 멈춘 턴은 열자마자 닫힌다",
        beforeStop && !afterStop && !lateOpened && chLive.drain().length === 1,
        `멈추기전=${beforeStop} · 멈춘뒤=${afterStop} · 이미멈춤=${lateOpened}`,
      ),
      assert(
        "무응답 시한 같은 다른 끝은 통로를 닫지 않는다(남은 것은 새 턴으로 다시 태우므로 받아도 잃지 않는다)",
        afterIdle,
        `시한 뒤 push=${afterIdle}`,
      ),
      assert(
        "★취소 판정이 실제 /stop 사유를 알아본다 — 코덱스 요약의 «취소» 판정도 같다(이름이 갈리면 재주입·turn_error·폴백으로 샌다)",
        isCancelled(new UserCancelledError()) && !isCancelled(new Error("boom")),
        `코덱스 요약=${isCancelled(new UserCancelledError())}`,
      ),
      assert(
        "배선 — 통로를 열 때 /stop 에 묶는다 · 런타임 facade 는 같은 판정을 쓴다(이름 문자열을 다시 쓰지 않는다)",
        /closeWhenStopped\(steeringCh, turnAc\.signal\)/.test(idx) &&
          (facade.match(/stoppedByUser\(input\.abortSignal\)/g) ?? []).length === 2 &&
          !/"UserCancelledError"/.test(idx + facade),
        `통로=${/closeWhenStopped\(steeringCh/.test(idx)} · facade=${(facade.match(/stoppedByUser\(input\.abortSignal\)/g) ?? []).length}`,
      ),
      assert(
        "배선 — 끼워넣기를 받을 때 그 턴에 센다 · /stop 답이 그 수를 쓴다 · 재주입은 /stop 판정을 거친다",
        /if \(turn !== undefined\) turn\.steered = \(turn\.steered \?\? 0\) \+ 1;/.test(idx) &&
          /stopReplyText\(stopped, entry\.steered \?\? 0\)/.test(idx) &&
          (/const again = reinjectUnlessStopped\(t\.signal, t\.msg, leftover\)/.test(life) && /signal: turnAc\.signal,/.test(idx) && /reinject: \(m\) => serializedHandler\(m\)/.test(idx)),
        `세기=${/turn\.steered = \(turn\.steered \?\? 0\) \+ 1/.test(idx)} · 답=${/stopReplyText\(stopped, entry\.steered/.test(idx)} · 재주입=${(/const again = reinjectUnlessStopped\(t\.signal, t\.msg, leftover\)/.test(life) && /signal: turnAc\.signal,/.test(idx) && /reinject: \(m\) => serializedHandler\(m\)/.test(idx))}`,
      ),
    ];
  },
};
