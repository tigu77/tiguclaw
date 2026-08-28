/**
 * 회귀: **플러그인 설정 — 선언은 값이고, 화면은 그 값에서 생긴다** (2026-08-28, §D).
 *
 * 지키는 것 다섯:
 *  ① **모르는 type 을 거부한다** — 화면이 못 그리는 종류를 받으면 선언은 있는데 아무것도
 *     안 생기고, 작성자는 자기가 뭘 잘못했는지 모른다(`readNeeds` 와 같은 규범).
 *  ② **나쁜 칸 하나가 나머지를 안 죽인다** — 통째로 거부하면 오타 하나에 설정이 다 사라진다.
 *  ③ ★**secret 은 파일에 안 들어간다** — 이 레코드는 화면에 뿌려지고 백업에 들어간다.
 *     쓰기 문이 거절하고, 화면엔 있다/없다만 간다.
 *  ④ **런타임은 자기 몫만 본다** — 선언에 없는 키는 파일에 남아 있어도 안 흘러든다.
 *  ⑤ ★**화면이 행을 손으로 짓지 않는다** — `view-plugins.js` 에 플러그인 이름이 없어야
 *     플러그인이 늘어도 그 파일을 안 고친다([[feedback_hand_maintained_lists]]).
 *
 * 등급: ①~④는 **동작**(순수 함수·파일을 실제로 쓴다), ⑤는 소스 대조.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPaths } from "../../core/paths.js";
import {
  effectiveSettings,
  readSettingsSpec,
  secretEnvName,
  settingsForClient,
  writePluginSetting,
  type PluginSettingSpec,
} from "../../core/plugins/settings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "plugin-settings",
  guards:
    "플러그인이 설정을 가질 길이 없던 것 + 그 길을 열면서 생기는 셋: 화면이 못 그리는 type 을 받아 선언만 남는 것 · secret 이 설정 파일(화면·백업)로 새는 것 · 화면이 플러그인마다 행을 손으로 지어 드리프트가 되는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① ② 선언 검사 (순수) ─────────────────────────────────────────────
    const v = readSettingsSpec([
      { key: "units", type: "enum", values: ["c", "f"], default: "c" },
      { key: "apiKey", type: "secret" },
      { key: "nope", type: "color" }, // 화면이 못 그린다
      { key: "units", type: "string" }, // 중복
      { key: "9bad", type: "string" }, // 이름 규칙 위반
      { key: "n", type: "number", default: "셋" }, // default 타입 불일치
      { key: "k", type: "secret", default: "sk-live" }, // secret 에 default
      { key: "e", type: "enum" }, // values 없음
    ]);
    out.push(
      assert(
        "★좋은 칸은 통과하고 나머지는 **각자** 떨어진다(오타 하나에 설정이 통째로 사라지지 않는다)",
        v.specs.length === 2 &&
          v.specs[0]?.key === "units" &&
          v.specs[1]?.key === "apiKey" &&
          v.problems.length === 6,
        `통과 ${v.specs.map((s) => s.key).join(",")} · 거부 ${v.problems.length}건`,
      ),
    );
    out.push(
      assert(
        "★모르는 type 을 거부하고 **아는 것을 말해준다**(집행·묘사 못 하는 선언은 안 받는다 — `readNeeds` 와 같은 규범)",
        v.problems.some((p) => p.includes("color") && p.includes("아는 것은")),
        v.problems.find((p) => p.includes("color")) ?? "없음",
      ),
    );
    out.push(
      assert(
        "★★`secret` 에는 default 를 못 둔다 — 열쇠를 코드(매니페스트)에 적게 하는 길을 아예 막는다",
        v.problems.some((p) => p.includes("secret") && p.includes("default")),
        v.problems.find((p) => p.includes("secret")) ?? "없음",
      ),
    );
    out.push(
      assert(
        "배열이 아니면 이유를 남긴다",
        readSettingsSpec({ units: "c" }).problems.length === 1,
        JSON.stringify(readSettingsSpec({ units: "c" }).problems),
      ),
    );

    // ── ③ ④ 값 읽기·쓰기 (동작 — 실제 파일) ──────────────────────────────
    const SPECS: PluginSettingSpec[] = [
      { key: "units", type: "enum", values: ["c", "f"], default: "c" },
      { key: "apiKey", type: "secret" },
      { key: "count", type: "number", default: 3 },
    ];
    const PLUGIN = "regr-settings";
    const dir = path.join(getPaths().commonPlugins, PLUGIN);
    mkdirSync(dir, { recursive: true });
    // 선언에 **없는** 키를 일부러 파일에 심어 둔다 — 흘러들면 안 된다.
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ units: "f", ghost: "남의 것", count: 9 }, null, 2),
      "utf8",
    );

    const eff = effectiveSettings(PLUGIN, SPECS);
    out.push(
      assert(
        "★런타임은 **선언된 키만** 본다 — 파일에 남은 옛 키가 조용히 흘러들지 않는다",
        eff.units === "f" && eff.count === 9 && !("ghost" in eff),
        JSON.stringify(eff),
      ),
    );

    delete process.env[secretEnvName(PLUGIN, "apiKey")];
    const noSecret = effectiveSettings(PLUGIN, SPECS);
    process.env[secretEnvName(PLUGIN, "apiKey")] = "sk-test";
    const withSecret = effectiveSettings(PLUGIN, SPECS);
    out.push(
      assert(
        "★secret 은 `.env` 에서만 온다 — 없으면 **키 자체가 없다**(빈 문자열이면 '설정됐는데 비었다' 로 오해한다)",
        !("apiKey" in noSecret) && withSecret.apiKey === "sk-test",
        `없을 때 ${JSON.stringify(noSecret)} · 있을 때 apiKey=${String(withSecret.apiKey)}`,
      ),
    );

    const client = settingsForClient(PLUGIN, SPECS);
    const secretRow = client.find((c) => c.key === "apiKey");
    out.push(
      assert(
        "★★화면으로 나가는 값에 **secret 이 없다**(있다/없다만) — 이 응답은 브라우저에 그려지고 백업에 들어간다",
        secretRow?.hasSecret === true &&
          !("value" in (secretRow as unknown as Record<string, unknown>)) &&
          !JSON.stringify(client).includes("sk-test"),
        JSON.stringify(client),
      ),
    );
    delete process.env[secretEnvName(PLUGIN, "apiKey")];

    const wSecret = writePluginSetting(PLUGIN, SPECS, "apiKey", "sk-oops");
    const wUnknown = writePluginSetting(PLUGIN, SPECS, "ghost", "x");
    const wBadType = writePluginSetting(PLUGIN, SPECS, "units", "kelvin");
    const wOk = writePluginSetting(PLUGIN, SPECS, "units", "c");
    const afterWrite = JSON.parse(
      readFileSync(path.join(dir, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    out.push(
      assert(
        "★★쓰기 문이 secret · 모르는 키 · 타입 불일치를 **거절하고 이유를 말한다**(그리고 파일엔 안 들어간다)",
        !wSecret.ok &&
          (wSecret.error ?? "").includes(".env") &&
          !wUnknown.ok &&
          !wBadType.ok &&
          wOk.ok &&
          afterWrite.units === "c" &&
          !("apiKey" in afterWrite) &&
          // ★모르는 키(`ghost`)는 파일에 **그대로 둔다** — 코어가 지우면 플러그인을 옛
          //  버전으로 되돌렸을 때 설정이 날아간다(정리≠삭제). 런타임에 안 흘러드는 것은
          //  위 ④가 이미 지킨다 — 노출을 막는 것과 파일을 지우는 것은 다른 판단이다.
          afterWrite.ghost === "남의 것",
        `secret=${wSecret.ok} unknown=${wUnknown.ok} badType=${wBadType.ok} ok=${wOk.ok} · 파일=${JSON.stringify(afterWrite)}`,
      ),
    );
    out.push(
      assert(
        "지우면 기본값으로 돌아간다(비우기를 별도 동사로 두지 않는다 — 같은 판단이 두 곳이 된다)",
        writePluginSetting(PLUGIN, SPECS, "count", undefined).ok &&
          effectiveSettings(PLUGIN, SPECS).count === 3,
        String(effectiveSettings(PLUGIN, SPECS).count),
      ),
    );

    // ── ⑤ 화면이 손으로 행을 짓지 않는다 (소스) ───────────────────────────
    const view = readFileSync(
      path.join(REPO, "packages/dashboard/js/view-plugins.js"),
      "utf8",
    );
    const named = ["weather", "map", "scheduler", "telegram"].filter((n) =>
      new RegExp(`["'\`]${n}["'\`]`).test(view),
    );
    out.push(
      assert(
        "★★설정 화면에 **플러그인 이름이 없다** — 있으면 플러그인이 늘 때마다 이 파일을 고쳐야 하고, 그게 곧 드리프트다",
        named.length === 0,
        named.length === 0 ? "이름 0개(선언에서 생성)" : `★박힌 이름: ${named.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★화면이 secret 값을 그리려 하지 않는다(있다/없다 행만)",
        /hasSecret/.test(view) && !/spec\.value.*secret|secret.*spec\.value/.test(view),
        `hasSecret 사용=${/hasSecret/.test(view)}`,
      ),
    );

    // 매니페스트 실물 — 첫 소비자가 실제로 선언했나.
    // ★**예제 플러그인은 배포본에 없다**(2026-08-29, 제공자 약관 때문에 제외). dev 에서만
    //  돌고, 건너뛰는 사실을 증거란에 남긴다(조용한 면제 금지).
    const wpkgPath = path.join(REPO, "plugins/weather/package.json");
    const wv = existsSync(wpkgPath)
      ? readSettingsSpec(
          (JSON.parse(readFileSync(wpkgPath, "utf8")) as { tiguclaw?: { settings?: unknown } })
            .tiguclaw?.settings,
        )
      : null;
    out.push(
      assert(
        "첫 소비자(weather)의 선언이 실제로 통과한다 — 선언만 있고 아무도 안 쓰는 기능이 아니다",
        wv === null || (wv.problems.length === 0 && wv.specs.some((s) => s.key === "units")),
        wv === null ? "예제 플러그인 없음(배포본) — 대상 없음" : JSON.stringify(wv),
      ),
    );

    if (existsSync(dir)) {
      // 검사가 만든 것은 검사가 치운다(격리 홈이라 지워도 안전).
      writeFileSync(path.join(dir, "settings.json"), "{}\n", "utf8");
    }
    return out;
  },
};
