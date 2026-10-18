/**
 * 회귀: **스케줄·파일 감시의 결과는 목적지로 잡은 대시보드 대화에 뜬다** (2026-10-17, 회사돌쇠 보고 — PartyIdleRPG 답안 감시).
 *
 * 사고: `add_watch(dest_channel=http-bridge, dest_target=dashboard:<세션>)` 이 정상 발화했는데(기록 ok) 답이 공통 대화
 *  `dashboard:default` 에 저장·표시됐다. 두 플러그인의 dispatcher 가 표시 세션(`observeThreadKey`)을 «모르니까 기본» 으로 **강제**했고,
 *  `deliverOutbound` 는 그 값을 목적지보다 우선한다. 스케줄러도 같은 모양이었다(호출 세 곳 모두 기본 세션 강제).
 *  ★종전 검사(`file-watch-delivers-result`)는 «배달 함수에 목적지가 넘어가나» 만 봐서 이 결함을 못 봤다 — 그래서 여기선
 *  **실제로 발행된 `channel.message.out` 의 세션**을 센다.
 *
 * 본다: 진짜 dispatcher 두 개(파일 감시·스케줄러) × 목적지(대시보드 대화 · 텔레그램) — 대시보드 대화면 그 세션, 텔레그램이면
 *  종전대로 기본 세션 · 배달은 목적지 그대로 · 판정이 코어 한 곳(`sessionOfDestination`)인가.
 *
 * 등급: **동작** — 배달·발행은 실제 경로, 채널 출구만 가짜.
 */
import { getEventBus, type EventBusEvent } from "../../core/eventbus.js";
import { getChannelOutbound, registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { sessionOfDestination } from "../../core/outbound.js";
import { DEFAULT_SESSION_ID } from "../../core/threadkey.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

type Dispatch = (i: Record<string, unknown>) => Promise<void>;

export const check: RegressionCheck = {
  name: "trigger-result-lands-in-destination-session",
  guards: "대시보드 대화를 목적지로 잡은 파일 감시·스케줄의 결과가 공통 대화(dashboard:default)에 떨어지던 것 — dispatcher 가 표시 세션을 기본으로 강제했다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // ★src 밖은 계산된 지정자로(`src-stays-inside-src`).
    const fw = (await import(new URL("../../../plugins/file-watch/src/dispatcher.ts", import.meta.url).href)) as { dispatch: Dispatch };
    const sc = (await import(new URL("../../../plugins/scheduler/src/dispatcher.ts", import.meta.url).href)) as { dispatch: Dispatch };
    const bus = getEventBus();
    const published: Array<{ threadKey: unknown; channel: unknown; text: unknown }> = [];
    const delivered: Array<{ channel: string; target: string }> = [];
    const off = bus.subscribe((ev: EventBusEvent) => {
      if (ev.type !== "channel.message.out") return;
      const p = ev.payload as { threadKey?: unknown; channel?: unknown; text?: unknown };
      if (typeof p.text === "string" && p.text.startsWith("regr-dest-")) published.push({ threadKey: p.threadKey, channel: p.channel, text: p.text });
    });
    const prev = { http: getChannelOutbound("http-bridge"), tg: getChannelOutbound("telegram") };
    const fake = (channel: string) => ({
      deliver: async (target: string) => { delivered.push({ channel, target }); },
      defaultOutboundTarget: async () => (channel === "telegram" ? "owner-default" : null),
    });
    registerChannelOutbound("http-bridge", fake("http-bridge") as never);
    registerChannelOutbound("telegram", fake("telegram") as never);
    const session = `dashboard:regr-dest-${Math.random().toString(36).slice(2)}`;
    const shown = (text: string): unknown => published.find((p) => p.text === text)?.threadKey;
    try {
      await fw.dispatch({ watchId: 1, destChannel: "http-bridge", destTarget: session, text: "regr-dest-fw-dash", bus });
      await fw.dispatch({ watchId: 1, destChannel: "telegram", destTarget: "777001", text: "regr-dest-fw-tg", bus });
      await sc.dispatch({ scheduleId: 1, destChannel: "http-bridge", destTarget: session, text: "regr-dest-sc-dash", bus });
      await sc.dispatch({ scheduleId: 1, destChannel: "telegram", destTarget: "777001", text: "regr-dest-sc-tg", bus });
      const got = {
        fwDash: shown("regr-dest-fw-dash"), fwTg: shown("regr-dest-fw-tg"),
        scDash: shown("regr-dest-sc-dash"), scTg: shown("regr-dest-sc-tg"),
        deliveredDash: delivered.filter((d) => d.channel === "http-bridge" && d.target === session).length,
        deliveredTg: delivered.filter((d) => d.channel === "telegram" && d.target === "777001").length,
      };
      out.push(assert("★목적지가 대시보드 대화면 결과가 그 대화에 뜬다 — 파일 감시·스케줄러 둘 다(공통 대화가 아니다)",
        got.fwDash === session && got.scDash === session && got.deliveredDash === 2, got));
      out.push(assert("목적지가 텔레그램이면 종전대로 기본 세션에 뜨고, 배달은 그 chat 으로 간다",
        got.fwTg === DEFAULT_SESSION_ID && got.scTg === DEFAULT_SESSION_ID && got.deliveredTg === 2, got));
    } finally {
      off();
      unregisterChannelOutbound("http-bridge");
      unregisterChannelOutbound("telegram");
      if (prev.http !== undefined) registerChannelOutbound("http-bridge", prev.http);
      if (prev.tg !== undefined) registerChannelOutbound("telegram", prev.tg);
    }
    // 판정 자체 — 대시보드 세션 좌표만 그 세션, 나머지(텔레그램·CLI·대상 없음·대시보드가 아닌 브리지 좌표)는 기본 세션
    const cases = {
      dash: sessionOfDestination("http-bridge", "dashboard:abc"),
      dashDefault: sessionOfDestination("http-bridge", DEFAULT_SESSION_ID),
      bridgeNull: sessionOfDestination("http-bridge", null),
      bridgeApp: sessionOfDestination("http-bridge", "http:app-1"),
      tg: sessionOfDestination("telegram", "777001"),
      cli: sessionOfDestination("cli", null),
    };
    out.push(assert("판정 — 대시보드 세션 좌표만 그 세션, 텔레그램·CLI·대상 없음·앱 좌표는 기본 세션",
      cases.dash === "dashboard:abc" && cases.dashDefault === DEFAULT_SESSION_ID &&
        [cases.bridgeNull, cases.bridgeApp, cases.tg, cases.cli].every((v) => v === DEFAULT_SESSION_ID), cases));
    // 판정이 한 곳인가 — 두 dispatcher 가 표시 세션을 직접 정하지 않는다(다시 강제하면 이 결함이 돌아온다)
    const wiring = {
      fw: /observeThreadKey: sessionOfDestination\(input\.destChannel, input\.destTarget\)/.test(stripComments(readSourceSync("plugins/file-watch/src/dispatcher.ts"))),
      sc: /observeThreadKey: sessionOfDestination\(input\.destChannel, input\.destTarget\)/.test(stripComments(readSourceSync("plugins/scheduler/src/dispatcher.ts"))),
      noForcedDefault: !/DEFAULT_SESSION_ID/.test(stripComments(readSourceSync("plugins/file-watch/src/dispatcher.ts")) + stripComments(readSourceSync("plugins/scheduler/src/dispatcher.ts"))),
    };
    out.push(assert("두 dispatcher 가 표시 세션을 코어 판정(sessionOfDestination)으로 정한다 — 기본 세션 강제 없음", Object.values(wiring).every(Boolean), wiring));
    return out;
  },
};
