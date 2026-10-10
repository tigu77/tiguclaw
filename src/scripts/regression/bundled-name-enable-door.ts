/**
 * 회귀: **«켜기» 문도 번들 이름 예약을 지난다** (2026-10-09, 전체 적대 검토 P3).
 *
 * ★사고(검토자 실행 재현): 번들 이름 예약(B-1, `bundled-name-is-reserved`)은 **설치 문**에만
 *  있었다. `setPluginEnabled(name, true)` 는 번들 뿌리에서 못 찾으면(번들이 깨져 있으면)
 *  홈 뿌리로 넘어가 그 이름의 홈 플러그인을 **그대로 배선했다** — 설치 문이 거부한 바로 그
 *  코드다. 부팅도 홈 것을 `import`·인스턴스화한 **뒤에** 걸렀다(코드는 이미 돌았다).
 *
 * ★고침은 문을 하나 더 막는 게 아니라 **판정을 실행 직전 한 자리**(`loadPlugins` 의
 *  `refusalToRun`)로 내린 것이다 — 설치·켜기·부팅 셋이 같은 자리를 지난다.
 *
 * 지키는 것 셋:
 *  ① 깨진 번들의 이름으로 홈 플러그인을 «켜기» 해도 **거부**되고 코드가 **안 돈다**.
 *  ② 홈 뿌리를 로드하는 것 자체(부팅 경로)가 그 이름의 코드를 **`import` 하지 않는다**.
 *  ③ 번들 아닌 이름은 «켜기» 로 그대로 켜진다(가드가 다 막으면 그것도 결함이다).
 *
 * 등급: **전부 동작** — 실제 깨진 번들 폴더를 놓고 켜기·로드를 시도해 실행 흔적을 센다.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEventBus } from "../../core/eventbus.js";
import { appRoot, getPaths } from "../../core/paths.js";
import { loadPlugins } from "../../core/plugins/loader.js";
import { initPluginManager, removePlugin, setPluginEnabled } from "../../core/plugins/manager.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type G = { __enableDoorRan?: string[] };
const ran = (): string[] => (globalThis as G).__enableDoorRan ?? [];

const putHome = async (name: string): Promise<void> => {
  const dir = path.join(getPaths().commonPlugins, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      tiguclaw: { schemaVersion: 1, kind: ["service"], name, entry: "./index.mjs" },
    }),
  );
  // 모듈 최상위에서 흔적을 남긴다 — `import` 만 돼도 잡힌다(인스턴스화·start 이전).
  await writeFile(
    path.join(dir, "index.mjs"),
    `(globalThis.__enableDoorRan ||= []).push(${JSON.stringify(name)});
export default class P { async startService() {} async stop() {} };\n`,
  );
};

export const check: RegressionCheck = {
  name: "bundled-name-enable-door",
  guards:
    "번들 이름 예약이 설치 문에만 있어서, 번들이 깨진 순간 «켜기» 가 홈 뿌리로 넘어가 그 이름의 홈 플러그인을 배선하고 부팅도 그 코드를 import 한 뒤에 거르던 것(2026-10-09 전체 적대 검토, B-1 우회)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });
    const TWIN = "zz-enable-twin-probe";
    const GOOD = "zz-enable-good-probe";
    const brokenDir = path.join(appRoot(), "plugins", TWIN);
    try {
      // 매니페스트를 못 읽는 번들(중단된 /update 모양) — 이름은 예약되고 번들 뿌리에선 못 찾는다.
      await mkdir(brokenDir, { recursive: true });
      await writeFile(path.join(brokenDir, "package.json"), '{"name": "zz-trunc');
      await putHome(TWIN);
      await putHome(GOOD);
      (globalThis as G).__enableDoorRan = [];

      const en = await setPluginEnabled(TWIN, true);
      out.push(
        assert(
          "★★깨진 번들의 이름으로 홈 플러그인을 **«켜기»** 해도 거부되고, 그 코드는 한 줄도 안 돈다(설치 문이 거부한 바로 그 코드다)",
          en.ok === false && !ran().includes(TWIN),
          `켜기 ok=${String(en.ok)} · 실행 흔적=[${ran().join(",")}]`,
        ),
      );

      (globalThis as G).__enableDoorRan = [];
      const loaded = (await loadPlugins(getPaths().commonPlugins)).map((p) => p.manifest.name);
      out.push(
        assert(
          "★★홈 뿌리 로드(부팅 경로)가 번들 이름의 코드를 **`import` 조차 안 한다** — 거르는 게 실행 **앞**이다",
          !loaded.includes(TWIN) && !ran().includes(TWIN),
          `로드됨=[${loaded.filter((n) => n.startsWith("zz-")).join(",")}] · 실행 흔적=[${ran().join(",")}]`,
        ),
      );

      const good = await setPluginEnabled(GOOD, true);
      out.push(
        assert(
          "★번들 아닌 이름은 «켜기» 로 그대로 켜진다 — 가드가 다 막으면 그것도 결함이다",
          good.ok === true,
          `켜기 ok=${String(good.ok)} · ${String(good.reason ?? "")}`,
        ),
      );
      await removePlugin(GOOD);
    } finally {
      await rm(brokenDir, { recursive: true, force: true });
      for (const n of [TWIN, GOOD]) {
        await rm(path.join(getPaths().commonPlugins, n), { recursive: true, force: true });
      }
    }
    return out;
  },
};
