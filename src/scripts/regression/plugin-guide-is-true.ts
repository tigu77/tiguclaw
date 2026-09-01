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
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CAPABILITIES } from "../../core/plugins/loader.js";
import { KNOWN_NEED_KEYS } from "../../core/plugins/host.js";
import { secretEnvName } from "../../core/plugins/settings.js";
import { bundledPluginNames } from "../../core/plugins/manager.js";
import { isValidPluginName } from "../../core/plugins/loader.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

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

    // ── ③b `kind` — 같은 질문에 같은 그물 (2026-09-01) ──────────────────────
    // ★`needs` 엔 이 대조가 있었는데 `kind` 엔 없었다. 그래서 로더가 받는 `provider` 가
    //  가이드에 **한 줄도 없는** 채로 살아 있었다 — 받아주면서 설명이 0이면 이름이 능력을
    //  대신 광고한다("LLM provider 를 붙이는 자리" 로 읽힌다). 외부 감사가 그걸 짚었다.
    const kindsUndocumented = [...KNOWN_CAPABILITIES].filter(
      (k) => !guide.includes(`| \`${k}\``),
    );
    out.push(
      assert(
        `★★\`kind\` ${String(KNOWN_CAPABILITIES.size)}개가 **전부 문서 표에 있다** — 로더가 받는데 가이드에 없으면 이름이 능력을 대신 광고한다`,
        kindsUndocumented.length === 0,
        kindsUndocumented.length === 0
          ? [...KNOWN_CAPABILITIES].join(", ")
          : `★문서에 없음: ${kindsUndocumented.join(", ")}`,
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

    // ── ⑦ 좌표 형식이 **실행값과 같다** (3라운드 G-4) ───────────────────────
    // ★`pluginThreadKey` 의 반환 형식을 바꾼 커밋이 그걸 설명하는 **JSDoc 2 + 양문 가이드
    //  2** 를 안 고쳐 넷이 거짓이 됐다. 그리고 **같은 커밋이 이 게이트를 강화하면서 그 넷을
    //  하나도 안 봤다.** 기계적으로 검증 가능한 축이었는데 사람이 지키고 있었다.
    const { pluginThreadKey } = await import("../../core/plugins/host.js");
    const sample = pluginThreadKey("weather", "seoul"); // 예: plugin:weather:seoul
    const shape = sample.split(":")[0] ?? "";           // 접두사만 뽑는다
    const claims: Array<[string, string]> = [
      ["host.ts JSDoc", hostTs],
      ["가이드(한)", guide],
      ["가이드(영)", existsSync(enPath) ? readFileSync(enPath, "utf8") : ""],
    ];
    // ★**문장마다** 본다 — 파일 어딘가에 옳은 문장이 하나 있으면 통과하던 게 종전이고,
    //  그래서 JSDoc 한 줄만 낡아도 안 잡혔다(실측). 좌표를 설명하는 인용문을 **전부** 뽑아
    //  각각이 실제 접두사를 담는지 확인한다.
    const COORD = /`[^`]*<(?:plugin|플러그인|이름|name)[^`]*>:<scope>`/g;
    // ★**과거 서술은 대상이 아니다.** 이 레포는 "종전엔 이랬다" 를 주석에 남기는 게
    //  규범인데(그게 다음 사람의 판단 재료다), 첫 판은 그걸 낡은 주장으로 잡았다 —
    //  실행 즉시 오탐 하나가 났다. 검사 대상은 **지금 그렇다고 말하는 문장**뿐이다.
    const PAST = /(종전|이전|예전|였는데|였다|이었다|was |formerly|before |used to)/;
    const stale: string[] = [];
    for (const [label, src] of claims) {
      if (src === "") continue;
      for (const line of src.split("\n")) {
        if (PAST.test(line)) continue;
        for (const m of line.matchAll(COORD)) {
          if (!m[0].startsWith(`\`${shape}:`)) stale.push(`${label}: ${m[0]}`);
        }
      }
    }
    out.push(
      assert(
        `★★좌표 형식을 **설명하는 곳**이 실행값과 같다(지금 \`${sample}\`) — 형식을 바꾼 커밋이 그걸 설명하는 네 곳을 안 고쳐 전부 거짓이 됐고, 그 커밋이 이 게이트를 강화하면서도 그 넷을 안 봤다`,
        stale.length === 0,
        stale.length === 0 ? `실행값 ${sample} · 설명문 전부 일치` : `★낡음: ${stale.join(" / ")}`,
      ),
    );

    // ── 이름 규칙 — 가이드가 **드는 예시를 실제로 돌려본다** ────────────────
    // ★사고(2026-08-30, 3라운드 E-F7): 가이드가 이름 문자 규칙을 **아예 안 적었다.**
    //  `name: "Weather"` 로 지으면 화면엔 *"쓸 수 있는 플러그인을 못 찾았습니다"* 만 뜨고
    //  진짜 이유는 로그에만 있다 — 독자는 자기 코드를 의심하며 시간을 태운다.
    // ★그래서 규칙을 적되, **적힌 예시를 검증기에 넣어본다**. 규칙이 바뀌면 이 검사가 먼저
    //  빨개진다(글이 조용히 낡는 대신).
    for (const [label, body] of [
      ["ko", guide],
      ["en", existsSync(enPath) ? readFileSync(enPath, "utf8") : ""],
    ] as Array<[string, string]>) {
      const says = /`my-widget`/.test(body) && /`My-Widget`/.test(body);
      out.push(
        assert(
          `★★가이드(${label})가 **이름 문자 규칙을 적고, 든 예시가 실제 검증기와 맞는다** — 규칙을 어긴 플러그인은 조용히 없는 것이 되고 사유는 로그에만 남는다`,
          says && isValidPluginName("my-widget") && !isValidPluginName("My-Widget"),
          says
            ? `my-widget=${String(isValidPluginName("my-widget"))} · My-Widget=${String(isValidPluginName("My-Widget"))}`
            : "★규칙(되는 예 / 안 되는 예)이 글에 없음",
        ),
      );
    }

    // ── 예약된 이름 목록이 **실물에서 파생되는가** ─────────────────────────
    // ★가이드는 예약 이름을 **열거해야 한다**(독자가 자기 이름을 고르기 전에 알아야 하니까).
    //  그러면 그 목록은 번들이 하나 늘거나 이름이 바뀌는 순간 조용히 낡는다
    //  ([[feedback_hand_maintained_lists]]). 그래서 **여기서 디스크와 대조한다** — 목록은
    //  글에 두되 권위는 코드에 둔다.
    // ★**가이드는 배포되는 글이다** — 예약 목록도 *받는 사람의 앱*을 기준으로 참이어야 한다
    //  (2026-08-31, 릴리스 게이트가 잡았다). dev 트리엔 예제 플러그인 `map`·`weather` 가
    //  있는데 **제공자 약관 때문에 배포에서 빠진다**. 그래서 배포본 독자에게는 그 두 이름이
    //  **쓸 수 있는 이름**인데 가이드가 예약이라고 적고 있었다 — 읽은 사람은 멀쩡한 이름을
    //  피해 자기 플러그인을 개명한다(이 파일의 "날조" 단언이 말하는 바로 그 피해다).
    // ★그 사실의 정본은 **sync manifest 한 곳**이다. 여기 이름을 다시 적지 않는다.
    //  배포 트리엔 그 파일이 없고, 그때는 뺄 것도 없다 — 그 트리의 `plugins/` 가 이미
    //  배포본이기 때문이다. ([[feedback_hand_maintained_lists]] · 조용한 통과 금지라
    //  어느 쪽으로 돌았는지 단언에 남긴다.)
    const syncManifest = path.join(REPO, ".claude/skills/sync-public/SKILL.md");
    const isDevTree = existsSync(syncManifest);
    // ★manifest 는 **폴더 이름**으로 빼는데 예약은 **매니페스트 `name`** 이다 — 이름공간이
    //  둘이라 그냥 빼면 갈린다 (2026-08-31, 적대 검토 F4). 실측으로 번들 10개 중 둘이 이미
    //  다르다: `cli-channel`→`cli` · `telegram-channel`→`telegram`. `map`·`weather` 는
    //  우연히 폴더명==이름이라 오늘은 맞았을 뿐이고, 다른 플러그인이 배포에서 빠지는 순간
    //  조용히 틀린다. 그래서 **디스크에서 한 번 번역**한다(새 목록이 아니다).
    // ★가이드 본문이 *"폴더명이 아니라 매니페스트의 `name` 으로 봅니다"* 라고 적고 있는데
    //  그걸 검증하는 코드가 폴더명으로 빼고 있었다.
    const notShipped = isDevTree
      ? [
          ...new Set(
            [...readFileSync(syncManifest, "utf8").matchAll(/\^plugins\/([a-z0-9-]+)\//g)]
              .map((m) => m[1] ?? "")
              .map((dir) => {
                // ★맨 `JSON.parse` 를 쓰면 깨진 매니페스트 하나에 **검사가 통째로 던진다**
                //  (5R F5 — 16단언이 한 줄로 사라졌다). 같은 커밋이 코어 쪽엔
                //  `safeReadJson` 을 쓰면서 여기만 맨손이었다. 못 읽으면 폴더 이름으로
                //  떨어지면 된다 — 그게 아래 `notShipped` 가 원하는 값이다.
                const pkg = path.join(REPO, "plugins", dir, "package.json");
                if (!existsSync(pkg)) return dir;
                try {
                  const t = (
                    JSON.parse(readFileSync(pkg, "utf8")) as { tiguclaw?: { name?: unknown } }
                  ).tiguclaw;
                  return typeof t?.name === "string" ? t.name : dir;
                } catch {
                  return dir;
                }
              }),
          ),
        ].sort()
      : [];
    const reserved = [...(await bundledPluginNames())].filter((n) => !notShipped.includes(n)).sort();
    out.push(
      assert(
        "★배포에서 빠지는 번들은 예약 목록에서도 빠진다 — 가이드는 **받는 사람의 앱**을 설명한다(dev 에만 있는 예제 이름을 예약이라고 적으면 독자가 쓸 수 있는 이름을 피한다)",
        isDevTree ? notShipped.length > 0 : reserved.length > 0,
        isDevTree
          ? `dev 트리 · 배포 제외 ${String(notShipped.length)}개(${notShipped.join(", ")}) → 예약 ${String(reserved.length)}개`
          : `배포 트리 · 여기 plugins/ 가 곧 배포본 → 예약 ${String(reserved.length)}개`,
      ),
    );
    for (const [label, body, section] of [
      ["ko", guide, "예약"],
      ["en", existsSync(enPath) ? readFileSync(enPath, "utf8") : "", "reserved"],
    ] as Array<[string, string, string]>) {
      const missing = reserved.filter((n) => !new RegExp("`" + n + "`").test(body));
      out.push(
        assert(
          `★★가이드(${label})가 **예약된 번들 이름 ${String(reserved.length)}개를 전부** 적는다 — 하나라도 빠지면 그 이름을 고른 사람이 설치 단계에서야 알게 된다`,
          missing.length === 0,
          missing.length === 0 ? reserved.join(", ") : `★빠짐: ${missing.join(", ")}`,
        ),
      );
      // ★**반대 방향도 본다** (2026-08-30, 적대 검토 E조 F4). 종전엔 *"디스크의 이름이
      //  글에 있나"* 한 방향뿐이라, 글에 `notion`·`slack` 을 예약이라고 **날조해도**
      //  초록이었다. 그러면 독자는 쓸 수 있는 이름을 피해 자기 것을 개명한다 — 이 파일이
      //  `host.*`·`needs.*` 에는 *"없는 것을 지어내지 않는다"* 축을 이미 두고 있는데
      //  새 목록에만 안 붙였다.
      // 범위는 **예약 이름을 전부 담는 가장 좁은 창** — 종전엔 각 이름의 *첫 등장*으로
      // 잡았는데, 예약된 이름 하나(`weather`)를 §2 예시로 한 번 쓰자 창이 문서 전체로
      // 벌어져 매니페스트 키·`host` 메서드까지 "날조" 로 셌다(2026-08-30, 3라운드).
      // 검사가 **거짓 빨강**을 내면 아무도 안 돌리게 된다([[feedback_gate_must_actually_run]]).
      const hits = reserved.flatMap((n, i) =>
        [...body.matchAll(new RegExp("`" + n + "`", "g"))].map((m) => ({ at: m.index ?? 0, i })),
      ).sort((a, b) => a.at - b.at);
      let span = "";
      if (new Set(hits.map((h) => h.i)).size === reserved.length) {
        const seen = new Map<number, number>();
        let best: [number, number] | undefined;
        let lo = 0;
        for (const h of hits) {
          seen.set(h.i, (seen.get(h.i) ?? 0) + 1);
          while (seen.size === reserved.length) {
            const width = h.at - hits[lo]!.at;
            if (best === undefined || width < best[1] - best[0]) best = [hits[lo]!.at, h.at];
            const drop = hits[lo]!.i;
            const left = (seen.get(drop) ?? 0) - 1;
            if (left === 0) seen.delete(drop);
            else seen.set(drop, left);
            lo++;
          }
        }
        if (best !== undefined) span = body.slice(best[0], best[1] + 20);
      }
      const invented = [...span.matchAll(/`([a-z][a-z0-9-]{2,})`/g)]
        .map((m) => m[1] ?? "")
        .filter((n) => !reserved.includes(n));
      out.push(
        assert(
          `★★가이드(${label})가 **예약되지 않은 이름을 예약이라고 적지 않는다** — 날조하면 독자는 쓸 수 있는 이름을 피해 자기 플러그인을 개명한다`,
          span !== "" && invented.length === 0,
          span === "" ? "★예약 목록을 못 찾음" : invented.length === 0 ? "날조 0" : `★날조: ${invented.join(", ")}`,
        ),
      );
    }

    return out;
  },
};
