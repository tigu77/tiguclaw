/**
 * 회귀: **플러그인 작성 가이드가 사실인가** (2026-08-29).
 *
 * ★문서는 코드보다 빨리 낡는다. 그리고 **틀린 문서는 없는 것보다 나쁘다** — 없으면 사람이
 *  소스를 읽지만, 틀리면 그걸 믿고 몇 시간을 태운다. 이 레포는 그 부류를 이미 겪었다
 *  (`openai 어댑터` 헤더가 "미완" 이라고 적혀 있는데 실제로는 ~90% 였다).
 *
 * ★그래서 **가이드가 이름을 대는 것들**을 코드에서 다시 찾는다. 산문을 검사하는 게 아니라,
 *  독자가 **그대로 타이핑할** 식별자·경로·API 이름만 본다:
 *
 *   - `window.tiguWidgets.register` · `ctx.resource` · `ctx.t`
 *   - `/api/plugin-data/` · `/plugin-asset/`
 *   - 매니페스트 키(`schemaVersion`·`entry`·`kind`·`needs`·`settings`)
 *   - `needs` 의 키들 · 설정 타입들 · `host` 의 메서드들
 *   - `secret` 환경변수 이름 규칙(문서에 **예시 두 줄**이 박혀 있다 — 실제로 계산해 본다)
 *
 * ★한국어판과 영어판이 **같은 것**을 말하는지도 본다. 두 벌이면 갈리고, 갈리면 한쪽
 *  독자만 틀린 걸 읽는다.
 *
 * 등급: `secret` 이름 규칙은 **동작**(순수 함수 실행으로 문서의 예시를 재현), 나머지는
 * 대조(문서가 댄 이름이 코드에 실재하는가). 산문의 정확성은 이 검사 밖이다 — 그건 사람이
 * 읽어야 하고, 그렇다고 적어둔다.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_NEED_KEYS } from "../../core/plugins/host.js";
import { secretEnvName } from "../../core/plugins/settings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "plugin-guide-is-true",
  guards:
    "작성 가이드가 코드보다 낡아 독자가 그대로 타이핑한 이름이 안 먹는 것(틀린 문서는 없는 것보다 나쁘다 — 없으면 소스를 읽지만 틀리면 그걸 믿고 시간을 태운다) + 한국어판과 영어판이 갈려 한쪽 독자만 틀린 걸 읽는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const guide = read("docs/plugins.md");

    // ── ① 가이드가 **이 이름들을 반드시 담아야 한다** ────────────────────────
    // ★방향이 뒤집혔다 (2026-08-29, 적대 검토 C). 종전엔 `guide.includes(X) && !코드에있음`
    //  이었는데, 그러면 **가이드가 X 를 잃는 순간 가드가 공허해진다** — 검사가 필요한 바로
    //  그 순간 사라진다. 실측으로 양쪽 가이드의 식별자 14곳을 동시에 틀리게 해도 **7/7
    //  초록**이었고, 증거란은 하드코딩 배열을 찍어 **안심시켰다**.
    //  이제는 **코드에 실재하고 + 가이드에 정확히 그 글자로 있어야** 통과한다.
    const host = read("packages/dashboard/js/widget-host.js");
    const dash = read("packages/dashboard/index.ts");
    const assets = read("src/core/plugin-assets.ts");
    const hostTs = read("src/core/plugins/host.ts");
    const wireSrc = read("src/core/plugins/wire.ts");
    /** [독자가 타이핑하는 글자, 그것이 실재함을 보이는 근거] */
    const MUST: Array<[string, boolean]> = [
      ["window.tiguWidgets", host.includes("window.tiguWidgets")],
      ["ctx.onDispose", host.includes("onDispose")],
      ["ctx.resource", /resource\(/.test(host)],
      ["ctx.t", /\bt:/.test(host)],
      ["/api/plugin-data/", dash.includes('"/api/plugin-data/"')],
      ["/plugin-asset/", assets.includes('"/plugin-asset/"')],
      ["getDataRoutes", wireSrc.includes("getDataRoutes")],
      ["getTools", wireSrc.includes("getTools")],
      ["getMcpServer", wireSrc.includes("getMcpServer")],
      ["host.dataDir", hostTs.includes("dataDir")],
      ["host.postCard", hostTs.includes("postCard(")],
      ["host.say", hostTs.includes("say(input:")],
      ["host.ask", hostTs.includes("ask(input:")],
    ];
    const notInCode = MUST.filter(([, real]) => !real).map(([n]) => n);
    const notInGuide = MUST.filter(([n]) => !guide.includes(n)).map(([n]) => n);
    out.push(
      assert(
        `★★독자가 타이핑하는 이름 ${String(MUST.length)}개가 **코드에 실재하고 가이드에 그 글자 그대로 있다** — 종전엔 "가이드에 있으면 코드도 있나" 만 봐서, 가이드가 이름을 잃거나 틀리는 순간 가드가 공허해졌다(실측: 14곳을 동시에 틀려도 초록이었다)`,
        notInCode.length === 0 && notInGuide.length === 0,
        notInCode.length === 0 && notInGuide.length === 0
          ? `${String(MUST.length)}개 양쪽 다 확인`
          : `★코드에 없음 [${notInCode.join(", ")}] · 가이드에 없음 [${notInGuide.join(", ")}]`,
      ),
    );

    out.push(
      assert(
        "★가이드가 `@tiguclaw/plugin` 을 **쓰라고 하지 않는다** — npm 미발행이고 레포에서 설치해도 타입 해석이 안 된다(실측 TS2307 3건). 발행·검증 전에 권하면 독자가 그걸 믿고 시간을 태운다",
        !/import type .* from "@tiguclaw\/plugin"/.test(guide),
        /import type .* from "@tiguclaw\/plugin"/.test(guide) ? "★아직 권하고 있다" : "권하지 않음(준비 중이라고 적음)",
      ),
    );

    // ── ② 가이드가 **없는 이름을 지어내지 않는다** ──────────────────────────
    // ★①의 반대 방향. 종전엔 이 축이 아예 없어서 `host.db(sql)`·`needs.storage` 같은 걸
    //  표에 넣어도 잡히지 않았다(실측). 독자는 그걸 믿고 쓴다.
    const invented: string[] = [];
    for (const m of guide.matchAll(/`host\.([a-zA-Z]+)\(?/g)) {
      const name = m[1] ?? "";
      if (name !== "" && !hostTs.includes(name)) invented.push(`host.${name}`);
    }
    // ★`needs` 표만 본다 — 종전엔 문서의 **모든** 표 행을 긁어서 매니페스트 키(`entry`·
    //  `kind`)까지 권한으로 오독했다(첫 실행에서 즉시 오탐).
    const needsSection = guide.split("## 4.")[1]?.split("\n## ")[0] ?? "";
    for (const m of needsSection.matchAll(/^\| `([a-z]+)` \|/gm)) {
      const k = m[1] ?? "";
      if (k !== "" && !KNOWN_NEED_KEYS.has(k)) invented.push(`needs.${k}`);
    }
    out.push(
      assert(
        "★★가이드가 **없는 것을 지어내지 않는다** — 코드에 없는 `host.*` 나 권한 키를 표에 넣으면 독자는 그걸 믿고 쓴다(그리고 조용히 안 된다)",
        invented.length === 0,
        invented.length === 0 ? "지어낸 이름 0" : `★없는 이름: ${[...new Set(invented)].join(", ")}`,
      ),
    );

    // ── ③ `needs` 키 — 문서와 코드가 **양방향** 일치 ────────────────────────
    // ★한쪽만 보면 안 된다: 문서에 없는 키가 코드에 생기면 아무도 못 쓰고(발견 불가),
    //  코드에 없는 키가 문서에 있으면 적어도 안 먹는다(조용한 실패).
    const documented = [...KNOWN_NEED_KEYS].filter((k) =>
      new RegExp(`\`${k}\``).test(guide) || guide.includes(`| \`${k}\``) || guide.includes(`"${k}"`),
    );
    const undocumented = [...KNOWN_NEED_KEYS].filter((k) => !documented.includes(k));
    out.push(
      assert(
        `★★\`needs\` 키 ${String(KNOWN_NEED_KEYS.size)}개가 **전부 문서에 있다** — 새 권한을 만들고 안 적으면 아무도 못 쓴다(있는데 발견 불가 = 없는 것)`,
        undocumented.length === 0,
        undocumented.length === 0
          ? [...KNOWN_NEED_KEYS].join(", ")
          : `★문서에 없음: ${undocumented.join(", ")}`,
      ),
    );

    // ── ④ `secret` 환경변수 규칙 — 문서의 예시를 **실행해서** 재현 ───────────
    // ★가이드에 예시 두 줄이 박혀 있다. 규칙이 바뀌면 그 두 줄이 거짓말이 되는데, 이건
    //  사람이 못 알아챈다(그럴듯해 보인다). 그래서 실제로 계산해 대조한다.
    const examples: Array<[string, string, string]> = [
      ["hello", "apiKey", "TIGUCLAW_PLUGIN_HELLO_APIKEY"],
      ["my-plugin", "api-key", "TIGUCLAW_PLUGIN_MY_PLUGIN_API_KEY"],
    ];
    const wrong = examples.filter(([p, k, want]) => secretEnvName(p, k) !== want);
    const inGuide = examples.filter(([, , want]) => guide.includes(want));
    out.push(
      assert(
        "★★가이드에 박힌 `secret` 환경변수 예시가 **실제 계산과 같다** — 규칙이 바뀌면 그 줄이 그럴듯한 거짓말이 되고, 사람은 열쇠가 왜 안 읽히는지 못 찾는다",
        wrong.length === 0 && inGuide.length === examples.length,
        wrong.length > 0
          ? `★어긋남: ${wrong.map(([p, k]) => `${p}/${k}→${secretEnvName(p, k)}`).join(", ")}`
          : `예시 ${String(inGuide.length)}/${String(examples.length)}개가 문서에 있고 계산과 일치`,
      ),
    );

    // ── ⑤ 매니페스트 키 · 설정 타입 · host 메서드 ────────────────────────────
    const loader = read("src/core/plugins/loader.ts");
    const settings = read("src/core/plugins/settings.ts");
    const named: Array<[string, string, boolean]> = [
      ["매니페스트 키", "schemaVersion", loader.includes("schemaVersion")],
      ["매니페스트 키", "entry", loader.includes("entry:")],
      ["설정 타입", "secret", settings.includes('"secret"')],
      ["설정 타입", "enum", settings.includes('"enum"')],
      ["host", "postCard", hostTs.includes("postCard(")],
      ["host", "dataDir", hostTs.includes("dataDir")],
      ["host", "say", hostTs.includes("say(input:")],
      ["host", "ask", hostTs.includes("ask(input:")],
      ["host", "on", hostTs.includes("on(type")],
    ];
    const gone = named.filter(([, n, ok]) => guide.includes(n) && !ok);
    out.push(
      assert(
        "★가이드가 댄 매니페스트 키·설정 타입·`host` 메서드가 전부 실재한다",
        gone.length === 0,
        gone.length === 0 ? `${String(named.length)}개 확인` : `★없음: ${gone.map(([c, n]) => `${c}.${n}`).join(", ")}`,
      ),
    );

    // ── ⑥ 영어판이 있고, 같은 것을 말한다 ───────────────────────────────────
    const enPath = path.join(REPO, "docs/plugins.en.md");
    const hasEn = existsSync(enPath);
    out.push(
      assert(
        "★영어판이 있다 — 공개 문서는 양문이 정책이고, 한쪽만 있으면 다른 쪽 독자는 이 기반이 없는 줄 안다",
        hasEn,
        hasEn ? "docs/plugins.en.md 있음" : "★없음",
      ),
    );
    if (hasEn) {
      const en = readFileSync(enPath, "utf8");
      // ★산문을 대조하지 않는다(번역이니 다르다). **독자가 타이핑하는 것**만 본다.
      const tokens = [
        "window.tiguWidgets",
        "/api/plugin-data/",
        "/plugin-asset/",
        "TIGUCLAW_PLUGIN_HELLO_APIKEY",
        "@tiguclaw/plugin",
        "getDataRoutes",
        "getMcpServer",
      ];
      const drifted = tokens.filter((t) => guide.includes(t) !== en.includes(t));
      out.push(
        assert(
          "★★두 언어판이 **같은 식별자**를 낸다 — 산문은 달라도 되지만 타이핑하는 이름이 갈리면 한쪽 독자만 안 되는 코드를 쓴다",
          drifted.length === 0,
          drifted.length === 0 ? `${String(tokens.length)}개 일치` : `★한쪽에만: ${drifted.join(", ")}`,
        ),
      );
    }

    return out;
  },
};
