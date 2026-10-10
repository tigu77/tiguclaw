/**
 * 회귀: **동시에 눌러도 도는 것은 하나, 끄면 0** (2026-10-09, 전체 적대 검토 P3).
 *
 * ★사고(검토자 실행 재현): `install-twice-runs-once` 는 **연달아**(await 하고 다시) 누르는
 *  경우만 쟀다. **동시에** 누르면 — 버튼 연타·두 탭·비서와 사람이 같이 — 두 설치가 둘 다
 *  «아직 없다» 를 읽고 각자 배선했고 `LIVE` 엔 뒤의 것만 남았다. 앞의 것은 아무도 못 끄는
 *  인스턴스가 됐다(observer 2개 시작 · 제거 뒤에도 running=2).
 *  게다가 배선의 stop 등록이 **이름**으로 «이미 있다» 를 판정해서, 같은 이름의 다른
 *  인스턴스가 있으면 새 인스턴스의 stop 을 아무 데도 안 걸었다.
 *
 * 지키는 것 셋:
 *  ① 같은 이름 동시 설치 → 도는 인스턴스 **1**, 제거하면 **0**.
 *  ② 동시에 «설치 + 끄기» 가 와도 마지막 결과대로 0 이다(문 넷이 같은 줄에 선다).
 *  ③ 배선 단위: 같은 이름의 두 인스턴스는 **각자의** stop 을 걸고, 하나를 걷어도 남의 것을
 *     안 뺀다(이름이 아니라 «이 인스턴스»).
 *
 * 등급: **전부 동작** — 실제 설치·제거·배선을 돌리고 살아 있는 인스턴스 수를 센다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEventBus } from "../../core/eventbus.js";
import { getPaths } from "../../core/paths.js";
import {
  initPluginManager,
  installHomePlugin,
  removePlugin,
  setPluginEnabled,
} from "../../core/plugins/manager.js";
import { wirePlugin } from "../../core/plugins/wire.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type G = { __raceRunning?: Record<string, number> };
const running = (name: string): number => (globalThis as G).__raceRunning?.[name] ?? 0;

const putObserver = async (name: string): Promise<void> => {
  const dir = path.join(getPaths().commonPlugins, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      version: "1.0.0",
      tiguclaw: { schemaVersion: 1, kind: ["observer"], name, entry: "./index.mjs" },
    }),
  );
  await writeFile(
    path.join(dir, "index.mjs"),
    `export default class O {
  async startObserver() { const r = (globalThis.__raceRunning ||= {}); r[${JSON.stringify(name)}] = (r[${JSON.stringify(name)}] || 0) + 1; }
  async stop() { globalThis.__raceRunning[${JSON.stringify(name)}] -= 1; }
};\n`,
  );
};

export const check: RegressionCheck = {
  name: "plugin-concurrent-install-no-leak",
  guards:
    "같은 이름을 동시에 두 번 설치하면 두 설치가 각자 배선해 앞의 인스턴스가 아무도 못 끄는 채 영구히 돌던 것 + 배선의 stop 등록이 이름으로 중복을 판정해 같은 이름의 다른 인스턴스가 있으면 새 인스턴스 stop 이 안 걸리던 것(2026-10-09 전체 적대 검토)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });

    // ① 동시 설치 ×2 → 제거.
    const A = "race-observer";
    await putObserver(A);
    const both = await Promise.all([installHomePlugin(A), installHomePlugin(A)]);
    const afterInstall = running(A);
    const rm = await removePlugin(A);
    out.push(
      assert(
        "★★같은 이름을 **동시에** 두 번 설치해도 도는 것은 하나, 제거하면 **0** — 하나라도 남으면 아무도 못 끄는 인스턴스다",
        both.every((r) => r.ok) && afterInstall === 1 && rm.ok && running(A) === 0,
        `설치 ok=${both.map((r) => String(r.ok)).join(",")} · 설치 뒤 running=${String(afterInstall)} · 제거 뒤 running=${String(running(A))}`,
      ),
    );

    // ② 동시에 설치 + 끄기 — 줄을 선 순서대로 끝나면 0.
    const B = "race-observer-b";
    await putObserver(B);
    await Promise.all([installHomePlugin(B), installHomePlugin(B), setPluginEnabled(B, false)]);
    out.push(
      assert(
        "★동시에 «설치·설치·끄기» 가 와도 마지막(끄기) 결과대로 running=0 — 네 문이 이름별로 한 줄에 선다",
        running(B) === 0,
        `running=${String(running(B))}`,
      ),
    );

    // ③ 배선 단위 — 같은 이름 두 인스턴스.
    const stopped: string[] = [];
    class Svc {
      constructor(readonly tag: string) {}
      async startService(): Promise<void> {}
      async stop(): Promise<void> {
        stopped.push(this.tag);
      }
    }
    const serviceStops: Array<{ name: string; stop: () => Promise<void> }> = [];
    const deps = { bus: getEventBus(), channels: [], serviceStops };
    const lp = (tag: string) => ({
      manifest: { schemaVersion: 1, kind: ["service"], name: "race-twin", entry: "x" },
      pluginDir: "/tmp/race-twin",
      capabilities: ["service"],
      instance: new Svc(tag),
    });
    await wirePlugin(lp("one"), deps);
    const w2 = await wirePlugin(lp("two"), deps);
    const registered = serviceStops.length;
    // 뒤의 것을 먼저 걷는다 — 이름으로 찾으면 **앞의 것**(남의 stop)을 빼 버린다.
    await w2.dispose();
    const afterDispose = [...stopped];
    // 그다음 셧다운 — 남은 등록이 정말 «one» 의 것이어야 한다.
    for (const s of [...serviceStops]) await s.stop();
    out.push(
      assert(
        "★★같은 이름의 두 인스턴스는 **각자의** stop 을 건다 — 하나를 걷으면 그것만 멈추고, 남은 등록은 다른 인스턴스의 것이다(셧다운이 그것을 멈춘다)",
        registered === 2 && afterDispose.join(",") === "two" && stopped.join(",") === "two,one",
        `등록 ${String(registered)}개 · dispose(two) 뒤 멈춘 것=[${afterDispose.join(",")}] · 셧다운 뒤=[${stopped.join(",")}]`,
      ),
    );
    return out;
  },
};
