/**
 * 회귀: **플러그인 배선은 플러그인별로 격리된다** (2026-08-26).
 *
 * ★무엇이 깨져 있었나. `kind` 는 "이 훅을 제공한다"는 선언인데 **아무도 대조하지 않았다.**
 *  `index.ts` 는 이렇게 썼다:
 *
 *      typeof inst.startChannel === "function"
 *        ? inst.startChannel.bind(inst)
 *        : (inst.start as ...).bind(inst)      // ← 둘 다 없으면 undefined.bind → TypeError
 *
 *  그리고 이 계산이 각 capability 의 inner try **밖**에 있었고, 루프 전체가 top-level
 *  `try` 하나에 묶여 있었다. 그래서 **한 플러그인의 선언 오타가 뒤의 플러그인 전부를
 *  미등록**으로 만들었다 — 채널도 트리거도 MCP 도구도. 디렉터리 순서라 첫 번째
 *  (`cli-channel`)가 어긋나면 나머지 여섯이 통째로 사라지고, 남는 흔적은
 *  `loadPlugins failed:` 한 줄이라 **어느 플러그인인지도 안 나온다.**
 *
 *  인스턴스화 단계는 `loader.ts` 가 이미 플러그인별로 격리한다 — 배선만 격리가 없었다.
 *
 * ★왜 이 검사가 가능해졌나: 배선이 top-level 코드에서 `core/plugins/wire.ts` 의 함수로
 *  나왔기 때문이다. 종전 모양으로는 문자열 grep 밖에 못 했다
 *  ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못 놓인 것").
 *
 * 등급: **동작 검사** — 진짜 `wirePlugin` 을 부르고 반환값·부작용(channels 배열)을 본다.
 * 격리: 가짜 인스턴스는 `outbound`·`getMcpServer` 를 안 내므로 코어 레지스트리를 안 만진다.
 */
import type { Channel } from "../../channels/types.js";
import type { EventBus } from "../../core/eventbus.js";
import type { LoadedPlugin } from "../../core/plugins/loader.js";
import { wirePlugin, type WirePluginDeps } from "../../core/plugins/wire.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** publish 를 세는 최소 버스 — 실제 EventBus 를 쓰면 라이브 구독자에 닿는다. */
const fakeBus = (): { bus: EventBus; errors: number } => {
  const state = { errors: 0 };
  const bus = {
    publish: (e: { type: string }): void => {
      if (e.type === "plugin.error") state.errors += 1;
    },
    subscribe: () => () => undefined,
    history: () => [],
  } as unknown as EventBus;
  return {
    bus,
    get errors(): number {
      return state.errors;
    },
  };
};

const fakePlugin = (
  name: string,
  capabilities: string[],
  instance: Record<string, unknown>,
): LoadedPlugin =>
  ({
    manifest: {
      schemaVersion: 1,
      kind: capabilities,
      name,
      entry: "./index.ts",
    },
    pluginDir: `/tmp/regression-plugins/${name}`,
    capabilities,
    instance,
  }) as LoadedPlugin;

const freshDeps = (): WirePluginDeps & { channels: Channel[] } => ({
  bus: fakeBus().bus,
  channels: [] as Channel[],
  serviceStops: [],
});

export const check: RegressionCheck = {
  name: "plugin-wiring-isolation",
  guards:
    "kind 선언과 실제 훅이 어긋난 플러그인 하나가 undefined.bind TypeError 로 배선 루프 전체를 끝내, 뒤에 오는 플러그인이 전부(채널·트리거·MCP 도구) 조용히 미등록되던 것 + 어느 플러그인 탓인지 로그에 안 남던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 선언은 channel 인데 훅이 둘 다 없다 — 던지지 않고 그 capability 만 건넌다.
    {
      const deps = freshDeps();
      let threw = "";
      let skipped: string[] = [];
      try {
        const r = await wirePlugin(
          fakePlugin("broken-channel", ["channel"], { name: "broken" }),
          deps,
        );
        skipped = r.skipped.map((s) => s.capability);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      out.push(
        assert(
          "훅 없는 channel 선언은 던지지 않는다",
          threw === "",
          threw === "" ? "throw 0건" : `throw: ${threw}`,
        ),
      );
      out.push(
        assert(
          "훅 없는 channel 은 skipped 에 이름이 남는다",
          skipped.includes("channel"),
          JSON.stringify(skipped),
        ),
      );
      out.push(
        assert(
          "훅 없는 채널은 channels 에 안 들어간다",
          deps.channels.length === 0,
          `channels=${deps.channels.length}`,
        ),
      );
    }

    // ② ★핵심 — 어긋난 플러그인 **뒤**의 플러그인이 그대로 붙는다(격리).
    {
      const deps = freshDeps();
      const order = [
        fakePlugin("broken-first", ["channel"], {}),
        fakePlugin("good-second", ["channel"], {
          name: "good",
          startChannel: async (): Promise<void> => undefined,
        }),
      ];
      let threw = "";
      try {
        for (const lp of order) await wirePlugin(lp, deps);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      out.push(
        assert(
          "앞 플러그인이 어긋나도 루프가 안 죽는다",
          threw === "",
          threw === "" ? "throw 0건" : `throw: ${threw}`,
        ),
      );
      out.push(
        assert(
          "★뒤에 오는 정상 플러그인이 등록된다",
          deps.channels.length === 1 && deps.channels[0]?.name === "good",
          JSON.stringify(deps.channels.map((c) => c.name)),
        ),
      );
    }

    // ③ 정상 경로 보존 — 전용 훅 / start 폴백 둘 다 종전대로 붙는다.
    {
      const deps = freshDeps();
      const r1 = await wirePlugin(
        fakePlugin("with-specific", ["channel"], {
          name: "specific",
          startChannel: async (): Promise<void> => undefined,
        }),
        deps,
      );
      const r2 = await wirePlugin(
        fakePlugin("with-fallback", ["channel"], {
          name: "fallback",
          start: async (): Promise<void> => undefined,
        }),
        deps,
      );
      out.push(
        assert(
          "startChannel 전용 훅으로 배선된다",
          r1.wired.includes("channel"),
          JSON.stringify(r1),
        ),
      );
      out.push(
        assert(
          "start 폴백도 종전대로 배선된다(단일 capability 플러그인)",
          r2.wired.includes("channel"),
          JSON.stringify(r2),
        ),
      );
      out.push(
        assert(
          "둘 다 channels 에 들어간다",
          deps.channels.length === 2,
          JSON.stringify(deps.channels.map((c) => c.name)),
        ),
      );
    }

    // ④ start 가 던져도 그 capability 만 잃는다(종전 inner try 동작 보존).
    {
      const deps = freshDeps();
      let threw = "";
      let r = { wired: [] as string[], skipped: [] as Array<{ capability: string }> };
      try {
        r = await wirePlugin(
          fakePlugin("throwing-observer", ["observer"], {
            startObserver: async (): Promise<void> => {
              throw new Error("boom");
            },
          }),
          deps,
        );
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      out.push(
        assert(
          "start 가 던져도 wirePlugin 은 안 던진다",
          threw === "",
          threw === "" ? "throw 0건" : `throw: ${threw}`,
        ),
      );
      out.push(
        assert(
          "던진 observer 는 skipped 에 이유와 함께 남는다",
          r.skipped.some((s) => s.capability === "observer"),
          JSON.stringify(r.skipped),
        ),
      );
    }

    // ⑤ 여러 capability 겸직 — 하나가 어긋나도 나머지는 붙는다(http-bridge 모양).
    {
      const deps = freshDeps();
      const r = await wirePlugin(
        fakePlugin("hybrid", ["channel", "observer"], {
          name: "hybrid",
          // startChannel 만 있고 startObserver·start 는 없다 → observer 만 건너뛴다.
          startChannel: async (): Promise<void> => undefined,
        }),
        deps,
      );
      out.push(
        assert(
          "겸직 중 성립하는 capability 는 붙는다",
          r.wired.includes("channel"),
          JSON.stringify(r.wired),
        ),
      );
      out.push(
        assert(
          "겸직 중 훅 없는 capability 만 건너뛴다",
          r.skipped.some((s) => s.capability === "observer") &&
            !r.skipped.some((s) => s.capability === "channel"),
          JSON.stringify(r.skipped),
        ),
      );
    }

    // ── 끄면 **정말 멈춘다** (2026-08-29, 적대 검토 A) ──────────────────────
    // ★종전엔 `stop()` 되돌림이 `service`·`channel` 에만 걸려 있었다. 번들
    //  `scheduler`·`file-watch` 는 둘 다 `trigger` 이고 `stop()` 을 구현해 뒀는데 **한 번도
    //  안 불렸다** — 대시보드에서 끄면 "끔" 이 뜨고 목록에서 사라지는데 **cron 은 계속
    //  발화한다**(실측: dispose 전 tick 4 → 후 9). 종전 회귀는 `service` 하나로만 검사해서
    //  이 갈래를 한 번도 안 밟았다.
    {
      const notStopped: string[] = [];
      for (const kind of ["trigger", "observer", "service"] as const) {
        let stopped = 0;
        const hook = `start${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;
        const r = await wirePlugin(
          fakePlugin(`stop-${kind}`, [kind], {
            [hook]: async (): Promise<void> => undefined,
            stop: async (): Promise<void> => {
              stopped += 1;
            },
          }),
          freshDeps(),
        );
        await r.dispose();
        if (stopped !== 1) notStopped.push(`${kind}(${String(stopped)}회)`);
      }
      out.push(
        assert(
          "★★`trigger`·`observer`·`service` 를 끄면 **셋 다 `stop()` 이 불린다** — 종전엔 `service` 만이라, 번들 스케줄러를 꺼도 cron 이 계속 발화했다(사용자에겐 '껐다' 고 보이는데 알림이 계속 온다)",
          notStopped.length === 0,
          notStopped.length === 0 ? "trigger·observer·service 각 1회" : `★안 멈춤: ${notStopped.join(", ")}`,
        ),
      );
    }

    return out;
  },
};
