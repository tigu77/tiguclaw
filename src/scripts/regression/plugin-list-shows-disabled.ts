/**
 * 회귀: **목록은 꺼진 것도 보여주고, 보려고 코드를 실행하지 않는다** (2026-08-28).
 *
 * ★UI 를 그리다 구멍이 보였다: `LIVE` 만 보여주면 **끄는 순간 목록에서 사라져 다시 켤 수가
 *  없다**(일방통행 문). 사용자에겐 "플러그인이 없어졌다" 로 보인다.
 *
 * ★그런데 꺼진 것을 보려고 `loadPlugins` 를 쓰면 **코드를 실행**하게 된다. 지금은 우리 것
 *  뿐이라 무해하지만, 서드파티를 받는 순간 그건 *"구경만 하려다 실행"* 이 된다.
 *  그래서 `scanPluginManifests` 가 **매니페스트만** 읽는다 — 지금 갈라 두는 게 싸다.
 *
 * 등급: **동작 검사** — 임시 홈에 **import 하면 던지는** 플러그인을 두고, 그래도 목록에
 * 나오는지 본다. 소스로는 "실행 안 한다" 를 지킬 수 없다.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { probeInterpreter } from "./_probe-helpers.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const manifest = (name: string): string =>
  JSON.stringify({
    name,
    version: "9.9.9",
    private: true,
    type: "module",
    tiguclaw: {
      schemaVersion: 1,
      kind: ["service"],
      name,
      entry: "./index.mjs",
      needs: { network: ["listed.test"] },
    },
  });

export const check: RegressionCheck = {
  name: "plugin-list-shows-disabled",
  guards:
    "목록이 돌고 있는 것만 보여줘서 끄는 순간 사라지고 다시 켤 수 없던 것(일방통행 문) + 목록을 보려고 남의 플러그인 코드를 실행하던 것",
  run: async (): Promise<Assertion[]> => {
    const home = await mkdtemp(path.join(tmpdir(), "plug-list-"));
    try {
      // ★`import` 하는 순간 **던지는** 플러그인. 목록에 뜨면 = 코드를 안 돌렸다는 증거다.
      const boom = path.join(home, "plugins", "boomy");
      await mkdir(boom, { recursive: true });
      await writeFile(path.join(boom, "package.json"), manifest("boomy"));
      await writeFile(
        path.join(boom, "index.mjs"),
        'throw new Error("이 모듈은 import 되면 안 된다");\n',
      );
      // 정상 플러그인 — 설치했다가 꺼도 목록에 남아야 한다.
      const ok = path.join(home, "plugins", "okey");
      await mkdir(ok, { recursive: true });
      await writeFile(path.join(ok, "package.json"), manifest("okey"));
      await writeFile(
        path.join(ok, "index.mjs"),
        "export default class O { async startService() {} async stop() {} };\n",
      );

      const probe = `void (async () => {
      const m = await import(${JSON.stringify(path.join(REPO, "src/core/plugins/manager.ts"))});
      const { getEventBus } = await import(${JSON.stringify(path.join(REPO, "src/core/eventbus.ts"))});
      m.initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });
      const first = await m.listAllPlugins();
      await m.installHomePlugin("okey");
      const afterInstall = await m.listAllPlugins();
      await m.setPluginEnabled("okey", false);
      const afterOff = await m.listAllPlugins();
      const pick = (l, n) => l.find((p) => p.name === n) || null;
      console.log("__J__" + JSON.stringify({
        boomListed: pick(first, "boomy") !== null,
        boomNeeds: pick(first, "boomy")?.needs || "",
        boomVersion: pick(first, "boomy")?.version || "",
        boomEnabled: pick(first, "boomy")?.enabled,
        okOn: pick(afterInstall, "okey")?.enabled,
        okStillListed: pick(afterOff, "okey") !== null,
        okOff: pick(afterOff, "okey")?.enabled,
        bundledSeen: first.filter((p) => p.source === "bundled").length,
      }));
    })();`;
      const r = spawnSync(probeInterpreter(REPO), ["-e", probe], {
        cwd: REPO,
        env: { ...process.env, TIGUCLAW_HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("__J__"));
      if (line === undefined) {
        return [
          assert("★프로브가 돌았다(0이면 아래는 미검사)", false, `★${`${r.stderr ?? ""}`.slice(-260)}`),
        ];
      }
      const j = JSON.parse(line.slice(5)) as {
        boomListed: boolean; boomNeeds: string; boomVersion: string; boomEnabled: boolean;
        okOn: boolean; okStillListed: boolean; okOff: boolean; bundledSeen: number;
      };

      return [
        assert(
          "★★목록을 보려고 **코드를 실행하지 않는다**(import 하면 던지는 플러그인도 목록엔 뜬다 — 서드파티를 받으면 '구경만 하려다 실행' 이 된다)",
          j.boomListed === true && j.boomEnabled === false,
          `목록에 뜸=${j.boomListed} · 켜짐=${j.boomEnabled}`,
        ),
        assert(
          "★실행 없이도 **버전·요구 권한**을 읽는다(매니페스트만으로 충분하다)",
          j.boomVersion === "9.9.9" && j.boomNeeds.includes("listed.test"),
          `v${j.boomVersion} · ${j.boomNeeds}`,
        ),
        assert(
          "★★껐어도 **목록에 남는다**(사라지면 다시 켤 수가 없다 — 일방통행 문)",
          j.okOn === true && j.okStillListed === true && j.okOff === false,
          `설치 후=${j.okOn} · 끈 뒤 남음=${j.okStillListed} · 끈 뒤 켜짐=${j.okOff}`,
        ),
        assert(
          "★번들도 같은 목록에 나온다(끄는 건 번들에도 되므로 보여야 한다)",
          j.bundledSeen > 0,
          `번들 ${j.bundledSeen}개`,
        ),
      ];
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
};
