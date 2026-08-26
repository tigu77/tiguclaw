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
  type ChannelOutbound,
} from "../channel-outbound.js";
import { registerMcpServer } from "../mcp-registry.js";
import type { EventBus } from "../eventbus.js";
import { appRoot } from "../paths.js";
import type { LoadedPlugin } from "./loader.js";

/** 배선 결과 — 회귀가 콘솔 대신 이 값을 본다. */
export interface WireResult {
  /** 실제로 꽂힌 capability (선언했고 훅도 있었던 것). */
  wired: string[];
  /** 건너뛴 것 — 선언은 했는데 못 꽂았다. */
  skipped: Array<{ capability: string; reason: string }>;
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
  getMcpServer?: () => McpSdkServerConfigWithInstance | undefined;
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
  const result: WireResult = { wired: [], skipped: [] };
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
          registerMcpServer(lp.manifest.name, () => {
            const fresh = getMcpServer();
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
        skip(capability, missingHook(capability, hook));
        continue;
      }
      try {
        await startFn(bus);
        if (capability === "service" && typeof inst.stop === "function") {
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
