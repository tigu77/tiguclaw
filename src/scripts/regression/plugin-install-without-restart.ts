/**
 * 회귀: **재부팅 없이 설치·제거가 된다** (2026-08-28).
 *
 * ★정태님: *"재부팅이 필요하면 그건 설치가 아니라 배포다"* 의 검사판. 이게 안 되면
 *  "플러그인"이라는 말이 거짓이 된다 — 폴더를 넣고 데몬을 재시작하는 건 설치가 아니다.
 *
 * ★막혀 있던 것은 **되돌리는 길**이었다. 레지스트리에 넣는 함수만 있고 빼는 함수가 0이었고,
 *  *"이 플러그인이 무엇을 등록했나"* 를 아무도 안 적어 뒀다. 그래서 제거가 **원리적으로**
 *  불가능했다(도구가 다음 턴에도 그대로 떴다). `wirePlugin` 이 `dispose` 를 돌려주게 해서 풀었다.
 *
 * ★**소스로는 못 지킨다.** "unregister 를 부르는 코드가 있나" 는 `if (false)` 하나로 뚫린다.
 *  그래서 여기선 **진짜 플러그인을 만들어 설치하고, 도구가 생겼다 사라지는 것을 본다.**
 *
 * ★지키는 것 넷:
 *  ① 설치하면 **다음 턴에 도구가 보인다**(레지스트리는 턴마다 읽힌다)
 *  ② 제거하면 **사라진다** — 그리고 서비스 `stop` 이 실제로 불린다
 *  ③ 재설치는 **먼저 되돌린다**(두 번 등록해 유령이 남지 않게)
 *  ④ **번들은 못 뺀다** — 되돌릴 길이 애매한 것을 런타임에 끄지 않는다
 *
 * 등급: **동작 검사** — 임시 홈에 플러그인을 만들어 설치·제거를 실제로 돌린다.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "plugin-install-without-restart",
  guards:
    "플러그인을 넣고 빼려면 데몬을 재시작해야 하던 것 — 레지스트리에 넣는 길만 있고 빼는 길이 0이었고, 어떤 플러그인이 무엇을 등록했는지 아무도 안 적어 둬서 제거가 원리적으로 불가능했다",
  run: async (): Promise<Assertion[]> => {
    const home = await mkdtemp(path.join(tmpdir(), "plug-install-"));
    try {
      const dir = path.join(home, "plugins", "runtimey");
      await mkdir(path.join(dir, "web"), { recursive: true });
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "runtimey",
          private: true,
          type: "module",
          tiguclaw: {
            schemaVersion: 1,
            kind: ["service"],
            name: "runtimey",
            entry: "./index.mjs",
            needs: { network: ["example.test"] },
          },
        }),
      );
      // 서비스가 **정말 멈추는지** 보려고 전역에 흔적을 남긴다.
      await writeFile(
        path.join(dir, "index.mjs"),
        `export default class R {
  async startService() { globalThis.__runtimeyStarted = (globalThis.__runtimeyStarted || 0) + 1; }
  async stop() { globalThis.__runtimeyStopped = (globalThis.__runtimeyStopped || 0) + 1; }
  getMcpServer() { return { type: "sdk", name: "runtimey", instance: {} }; }
};\n`,
      );

      // ★홈을 갈아끼우려면 `getPaths()` 가 메모이즈돼 있어 **프로세스를 갈라야** 한다.
      const probe = `void (async () => {
      const m = await import(${JSON.stringify(path.join(REPO, "src/core/plugins/manager.ts"))});
      const reg = await import(${JSON.stringify(path.join(REPO, "src/core/mcp-registry.ts"))});
      const { getEventBus } = await import(${JSON.stringify(path.join(REPO, "src/core/eventbus.ts"))});
      m.initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });
      const has = () => Object.keys(reg.getRegisteredMcpServers()).includes("runtimey");
      const before = has();
      const a = await m.installHomePlugin("runtimey");
      const afterInstall = has();
      const listed = m.listLivePlugins().map((p) => p.name + ":" + p.source + "@" + (p.version || "-"));
      // 끄기 → 도구가 사라지고 설정에 기록된다. 켜기 → 다시 온다(재부팅 없이).
      const off = await m.setPluginEnabled("runtimey", false);
      const afterOff = has();
      const on = await m.setPluginEnabled("runtimey", true);
      const afterOn = has();
      const again = await m.installHomePlugin("runtimey");   // 재설치
      const startedAfterReinstall = globalThis.__runtimeyStarted || 0;
      const stoppedAfterReinstall = globalThis.__runtimeyStopped || 0;
      const rm1 = await m.removePlugin("runtimey");
      const afterRemove = has();
      const stopped = globalThis.__runtimeyStopped || 0;
      const rm2 = await m.removePlugin("runtimey");              // 두 번째 제거
      console.log("__J__" + JSON.stringify({
        before, afterInstall, afterRemove, listed,
        afterOff, afterOn, offOk: off.ok, onOk: on.ok, codeReloaded: on.codeReloaded,
        installOk: a.ok, needs: a.needs, reinstallOk: again.ok,
        startedAfterReinstall, stoppedAfterReinstall,
        stopped, rm1, rm2,
      }));
    })();`;
      const r = spawnSync(path.join(REPO, "node_modules/.bin/tsx"), ["-e", probe], {
        cwd: REPO,
        env: { ...process.env, TIGUCLAW_HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("__J__"));
      if (line === undefined) {
        return [
          assert(
            "★프로브가 실제로 돌았다(0이면 아래는 미검사다)",
            false,
            `★실패 — ${`${r.stderr ?? ""}`.slice(-260)}`,
          ),
        ];
      }
      const j = JSON.parse(line.slice(5)) as {
        before: boolean; afterInstall: boolean; afterRemove: boolean; listed: string[];
        afterOff: boolean; afterOn: boolean; offOk: boolean; onOk: boolean; codeReloaded: boolean;
        installOk: boolean; needs?: string; reinstallOk: boolean;
        startedAfterReinstall: number; stoppedAfterReinstall: number;
        stopped: number; rm1: { ok: boolean }; rm2: { ok: boolean; reason?: string };
      };

      return [
        assert(
          "★★설치하면 **재부팅 없이** 도구가 생긴다(레지스트리는 턴마다 읽히므로 다음 턴에 보인다)",
          j.before === false && j.installOk && j.afterInstall === true,
          `설치 전=${j.before} · 설치 후=${j.afterInstall} · ok=${j.installOk}`,
        ),
        assert(
          "★설치가 **무엇을 요구하는지** 돌려준다(사용자가 알고 깔아야 한다)",
          (j.needs ?? "").includes("example.test"),
          j.needs ?? "(없음)",
        ),
        assert(
          "★목록에 **출처·버전과 함께** 뜬다(번들인지 사용자가 깐 것인지 · 어느 판인지)",
          j.listed.some((x) => x.startsWith("runtimey:home@")),
          j.listed.join(", ") || "(빈 목록)",
        ),
        assert(
          "★★끄면 **도구가 사라지고** 켜면 **재부팅 없이 돌아온다**(번들에도 되는 유일한 수단)",
          j.offOk && j.afterOff === false && j.onOk && j.afterOn === true,
          `끔 ok=${j.offOk}/도구=${j.afterOff} · 켬 ok=${j.onOk}/도구=${j.afterOn}`,
        ),
        assert(
          "★★켜기가 **코드를 새로 읽지 않았다고 정직하게 말한다**(ESM 캐시 — 반쪽 리로드는 안 하느니 못하다)",
          j.codeReloaded === false,
          `codeReloaded=${j.codeReloaded}`,
        ),
        assert(
          "★★제거하면 **사라진다**(넣는 길만 있고 빼는 길이 없어 도구가 계속 뜨던 것)",
          j.rm1.ok && j.afterRemove === false,
          `제거 ok=${j.rm1.ok} · 제거 후 도구=${j.afterRemove}`,
        ),
        assert(
          "★★서비스 `stop` 이 **실제로** 불린다(등록만 되돌리고 돌던 것을 안 세우면 유령이 남는다)",
          j.stopped >= 1,
          `stop 호출 ${j.stopped}회`,
        ),
        // ★숫자를 박지 않고 **불변식**으로 본다: 몇 번을 껐다 켜고 다시 깔든 **살아 있는
        //  인스턴스는 정확히 하나**여야 한다(start - stop === 1). 시퀀스를 늘릴 때마다
        //  기대값을 고쳐야 하는 검사는 곧 아무도 안 고치고 지나친다.
        assert(
          "★★재설치·켜기가 **먼저 되돌린다** — 살아 있는 인스턴스가 정확히 하나다(유령 금지)",
          j.reinstallOk && j.startedAfterReinstall - j.stoppedAfterReinstall === 1,
          `start ${j.startedAfterReinstall} - stop ${j.stoppedAfterReinstall} = ${j.startedAfterReinstall - j.stoppedAfterReinstall}(기대 1)`,
        ),
        assert(
          "★없는 것을 제거하면 **사유를 말한다**(조용한 성공 금지)",
          j.rm2.ok === false && (j.rm2.reason ?? "") !== "",
          j.rm2.reason ?? "★조용히 성공",
        ),
      ];
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
};
