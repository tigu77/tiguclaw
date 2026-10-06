/**
 * 회귀: **메인 턴 도구가 오래 걸리면 텔레그램 사용자에게 알림이 실제로 간다** — 세션 키가 `dashboard:` 여도 (2026-10-06).
 *
 * 사고(회사 PC, v0.64): 텔레그램 대화 중 Bash 하나가 3일 동안 끝나지 않았다. 600초 시점에 `[tool-slow]` 경고는 로그에
 * 찍혔지만 «오래 걸린다 · /stop 으로 멈출 수 있다» 알림은 **동료에게 한 번도 안 갔다**. 알림 쪽이 세션 키에서 chatId 를
 * 직접 뽑았는데(`tg:<id>` 모양만 인식), v0.7 채널/세션 분리 뒤로 텔레그램 대화의 세션 키는 `dashboard:<uuid>` 일 수 있다.
 * 그동안 동료가 보낸 메시지 9건은 멈춘 턴의 대기열에만 쌓였다.
 * ★종전 검사(`tool-stall-visible`)는 소스에 `extractTelegramChatId(tk)` 가 **있는지**를 봐서 바로 이 결함을 못 박고 있었다.
 *  그래서 이 검사는 이벤트를 실제로 발행하고 **가짜 telegram 출구에 무엇이 도착하는지** 센다.
 *
 * 등급: **동작** — 구독·판정·전송까지 실제 경로, 출구만 가짜.
 */
import { getEventBus } from "../../core/eventbus.js";
import { getChannelOutbound, registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { registerWorkerHandler } from "../../core/worker-jobs.js";
import { initStore, saveSession, setSessionChannelMeta, SESSION_STORAGE_CHANNEL } from "../../store/sessions.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "main-turn-tool-slow-reaches-telegram",
  guards:
    "텔레그램 대화의 세션 키가 dashboard: 이면 메인 턴 «도구가 오래 걸린다 · /stop» 알림이 조용히 안 가, Bash 가 3일 멈춘 동안 사용자가 몰랐던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const got: Array<{ target: string; text: string }> = [];
    const prev = getChannelOutbound("telegram");
    registerChannelOutbound("telegram", {
      deliver: async (target: string, text: string) => {
        got.push({ target, text });
      },
      defaultOutboundTarget: async () => "owner-default",
    } as never);
    registerWorkerHandler((async () => undefined) as never); // 구독(부팅 1회와 같은 경로)
    const rnd = Math.random().toString(36).slice(2);
    const mk = (tk: string, last: { ch: string; target: string } | null): void => {
      saveSession({ channel: SESSION_STORAGE_CHANNEL, threadKey: tk, claudeSessionId: `regr-${rnd}-${tk}`, model: null, systemPromptHash: null });
      if (last !== null) setSessionChannelMeta({ channel: SESSION_STORAGE_CHANNEL, threadKey: tk, lastChannel: last.ch as never, lastChannelTarget: last.target });
    };
    const viaTelegram = `dashboard:regr-tg-${rnd}`;
    const viaDashboard = `dashboard:regr-dash-${rnd}`;
    mk(viaTelegram, { ch: "telegram", target: "777001" });
    mk(viaDashboard, { ch: "http-bridge", target: "dash" });
    const fire = async (threadKey: string): Promise<void> => {
      getEventBus().publish({ type: "llm.tool_slow", ts: Date.now(), payload: { channel: "telegram", threadKey, tool: "Bash", ms: 600_000 } });
      await new Promise((r) => setTimeout(r, 30));
    };
    try {
      await fire(viaTelegram);
      const tg = got.filter((g) => g.target === "777001");
      await fire(viaTelegram); // 같은 턴 두 번째 — 턴당 1회
      const dup = got.filter((g) => g.target === "777001").length;
      const before = got.length;
      await fire(viaDashboard);
      const dashPushed = got.length - before;
      return [
        assert(
          "★세션 키가 dashboard: 인 텔레그램 대화에 «오래 걸린다 · /stop» 알림이 그 chat 으로 간다",
          tg.length === 1 && /\/stop/.test(tg[0]!.text) && /Bash/.test(tg[0]!.text),
          tg.length === 0 ? `★전송 0 (받은 것: ${JSON.stringify(got.map((g) => g.target))})` : tg[0]!.text.slice(0, 90),
        ),
        assert("같은 턴에선 한 번만 보낸다(스팸 방지)", dup === 1, `${dup}회`),
        assert("마지막 채널이 대시보드면 푸시하지 않는다(화면에서 본다 — 중복 방지)", dashPushed === 0, `${dashPushed}회`),
      ];
    } finally {
      unregisterChannelOutbound("telegram");
      if (prev !== undefined) registerChannelOutbound("telegram", prev);
    }
  },
};
