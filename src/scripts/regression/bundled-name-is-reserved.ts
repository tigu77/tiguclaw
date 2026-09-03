/**
 * 회귀: **번들 이름은 예약돼 있다 — 홈이 그 이름으로 못 들어온다** (2026-08-30).
 *
 * ★사고(적대 검토 B-1, 실측 재현): 같은 질문에 **두 답**이 있었다. 부팅은 디스크를 봤고,
 *  설치 문은 **돌고 있는 것**(`LIVE`)을 봤다. 그래서 번들 쌍둥이가 꺼져 있으면 그 이름이
 *  열렸다:
 *
 *  ```
 *  실제로 도는 것: home · 9.9.9-EVIL · network:attacker.test + outbound
 *  화면의 그 행 : bundled · 0.1.0 · "외부 미선언(모름)"
 *  ```
 *
 *  ★핵심은 라벨이 아니라 **권한 표시가 틀렸다**는 것이다. 화면은 "밖으로 아무것도 안
 *  합니다" 라고 하는데 나가겠다고 선언한 코드가 돌고 있었다 — `docs/security.ko.md §2` 가
 *  "목록에서 출처가 보입니다" 라고 약속하는 바로 그 자리다.
 *
 * 지키는 것 넷:
 *  ① 번들 이름으로는 설치가 **거부된다**.
 *  ② ★**번들 쌍둥이가 꺼져 있어도** 거부된다 — 이게 사고 자체다(가드가 LIVE 를 물었다).
 *  ③ 거부되면 그 코드는 **한 줄도 안 돈다**(거부 메시지만 맞고 배선은 됐다면 무의미하다).
 *  ④ ★판정이 **로드 성공이 아니라 디스크**다 — 번들 하나가 깨져도 그 이름은 예약된다.
 *     ★이 문장은 오래 **거짓**이었다(2026-08-30, 3라운드 D-3): 예약이 `scanPluginManifests`
 *     라 **스키마를 통과해야** 이름이 살았고, `entry` 한 줄만 지우면 그 이름이 홈에 열렸다.
 *     아래 ④는 이제 **깨진 번들을 실제로 하나 놓고** 잰다 — 안 재는 문장은 문장일 뿐이다.
 *  ⑤ 번들 아닌 이름은 그대로 설치된다(가드가 다 막으면 그것도 결함이다).
 *
 * 등급: **전부 동작** — 실제로 설치를 시도하고 전역 흔적으로 실행 여부를 본다.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEventBus } from "../../core/eventbus.js";
import { appRoot, getPaths } from "../../core/paths.js";
import { setModuleDisabled } from "../../core/settings.js";
import { isSelfReferentialModule } from "../../core/plugins/inventory.js";
import {
  bundledPluginNames,
  initPluginManager,
  installHomePlugin,
  listAllPlugins,
} from "../../core/plugins/manager.js";
import { scanPluginManifests } from "../../core/plugins/loader.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 홈에 플러그인 폴더 하나를 만든다. 뜨면 `globalThis.__reservedRan` 에 이름을 남긴다. */
const putHomePlugin = async (name: string, extra: Record<string, unknown>): Promise<void> => {
  const dir = path.join(getPaths().commonPlugins, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      version: "9.9.9-HOME",
      tiguclaw: { schemaVersion: 1, kind: ["service"], name, entry: "./index.mjs", ...extra },
    }),
  );
  await writeFile(
    path.join(dir, "index.mjs"),
    `export default class P {
  async startService() { (globalThis.__reservedRan ||= []).push(${JSON.stringify(name)}); }
  async stop() {}
};\n`,
  );
};

export const check: RegressionCheck = {
  name: "bundled-name-is-reserved",
  guards:
    "번들 쌍둥이가 꺼져 있거나 로드에 실패한 순간 홈 플러그인이 그 이름으로 들어와, 목록이 번들의 출처·버전·**권한**을 보여주면서 홈 코드를 돌리던 것(실측 재현 2026-08-30)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });

    const bundled = await bundledPluginNames();
    const victim = [...bundled].find((n) => n === "running-work") ?? [...bundled][0];

    // ④ 판정이 디스크다 — 아무것도 안 떠 있는데(LIVE 비었다) 이름이 나온다.
    out.push(
      assert(
        "★번들 이름 판정이 **디스크**를 본다 — 아무것도 로드하지 않은 지금도 이름이 나온다(`LIVE` 를 물었다면 0이다)",
        bundled.size > 0,
        `번들 이름 ${bundled.size}개 · 표적=${String(victim)}`,
      ),
    );

    // ④b ★**깨진 번들을 실제로 하나 놓고** 잰다 (2026-08-30, 3라운드 D-3).
    //  종전엔 `bundled.size > 0` 하나로 이 문장을 대신했다 — 값의 의미를 안 보는 검사라,
    //  예약이 10→9 로 **줄어도** 초록이었다. 깨진 번들은 그 이름으로 들어올 **가장 좋은
    //  순간**이므로, 하필 그때 문이 열리면 가드가 없는 것보다 나쁘다.
    const BROKEN = "zz-broken-bundle-probe";
    const brokenDir = path.join(appRoot(), "plugins", `.tmp-${BROKEN}`);
    try {
      await rm(brokenDir, { recursive: true, force: true });
      await mkdir(brokenDir, { recursive: true });
      // `entry` 가 없다 = 스키마 미통과 = `scanPluginManifests` 가 안 센다.
      await writeFile(
        path.join(brokenDir, "package.json"),
        JSON.stringify({
          name: BROKEN,
          private: true,
          tiguclaw: { schemaVersion: 1, name: BROKEN, selfReferential: true },
        }),
      );
      const scanned = new Set(
        (await scanPluginManifests(path.join(appRoot(), "plugins"))).map((m) => m.manifest.name),
      );
      const reserved = await bundledPluginNames();
      await putHomePlugin(BROKEN, {});
      const sneak = await installHomePlugin(BROKEN);
      out.push(
        assert(
          "★★**깨진 번들의 이름도 예약된다** — 매니페스트가 스키마를 못 통과해도(그래서 목록엔 안 뜨는데도) 홈이 그 이름으로 못 들어온다",
          !scanned.has(BROKEN) && reserved.has(BROKEN) && sneak.ok === false,
          `스캔에 있나=${String(scanned.has(BROKEN))} · 예약됐나=${String(reserved.has(BROKEN))} · 설치=${sneak.ok ? "★성공(가로채기)" : "거부"}`,
        ),
      );
      // ★**같은 이름에 두 답이 없다.** 이 깨진 번들은 `selfReferential: true` 를 선언한다 —
      //  종전엔 그 선언은 읽히는데(원시 package.json) 예약은 안 됐다(스키마). 한 이름에
      //  "번들이다"(플래그)와 "번들 아니다"(예약)가 동시에 참이었다.
      out.push(
        assert(
          "★★같은 이름에 **한 답만** 있다 — 예약과 `selfReferential`/`core` 판정이 같은 디스크 읽기에서 나온다(종전엔 하나는 스키마, 하나는 원시 `package.json` 이라 갈렸다)",
          isSelfReferentialModule(BROKEN) === reserved.has(BROKEN),
          `selfReferential=${String(isSelfReferentialModule(BROKEN))} · 예약=${String(reserved.has(BROKEN))} · 예약 ${String(reserved.size)}개 / 스캔 ${String(scanned.size)}개`,
        ),
      );
      // ④c ★**JSON 이 깨진 번들**도 이름을 지킨다 (2026-08-31, 적대 검토 4R F6). ④b 는
      //  *스키마* 미통과만 쟀는데, 현실에서 더 흔한 깨짐은 **파일 자체가 깨지는 것**이다
      //  (중단된 `/update` · 부분 쓰기). 종전엔 그쪽이 아예 없는 것이 돼 이름이 열렸다 —
      //  덜 흔한 깨짐이 더 흔한 깨짐보다 더 보호받고 있었다.
      // ★첫 판은 픽스처 이름이 `.tmp-…` 라 **제품이 애초에 받지 않는 이름**이었다
      //  (5R F1). 그래서 `installHomePlugin` 까지 밀 수가 없었고, 단언이 `Set.has()` 한
      //  줄로 내려앉아 **술어를 전혀 안 묶었다** — 예약 판정을 *"내가 만든 그 폴더만"* 으로
      //  좁혀도 2,409건이 초록이었다. 되돌림은 잡는데 **좁힘을 못 잡는** 그물이었다.
      //  이제 ④b 와 **같은 모양으로 끝까지 민다**(유효 이름 + 실제 설치 시도 + 거부 확인).
      const dir2 = path.join(appRoot(), "plugins", BROKEN);
      try {
        await mkdir(dir2, { recursive: true });
        await writeFile(path.join(dir2, "package.json"), '{"name": "zz-trunc');
        const afterTruncated = await bundledPluginNames();
        await putHomePlugin(BROKEN, {});
        const sneak2 = await installHomePlugin(BROKEN);
        out.push(
          assert(
            "★★**매니페스트를 아예 못 읽어도** 그 이름으로는 못 들어온다 — 깨진 번들은 그 이름으로 들어올 가장 좋은 순간이라, 하필 그때 열리는 문은 없느니만 못하다",
            afterTruncated.has(BROKEN) && sneak2.ok === false,
            `깨진 JSON 예약됨=${String(afterTruncated.has(BROKEN))} · 설치=${sneak2.ok ? "★성공(가로채기)" : "거부"} · 예약 ${String(afterTruncated.size)}개`,
          ),
        );
        // ★**잔해는 예약이 아니다** (5R F2). 술어가 "디렉터리인가" 면 `.DS_Store` 만 남은
        //  폴더가 정상 설치를 거짓 사유로 막고, 가이드 §11 의 "폴더는 아무렇게나 둬도
        //  됩니다" 가 거짓이 된다. 넓힌 술어의 **거짓양성 쪽**에도 못을 박는다.
        // ★이름을 **④b 픽스처와 갈라야 한다** — 처음엔 같은 이름을 써서, 위 깨진
        //  매니페스트가 그 이름을 예약하는 바람에 잔해 판정이 오염됐다(실측: 예약 11개).
        //  같은 검사 안의 픽스처끼리도 서로의 관측을 오염시킨다.
        const DEBRIS = "zz-debris-probe";
        const debrisDir = path.join(appRoot(), "plugins", DEBRIS);
        try {
          await mkdir(debrisDir, { recursive: true });
          await writeFile(path.join(debrisDir, ".DS_Store"), "x");
          const afterDebris = await bundledPluginNames();
          out.push(
            assert(
              "★★`plugins/` 의 **잔해 폴더는 이름을 안 가져간다** — `/update` 가 지우다 만 폴더 하나가 정상 홈 플러그인을 '같은 이름의 번들이 있습니다' 로 막으면 사용자는 제품 안에서 이유를 알 길이 없다",
              !afterDebris.has(DEBRIS),
              `잔해 예약됨=${String(afterDebris.has(DEBRIS))} · 예약 ${String(afterDebris.size)}개`,
            ),
          );
        } finally {
          await rm(debrisDir, { recursive: true, force: true });
        }

        // ★**진짜 번들로 잰다** (5R F1 의 남은 절반). 위 둘은 검사가 만든 폴더를 검사가
        //  관측한다 — 그래서 예약 판정을 *"내 픽스처처럼 생긴 것만"* 으로 좁혀도 초록이었다
        //  (실측: `zz-` 접두만 예약하는 변이가 2,410건 통과). 자기가 만든 픽스처는 언제든
        //  예외로 뺄 수 있으므로, 술어를 묶으려면 **레포에 실제로 있는 번들**을 깨야 한다.
        // ★원본은 메모리에 들고 `finally` 로 되돌린다(추적 파일이라 최악에도 `git checkout`
        //  한 줄이면 복구된다).
        const REAL = "running-work";
        const realPkg = path.join(appRoot(), "plugins", REAL, "package.json");
        const original = await readFile(realPkg, "utf8");
        let reservedWhileBroken = false;
        try {
          await writeFile(realPkg, '{"name": "@tiguclaw/run');
          reservedWhileBroken = (await bundledPluginNames()).has(REAL);
        } finally {
          await writeFile(realPkg, original);
        }
        out.push(
          assert(
            `★★**실제 번들(\`${REAL}\`)의 매니페스트가 깨져도** 그 이름은 예약된다 — 픽스처가 아니라 레포에 있는 것으로 재야 술어가 묶인다`,
            reservedWhileBroken && (await bundledPluginNames()).has(REAL),
            `깨진 동안 예약=${String(reservedWhileBroken)} · 복원 후 예약=${String((await bundledPluginNames()).has(REAL))}`,
          ),
        );
      } finally {
        await rm(dir2, { recursive: true, force: true });
        await rm(path.join(getPaths().commonPlugins, BROKEN), { recursive: true, force: true });
      }
    } finally {
      await rm(brokenDir, { recursive: true, force: true });
      await rm(path.join(getPaths().commonPlugins, BROKEN), { recursive: true, force: true });
    }
    if (victim === undefined) return out;

    // ①②③ 번들 이름으로 들어오려는 시도 — 쌍둥이를 **꺼둔 채** 한다(그게 사고다).
    setModuleDisabled(victim, true);
    await putHomePlugin(victim, { needs: { network: ["attacker.test"], outbound: true } });
    const hijack = await installHomePlugin(victim);
    setModuleDisabled(victim, false);

    out.push(
      assert(
        "★★번들 쌍둥이가 **꺼져 있어도** 그 이름의 홈 플러그인은 거부된다 — 종전 가드는 '돌고 있나' 를 물어서, 끈 순간 문이 열렸다",
        hijack.ok === false,
        hijack.ok ? "★설치됨(가로채기 성공)" : `거부 · ${hijack.reason ?? ""}`,
      ),
    );
    out.push(
      assert(
        "★거부되면 그 코드는 **한 줄도 안 돈다** — 메시지만 맞고 배선이 됐다면 거부가 아니다",
        !((globalThis as { __reservedRan?: string[] }).__reservedRan ?? []).includes(victim),
        JSON.stringify((globalThis as { __reservedRan?: string[] }).__reservedRan ?? []),
      ),
    );

    const row = (await listAllPlugins()).find((p) => p.name === victim);
    out.push(
      assert(
        "★그 이름의 행은 **번들**이고 번들의 권한을 보여준다 — 홈 것이 그 자리를 차지하면 사용자는 틀린 권한을 보고 승인한다",
        row?.source === "bundled" && row?.version !== "9.9.9-HOME",
        row === undefined ? "행 없음" : `${row.source} · ${row.version ?? "-"} · ${row.needs}`,
      ),
    );

    // ⑤ 반대 방향 — 가드가 다 막으면 그것도 결함이다.
    const free = "reserved-check-free-name";
    await putHomePlugin(free, {});
    const legit = await installHomePlugin(free);
    out.push(
      assert(
        "★번들에 없는 이름은 **그대로 설치된다** — 이름 가드가 정상 설치까지 막으면 그건 고친 게 아니다(예약어 목록이 번들 전부를 죽인 전례가 있다)",
        legit.ok === true,
        legit.ok ? "설치됨" : `★거부 · ${legit.reason ?? ""}`,
      ),
    );
    return out;
  },
};
