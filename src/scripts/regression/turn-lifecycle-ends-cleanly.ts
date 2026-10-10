/**
 * 회귀: **턴 입구는 종료 중에 닫히고, 턴 출구는 자기 흔적을 치우고 남은 끼워넣기를 다음 턴으로 넘긴다** (2026-10-09).
 *
 * 사고 ①(P2~3): 종료가 시작된 뒤 도착한 메시지가 그대로 새 턴을 열었다 — 셸·잡을 만들다 force-exit 에 잘렸고,
 *  종료 통지는 이미 지나가 그 턴은 아무에게도 «중단» 을 말하지 못했다.
 * 사고 ②(G3): 끝난 턴의 in-flight 해제(`inflightTurns.delete`)·남은 끼워넣기 재주입(`steeringCh.drain()`)이
 *  index.ts 의 익명 `finally` 안에 있어 그물이 0 이었다. 둘 다 빠지면 증상이 조용하다 — 끝난 턴이 `/stop`·`/health`·
 *  종료 통지에 «진행 중» 으로 남고, 답 쓰는 중에 보낸 메시지가 증발한다(2026-07-25·08-11 실사고의 바로 그 자리).
 *
 * ★판정을 `core/entry/turn-lifecycle.ts` 로 뽑아 **실제로 돌린다**. 진입점 배선(입구가 이 문을 지나는가·finally 가
 *  이걸 부르는가)만 소스 대조다.
 */
import { createSteeringChannel, UserCancelledError } from "../../core/steering.js";
import { endTurn, refuseWhileClosing } from "../../core/entry/turn-lifecycle.js";
import type { IncomingMessage } from "../../channels/types.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const mkMsg = (over: Partial<IncomingMessage> = {}): IncomingMessage & { replies: string[] } => {
  const replies: string[] = [];
  return {
    channel: "cli",
    channelUserId: "u",
    threadKey: "dashboard:lifecycle",
    text: "안녕",
    receivedAt: 1,
    reply: async (t: string) => {
      replies.push(t);
    },
    replies,
    ...over,
  } as IncomingMessage & { replies: string[] };
};

export const check: RegressionCheck = {
  name: "turn-lifecycle-ends-cleanly",
  guards:
    "종료 중 도착한 메시지가 새 턴을 열어 잘리던 것 + 끝난 턴의 in-flight 해제·남은 끼워넣기 재주입 배선에 그물이 0 이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 입구 — 종료 중이면 안 연다 ─────────────────────────────────────────────
    {
      let closing = false;
      let innerCalls = 0;
      const gate = refuseWhileClosing(() => closing, async () => {
        innerCalls += 1;
      });
      const live = mkMsg();
      await gate(live);
      closing = true;
      const late = mkMsg();
      await gate(late);
      const synth = mkMsg({ synthetic: true });
      await gate(synth);
      out.push(assert("평소엔 그대로 지나간다", innerCalls >= 1 && live.replies.length === 0, `inner=${innerCalls} · 답=${live.replies.length}`));
      out.push(
        assert(
          "★종료 중 도착한 메시지는 새 턴을 열지 않고 «다시 보내 달라» 고 답한다",
          innerCalls === 1 && late.replies.length === 1 && !late.replies[0]!.startsWith("srv."),
          `inner=${innerCalls}(기대 1) · 답=${JSON.stringify(late.replies)}`,
        ),
      );
      out.push(assert("합성 메시지(매니저 완료)는 답할 상대가 없다 — 열지도 답하지도 않는다", synth.replies.length === 0 && innerCalls === 1, `답=${synth.replies.length} inner=${innerCalls}`));
    }

    // ── ② 출구 — in-flight 해제 · 채널 정리 · 남은 끼워넣기 재주입 ───────────────────
    const turn = (opts: { leftover?: string[]; overwritten?: boolean; stopped?: boolean }) => {
      const msg = mkMsg();
      const entry = { id: "this" };
      const inflight = new Map<string, { id: string }>([[msg.threadKey, opts.overwritten === true ? { id: "next" } : entry]]);
      const ch = createSteeringChannel();
      const chans = new Map([[msg.threadKey, ch]]);
      for (const raw of opts.leftover ?? []) ch.push({ raw, text: `[개입] ${raw}`, ts: 1 });
      const ac = new AbortController();
      if (opts.stopped === true) ac.abort(new UserCancelledError());
      const reinjected: IncomingMessage[] = [];
      endTurn({ msg, entry, inflight, steering: ch, steeringChannels: chans, signal: ac.signal, reinject: (m) => reinjected.push(m) });
      return { inflight, chans, ch, reinjected, key: msg.threadKey };
    };
    {
      const t = turn({});
      out.push(assert("★끝난 턴은 in-flight 에서 빠진다(/stop·/health·종료 통지가 끝난 턴을 진행 중으로 안 본다)", !t.inflight.has(t.key), `남음=${t.inflight.has(t.key)}`));
      out.push(
        assert(
          "끼워넣기 채널은 닫히고 레지스트리에서 빠진다(뒤에 온 메시지는 새 턴으로)",
          !t.chans.has(t.key) && t.ch.push({ raw: "늦게", text: "늦게", ts: 2 }) === false && t.reinjected.length === 0,
          `레지스트리=${t.chans.has(t.key)} · 닫힌 뒤 push=${t.ch.push({ raw: "x", text: "x", ts: 3 })} · 재주입=${t.reinjected.length}`,
        ),
      );
      const o = turn({ overwritten: true });
      out.push(assert("그 사이 새 턴이 덮어쓴 등록은 건드리지 않는다", o.inflight.get(o.key)?.id === "next", JSON.stringify(o.inflight.get(o.key) ?? null)));
      const l = turn({ leftover: ["이것도 봐줘"] });
      out.push(
        assert(
          "★턴 끝에 남은 끼워넣기는 원문으로 다음 턴에 재주입된다(증발 0)",
          l.reinjected.length === 1 && l.reinjected[0]!.text.includes("이것도 봐줘") && !l.reinjected[0]!.text.includes("[개입]") && l.reinjected[0]!.synthetic === true,
          `재주입=${l.reinjected.length}건 text=${JSON.stringify(l.reinjected[0]?.text ?? null)}`,
        ),
      );
      const s = turn({ leftover: ["버려질 말"], stopped: true });
      out.push(assert("/stop 으로 끝난 턴의 끼워넣기는 다시 태우지 않는다", s.reinjected.length === 0 && !s.inflight.has(s.key), `재주입=${s.reinjected.length} · in-flight=${s.inflight.has(s.key)}`));
    }

    // ── ③ 배선 — 모든 입구가 문을 지나고, finally 가 출구를 부른다 ─────────────────────
    {
      const w = await sourceHas("../../index.ts", [
        /const serializedHandler: MessageHandler = refuseWhileClosing\(\(\) => shuttingDown, queueHandler\)/,
        /await ch\.start\(serializedHandler\)/,
        /registerWorkerHandler\(serializedHandler\)/,
        /shuttingDown = true;/,
        /finally \{[\s\S]{0,400}endTurn\(\{[\s\S]{0,300}inflight: inflightTurns,[\s\S]{0,200}reinject: \(m\) => serializedHandler\(m\)/,
      ]);
      out.push(assert("진입점 배선 — 채널·재주입 입구가 종료 문을 지나고, 핸들러 finally 가 출구 정리를 부른다", w.ok, w.ok ? "5/5" : `누락: ${w.missing.join(" · ")}`));
    }
    return out;
  },
};
