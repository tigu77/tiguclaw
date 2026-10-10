/**
 * 회귀: **텔레그램 본답이 짧은 장애에 조용히 사라지지 않는다** (2026-10-09 전체 적대 검토 P3).
 *
 * 사고: 인입 답(`replyAndRecord`)은 대화형 예산(HTML ~5초 + plain ~5초)만 쓰고, 둘 다 실패하면 로그만 찍고 정상
 * 반환했다 — 코어는 «배달됨». 같은 장애에 스케줄 알림은 80초 + 5분 재전송으로 살아남는데, 사용자가 기다리던
 * 답만 10초 남짓의 흔들림에 사라졌다.
 *
 * 재는 것 — 진짜 `replyAndRecord` 에 가짜 send 를 준다(429 + retry_after 0.01초 = 실패가 수 ms 에 끝난다):
 *  ① 대화형 예산이 다 떨어진 뒤 장애가 풀리면 **답이 결국 도착한다**(HTML 그대로)
 *  ② 뒤에서 다시 보낼 때 쓰는 예산이 대화형보다 길다(스케줄 알림과 같은 예산 — 시도 횟수로 잰다)
 *  ③ 그래도 못 가면 `plugin.error` 로 «미배달» 이 남는다
 *
 * 등급: **동작**(네트워크 0).
 */
import { GrammyError } from "grammy";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { loadTelegram, settle } from "./_fake-telegram.js";

const tooMany = (): GrammyError =>
  new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0.01 } },
    "sendMessage",
    {},
  );

export const check: RegressionCheck = {
  name: "telegram-reply-loss-resent",
  guards:
    "텔레그램 인입 본답이 대화형 짧은 예산(~10초)을 넘는 일시 장애에 로그만 남기고 정상 반환해 조용히 유실되던 것 — 같은 장애에 스케줄 알림은 살아남았다",
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
    try {
      // ── ① 장애가 대화형 예산보다 길다 → 그 뒤에 풀린다 ──────────────────
      {
        let calls = 0;
        let inlineCalls = 0;
        const delivered: Array<{ text: string; html: boolean }> = [];
        // 대화형 예산을 정확히 다 태우는 만큼 실패시킨다 — 먼저 «항상 실패» 로 대화형 시도 수를 잰다.
        {
          let probe = 0;
          await mod.replyAndRecord(async () => { probe++; throw tooMany(); }, "dashboard:regr-tg-loss", "1", "x");
          inlineCalls = probe;
          for (let i = 0; i < 100 && errors.length === 0; i++) await settle(20);
          errors.length = 0;
        }
        await mod.replyAndRecord(
          async (chunk, extra) => {
            calls++;
            if (calls <= inlineCalls) throw tooMany();
            delivered.push({ text: chunk, html: extra.parse_mode === "HTML" });
            return { message_id: 77 };
          },
          "dashboard:regr-tg-loss",
          "1",
          "본답입니다",
        );
        const returnedAfter = calls;
        for (let i = 0; i < 100 && delivered.length === 0; i++) await settle(20);
        out.push(
          assert(
            "★대화형 예산이 다 떨어진 뒤 장애가 풀리면 답이 결국 도착한다(HTML 그대로)",
            returnedAfter === inlineCalls && delivered.length === 1 && delivered[0]!.html && delivered[0]!.text.includes("본답입니다"),
            `대화형 시도 ${inlineCalls}회 · 반환 시점 ${returnedAfter}회 · 도착 ${JSON.stringify(delivered)}`,
          ),
        );
        out.push(
          assert(
            "풀린 경우엔 «미배달» 이 안 남는다",
            errors.length === 0,
            `plugin.error ${errors.length}건`,
          ),
        );
      }

      // ── ②③ 장애가 안 풀린다 → 긴 예산을 다 쓰고 «미배달» ───────────────
      {
        let calls = 0;
        await mod.replyAndRecord(async () => { calls++; throw tooMany(); }, "dashboard:regr-tg-loss", "1", "끝내 못 가는 답");
        const inline = calls;
        for (let i = 0; i < 200 && errors.length === 0; i++) await settle(20);
        const background = calls - inline;
        out.push(
          assert(
            "★뒤에서 다시 보내는 예산이 대화형보다 길다(스케줄 알림과 같은 예산)",
            inline > 0 && background > inline,
            `대화형 ${inline}회 · 뒤에서 ${background}회`,
          ),
        );
        out.push(
          assert(
            "★그래도 못 가면 plugin.error 로 «미배달» 이 남는다",
            errors.length === 1 && errors[0]!.includes("undelivered") && errors[0]!.includes("1/1"),
            `plugin.error ${errors.length}건 ${JSON.stringify(errors.map((e) => e.slice(0, 120)))}`,
          ),
        );
      }

      // ── ④ 뒤로 미룬 답이 있으면 다음 답이 앞지르지 않는다 · 여러 청크가 순서대로 한 번씩 (2026-10-09 재검토) ──
      {
        let failLeft = 0;
        const order: string[] = [];
        const longA = `A1-\n${("가".repeat(90) + "\n").repeat(70)}A2-끝`; // 줄이 있는 실제 답 모양 — 4096 경계에서 둘로 나뉜다
        const send = async (chunk: string): Promise<{ message_id: number }> => {
          if (failLeft > 0) { failLeft--; throw tooMany(); }
          order.push(chunk.includes("A1-") ? "A1" : chunk.includes("A2-끝") ? "A2" : chunk.includes("답B") ? "B" : "?");
          return { message_id: 90 + order.length };
        };
        // 대화형 시도를 정확히 다 태운 뒤에 풀린다 — A 의 첫 청크부터 뒤로 넘어간다.
        let probe = 0;
        await mod.replyAndRecord(async () => { probe++; throw tooMany(); }, "dashboard:regr-tg-order0", "9", "x");
        for (let i = 0; i < 200 && errors.length === 0; i++) await settle(20);
        errors.length = 0;
        failLeft = probe + 2; // 대화형 전부 + 뒤에서 두 번 더 실패한 뒤 풀린다
        await mod.replyAndRecord(send, "dashboard:regr-tg-order", "2", longA);
        await mod.replyAndRecord(send, "dashboard:regr-tg-order", "2", "답B");
        for (let i = 0; i < 300 && order.length < 3; i++) await settle(20);
        out.push(
          assert(
            "★앞 답이 뒤에서 다시 가는 동안 다음 답은 그 뒤에 선다 — 여러 청크도 순서대로 한 번씩(A1·A2·B)",
            order.join(",") === "A1,A2,B",
            `도착 순서 ${order.join(",")}`,
          ),
        );
        // 늦게 간 답도 답장 매핑에 묶인다 — 안 묶이면 그 답에 답장해도 원래 세션으로 못 간다(2026-10-10 재검토: 줄 선 답은 [] 를 돌려줬다)
        const { findSessionForOutboundMessage } = await import("../../store/outbound-messages.js");
        const bound = [91, 92, 93].map((id) => findSessionForOutboundMessage("telegram", "2", id));
        out.push(
          assert(
            "★뒤에서 늦게 간 청크(A1·A2)와 줄 서서 간 답(B)도 답장 매핑에 묶인다",
            bound.every((x) => x === "dashboard:regr-tg-order"),
            { 매핑: bound },
          ),
        );
      }

      // ── ④' 앞 답의 발송이 응답 없이 멈춰도 다음 답을 무기한 막지 않는다(줄 붙잡는 시간에 상한) ──
      {
        (mod as unknown as { setBacklogHoldMsForTest: (ms: number) => void }).setBacklogHoldMsForTest(300);
        try {
          // 대화형 예산 동안은 실패시켜 뒤로 넘기고, 돌아온 뒤(뒤에서 다시 보낼 때)는 응답 없이 멈춘다 — 시도 횟수를 세지 않는다.
          let inlineDone = false;
          await mod.replyAndRecord(
            async () => {
              if (!inlineDone) throw tooMany();
              return new Promise<never>(() => {});
            },
            "dashboard:regr-tg-hang",
            "10",
            "멈춘 답",
          );
          inlineDone = true;
          const got: string[] = [];
          await mod.replyAndRecord(async (chunk) => { got.push(chunk); return { message_id: 5 }; }, "dashboard:regr-tg-hang", "10", "다음 답");
          for (let i = 0; i < 100 && got.length === 0; i++) await settle(20);
          out.push(assert("★앞 발송이 멈춰도 다음 답은 줄 상한 뒤에 간다(무기한 막히지 않는다)", got.length === 1 && got[0]!.includes("다음 답"), { 도착: got }));
        } finally {
          (mod as unknown as { setBacklogHoldMsForTest: (ms: number) => void }).setBacklogHoldMsForTest(180_000);
        }
      }

      // ── ⑤ 뒤에서 한 청크를 끝내 잃으면 나머지는 보내지 않는다(중간이 빠진 답 X) ──
      {
        errors.length = 0;
        const sent: string[] = [];
        const longC = `C1-\n${("나".repeat(90) + "\n").repeat(70)}C2-끝`;
        await mod.replyAndRecord(
          async (chunk) => {
            if (chunk.includes("C1-")) throw tooMany(); // 첫 청크는 끝내 못 간다
            sent.push(chunk.includes("C2-끝") ? "C2" : "?");
            return { message_id: 1 };
          },
          "dashboard:regr-tg-gap",
          "3",
          longC,
        );
        // 앞 시나리오의 늦은 오류와 섞이지 않게 **이 답(2청크)** 의 오류만 본다.
        const mine = (): string[] => errors.filter((e) => e.includes("/2"));
        for (let i = 0; i < 400 && mine().length === 0; i++) await settle(20);
        await settle(200);
        out.push(
          assert(
            "★뒤에서 첫 청크를 끝내 잃으면 둘째 청크는 보내지 않고, «나머지도 안 보냈다» 를 남긴다",
            sent.length === 0 && mine().length === 1 && mine()[0]!.includes("1/2") && mine()[0]!.includes("remaining 1"),
            { 보낸것: sent, 오류: mine().map((e) => e.slice(0, 140)) },
          ),
        );
      }
    } finally {
      unsub();
    }
    return out;
  },
};
