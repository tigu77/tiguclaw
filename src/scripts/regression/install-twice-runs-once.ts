/**
 * 회귀: **설치를 몇 번 눌러도 도는 것은 하나, 끄면 다 멈춘다** (2026-08-30).
 *
 * ★적대 검토(B-4)가 *"연달아 두 번 설치하면 끄기가 성공을 보고하고도 두 인스턴스가 계속
 *  돈다"* 고 보고했다. **실측해 보니 재현되지 않았다** — service·trigger·observer 셋 다,
 *  1·2·3회 설치 모두 `시작 수 == 정지 수`, 끈 뒤 tick **0**:
 *
 *  ```
 *  service ×2 → 끄기 : 시작 2 · 정지 2 · 끈 뒤 0
 *  ×3        → 제거 : 시작 3 · 정지 3 · 제거 뒤 0
 *  ```
 *
 *  보고된 기제(*"두 번째 배선이 빈 dispose 를 만들어 진짜 되돌림을 덮는다"*)도 코드와 맞지
 *  않는다 — `dispose` 는 배선마다 새로 만드는 클로저이고, 설치는 **새로 꽂기 전에** 기존
 *  것을 되돌린다.
 *
 * ★그래서 고칠 게 없었다. **대신 그 성질을 그물로 고정한다** — 지금 참인 것을 재확인하려고
 *  다음 사람이 같은 반나절을 쓰지 않게. 잰 값이 판정이고, 그 판정은 코드에 남아야 한다.
 *
 * 지키는 것 셋:
 *  ① 몇 번을 설치해도 **끄면 시작한 만큼 멈춘다**(하나라도 남으면 유령 타이머다).
 *  ② 끈 뒤엔 **한 tick 도 안 돈다** — "성공"을 보고하고 계속 도는 것이 최악이다(조용함).
 *  ③ 제거 경로도 같다(끄기만 덮으면 다른 문으로 샌다).
 *
 * 등급: **전부 동작** — 진짜 타이머를 돌리고 끈 뒤 증가분을 센다.
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
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Counts = { s?: number; p?: number; k?: number };
const g = (): Counts => globalThis as unknown as Counts;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const putTicker = async (name: string): Promise<void> => {
  const dir = path.join(getPaths().commonPlugins, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      version: "1.0.0",
      tiguclaw: { schemaVersion: 1, kind: ["service"], name, entry: "./index.mjs" },
    }),
  );
  // ★진짜 타이머를 돈다 — "멈췄다고 적혀 있나" 가 아니라 **정말 멈추나**를 봐야 한다.
  await writeFile(
    path.join(dir, "index.mjs"),
    `export default class T {
  async startService() {
    globalThis.s = (globalThis.s || 0) + 1;
    this.t = setInterval(() => { globalThis.k = (globalThis.k || 0) + 1; }, 20);
  }
  async stop() { globalThis.p = (globalThis.p || 0) + 1; clearInterval(this.t); }
};\n`,
  );
};

export const check: RegressionCheck = {
  name: "install-twice-runs-once",
  guards:
    "설치 버튼을 연달아 누르면 인스턴스가 겹쳐 쌓이고, 끄기가 성공을 보고하고도 유령 타이머가 계속 도는 것(적대 검토 B-4 가 보고 → 실측 결과 재현 안 됨 → 그 측정을 고정)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });

    const trial = async (
      name: string,
      times: number,
      close: () => Promise<{ ok: boolean }>,
    ): Promise<{ s: number; p: number; ticked: number; ok: boolean }> => {
      g().s = 0;
      g().p = 0;
      await putTicker(name);
      for (let i = 0; i < times; i++) await installHomePlugin(name);
      await wait(100);
      const before = g().k ?? 0;
      const r = await close();
      await wait(200);
      return { s: g().s ?? 0, p: g().p ?? 0, ticked: (g().k ?? 0) - before, ok: r.ok };
    };

    const twice = await trial("twice-ticker", 2, () => setPluginEnabled("twice-ticker", false));
    out.push(
      assert(
        "★★두 번 설치하고 끄면 **시작한 만큼 멈춘다** — 하나라도 남으면 아무도 모르는 타이머가 계속 돈다",
        twice.s > 0 && twice.s === twice.p,
        `시작 ${twice.s} · 정지 ${twice.p}`,
      ),
    );
    out.push(
      assert(
        "★★끈 뒤엔 **한 tick 도 안 돈다** — 성공을 보고하고 계속 도는 것이 가장 나쁘다(조용하다)",
        twice.ok && twice.ticked === 0,
        `끄기 ok=${String(twice.ok)} · 끈 뒤 tick ${twice.ticked}`,
      ),
    );

    const thrice = await trial("thrice-ticker", 3, () => removePlugin("thrice-ticker"));
    out.push(
      assert(
        "★제거 경로도 같다 — 끄기만 덮으면 다른 문으로 샌다(이 레포가 반복해서 데인 형태다)",
        thrice.ok && thrice.s === thrice.p && thrice.ticked === 0,
        `시작 ${thrice.s} · 정지 ${thrice.p} · 제거 뒤 tick ${thrice.ticked}`,
      ),
    );
    return out;
  },
};
