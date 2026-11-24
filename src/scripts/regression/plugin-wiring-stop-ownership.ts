/**
 * 회귀: **시작을 시도한 플러그인 인스턴스는 그 기록이 걷힐 때 `stop()` 을 정확히 1회 받는다** (2026-11-20, C1).
 *
 * ★무엇이 깨져 있었나 (근거: docs/decisions/2026-11-18-stability-c1-c3-review.md §1).
 *  ①`wire.ts` 가 observer/trigger/service 의 `await startFn` **성공 뒤에만** stop 을 걸었다 — 즉시 capability 가
 *   하나도 시작 못 한 비채널 인스턴스는 끄기·제거·재설치·종료 어디서도 stop 0회(타이머를 만든 뒤 던지면 계속 돈다).
 *  ②종료 루프(`index.ts`)가 정리 항목을 배열에서 **빼지 않고** `for…of` 로 stop 을 불렀다 — 종료가 stop 을 기다리는
 *   사이 같은 인스턴스를 끄면 stop 2회, 순회 중 앞 항목이 빠지면 배열이 당겨져 뒤 항목을 건너뛴다.
 *
 * 등급: **동작 검사** — 진짜 `wirePlugin`·`dispose`·`drainStops`(종료가 부르는 그 함수)를 부르고 stop 횟수를 센다.
 * 격리: 가짜 인스턴스는 `outbound`·`getMcpServer` 를 안 내 코어 레지스트리를 안 만진다. 번들 stop 확인만 격리 홈 DB 를 연다.
 */
import type { Channel } from "../../channels/types.js";
import type { EventBus } from "../../core/eventbus.js";
import type { LoadedPlugin } from "../../core/plugins/loader.js";
import { getChannelOutbound } from "../../core/channel-outbound.js";
import { channelPluginName, drainStops, wirePlugin, type WirePluginDeps } from "../../core/plugins/wire.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const fakeBus = (): EventBus =>
  ({
    publish: (): void => undefined,
    subscribe: () => () => undefined,
    history: () => [],
  }) as unknown as EventBus;

const fakePlugin = (name: string, capabilities: string[], instance: Record<string, unknown>): LoadedPlugin =>
  ({
    manifest: { schemaVersion: 1, kind: capabilities, name, entry: "./index.ts" },
    pluginDir: `/tmp/regression-plugins/${name}`,
    capabilities,
    instance,
  }) as LoadedPlugin;

const freshDeps = (): WirePluginDeps & { channels: Channel[] } => ({
  bus: fakeBus(),
  channels: [] as Channel[],
  serviceStops: [],
});

const ok = async (): Promise<void> => undefined;
const boom = async (): Promise<void> => {
  throw new Error("start boom");
};

/** stop 을 세고, 원하면 문(gate)이 열릴 때까지 기다리게 한다 — 종료와 끄기가 겹치는 순간을 만든다. */
const stopProbe = (): {
  count: () => number;
  entered: () => boolean;
  stop: () => Promise<void>;
  hold: () => void;
  release: () => void;
} => {
  let n = 0;
  let inside = false;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  return {
    count: () => n,
    entered: () => inside,
    hold: () => {
      gate = new Promise<void>((r) => {
        open = r;
      });
    },
    release: () => open?.(),
    stop: async () => {
      n += 1;
      inside = true;
      if (gate !== undefined) await gate;
    },
  };
};

/** 마이크로태스크를 몇 바퀴 돌려 비동기 진행(종료 루프가 stop 안으로 들어가기)을 기다린다. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const noop = (): void => undefined;

export const check: RegressionCheck = {
  name: "plugin-wiring-stop-ownership",
  guards:
    "시작이 던진 observer/trigger/service 인스턴스가 끄기·제거·재설치·종료에서 stop 을 한 번도 못 받던 것(타이머 잔류) + 종료 루프가 정리 항목을 빼지 않고 불러 끄기와 겹치면 stop 2회·순회 중 뒤 항목을 건너뛰던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── A. 여섯 모양 — 시작이 일부/전부 실패해도 dispose 에서 stop 정확히 1회 ──────────────
    {
      const shapes: Array<{ label: string; caps: string[]; inst: Record<string, unknown> }> = [
        { label: "observer 만, 실패", caps: ["observer"], inst: { startObserver: boom } },
        { label: "trigger 실패 + observer 성공", caps: ["trigger", "observer"], inst: { startTrigger: boom, startObserver: ok } },
        { label: "trigger 성공 + observer 실패", caps: ["trigger", "observer"], inst: { startTrigger: ok, startObserver: boom } },
        { label: "trigger·observer 둘 다 실패", caps: ["trigger", "observer"], inst: { startTrigger: boom, startObserver: boom } },
        { label: "channel + observer 실패", caps: ["channel", "observer"], inst: { name: "c1-hybrid", startChannel: ok, startObserver: boom } },
        { label: "service start() 폴백 실패", caps: ["service"], inst: { start: boom } },
      ];
      const rows: string[] = [];
      let bad = 0;
      for (const [i, s] of shapes.entries()) {
        const probe = stopProbe();
        const deps = freshDeps();
        const r = await wirePlugin(fakePlugin(`c1-shape-${String(i)}`, s.caps, { ...s.inst, stop: probe.stop }), deps);
        const registered = deps.serviceStops.length + deps.channels.length;
        await r.dispose();
        const row = `${s.label}: wired[${r.wired.join(",")}] 등록 ${String(registered)} · stop ${String(probe.count())}회`;
        rows.push(row);
        if (registered !== 1 || probe.count() !== 1) bad += 1;
      }
      out.push(
        assert(
          "★★시작이 일부·전부 실패한 여섯 모양 모두 등록 1개 · 끄기(dispose)에서 stop 정확히 1회 — 종전엔 하나도 못 시작한 비채널 인스턴스가 0회였다(타이머·구독 잔류)",
          bad === 0,
          rows,
        ),
      );
    }

    // ── B. 등록하지 말아야 할 것 — stop 이 없거나, 시작 훅이 없으면 0 ─────────────────────
    {
      const d1 = freshDeps();
      const r1 = await wirePlugin(fakePlugin("c1-nostop-fail", ["observer"], { startObserver: boom }), d1);
      const d2 = freshDeps();
      await wirePlugin(fakePlugin("c1-nostop-ok", ["observer"], { startObserver: ok }), d2);
      const probe = stopProbe();
      const d3 = freshDeps();
      await wirePlugin(fakePlugin("c1-nohook", ["observer"], { stop: probe.stop }), d3);
      let threw = "";
      try {
        await r1.dispose();
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      out.push(
        assert(
          "stop 이 없는 인스턴스는(시작 성공·실패 모두) 아무 데도 등록되지 않고 dispose 도 안 던진다",
          d1.serviceStops.length === 0 && d2.serviceStops.length === 0 && threw === "",
          { fail: d1.serviceStops.length, ok: d2.serviceStops.length, threw },
        ),
      );
      out.push(
        assert(
          "시작 훅이 없는 선언(start*·start 둘 다 없음)은 지금처럼 stop 미등록 — 시작을 시도하지 않았으니 정리할 것도 없다",
          d3.serviceStops.length === 0 && d3.channels.length === 0,
          { serviceStops: d3.serviceStops.length, channels: d3.channels.length },
        ),
      );
    }

    // ── C. 동시 dispose — 끄기와 제거가 겹쳐도 1회 ─────────────────────────────────────────
    {
      const probe = stopProbe();
      const r = await wirePlugin(fakePlugin("c1-double-dispose", ["observer"], { startObserver: boom, stop: probe.stop }), freshDeps());
      await Promise.all([r.dispose(), r.dispose()]);
      out.push(assert("시작 실패 인스턴스를 동시에 두 번 dispose 해도 stop 1회", probe.count() === 1, `${String(probe.count())}회`));
    }

    // ── D. 종료 소비(`drainStops`) × 끄기 교차 ─────────────────────────────────────────────
    // D1 종료 선행 → 종료가 stop 을 기다리는 사이 dispose
    {
      const probe = stopProbe();
      const deps = freshDeps();
      const r = await wirePlugin(fakePlugin("c1-shut-first", ["observer"], { startObserver: boom, stop: probe.stop }), deps);
      probe.hold();
      const shut = drainStops(deps.serviceStops, noop, noop);
      await settle();
      const enteredBeforeDispose = probe.entered();
      // dispose 를 기다리기 **전에** 문을 연다 — 결함이면 dispose 의 두 번째 stop 이 같은 문에서 멈춰 검사가 매달린다(단언으로 잡히게).
      const disposing = r.dispose();
      probe.release();
      await Promise.all([disposing, shut]);
      out.push(
        assert(
          "★★종료가 stop 을 기다리는 사이 같은 인스턴스를 꺼도 stop 1회 — 종전 종료는 항목을 안 빼서 끄기가 다시 찾아 2회 불렀다",
          enteredBeforeDispose && probe.count() === 1 && deps.serviceStops.length === 0,
          { enteredBeforeDispose, stops: probe.count(), left: deps.serviceStops.length },
        ),
      );
    }
    // D2 dispose 선행 → 종료
    {
      const probe = stopProbe();
      const deps = freshDeps();
      const r = await wirePlugin(fakePlugin("c1-dispose-first", ["trigger"], { startTrigger: ok, stop: probe.stop }), deps);
      await r.dispose();
      await drainStops(deps.serviceStops, noop, noop);
      out.push(assert("끈 뒤 종료해도 stop 1회", probe.count() === 1, `${String(probe.count())}회`));
    }
    // D2b dispose 선행인데 아직 stop 이 안 끝났을 때 종료가 같은 배열을 본다 (R1 검사 부족)
    {
      const probe = stopProbe();
      const deps = freshDeps();
      const r = await wirePlugin(fakePlugin("c1-dispose-inflight", ["observer"], { startObserver: boom, stop: probe.stop }), deps);
      probe.hold();
      const disposing = r.dispose();
      await settle();
      const enteredBeforeShutdown = probe.entered();
      const shut = drainStops(deps.serviceStops, noop, noop);
      probe.release();
      await Promise.all([disposing, shut]);
      out.push(
        assert(
          "★끄기가 stop 안에서 기다리는 사이 종료가 소비를 시작해도 stop 1회 — 되돌림은 stop 을 부르기 **전에** 배열에서 뺀다",
          enteredBeforeShutdown && probe.count() === 1 && deps.serviceStops.length === 0,
          { enteredBeforeShutdown, stops: probe.count(), left: deps.serviceStops.length },
        ),
      );
    }
    // D3 channel 겸직 — 정리 항목이 channels 쪽에 있다
    {
      const probe = stopProbe();
      const deps = freshDeps();
      const r = await wirePlugin(
        fakePlugin("c1-hybrid-shut", ["channel", "observer"], { name: "c1-hybrid-shut", startChannel: ok, startObserver: ok, stop: probe.stop }),
        deps,
      );
      const serviceBefore = deps.serviceStops.length;
      probe.hold();
      const shut = drainStops(deps.channels, noop, noop);
      await settle();
      const disposing = r.dispose();
      probe.release();
      await Promise.all([disposing, shut]);
      await drainStops(deps.serviceStops, noop, noop);
      out.push(
        assert(
          "channel 겸직 인스턴스: 종료(채널 소비) 중 끄기와 겹쳐도 stop 1회 · serviceStops 엔 안 걸린다",
          probe.count() === 1 && serviceBefore === 0,
          { stops: probe.count(), serviceBefore },
        ),
      );
    }
    // D4 종료 중 늦은 등록 — 소비가 끝나기 전 붙은 항목도 소비한다
    {
      const first = stopProbe();
      const late = stopProbe();
      const deps = freshDeps();
      await wirePlugin(fakePlugin("c1-early", ["observer"], { startObserver: ok, stop: first.stop }), deps);
      first.hold();
      const shut = drainStops(deps.serviceStops, noop, noop);
      await settle();
      // 켜기·재설치가 이름 줄에서 기다리다 종료 중에 배선된 모양 — 시작이 실패해도 등록된다.
      await wirePlugin(fakePlugin("c1-late", ["observer"], { startObserver: boom, stop: late.stop }), deps);
      first.release();
      await shut;
      out.push(
        assert(
          "★종료 소비 도중(앞 stop 대기 중) 새로 배선된 인스턴스도 그 소비가 끝나기 전에 stop 1회 — «한꺼번에 비워 가져오기» 면 놓친다",
          first.count() === 1 && late.count() === 1 && deps.serviceStops.length === 0,
          { first: first.count(), late: late.count(), left: deps.serviceStops.length },
        ),
      );
    }
    // D5 순회 중 앞 항목이 끄기로 빠져도 뒤 항목을 안 건너뛴다
    {
      const a = stopProbe();
      const b = stopProbe();
      const c = stopProbe();
      const deps = freshDeps();
      const ra = await wirePlugin(fakePlugin("c1-a", ["observer"], { startObserver: ok, stop: a.stop }), deps);
      await wirePlugin(fakePlugin("c1-b", ["service"], { startService: boom, stop: b.stop }), deps);
      await wirePlugin(fakePlugin("c1-c", ["trigger"], { startTrigger: ok, stop: c.stop }), deps);
      a.hold();
      const shut = drainStops(deps.serviceStops, noop, noop);
      await settle();
      const disposing = ra.dispose();
      a.release();
      await Promise.all([disposing, shut]);
      out.push(
        assert(
          "★★종료가 앞 항목 stop 을 기다리는 사이 그 항목이 끄기로 빠져도 뒤 항목을 건너뛰지 않는다(각 1회) — 종전 for…of 는 배열이 당겨져 다음 항목을 건너뛰었다",
          a.count() === 1 && b.count() === 1 && c.count() === 1,
          { a: a.count(), b: b.count(), c: c.count() },
        ),
      );
    }
    // D6 순서·단계 표시·던져도 계속 — 종료가 보는 그 형상
    {
      const events: string[] = [];
      const channels = [
        { name: "ch1", stop: async () => void events.push("stop:ch1") },
      ];
      const services = [
        { name: "s1", stop: async () => { events.push("stop:s1"); throw new Error("s1 boom"); } },
        { name: "s2", stop: async () => void events.push("stop:s2") },
      ];
      await drainStops(channels, (n) => events.push(`step:${n}`), (n, e) => events.push(`err:${n}:${e}`));
      await drainStops(services, (n) => events.push(`step:${n}`), (n, e) => events.push(`err:${n}:${e}`));
      const want = ["step:ch1", "stop:ch1", "step:s1", "stop:s1", "err:s1:s1 boom", "step:s2", "stop:s2"];
      out.push(
        assert(
          "종료 소비는 항목마다 단계 표시 → stop 순 · 원래 순서 유지 · stop 이 던져도 다음 항목으로 간다",
          JSON.stringify(events) === JSON.stringify(want) && channels.length === 0 && services.length === 0,
          events,
        ),
      );
    }

    // D7 종료가 채널을 꺼낸 뒤 **다른 플러그인**이 같은 채널 이름으로 붙는다 → 옛 인스턴스의 끄기는 새 것을 건드리지 않는다 (R1 결함)
    {
      const a = stopProbe();
      const b = stopProbe();
      const deps = freshDeps();
      // ★두 플러그인이 **같은 outbound 객체**를 내도(공유 모듈 등) 등록 단위로 가린다 — 값으로 가리면 옛 끄기가 새 등록을 지웠다(R2).
      const shared = { name: "shared-outbound" };
      const ra = await wirePlugin(
        fakePlugin("c1-chan-a", ["channel"], { name: "c1-dup-channel", startChannel: ok, stop: a.stop, outbound: shared }),
        deps,
      );
      // 종료가 채널 소비를 끝냈다(서비스 정지 단계) — 그 채널 이름은 이제 비어 있다.
      await drainStops(deps.channels, noop, noop);
      const rb = await wirePlugin(
        fakePlugin("c1-chan-b", ["channel"], { name: "c1-dup-channel", startChannel: ok, stop: b.stop, outbound: shared }),
        deps,
      );
      const bWired = rb.wired.includes("channel");
      await ra.dispose();
      const after = {
        bWired,
        bStops: b.count(),
        bStillListed: deps.channels.some((c) => c.name === "c1-dup-channel"),
        outboundKept: getChannelOutbound("c1-dup-channel") === (shared as unknown),
        providerIsB: channelPluginName("c1-dup-channel") === "c1-chan-b",
        aStops: a.count(),
      };
      await rb.dispose();
      const cleaned = getChannelOutbound("c1-dup-channel") === undefined && channelPluginName("c1-dup-channel") === undefined;
      out.push(
        assert(
          "★★종료가 꺼낸 채널 이름에 다른 플러그인이 붙은 뒤 옛 인스턴스를 꺼도 새 채널은 stop 0회·목록·아웃바운드·제공자 표시 유지 — 이름으로 찾던 되돌림은 새 것을 빼고 멈췄다",
          after.bWired && after.bStops === 0 && after.bStillListed && after.outboundKept && after.providerIsB && after.aStops === 1 && b.count() === 1 && cleaned,
          { ...after, bStopsAfterOwnDispose: b.count(), cleaned },
        ),
      );
    }
    // D8 다중 capability — 첫 훅 실패 뒤 다음 훅이 기다리는 동안엔 아직 정리 항목이 없다 · stop 은 마지막 시작이 끝난 뒤 (R1 결함)
    {
      const events: string[] = [];
      let openObserver: (() => void) | undefined;
      const observerGate = new Promise<void>((r) => {
        openObserver = r;
      });
      const deps = freshDeps();
      const wiring = wirePlugin(
        fakePlugin("c1-multi-order", ["trigger", "observer"], {
          startTrigger: async () => {
            events.push("trigger-start");
            throw new Error("trigger boom");
          },
          startObserver: async () => {
            await observerGate;
            events.push("observer-subscribed");
          },
          stop: async () => void events.push("stop"),
        }),
        deps,
      );
      await settle();
      const registeredWhileStarting = deps.serviceStops.length;
      await drainStops(deps.serviceStops, noop, noop);
      openObserver?.();
      const r = await wiring;
      const registeredAfter = deps.serviceStops.length;
      await r.dispose();
      out.push(
        assert(
          "★★첫 시작 훅이 실패하고 다음 훅이 아직 도는 동안 종료가 소비해도 stop 은 그 훅보다 먼저 불리지 않는다 · 시작이 다 끝난 뒤 1개 등록 → 끄기에서 1회",
          registeredWhileStarting === 0 &&
            registeredAfter === 1 &&
            JSON.stringify(events) === JSON.stringify(["trigger-start", "observer-subscribed", "stop"]),
          { registeredWhileStarting, registeredAfter, events },
        ),
      );
    }

    // D9 시작을 시도한 뒤 루프가 **바깥으로** 던져도(배선 격리 catch) 정리 등록은 남는다 — `finally` (R2 검사 부족)
    {
      const probe = stopProbe();
      let triggerStarted = false;
      const inst: Record<string, unknown> = {
        startTrigger: async () => {
          triggerStarted = true;
        },
        stop: probe.stop,
      };
      // observer 전용 훅이 없어 폴백 `start` 를 읽는 순간 던진다 — 훅별 try 밖이다.
      Object.defineProperty(inst, "start", {
        get: () => {
          throw new Error("start getter boom");
        },
      });
      const deps = freshDeps();
      const r = await wirePlugin(fakePlugin("c1-loop-throws", ["trigger", "observer"], inst), deps);
      const isolated = r.skipped.some((s) => s.capability === "*" && s.reason.includes("start getter boom"));
      const registered = deps.serviceStops.length;
      await r.dispose();
      out.push(
        assert(
          "★시작 훅 하나를 부른 뒤 루프가 훅별 try 밖에서 던져도 배선은 격리(skipped '*')되고 정리 1개가 남아 끄기에서 stop 1회",
          triggerStarted && isolated && registered === 1 && probe.count() === 1,
          { triggerStarted, isolated, registered, stops: probe.count(), skipped: r.skipped },
        ),
      );
    }

    // ── E. 번들 stop 을 시작 없이 부르기 — 시작 실패 뒤 불려도 무해한가 ─────────────────────
    {
      assertIsolated();
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const results: string[] = [];
      let bad = 0;
      for (const rel of ["../../../plugins/scheduler/src/index.ts", "../../../plugins/file-watch/src/index.ts", "../../../plugins/dashboard/index.ts"]) {
        try {
          const mod = await loadPluginModule<{ default: new () => { stop: () => Promise<void> } }>(rel);
          const inst = new mod.default();
          await inst.stop();
          await inst.stop();
          results.push(`${rel}: ok`);
        } catch (e) {
          bad += 1;
          results.push(`${rel}: ★${e instanceof Error ? e.message : String(e)}`);
        }
      }
      out.push(
        assert(
          "번들 scheduler·file-watch·dashboard 의 stop() 은 한 번도 시작 안 한 인스턴스에서 불려도(두 번 연달아도) 던지지 않는다",
          bad === 0,
          results,
        ),
      );
    }

    return out;
  },
};
