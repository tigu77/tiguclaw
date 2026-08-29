/**
 * 플러그인 배선 — 로더가 인스턴스화한 것을 capability 별로 코어에 꽂는다.
 *
 * ★왜 `index.ts` 밖으로 나왔나 (2026-08-26). 종전엔 이 로직이 `index.ts` 의 top-level
 *  `try` **하나** 안에 통째로 있었고, 그래서 결함이 둘이었다:
 *
 *   ① **한 플러그인의 예외가 뒤의 전부를 죽였다.** `kind:"channel"` 이라 선언했는데
 *      `startChannel` 도 `start` 도 없으면 `undefined.bind(...)` 가 TypeError 를 던지는데,
 *      그 계산이 각 capability 의 inner try **밖**에 있었다 → 바깥 catch 로 튀어 루프가
 *      끝난다 → 그 뒤 플러그인은 채널도 트리거도 MCP 도구도 등록되지 않는다. 남는 흔적은
 *      `loadPlugins failed:` 한 줄뿐이라 어느 플러그인인지도 안 나온다. 디렉터리 순서라
 *      첫 번째(`cli-channel`)가 어긋나면 나머지 여섯이 통째로 사라진다.
 *      ★인스턴스화 단계는 `loader.ts` 가 이미 플러그인별로 격리한다 — **배선만 격리가
 *      없었다.** 여기서 그 대칭을 복구한다.
 *   ② **검사가 문자열 grep 밖에 못 했다.** top-level 코드는 부르는 방법이 없다
 *      ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못
 *      놓인 것"). 함수로 나오면 회귀가 진짜로 부를 수 있고, 그래서 결과를 `WireResult`
 *      로 **돌려준다**(콘솔을 엿보지 않아도 판정된다).
 */
import path from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, MessageHandler } from "../../channels/types.js";
import {
  registerChannelOutbound,
  unregisterChannelOutbound,
  type ChannelOutbound,
} from "../channel-outbound.js";
import { buildToolServer, readToolSpecs } from "./tools.js";
import { registerMcpServer, unregisterMcpServer } from "../mcp-registry.js";
import {
  registerPluginDataRoutes,
  unregisterPluginDataRoutes,
  type PluginDataRoutes,
} from "./data-routes.js";
import { createPluginHost, type PluginHost } from "./host.js";
import type { EventBus } from "../eventbus.js";
import { appRoot } from "../paths.js";
import type { LoadedPlugin } from "./loader.js";

/** 배선 결과 — 회귀가 콘솔 대신 이 값을 본다. */
export interface WireResult {
  /** 실제로 꽂힌 capability (선언했고 훅도 있었던 것). */
  wired: string[];
  /** 건너뛴 것 — 선언은 했는데 못 꽂았다. */
  skipped: Array<{ capability: string; reason: string }>;
  /**
   * **이 플러그인이 등록한 것을 전부 되돌린다** (2026-08-28, 런타임 설치/제거).
   *
   * ★없어서 막혔다. 배선은 등록을 **여기저기 흩뿌린다**(채널 목록·outbound 레지스트리·
   *  MCP 레지스트리·서비스 stop) — 제거하려면 *"이 플러그인이 무엇을 등록했나"* 를 알아야
   *  하는데 그 기록이 없었다. 그래서 제거가 원리적으로 불가능했다.
   * ★고침은 목록을 새로 만드는 게 아니라 **등록하는 자리에서 되돌림을 같이 모으는 것**이다
   *  — 위젯 호스트(`onDispose`)에서 이미 검증한 형상이고, 손 목록이 안 생긴다.
   * ★**"더 이상 안 불린다" 까지**다. 코드는 프로세스에 남는다(ESM 언로드 없음) — 진짜
   *  언로드는 프로세스 경계가 있어야 한다(설계 §H).
   */
  dispose: () => Promise<void>;
}

export interface WirePluginDeps {
  bus: EventBus;
  /** 코어 채널 목록 — 플러그인 채널이 wrapper 로 push 된다. */
  channels: Channel[];
  /** shutdown 이 일괄 호출할 service stop 핸들. */
  serviceStops: Array<{ name: string; stop: () => Promise<void> }>;
}

/** 로더가 인스턴스화한 플러그인에서 덕 타이핑으로 읽는 면. */
interface PluginInstance {
  name?: string;
  start?: (arg: never) => Promise<void>;
  startChannel?: (handler: MessageHandler) => Promise<void>;
  startObserver?: (eventBus: EventBus) => Promise<void>;
  startTrigger?: (eventBus: EventBus) => Promise<void>;
  startService?: (eventBus: EventBus) => Promise<void>;
  stop?: () => Promise<void>;
  /**
   * ★`host` 는 **옵션**이다 — 안 받는 플러그인은 그대로 돈다(회귀 0).
   * ★플러그인이 코어를 만지는 **유일한 표면**이다(`core/plugins/host.ts`). 나중에 격리를
   *  넣을 때 이 표면만 IPC 로 바꾸면 되고, 플러그인은 안 고친다.
   */
  /**
   * 도구를 **SDK 없이** 선언한다 (2026-08-29). `getMcpServer` 의 형제 —
   * 저건 SDK 를 쓸 수 있는 사람용, 이건 아무것도 import 하지 않는 사람용.
   */
  getTools?: () => unknown;
  getMcpServer?: (
    host?: PluginHost,
  ) => McpSdkServerConfigWithInstance | undefined;
  /**
   * **데이터 라우트** — 위젯이 모델을 안 거치고 값을 받아오는 길 (2026-08-28, §E.2).
   *
   * ★`getMcpServer` 와 같은 형이다: capability 선언과 **무관**하게, 내면 배선된다.
   *  홈 위젯을 내는 플러그인은 도구도 같이 내는 게 보통이라 별도 `kind` 를 만들지 않는다.
   */
  getDataRoutes?: () => PluginDataRoutes | undefined;
  outbound?: ChannelOutbound;
  status?: "up" | "disabled";
}

const publishPluginError = (
  bus: EventBus,
  pluginName: string,
  phase: "load" | "start" | "runtime",
  error: string,
): void => {
  try {
    bus.publish({
      type: "plugin.error",
      ts: Date.now(),
      payload: { pluginName, phase, error },
    });
  } catch {
    // bus 자체 throw — 무시.
  }
};

/**
 * 선언한 capability ↔ 실제 훅 대조.
 *
 * 전용 훅(`startChannel` 등)이 우선, 없으면 단일 capability 플러그인용 `start` 폴백.
 * ★**둘 다 없으면 `undefined`** — 종전처럼 `undefined.bind()` 로 던지지 않는다. 던지는
 *  쪽이 나빴던 이유는 실패 자체가 아니라 **범위**였다(위 ① 참조).
 */
const resolveStartHook = <A>(
  inst: PluginInstance,
  specific: ((arg: A) => Promise<void>) | undefined,
): ((arg: A) => Promise<void>) | undefined => {
  if (typeof specific === "function") return specific.bind(inst);
  if (typeof inst.start === "function") {
    return (inst.start as (arg: A) => Promise<void>).bind(inst);
  }
  return undefined;
};

/**
 * 플러그인 하나를 배선한다. **이 함수는 던지지 않는다** — 자기 예외를 자기가 삼키고
 * `skipped` 에 이유를 남긴다(호출자 루프가 다음 플러그인으로 간다).
 */
export const wirePlugin = async (
  lp: LoadedPlugin,
  deps: WirePluginDeps,
): Promise<WireResult> => {
  const { bus, channels, serviceStops } = deps;
  // ★등록하는 자리에서 되돌림을 같이 모은다 — 나중에 목록을 다시 뒤지지 않는다.
  const undo: Array<() => Promise<void> | void> = [];
  const result: WireResult = {
    wired: [],
    skipped: [],
    dispose: async () => {
      // 역순 — 나중에 등록한 것부터 되돌린다(의존 순서를 뒤집는다).
      for (const fn of [...undo].reverse()) {
        try {
          await fn();
        } catch (e) {
          console.error(
            `[plugin-loader] ${lp.manifest.name} 되돌리기 실패: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      undo.length = 0;
    },
  };
  const inst = lp.instance as PluginInstance;
  const relDir = path.relative(appRoot(), lp.pluginDir);

  /** 선언은 했는데 못 꽂았다 — 이름·기대 훅을 대고 그 capability 만 건넌다. */
  const skip = (capability: string, reason: string): void => {
    result.skipped.push({ capability, reason });
    console.error(`[plugin-loader] ${lp.manifest.name}: ${reason}`);
    publishPluginError(bus, lp.manifest.name, "start", reason);
  };

  /** 훅 부재 메시지 — 로그만 보고 고칠 수 있게 기대값을 싣는다. */
  const missingHook = (capability: string, hook: string): string =>
    `kind "${capability}" 를 선언했는데 ${hook}() 도 start() 도 없습니다 ` +
    `(from ${relDir}) — 이 capability 만 건너뜁니다.`;

  try {
    // ─── MCP server registration (scheduler v1 §8.1 대안 C) ──────────────────
    // capability 무관 — plugin 인스턴스가 in-process MCP server 를 export 하면
    // registry 에 박는다. router 가 영역 A 호출 시 extraMcpServers 로 전달.
    if (typeof inst.getMcpServer === "function") {
      try {
        // ★부팅 땐 "있는지"만 확인하고, 실제 인스턴스는 **턴마다** 팩토리로 만든다
        //  (2026-08-10). 여기서 만든 하나를 registry 에 담아두면 프로세스 싱글턴이
        //  되고, 동시 턴에서 MCP transport 가 충돌한다 — mcp-registry.ts 주석 참조.
        const server = inst.getMcpServer();
        if (server !== undefined) {
          const getMcpServer = inst.getMcpServer.bind(inst);
          const needs = lp.manifest.needs ?? {};
          undo.push(() => {
            unregisterMcpServer(lp.manifest.name);
          });
          registerMcpServer(lp.manifest.name, (ctx) => {
            // ★턴 좌표를 **호스트로 감싸서** 준다 — 플러그인은 좌표가 아니라 능력을 받는다.
            const fresh = getMcpServer(
              createPluginHost(lp.manifest.name, needs, ctx, lp.manifest.settings ?? []),
            );
            if (fresh === undefined) {
              throw new Error(
                `plugin '${lp.manifest.name}' getMcpServer() 가 이번엔 undefined 를 돌려줬습니다`,
              );
            }
            return fresh;
          });
          result.wired.push("mcp");
          console.log(
            `registered mcp server from plugin: ${lp.manifest.name} (from ${relDir})`,
          );
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        result.skipped.push({ capability: "mcp", reason });
        console.error(
          `[plugin-loader] mcp server registration ${lp.manifest.name} failed: ${reason}`,
        );
      }
    }

    // ─── 도구 선언 등록 — **SDK 없이** (2026-08-29, tools.ts) ────────────────
    // ★`getMcpServer()` 와 형제다. 저건 SDK 를 쓸 수 있는 사람용이고, 이건 **아무것도
    //  import 하지 않는 사람용**이다 — 홈에 깔린 플러그인엔 `node_modules` 가 없어서
    //  SDK import 가 로드에서 죽는다(실측). 둘 다 내면 둘 다 실린다.
    if (typeof inst.getTools === "function") {
      try {
        const tv = readToolSpecs(inst.getTools());
        for (const problem of tv.problems) {
          // ★나쁜 칸 하나는 **그 도구만** 떨어뜨린다 — 오타 하나에 나머지가 같이 죽지 않는다.
          console.warn(`[plugin-loader] ${lp.manifest.name}: ${problem}`);
        }
        if (tv.specs.length > 0) {
          const needs = lp.manifest.needs ?? {};
          const name = `${lp.manifest.name}-tools`;
          undo.push(() => {
            unregisterMcpServer(name);
          });
          registerMcpServer(name, (ctx) =>
            buildToolServer(
              lp.manifest.name,
              tv.specs,
              createPluginHost(lp.manifest.name, needs, ctx, lp.manifest.settings ?? []),
            ),
          );
          result.wired.push("tools");
          console.log(
            `registered ${String(tv.specs.length)} tool(s) from plugin: ${lp.manifest.name} ` +
              `(${tv.specs.map((t) => t.name).join(", ")}) (from ${relDir})`,
          );
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        result.skipped.push({ capability: "tools", reason });
        console.error(`[plugin-loader] tool registration ${lp.manifest.name} failed: ${reason}`);
      }
    }

    // ─── 데이터 라우트 등록 (2026-08-28, 위젯 플랫폼 §E.2) ──────────────────
    // MCP 와 같은 형: capability 무관, 내면 배선된다. 실패는 이 플러그인만 건너뛴다.
    if (typeof inst.getDataRoutes === "function") {
      try {
        const routes = inst.getDataRoutes();
        if (routes !== undefined && Object.keys(routes).length > 0) {
          registerPluginDataRoutes(
            lp.manifest.name,
            lp.manifest.needs ?? {},
            routes,
            lp.manifest.settings ?? [],
          );
          undo.push(() => {
            unregisterPluginDataRoutes(lp.manifest.name);
          });
          result.wired.push("data-routes");
          console.log(
            `registered data routes from plugin: ${lp.manifest.name} ` +
              `(${Object.keys(routes).sort().join(", ")}) (from ${relDir})`,
          );
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        result.skipped.push({ capability: "data-routes", reason });
        console.error(
          `[plugin-loader] data route registration ${lp.manifest.name} failed: ${reason}`,
        );
      }
    }

    // ─── channel capability 등록 (start* 호출은 index.ts 의 channels.start loop) ──
    if (lp.capabilities.includes("channel")) {
      const channelName =
        typeof inst.name === "string" ? inst.name : lp.manifest.name;
      const conflict = channels.some((c) => c.name === channelName);
      const startFn = resolveStartHook<MessageHandler>(
        inst,
        inst.startChannel,
      );
      if (conflict) {
        const reason = `channel "${channelName}" 이름 충돌 — hardcoded 우선(플러그인 skip).`;
        result.skipped.push({ capability: "channel", reason });
        console.warn(`[plugin-loader] ${lp.manifest.name}: ${reason}`);
      } else if (startFn === undefined) {
        skip("channel", missingHook("channel", "startChannel"));
      } else {
        const stopFn =
          typeof inst.stop === "function"
            ? inst.stop.bind(inst)
            : async (): Promise<void> => {
                /* no-op */
              };
        undo.push(async () => {
          const i = channels.findIndex((c) => c.name === channelName);
          if (i >= 0) {
            const [removed] = channels.splice(i, 1);
            try {
              await removed?.stop();
            } catch {
              /* 이미 죽었을 수 있다 — 제거는 계속한다 */
            }
          }
        });
        channels.push({
          name: channelName,
          start: startFn,
          stop: stopFn,
          // presence 상태 forward(D1(b), §12.3) — 플러그인 채널은 wrapper 로 push 되므로
          // 인스턴스가 선언한 status 를 duck-type 으로 읽어 wrapper 에 실어야 presence 루프가
          // 본다(inst.outbound → registerChannelOutbound forward 와 동형). 미선언 = 미포함
          // → presence `?? "up"`(회귀 0).
          ...(inst.status !== undefined ? { status: inst.status } : {}),
        });
        // 아웃바운드 능력 등록(ADR 2026-07-16 §D1/§D3) — plugin 이 `outbound` 를 표명하면
        // 덕 타이핑으로 읽어 코어 레지스트리에 등록(startChannel 과 동형, §0 준수:
        // core→plugin import 0). http-bridge = 관측-전용(deliver 없음) 이지만 *등록*은 한다
        // ("미등록/unsupported" 과 구분). 코어 채널은 index.ts 의 start 루프가 등록.
        if (inst.outbound !== undefined) {
          registerChannelOutbound(channelName, inst.outbound);
          undo.push(() => {
            unregisterChannelOutbound(channelName);
          });
        }
        result.wired.push("channel");
        console.log(
          `loaded channel plugin: ${lp.manifest.name} (from ${relDir})`,
        );
      }
    }

    // ─── trigger / observer / service — 즉시 start(bus). 셋이 동형이라 한 루프다. ──
    // 외부 프로세스(대시보드 등) 기동·정리는 service 몫. stop() 은 shutdown 이 일괄 호출.
    const immediate: Array<{
      capability: "trigger" | "observer" | "service";
      hook: string;
      specific: ((bus: EventBus) => Promise<void>) | undefined;
    }> = [
      { capability: "trigger", hook: "startTrigger", specific: inst.startTrigger },
      {
        capability: "observer",
        hook: "startObserver",
        specific: inst.startObserver,
      },
      {
        capability: "service",
        hook: "startService",
        specific: inst.startService,
      },
    ];

    for (const { capability, hook, specific } of immediate) {
      if (!lp.capabilities.includes(capability)) continue;
      const startFn = resolveStartHook<EventBus>(inst, specific);
      if (startFn === undefined) {
        // ★**이미 무언가를 냈으면 그게 곧 그 capability 다** (2026-08-29). 종전엔 도구·
        //  데이터 라우트를 다 등록해놓은 플러그인에게 *"아무것도 없습니다"* 라고 경고했다.
        //  실측: 레포 밖에서 가이드대로 만든 플러그인이 첫 부팅에서 이 경고를 받았고,
        //  작성자 입장에선 **뭘 잘못했는지 알 수 없는 거짓 신호**다(아무것도 안 틀렸다).
        //  `service` 는 원래 "낼 것을 내는" 종류라 수명주기 훅이 필요 없다.
        const alreadyProvides =
          capability === "service" &&
          (result.wired.includes("mcp") ||
            result.wired.includes("tools") ||
            result.wired.includes("data-routes"));
        if (!alreadyProvides) skip(capability, missingHook(capability, hook));
        continue;
      }
      try {
        await startFn(bus);
        // ★**`service` 뿐 아니라 `trigger`·`observer` 도 멈춘다** (2026-08-29, 적대 검토 A).
        //  종전엔 `service`·`channel` 에만 `stop` 을 걸어서, 대시보드에서 스케줄러를 끄면
        //  *"끔"* 이 뜨고 목록에서 사라지는데 **cron 은 계속 돌아 계속 발화했다**(실측:
        //  dispose 전 tick 4 → 후 9). 번들 `scheduler`·`file-watch` 가 둘 다 `trigger` 이고
        //  `stop()` 을 구현해 뒀는데 그게 한 번도 안 불렸다.
        if (typeof inst.stop === "function") {
          undo.push(async () => {
            const i = serviceStops.findIndex((x) => x.name === lp.manifest.name);
            if (i >= 0) {
              const [removed] = serviceStops.splice(i, 1);
              try {
                await removed?.stop();
              } catch {
                /* 이미 죽었을 수 있다 */
              }
            }
          });
          serviceStops.push({
            name: lp.manifest.name,
            stop: inst.stop.bind(inst),
          });
        }
        result.wired.push(capability);
        console.log(
          `loaded ${capability} plugin: ${lp.manifest.name} (from ${relDir})`,
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        result.skipped.push({ capability, reason });
        console.error(
          `[plugin-loader] ${capability} ${lp.manifest.name} start failed: ${reason}`,
        );
        publishPluginError(bus, lp.manifest.name, "start", reason);
      }
    }
  } catch (e) {
    // ★배선 격리 — 위에서 못 예상한 무엇이 던져도 **이 플러그인만** 잃는다.
    //  종전엔 이 예외가 루프 전체를 끝냈다(뒤의 플러그인 전부 미등록).
    const reason = e instanceof Error ? e.message : String(e);
    result.skipped.push({ capability: "*", reason });
    console.error(`[plugin-loader] wiring ${lp.manifest.name} failed: ${reason}`);
    publishPluginError(bus, lp.manifest.name, "start", reason);
  }

  return result;
};
