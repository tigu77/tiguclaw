/**
 * 회귀: **텔레그램 폴링이 죽으면 드러난다** (2026-10-09 전체 적대 검토 P3).
 *
 * 사고(검토 실측): 409(다른 인스턴스가 같은 토큰으로 폴링)·401(토큰 무효)로 `bot.start` 가 거절되면 로그 한 줄뿐이었다.
 * `status` 는 생성자의 "up" 그대로, 이벤트도 없어 — 메시지를 하나도 못 받는 채널이 어디에도 안 드러났다.
 *
 * 재는 것 — 진짜 `TelegramChannel` 을 띄우고 getUpdates 에 409 를 돌려준다:
 *  ① status 가 "up" 에서 내려간다
 *  ② `plugin.error`(pluginName=telegram-channel)가 원인(409)을 싣고 나온다
 *  ③ 다시 폴링하지 않는다(409 는 상대 인스턴스가 있다는 뜻 — 재시도하면 서로를 끊는다)
 *
 * 등급: **동작**(Bot API 는 가짜 변환기 — 네트워크 0).
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { fakeChannel, loadTelegram, settle, startWithOwners } from "./_fake-telegram.js";

export const check: RegressionCheck = {
  name: "telegram-polling-death-visible",
  guards:
    "텔레그램 폴링이 409·401 로 죽어도 status 는 'up' 그대로·이벤트 0 이라 메시지를 못 받는 채널이 아무 데도 안 드러나던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { getEventBus } = await import("../../core/eventbus.js");
    const mod = await loadTelegram();
    const errors: string[] = [];
    const unsub = getEventBus().subscribe((ev) => {
      if (ev.type !== "plugin.error") return;
      const p = ev.payload as { pluginName?: string; error?: string };
      if (p.pluginName === "telegram-channel") errors.push(String(p.error));
    });
    const { channel, calls } = fakeChannel(mod, (method) =>
      method === "getUpdates"
        ? { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }
        : undefined,
    );
    try {
      const statusBefore = channel.status;
      await startWithOwners(channel, "111", async () => {});
      for (let i = 0; i < 40 && errors.length === 0; i++) await settle(50);
      const pollsAtDeath = calls.filter((c) => c.method === "getUpdates").length;
      await settle(300);
      const pollsLater = calls.filter((c) => c.method === "getUpdates").length;
      out.push(
        assert(
          "★폴링이 죽으면 status 가 'up' 에서 내려간다",
          statusBefore === "up" && channel.status !== "up",
          `시작 전 ${statusBefore} → 죽은 뒤 ${channel.status}`,
        ),
      );
      out.push(
        assert(
          "★plugin.error 가 원인(409)을 싣고 나온다",
          errors.length === 1 && errors[0]!.includes("409"),
          `plugin.error ${errors.length}건 ${JSON.stringify(errors.map((e) => e.slice(0, 120)))}`,
        ),
      );
      out.push(
        assert(
          "다시 폴링하지 않는다(재시작 루프 0)",
          pollsAtDeath >= 1 && pollsLater === pollsAtDeath,
          `getUpdates 죽을 때 ${pollsAtDeath}회 · 300ms 뒤 ${pollsLater}회`,
        ),
      );
    } finally {
      unsub();
      await channel.stop();
    }

    // ④ 우리가 멈춘 것은 사망이 아니다 — 부팅 재시도(deleteWebhook 5xx) 중에 stop() 하면 `bot.start` 가 «Aborted delay» 로 거절되는데, 그걸
    //  «폴링이 죽었다» 로 알리면 정상 종료·재시작마다 가짜 장애 알림이 나간다(2026-10-10 재검토: 그물 0).
    {
      const stopErrors: string[] = [];
      const unsub2 = getEventBus().subscribe((ev) => {
        if (ev.type !== "plugin.error") return;
        const p = ev.payload as { pluginName?: string; error?: string };
        if (p.pluginName === "telegram-channel") stopErrors.push(String(p.error));
      });
      const { channel: ch2, calls: calls2 } = fakeChannel(mod, (method) =>
        // ★getMe 가 아니라 deleteWebhook 을 실패시킨다 — grammy 는 첫 시작의 getMe 재시도에 중단 신호를 안 넘겨(그 루프는 stop 으로
        //  안 멈춘다) 테스트 프로세스가 끝나지 않는다. 중단 신호를 받는 자리는 deleteWebhook 재시도다.
        method === "deleteWebhook" ? { ok: false, error_code: 500, description: "Internal Server Error" } : undefined,
      );
      try {
        await startWithOwners(ch2, "111", async () => {});
        for (let i = 0; i < 40 && calls2.filter((c) => c.method === "deleteWebhook").length < 2; i++) await settle(50);
        await ch2.stop();
        await settle(400);
        out.push(
          assert(
            "★부팅 재시도 중에 우리가 멈추면 «폴링 사망» 을 알리지 않는다",
            calls2.filter((c) => c.method === "deleteWebhook").length >= 2 && stopErrors.length === 0,
            { deleteWebhook: calls2.filter((c) => c.method === "deleteWebhook").length, 오류: stopErrors.map((e) => e.slice(0, 100)) },
          ),
        );
      } finally {
        unsub2();
        await ch2.stop();
      }
    }
    return out;
  },
};
