/**
 * 회귀: **«모듈» 화면은 꺼진·밖의·위장한 플러그인 코드를 실행하지 않는다** (2026-10-09, 전체 적대 검토 P3).
 *
 * ★사고(검토자 실행 재현): 모듈 카드 수집(`providers.ts` `loadPluginModuleExports`)이 로더가
 *  쓰는 판정을 **하나도** 안 거쳤다. 그래서
 *   - `enabled:false`·제거한 홈 플러그인의 코드가 «모듈» 화면을 열 때마다 실행됐고,
 *   - `provider.entry: "../../outside/escape.js"` 가 플러그인 폴더 **밖** 파일을 실행했고,
 *   - `id:"core.daemon"` 카드가 코어 카드와 **두 장** 떴다(코어 카드 위장).
 *
 * 지키는 것 다섯:
 *  ① 꺼 둔 플러그인의 provider 코드는 **안 돈다**(로더와 같은 `refusalToRun`).
 *  ② 번들 이름을 단 홈 플러그인의 provider 코드도 **안 돈다**.
 *  ③ 폴더 밖을 가리키는 entry 는 **실행 시도조차 안 한다**.
 *  ④ 코어 id(`core.*`) 카드는 — 매니페스트로든 `load()` 결과로든 — 코어 카드를 덮지 못한다.
 *  ⑤ 정상 플러그인 카드는 그대로 뜬다(가드가 다 막으면 그것도 결함이다).
 *
 * 등급: **전부 동작** — 실제 `collectModules()` 를 돌리고 실행 흔적·카드를 센다.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../../core/paths.js";
import { setModuleDisabled } from "../../core/settings.js";
import { collectModules } from "../../core/plugins/providers.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type G = { __modRan?: string[] };
const ran = (): string[] => (globalThis as G).__modRan ?? [];

/** 실행되면 `__modRan` 에 tag 를 남기고, 지정한 id 의 카드를 내는 provider 소스. */
const providerSrc = (tag: string, cardId: string): string =>
  `(globalThis.__modRan ||= []).push(${JSON.stringify(tag)});
export const collectProvider = () => ({ id: ${JSON.stringify(cardId)}, kind: "plugin", name: ${JSON.stringify(tag)}, status: "active", summary: ${JSON.stringify(tag)}, updatedAt: new Date().toISOString() });\n`;

const putProviderPlugin = async (
  name: string,
  providerId: string,
  entry: string,
  src?: string,
): Promise<void> => {
  const dir = path.join(getPaths().commonPlugins, name);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      tiguclaw: {
        schemaVersion: 1,
        kind: ["provider"],
        name,
        entry: "./src/provider.mjs",
        provider: { id: providerId, entry },
      },
    }),
  );
  if (src !== undefined) await writeFile(path.join(dir, "src", "provider.mjs"), src);
};

export const check: RegressionCheck = {
  name: "module-cards-respect-plugin-gate",
  guards:
    "모듈 카드 수집이 로더의 판정을 안 거쳐 꺼 두거나 제거한 플러그인 코드가 «모듈» 화면을 열 때마다 실행되고, provider.entry 가 플러그인 폴더 밖 파일을 실행하고, core.daemon 카드를 위장해 두 장 뜨던 것(2026-10-09 전체 적대 검토)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const home = getPaths().home;
    const made = ["modgate-off", "modgate-escape", "modgate-spoof", "modgate-spoofload", "modgate-good", "running-work"];
    const outside = path.join(home, "modgate-outside.mjs");
    try {
      await putProviderPlugin("modgate-off", "plugin.modgate-off", "./src/provider.mjs", providerSrc("off", "plugin.modgate-off"));
      setModuleDisabled("modgate-off", true);
      await writeFile(outside, providerSrc("escape", "plugin.modgate-escape"));
      // pluginDir = <home>/plugins/modgate-escape → ../../ = <home>
      await putProviderPlugin("modgate-escape", "plugin.modgate-escape", "../../modgate-outside.mjs");
      await putProviderPlugin("modgate-spoof", "core.daemon", "./src/provider.mjs", providerSrc("spoof", "core.daemon"));
      await putProviderPlugin("modgate-spoofload", "plugin.modgate-spoofload", "./src/provider.mjs", providerSrc("spoofload", "core.daemon"));
      await putProviderPlugin("modgate-good", "plugin.modgate-good", "./src/provider.mjs", providerSrc("good", "plugin.modgate-good"));
      // 번들 이름(running-work) 쌍둥이 — 홈에서 그 이름으로 코드가 돌면 안 된다.
      await putProviderPlugin("running-work", "plugin.running-work-twin", "./src/provider.mjs", providerSrc("twin", "plugin.running-work-twin"));

      (globalThis as G).__modRan = [];
      const r = await collectModules();
      const ids = r.providers.map((m) => m.id);
      const coreDaemon = r.providers.filter((m) => m.id === "core.daemon");
      const tags = ran();

      out.push(
        assert(
          "★★꺼 둔 플러그인의 provider 코드는 **안 돈다** — 사용자는 껐다고 믿는다",
          !tags.includes("off") && !ids.includes("plugin.modgate-off"),
          `실행 흔적=[${tags.join(",")}]`,
        ),
      );
      out.push(
        assert(
          "★★번들 이름을 단 홈 플러그인의 provider 코드도 **안 돈다** — 로더와 같은 예약 판정",
          !tags.includes("twin") && !ids.includes("plugin.running-work-twin"),
          `실행 흔적=[${tags.join(",")}]`,
        ),
      );
      out.push(
        assert(
          "★★플러그인 폴더 **밖**을 가리키는 provider.entry 는 실행하지 않는다",
          !tags.includes("escape") && !ids.includes("plugin.modgate-escape"),
          `실행 흔적=[${tags.join(",")}]`,
        ),
      );
      out.push(
        assert(
          "★★코어 카드(`core.daemon`)는 **한 장** — 매니페스트 id 로도 load() 결과로도 위장 못 한다(위장한 쪽은 실행 전 거부 · 오류 카드)",
          coreDaemon.length === 1 &&
            coreDaemon[0]?.kind === "core" &&
            !tags.includes("spoof") &&
            r.providers.some((m) => m.id === "plugin.modgate-spoofload" && m.status === "error"),
          `core.daemon ${String(coreDaemon.length)}장 · spoof 실행=${String(tags.includes("spoof"))} · spoofload 카드=${JSON.stringify(r.providers.find((m) => m.id === "plugin.modgate-spoofload")?.status)}`,
        ),
      );
      out.push(
        assert(
          "★정상 플러그인 카드는 그대로 뜬다 — 가드가 다 막으면 그것도 결함이다",
          tags.includes("good") && ids.includes("plugin.modgate-good"),
          `실행 흔적=[${tags.join(",")}] · 카드=${String(ids.includes("plugin.modgate-good"))}`,
        ),
      );
    } finally {
      setModuleDisabled("modgate-off", false);
      for (const n of made) await rm(path.join(getPaths().commonPlugins, n), { recursive: true, force: true });
      await rm(outside, { force: true });
    }
    return out;
  },
};
