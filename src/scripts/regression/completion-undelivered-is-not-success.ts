/**
 * 회귀: **매니저 완료 보고가 못 나갔는데 «보냄» 으로 기록하지 않는다** (2026-10-20 회사돌쇠 — 감시가 띄운 매니저).
 *
 * 사고: 감시 턴이 띄운 매니저의 완료 보고(236자)가 내부 채널 `file-watch` 로 가 미배달됐는데 기록엔 전달 성공이었다.
 * 기제 둘이 겹쳤다:
 *  ①보고 좌표 — 감시 파사드가 사람 도달 좌표(`notifyDest`)를 빼고 넘겨 잡의 채널로 폴백했다(→ `file-watch-run-is-named`).
 *  ②결과 손실 — 미등록 채널은 `deliverOutbound` 가 던지지 않고 `{ delivered:false }` 를 **돌려주는데**, 통지 래퍼(`reacquireReply`)가
 *   그 값을 버려 완료 턴의 `trackedReply` 가 «보냄» 으로 표시했고 → raw 안전망이 꺼졌다. 안전망도 같은 래퍼라 그 실패도 조용했다.
 * 이 검사는 ②를 **진짜 `onWorkerComplete`** 로 돌린다(스텁 채널 + 등록 안 된 채널).
 */
import { initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { __resetJobsForTest, notifyJobOwner, onWorkerComplete, registerJob, registerWorkerHandler } from "../../core/worker-jobs.js";
import { initStore } from "../../store/sessions.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "regr-undelivered-ok";
const GONE = "regr-undelivered-gone"; // 등록하지 않는 채널(감시의 `file-watch` 자리)

export const check: RegressionCheck = {
  name: "completion-undelivered-is-not-success",
  guards:
    "매니저 완료 보고가 등록 안 된 채널로 가 미배달됐는데 «보냄» 으로 기록돼 raw 안전망이 꺼지던 것 — 통지 래퍼가 deliverOutbound 의 delivered:false 를 버렸다(회사돌쇠 10-20)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    initEventBus();
    const sent: string[] = [];
    registerChannelOutbound(CH, { deliver: async (_t, text) => { sent.push(text); return undefined; } });
    const logs: string[] = [];
    const orig = { warn: console.warn, error: console.error };
    console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    const drive = async (channel: string, opts: { reply: boolean; notifyTo?: string }): Promise<{ sent: string[]; logs: string[] }> => {
      __resetJobsForTest();
      sent.length = 0;
      logs.length = 0;
      registerWorkerHandler(async (msg) => {
        if (opts.reply) await msg.reply("결과를 보고합니다");
      });
      const jobId = registerJob({
        label: "회귀 잡", task: "검사", threadKey: `${channel}:3`, channel: channel as never, channelUserId: "regr",
        ...(opts.notifyTo !== undefined ? { notifyDest: { channel: opts.notifyTo as never, target: "t" } } : {}),
      });
      await onWorkerComplete(jobId, { result: "끝" });
      return { sent: [...sent], logs: [...logs] };
    };
    try {
      const gone = await drive(GONE, { reply: true }); // 보고 좌표가 미등록 채널 — 모델은 답했다
      const ok = await drive(GONE, { reply: true, notifyTo: CH }); // 좌표가 정상 채널
      const silent = await drive(GONE, { reply: false, notifyTo: CH }); // 모델이 아무것도 안 보냄
      let ownerErr = "";
      try {
        await notifyJobOwner({ jobId: "x", label: "x", threadKey: `${GONE}:3`, channel: GONE }, "알림");
      } catch (e) {
        ownerErr = e instanceof Error ? e.message : String(e);
      }
      return [
        assert(
          "★★미등록 채널로 간 완료 보고는 «보냄» 이 아니다 — 안전망이 돌고(raw 통지 시도), 그것도 못 나가면 **실패로 남긴다**",
          gone.logs.some((l) => l.includes("raw 안전망 통지마저 실패") && l.includes("isn't registered")) && gone.sent.length === 0,
          gone.logs.filter((l) => /안전망|registered/.test(l)).slice(0, 3).join(" | ") || "★안전망·실패 기록 없음",
        ),
        assert(
          "정상 채널이면 그대로 한 번만 간다(안전망은 안 돈다 — 이중 통지 0)",
          ok.sent.length === 1 && ok.sent[0] === "결과를 보고합니다" && !ok.logs.some((l) => l.includes("안전망")),
          JSON.stringify({ sent: ok.sent, logs: ok.logs.filter((l) => l.includes("안전망")) }),
        ),
        assert(
          "모델이 아무것도 안 보내면 안전망이 정상 채널로 raw 통지를 보낸다(종전 동작 유지)",
          silent.sent.length === 1 && silent.logs.some((l) => l.includes("raw 안전망 통지 발화")),
          JSON.stringify({ sent: silent.sent.map((s) => s.slice(0, 40)), logs: silent.logs.filter((l) => l.includes("안전망")) }),
        ),
        assert(
          "★사람에게 바로 가는 통지(`notifyJobOwner`)도 미등록 채널이면 **던진다** — 부르는 쪽이 실패로 기록한다",
          ownerErr.includes("배달 실패") && ownerErr.includes("isn't registered"),
          ownerErr || "★던지지 않음(조용히 성공)",
        ),
      ];
    } finally {
      console.warn = orig.warn;
      console.error = orig.error;
      unregisterChannelOutbound(CH);
      __resetJobsForTest();
    }
  },
};
