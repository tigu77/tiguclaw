/**
 * 회귀: **홈 `.env` 를 정본으로 삼는 플러그인 설정** (2026-09-02 정태님:
 * *"빌트인 플러그인들까지 억지로 옮길 필요는 없을거같긴해 / 홈셋팅도 같이 읽어서 사용할
 * 수 있어도 나쁘진 않을거같아 가능한가"*).
 *
 * ★왜: 번들 플러그인은 `process.env.HTTP_BRIDGE_PORT` 처럼 **자기가 직접** 읽는다. 전부
 *  `host.settings` 로 옮기는 건 큰 이사이고, 토큰류는 env 이름이 규칙(`TIGUCLAW_PLUGIN_*`)
 *  으로 바뀌어 **기존 설치가 깨진다**. 선언에 `env` 한 칸을 두면 옮기지 않고도 화면이
 *  «지금 값» 을 말한다.
 *
 * ★그래서 **읽기 전용**이다. 플러그인이 여전히 env 를 읽으므로 화면에서 고쳐도 안 먹는다 —
 *  편집을 열어두면 «고쳤는데 아무 일도 안 일어나는» 화면이 된다(오늘 이 레포에서 같은
 *  부류를 셋 봤다). **서버가 막는다** — 화면 가드만이면 API 직호출로 뚫린다.
 *
 * ★★그리고 이 검사의 절반은 **비밀이 화면으로 새지 않는가**다. 첫 판에서 내가 telegram
 *  토큰을 `string` + `env` 로 선언했고, 렌더 분기도 `env` 를 `secret` 보다 **앞에** 뒀다 —
 *  둘 중 하나만으로도 봇 토큰이 대시보드에 그대로 찍혔다. 잡았지만, 잡았다는 사실이
 *  아니라 **다시 그렇게 못 하는 것**이 검사의 일이다.
 *
 * 등급: **동작**(해석·쓰기 거부를 실제로 실행) + **판정**(렌더 순서).
 */
import {
  effectiveSettings,
  readSettingsSpec,
  settingsForClient,
  writePluginSetting,
} from "../../core/plugins/settings.js";
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SPEC = readSettingsSpec([
  { key: "port", type: "number", env: "TGC_TEST_PORT" },
  { key: "host", type: "string", env: "TGC_TEST_HOST" },
  { key: "mode", type: "enum", values: ["a", "b"], env: "TGC_TEST_MODE", default: "a" },
  { key: "flag", type: "boolean", env: "TGC_TEST_FLAG", default: false },
  { key: "token", type: "secret", env: "TGC_TEST_TOKEN" },
  { key: "plain", type: "string", default: "d" },
  { key: "derived", type: "string", default: "x", readOnly: true },
  // ★«풀어달라» 는 선언 — 받아들이면 안 된다.
  { key: "sneaky", type: "string", env: "TGC_TEST_HOST", readOnly: false },
  { key: "loose", type: "secret", env: "TGC_TEST_TOKEN", readOnly: false },
]).specs;

export const check: RegressionCheck = {
  name: "plugin-settings-from-env",
  guards:
    "빌트인 플러그인이 env 를 직접 읽어 대시보드가 그 값을 보여줄 길이 없던 것 + 그 값을 화면에서 고칠 수 있게 두면 파일에만 남고 아무 일도 안 일어나던 것 + secret 을 env 로 선언하면 값이 화면에 그대로 찍히던 것(2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    const P = "tgc-env-probe";
    const saved = { ...process.env };
    const out: Assertion[] = [];
    try {
      process.env.TGC_TEST_PORT = "8080";
      process.env.TGC_TEST_HOST = "example.test";
      process.env.TGC_TEST_MODE = "b";
      process.env.TGC_TEST_FLAG = "true";
      process.env.TGC_TEST_TOKEN = "s3cret-value";

      const eff = effectiveSettings(P, SPEC);
      out.push(
        assert(
          "★★선언한 env 에서 값을 읽는다 — 형까지 맞춘다(env 는 언제나 문자열이다)",
          eff.port === 8080 && eff.host === "example.test" && eff.mode === "b" && eff.flag === true,
          `port=${JSON.stringify(eff.port)} host=${JSON.stringify(eff.host)} mode=${JSON.stringify(eff.mode)} flag=${JSON.stringify(eff.flag)}`,
        ),
      );

      // 형이 안 맞으면 조용히 default — 잘못된 env 하나가 플러그인을 못 뜨게 하면 안 된다.
      process.env.TGC_TEST_MODE = "없는값";
      process.env.TGC_TEST_PORT = "포트아님";
      const bad = effectiveSettings(P, SPEC);
      out.push(
        assert(
          "★env 값이 형에 안 맞으면 **default 로** 떨어진다(깨진 env 하나가 플러그인을 죽이지 않게)",
          bad.mode === "a" && bad.port === undefined,
          `mode=${JSON.stringify(bad.mode)}(default 'a') · port=${JSON.stringify(bad.port)}(없어야)`,
        ),
      );
      process.env.TGC_TEST_MODE = "b";
      process.env.TGC_TEST_PORT = "8080";

      // ★★비밀 유출 — 이 검사의 절반이다.
      const client = settingsForClient(P, SPEC);
      const tokenRow = client.find((s) => s.key === "token");
      const anyValue = JSON.stringify(client);
      out.push(
        assert(
          "★★secret 은 **값이 화면 계약에 안 실린다** — env 로 선언해도(내가 그렇게 짰다가 잡았다)",
          tokenRow?.hasSecret === true &&
            (tokenRow as { value?: unknown }).value === undefined &&
            !anyValue.includes("s3cret-value"),
          `hasSecret=${String(tokenRow?.hasSecret)} · 값 유출=${anyValue.includes("s3cret-value")}`,
        ),
      );
      out.push(
        assert(
          "★일반 값은 화면 계약에 실린다(그래야 보여줄 수 있다) + 출처 이름도 같이",
          client.find((s) => s.key === "host")?.value === "example.test" &&
            client.find((s) => s.key === "host")?.env === "TGC_TEST_HOST",
          JSON.stringify(client.find((s) => s.key === "host")),
        ),
      );

      // ★★쓰기 거부 — 서버가 막는다.
      const w = writePluginSetting(P, SPEC, "host", "다른값");
      const ws = writePluginSetting(P, SPEC, "token", "x");
      const wok = writePluginSetting(P, SPEC, "plain", "z");
      out.push(
        assert(
          "★★env 가 정본인 키는 **서버가 쓰기를 막는다** — 화면 가드만이면 API 직호출로 뚫린다",
          w.ok === false && w.errorKey === "plugins.reason.settingComesFromEnv",
          `ok=${String(w.ok)} · ${String(w.errorKey)}`,
        ),
      );
      out.push(
        assert(
          "★secret 은 종전대로 막힌다(회귀 0) · env 를 선언했어도",
          ws.ok === false && ws.errorKey === "plugins.reason.secretGoesInEnv",
          `ok=${String(ws.ok)} · ${String(ws.errorKey)}`,
        ),
      );
      out.push(
        assert(
          "★env 를 안 단 설정은 **여전히 쓸 수 있다** — 이 변경이 종전 기능을 막지 않는다",
          wok.ok === true,
          `ok=${String(wok.ok)} · ${String(wok.error ?? "")}`,
        ),
      );
    } finally {
      for (const k of ["TGC_TEST_PORT", "TGC_TEST_HOST", "TGC_TEST_MODE", "TGC_TEST_FLAG", "TGC_TEST_TOKEN"])
        delete process.env[k];
      Object.assign(process.env, saved);
    }

    // ★★한 방향 규칙 — 조이는 건 되고 푸는 건 안 된다.
    {
      const ro = SPEC.find((x) => x.key === "derived");
      const sneaky = SPEC.find((x) => x.key === "sneaky");
      const loose = SPEC.find((x) => x.key === "loose");
      out.push(
        assert(
          "★★플러그인이 `readOnly: true` 로 **조이면** 서버가 쓰기를 막는다",
          ro?.readOnly === true && writePluginSetting("p", SPEC, "derived", "z").ok === false,
          `선언=${String(ro?.readOnly)} · 쓰기=${String(writePluginSetting("p", SPEC, "derived", "z").ok)}`,
        ),
      );
      out.push(
        assert(
          "★★`readOnly: false` 는 **약속이 아니다** — 저장조차 안 한다(참고하는 순간 게이트가 뚫린다)",
          sneaky?.readOnly === undefined && loose?.readOnly === undefined,
          `sneaky=${String(sneaky?.readOnly)} · loose=${String(loose?.readOnly)}`,
        ),
      );
      out.push(
        assert(
          "★★그래서 «풀어달라» 고 적어도 env·secret 은 그대로 막힌다",
          writePluginSetting("p", SPEC, "sneaky", "z").ok === false &&
            writePluginSetting("p", SPEC, "loose", "z").ok === false,
          `sneaky=${String(writePluginSetting("p", SPEC, "sneaky", "z").errorKey)} · loose=${String(writePluginSetting("p", SPEC, "loose", "z").errorKey)}`,
        ),
      );
    }

    // 검증: env 이름 모양
    const v = readSettingsSpec([
      { key: "a", type: "string", env: "lower_case" },
      { key: "b", type: "string", env: "OK_NAME" },
    ]);
    out.push(
      assert(
        "★env 이름은 **모양으로** 받는다(소문자·이상한 이름은 거부하고 이유를 말한다)",
        v.specs.length === 1 && v.specs[0]?.key === "b" && v.problems.length === 1,
        `통과 ${String(v.specs.length)}개 · 문제 ${String(v.problems.length)}건`,
      ),
    );

    // 판정: 렌더 순서 — secret 이 env 보다 먼저여야 한다.
    const view = readSourceSync("packages/dashboard/js/view-plugins.js");
    const iSecret = view.indexOf('spec.type === "secret"');
    const iEnv = view.indexOf("spec.env ||");
    out.push(
      assert(
        "★★화면도 `secret` 을 **먼저** 본다 — 순서가 뒤집히면 env 분기가 비밀을 그대로 찍는다",
        iSecret > 0 && iEnv > 0 && iSecret < iEnv,
        `secret@${String(iSecret)} · env@${String(iEnv)}`,
      ),
    );
    return out;
  },
};
