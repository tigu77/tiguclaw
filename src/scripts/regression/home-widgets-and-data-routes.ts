/**
 * 회귀: **홈 위젯 — 배치는 비서가 쓰고, 값은 데몬이 받아온다** (2026-08-28, 위젯 플랫폼 §J).
 *
 * 지키는 것 넷:
 *  ① **판정이 순수 함수다** — 모르는 플러그인·중복 id·자격증명·캡을 거부하고 **이유를 남긴다**.
 *     반쪽으로 적용하면 지금 홈이 무엇인지 아무도 모르게 된다.
 *  ② **쓰기가 남의 설정을 안 날린다** — `settings.json` 은 코어 정본이라 모델 프로파일·테마가
 *     같이 산다. 한 키만 바꾸는 게 계약이다.
 *  ③ **캐시가 서버에 있다** — 탭이 몇이든 TTL 당 한 번. 이게 없으면 상시 띄워두는 화면이
 *     무료 티어 API 를 크롤링한다. 실패는 **캐시하지 않는다**(새로고침이 먹혀야 한다).
 *  ④ **게이트와 parity** — `/plugin-data/` 는 read 등급이고(프리픽스 한 줄), `configure_home`
 *     은 **세 어댑터 전부**에 실린다(원칙 #2 — 기능은 LLM 무관).
 *
 * 등급: ①②③은 **동작**(실제로 부르고 쓰고 읽는다), ④는 소스 대조(라우팅·배선 사실).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_WIDGET_MAX,
  looksLikeCredentialKey,
  looksLikeCredentialValue,
  normalizeHomeWidgets,
  readHomeWidgets,
  writeHomeWidgets,
} from "../../core/home-widgets.js";
import {
  PLUGIN_MEDIA_MAX_BYTES,
  callPluginDataRoute,
  clearPluginDataCache,
  registerPluginDataRoutes,
  unregisterPluginDataRoutes,
} from "../../core/plugins/data-routes.js";
import { getPaths } from "../../core/paths.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

const KNOWN = new Set(["weather"]);

export const check: RegressionCheck = {
  name: "home-widgets-and-data-routes",
  guards:
    "서드파티 핸들러의 **동기** throw 가 reject 로 새어 데몬을 crash-fast 시키는 것 + 미디어 상한이 in-flight 합류자에게만 안 걸리는 것 + 자격증명 가드가 낱말이 이름 중간에 오면 통과하던 것(authToken·clientSecret·x-api-key) + 홈 배치가 모르는 플러그인·중복 id·자격증명을 받아들이는 것 + 배치 쓰기가 settings.json 의 다른 키를 날리는 것 + 위젯 데이터가 브라우저마다 외부를 부르는 것(캐시 없음) + 실패를 캐시해 새로고침이 안 먹는 것 + /plugin-data 게이트 누락 + configure_home 이 한 어댑터에만 실리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 판정 (순수) ──────────────────────────────────────────────────────
    const good = normalizeHomeWidgets(
      [
        { id: "a", type: "weather/forecast", config: { place: "수원시" } },
        { id: "b", type: "weather/forecast", size: "wide", config: { place: "Tokyo" } },
      ],
      KNOWN,
    );
    out.push(
      assert(
        "★좋은 배치는 통과하고 size 기본은 small (같은 type 을 **여러 개** 놓을 수 있어야 한다 — 도시 둘이 이 기능의 요구였다)",
        good.rejected.length === 0 &&
          good.widgets.length === 2 &&
          good.widgets[0]?.size === "small" &&
          good.widgets[1]?.size === "wide",
        JSON.stringify(good),
      ),
    );

    const bad = normalizeHomeWidgets(
      [
        { id: "a", type: "ghost/thing" },
        { id: "b", type: "notaplugin" },
        { id: "c", type: "weather/forecast", size: "huge" },
        { id: "d", type: "weather/forecast", config: { apiKey: "sk-live-1" } },
        { id: "e", type: "weather/forecast" },
        { id: "e", type: "weather/forecast" },
      ],
      KNOWN,
    );
    out.push(
      assert(
        "★모르는 플러그인 · 형식 오류 · 범위 밖 size · 중복 id 를 거부한다",
        bad.widgets.length === 1 &&
          bad.widgets[0]?.id === "e" &&
          bad.rejected.length === 5,
        JSON.stringify(bad.rejected),
      ),
    );
    out.push(
      assert(
        "★★자격증명처럼 보이는 config 키를 거부한다 — 이 레코드는 **브라우저로 나가고 백업에 들어간다**",
        bad.rejected.some((r) => r.at === "widgets[3]" && /\.env|열쇠/.test(r.reason)),
        JSON.stringify(bad.rejected.find((r) => r.at === "widgets[3]")),
      ),
    );
    const many = normalizeHomeWidgets(
      Array.from({ length: HOME_WIDGET_MAX + 3 }, (_, i) => ({
        id: `w${i}`,
        type: "weather/forecast",
      })),
      KNOWN,
    );
    out.push(
      assert(
        `★캡 ${HOME_WIDGET_MAX} 개 — 위젯 하나가 곧 주기적인 외부 호출 하나다(무한이면 데몬이 크롤러가 된다)`,
        many.widgets.length === HOME_WIDGET_MAX && many.rejected.length === 3,
        `${many.widgets.length} / rejected ${many.rejected.length}`,
      ),
    );
    out.push(
      assert(
        "배열이 아니면 이유를 남기고 빈 배치가 된다(홈은 영역을 안 그린다)",
        normalizeHomeWidgets({ nope: true }, KNOWN).rejected.length === 1,
        JSON.stringify(normalizeHomeWidgets({ nope: true }, KNOWN)),
      ),
    );

    // ── ② 쓰기가 남의 키를 안 날린다 (동작) ────────────────────────────────
    const settings = getPaths().settings;
    writeFileSync(
      settings,
      JSON.stringify({ models: { default: "keep-me" }, theme: "dusk" }, null, 2),
      "utf8",
    );
    writeHomeWidgets(good.widgets);
    const after = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    out.push(
      assert(
        "★★배치를 써도 `settings.json` 의 다른 키가 그대로다 — 이 파일엔 모델 프로파일·테마가 같이 산다",
        JSON.stringify(after.models) === JSON.stringify({ default: "keep-me" }) &&
          after.theme === "dusk",
        JSON.stringify(after),
      ),
    );
    const roundTrip = readHomeWidgets(KNOWN);
    out.push(
      assert(
        "★쓰고 읽으면 같다 — **읽는 자리와 쓰는 자리가 같아야** 한다(레이어 병합으로 읽으면 프로젝트 파일이 값을 가려 '쓰기가 먹은 것처럼 보이는데 화면은 안 바뀐다')",
        JSON.stringify(roundTrip.widgets) === JSON.stringify(good.widgets),
        JSON.stringify(roundTrip),
      ),
    );
    writeHomeWidgets([]);
    const emptied = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    out.push(
      assert(
        "비우면 키를 지운다(설정한 적 없음 == 비워둠 — 화면 동작이 같으니 흔적을 안 남긴다)",
        emptied.dashboard === undefined && emptied.theme === "dusk",
        JSON.stringify(emptied),
      ),
    );

    // ── ③ 데이터 라우트 · 캐시 (동작) ──────────────────────────────────────
    clearPluginDataCache();
    let calls = 0;
    let fail = false;
    registerPluginDataRoutes("probe", {}, {
      value: {
        ttlMs: 60_000,
        handler: async (query) => {
          calls += 1;
          if (fail) throw new Error("외부가 죽었다");
          return { echo: query.q ?? "", n: calls };
        },
      },
    });

    const first = await callPluginDataRoute("probe", "value", { q: "a" });
    const second = await callPluginDataRoute("probe", "value", { q: "a" });
    out.push(
      assert(
        "★★TTL 안에서는 캐시가 답한다 — 탭이 몇이든 밖으로는 한 번(이게 없으면 상시 화면이 무료 티어를 크롤링한다)",
        calls === 1 && first.ok && second.ok && second.cached,
        `calls=${calls}`,
      ),
    );
    const other = await callPluginDataRoute("probe", "value", { q: "b" });
    out.push(
      assert(
        "질의가 다르면 다른 값이다(캐시 키에 질의가 들어간다)",
        calls === 2 && other.ok && !other.cached,
        `calls=${calls}`,
      ),
    );

    clearPluginDataCache();
    calls = 0;
    const together = await Promise.all([
      callPluginDataRoute("probe", "value", { q: "z" }),
      callPluginDataRoute("probe", "value", { q: "z" }),
      callPluginDataRoute("probe", "value", { q: "z" }),
    ]);
    out.push(
      assert(
        "★동시에 셋이 물어도 밖으로는 한 번(in-flight 합류) — 탭 셋을 동시에 여는 게 실제 경로다",
        calls === 1 && together.every((r) => r.ok),
        `calls=${calls}`,
      ),
    );

    clearPluginDataCache();
    calls = 0;
    fail = true;
    const failed = await callPluginDataRoute("probe", "value", { q: "e" });
    const retried = await callPluginDataRoute("probe", "value", { q: "e" });
    fail = false;
    out.push(
      assert(
        "★★실패는 캐시하지 않는다 — 캐시하면 새로고침해도 몇 분간 옛 실패를 본다",
        !failed.ok && failed.status === 502 && !retried.ok && calls === 2,
        `calls=${calls} first=${JSON.stringify(failed)}`,
      ),
    );

    const unknownRoute = await callPluginDataRoute("probe", "nope", {});
    out.push(
      assert(
        "모르는 라우트는 404 다 — 502(남의 서버 문제)와 가른다(로그만 보고 어느 쪽인지 알아야 한다)",
        !unknownRoute.ok && unknownRoute.status === 404,
        JSON.stringify(unknownRoute),
      ),
    );

    await callPluginDataRoute("probe", "value", { q: "keep" });
    unregisterPluginDataRoutes("probe");
    const afterOff = await callPluginDataRoute("probe", "value", { q: "keep" });
    out.push(
      assert(
        "★플러그인을 끄면 라우트도 캐시도 사라진다 — 안 그러면 꺼진 플러그인의 값이 TTL 동안 계속 나간다",
        !afterOff.ok && afterOff.status === 404,
        JSON.stringify(afterOff),
      ),
    );

    // ── ④ 게이트 · parity (소스 대조) ──────────────────────────────────────
    const bridge = read("plugins/http-bridge");
    out.push(
      assert(
        '★★`/plugin-data/` 가 role 게이트에 **프리픽스로** 있다 — 플러그인마다 한 줄씩 늘면 그게 곧 빠뜨릴 목록이다(이 사다리는 이미 한 번 빠뜨려 read 토큰이 쓰기를 했다)',
        /pathname\.startsWith\("\/plugin-data\/"\) && method === "GET"/.test(bridge),
        (bridge.match(/pathname\.startsWith\("\/plugin-data\/"\)[^\n]*/) ?? ["없음"])[0],
      ),
    );
    out.push(
      assert(
        "홈 배치 조회(`/home-widgets`)도 게이트에 있다 — 읽기만 열려 있고 쓰기 구멍은 없다",
        /pathname === "\/home-widgets" && method === "GET"/.test(bridge) &&
          !/pathname === "\/home-widgets" && method === "POST"/.test(bridge),
        (bridge.match(/pathname === "\/home-widgets"[^\n]*/) ?? ["없음"])[0],
      ),
    );
    const adapters = [
      "src/core/llm-runtime/adapters/claude-agent-sdk.ts",
      "src/core/llm-runtime/adapters/openai-agents-sdk.ts",
      "src/core/llm-runtime/adapters/openai-codex-oauth.ts",
    ];
    const missing = adapters.filter((f) => !read(f).includes("createHomeWidgetsMcpServer"));
    out.push(
      assert(
        "★★`configure_home` 이 **세 어댑터 전부**에 실린다 — 한 곳에만 있으면 '어느 모델로 바꾸면 홈을 못 고치는' 기능이 된다(원칙 #2)",
        missing.length === 0,
        missing.length === 0 ? `3/3 어댑터` : `누락: ${missing.join(", ")}`,
      ),
    );
    const overview = read("packages/dashboard/js/view-overview.js");
    out.push(
      assert(
        "★홈을 떠나면 poll 을 끄는 자리가 **정의점**(setActiveNav)에 있다 — 뷰로 들어가는 문은 여럿이라 문마다 붙이면 또 빠뜨린다",
        /const setActiveNav = \(view\) => \{[\s\S]{0,400}?stopHomeWidgets\(\)/.test(overview),
        (overview.match(/[^\n]*stopHomeWidgets\(\);[^\n]*/) ?? ["없음"])[0].trim(),
      ),
    );

    // ── ⑤ 적대 검토 수정분 (2026-08-29) ────────────────────────────────────
    // ★셋 다 **실행**으로 검사한다 — 소스를 훑는 검사는 동의어 하나로 뚫린다.

    // B-P4 — 서드파티 핸들러가 **동기로** 던진다(거부 프라미스가 아니라 `throw`).
    //  종전엔 `handler()` 호출이 `try` 밖이라 이 함수가 **reject** 로 샜고, 브리지에서
    //  그건 `unhandledRejection` → 데몬 crash-fast 다. 플러그인 하나가 데몬을 죽인다.
    registerPluginDataRoutes("sync-throw", {}, {
      boom: {
        ttlMs: 1000,
        handler: () => {
          throw new Error("동기 폭발");
        },
      },
    });
    let syncRejected = false;
    let syncResult: unknown;
    try {
      syncResult = await callPluginDataRoute("sync-throw", "boom", {});
    } catch {
      syncRejected = true;
    }
    unregisterPluginDataRoutes("sync-throw");
    out.push(
      assert(
        "★★핸들러가 **동기로** 던져도 이 함수는 값으로 답한다(502) — reject 로 새면 브리지에서 `unhandledRejection` → **데몬 crash-fast** 라, 서드파티 플러그인 하나가 데몬을 죽인다",
        !syncRejected &&
          (syncResult as { ok: boolean; status?: number }).ok === false &&
          (syncResult as { status?: number }).status === 502,
        syncRejected ? "★reject 로 샜다" : JSON.stringify(syncResult),
      ),
    );

    // B-P1 — 미디어 상한은 **합류자에게도** 걸린다. 상한이 "먼저 물어본 사람에게만"
    //  걸리면 그건 상한이 아니다.
    clearPluginDataCache();
    let bigCalls = 0;
    registerPluginDataRoutes("big-media", {}, {
      tile: {
        ttlMs: 60_000,
        handler: async () => {
          bigCalls += 1;
          await new Promise((r) => setTimeout(r, 10));
          return {
            contentType: "image/png",
            body: new Uint8Array(PLUGIN_MEDIA_MAX_BYTES + 1),
          };
        },
      },
    });
    // 첫 호출이 도는 사이에 둘째가 **합류**한다(첫 호출을 await 하지 않고 바로 부른다).
    const bothBig = await Promise.all([
      callPluginDataRoute("big-media", "tile", {}),
      callPluginDataRoute("big-media", "tile", {}),
    ]);
    unregisterPluginDataRoutes("big-media");
    out.push(
      assert(
        "★★상한을 넘긴 미디어는 **합류한 쪽에도** 안 나간다 — 종전엔 최초 호출자 경로에만 검사가 있어, 탭 둘을 동시에 열면 둘째가 상한을 우회했다",
        bigCalls === 1 && bothBig.every((r) => !r.ok && r.status === 502),
        `밖으로 ${bigCalls}회 · 결과=${bothBig.map((r) => (r.ok ? "ok" : `${String(r.status)}`)).join(",")}`,
      ),
    );

    // A-F2 — 자격증명 가드. ★**표본이 한 개면 그건 표본이 아니다** — 종전 회귀는 `apiKey`
    //  하나만 봤는데, 그게 옛 정규식이 유일하게 잡던 형태였다.
    // ★★**표본도 같이 되돌렸다** (2026-08-30). 값 기반 판정을 되돌렸으므로 그 표본은
    //  대상이 없다. 남아 있는 결함(정상 키 과차단)은 로드맵에 있다 — 다음 설계 때
    //  **갈래마다 그 갈래만 밟는 표본**을 함께 만든다(이번에 두 번 놓친 축이다).
    const mustBlock = [
      "apiKey", "api_key", "x-api-key", "apikey", "authToken", "auth_token",
      "authtoken", "clientSecret", "accessKey", "privateKey", "password",
      "passwd", "credentials", "bearer", "Cookie", "sessionId", "jwt",
      "oauthToken", "SIGNATURE", "pwd", "certPath",
      "API_KEY", "refreshToken", "accessToken", "secretKey", "sessionKey", "AUTHORIZATION",
      // ★**2026-08-30 실측으로 뚫렸던 24종** (적대 검토 B조 P-2). 아침에 `key`·`pass`·
      //  `session` 을 약한 목록에서 빼고 *"합성어로 되찾는다"* 고 적었는데, 되찾기가 손
      //  목록이라 이것들이 전부 새어 나갔다. 진짜 export 로 돌려보니
      //  `passphrase="correct-horse-battery-staple"` 가 settings.json 에 쓰이고 브라우저로
      //  나갔다. **표본이 구현의 낱말 목록을 베끼면 그 목록의 빈틈은 원리적으로 안 보인다** —
      //  그래서 여기엔 구현을 안 보고 *"이건 자격증명이다"* 로 고른 이름을 적는다.
      "passphrase", "passcode", "pass", "apiPass", "userPass", "pgpass", "gpgPassphrase",
      "key", "consumerKey", "encryptionKey", "signingKey", "hmacKey", "sharedKey",
      "clientKey", "licenseKey", "masterKey", "appKey", "serviceKey", "deployKey",
      "hostKey", "subscriptionKey", "keyfile", "api.key", "api key",
    ];
    const mustPass = [
      // 자격증명 낱말이 **아예 없는** 이름 — 이건 언제나 통과해야 한다.
      "city", "units", "keyword", "author", "monkey", "lat", "lon", "zoom",
      "refreshMinutes", "title", "query", "passenger", "turnkey", "donkey", "authorName",
      "columns", "showLegend", "maxItems", "dateFormat", "unit",
    ];
    // ★**지금 막히는 무해한 이름들 — 결함이 아니라 치르는 값이다.**
    //
    //  `chartKey` 와 `apiKey` 는 문법이 같다(수식어 + 머리명사 `key`). 이름만으로는
    //  구조적으로 못 가르므로 **막는 쪽을 기본**으로 골랐다 — 이 가드는 비대칭이라서다:
    //  과차단은 되돌릴 수 있고(위젯이 사유와 함께 거부되고 `.env` 안내가 붙는다) 유출은
    //  되돌릴 수 없다(값이 화면·백업으로 나간 뒤다).
    //
    // ★**이 목록을 풀려면 같은 커밋에서 위 `mustBlock` 이 여전히 전부 막힌다는 걸 보여라.**
    //  아침에 그 증명 없이 풀었다가 24종을 뚫었다. 여기 적어 두는 이유는 그 교환을 **눈에
    //  보이게** 두기 위해서다 — 조용히 뒤집히지 않게.
    const knownOverBlocked = [
      "chartKey", "sortKey", "dataKey", "labelKey", "titleKey", "cacheKey", "seriesKey",
      "groupKey", "rowKey", "localeKey", "primaryKey", "passRate", "sessionCount",
      "tokenCount", "certPathLabel", "privateNote", "jwtDocsUrl", "passwordHintText",
    ];
    // ── 값이 대놓고 자격증명인 것 ─────────────────────────────────────────
    // ★이름 가드가 원리적으로 못 보는 갈래다 (2026-08-30, 적대 검토 D조 D-1). 이름을
    //  되돌리면서 값 관측까지 같이 지웠고, 그래서 `pem: "-----BEGIN RSA PRIVATE KEY-----"`
    //  처럼 **값이 개인키인데** 이름에 낱말이 없어 통과했다. 실측 19종.
    const valueMustBlock: Array<[string, string]> = [
      ["pem", "-----BEGIN RSA PRIVATE KEY-----MIIEpAIBAAKCAQEA"],
      ["identityFile", "-----BEGIN OPENSSH PRIVATE KEY-----b3BlbnNzaA"],
      ["kubeconfig", "-----BEGIN CERTIFICATE-----MIIDdzCCAl+gAwIB"],
      ["githubPat", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
      ["slackWebhook", "xoxb-2321-4432-abcdefghijklmnop"],
      ["creds", "sk-proj-abcdefghijklmnopqrstuvwxyz"],
      ["databaseUrl", "postgres://admin:hunter2@db:5432/app"],
      ["mongoUri", "mongodb://user:pw@host:27017/db"],
    ];
    // ★반대 방향 — 평범한 URL·문자열이 막히면 위젯을 못 만든다.
    const valueMustPass: Array<[string, string]> = [
      ["docsUrl", "https://example.com/guide"],
      ["apiBase", "https://api.example.com/v1"],
      ["title", "이번 달 매출"],
      ["dateFormat", "YYYY-MM-DD"],
      ["city", "Seoul"],
      ["query", "select * from t"],
      ["avatar", "https://cdn.example.com/a.png"],
    ];
    const valueLeaked = valueMustBlock.filter(([, v]) => !looksLikeCredentialValue(v));
    const valueOver = valueMustPass.filter(([, v]) => looksLikeCredentialValue(v));
    out.push(
      assert(
        "★★**값이 대놓고 자격증명이면** 이름이 평범해도 막는다 — `pem`·`kubeconfig`·`githubPat` 은 이름에 걸릴 낱말이 없어서 이름 가드만으론 원리적으로 못 본다(실측 19종이 그렇게 샜다)",
        valueLeaked.length === 0,
        valueLeaked.length === 0 ? `${String(valueMustBlock.length)}종 전부 차단` : `★샘: ${valueLeaked.map(([k]) => k).join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★★평범한 URL·문자열은 **그대로 통과한다** — 값 가드가 길이·엔트로피 추측으로 번지면 그건 또 하나의 이름 맞히기이고, 과차단이 늘면 사람들이 가드를 우회하는 법부터 배운다",
        valueOver.length === 0,
        valueOver.length === 0 ? `${String(valueMustPass.length)}종 전부 통과` : `★막힘: ${valueOver.map(([k]) => k).join(", ")}`,
      ),
    );

    // ★**입구로 통과시켜 본다** — 판정 함수만 부르면 이음매가 안 검사된다. 실제로 변이
    //  M12(호출부에서 `|| looksLikeCredentialValue(v)` 를 뗌)가 위 단언들을 **전부 통과**
    //  했다: 부품은 멀쩡한데 아무도 안 부르는 상태다([[feedback_simple_composable_no_duplication]]).
    const throughDoor = normalizeHomeWidgets(
      [
        { id: "leak", type: "weather/forecast", config: { pem: "-----BEGIN RSA PRIVATE KEY-----MIIEpAIBAAKCAQEA" } },
        { id: "fine", type: "weather/forecast", config: { place: "수원시" } },
      ],
      KNOWN,
    );
    out.push(
      assert(
        "★★자격증명 **값**을 담은 위젯이 **실제 입구에서 거부된다** — 판정 함수만 검사하면 그 판정을 아무도 안 불러도 초록이다(그 변이가 실제로 통과했다)",
        throughDoor.widgets.length === 1 && throughDoor.widgets[0]?.id === "fine",
        `통과한 위젯 ${throughDoor.widgets.map((w) => w.id).join(", ") || "없음"}`,
      ),
    );

    const leaked = mustBlock.filter((k) => !looksLikeCredentialKey(k));
    const overblocked = mustPass.filter((k) => looksLikeCredentialKey(k));
    const quietlyUnblocked = knownOverBlocked.filter((k) => !looksLikeCredentialKey(k));
    out.push(
      assert(
        `★★자격증명처럼 보이는 키 ${String(mustBlock.length)}종이 전부 막힌다 — 종전 정규식은 낱말이 **이름 중간**에 오면 통과시켜 \`authToken\`·\`clientSecret\`·\`accessKey\`·\`x-api-key\` 가 다 뚫렸다(이 값은 브라우저로 나가고 백업에 들어간다)`,
        leaked.length === 0,
        leaked.length === 0 ? `${String(mustBlock.length)}종 전부 차단` : `★통과: ${leaked.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★평범한 설정 키는 안 막힌다 — `keyword`·`author`·`monkey` 는 자격증명이 아니다(넓히면서 낱말 경계를 두는 이유)",
        overblocked.length === 0,
        overblocked.length === 0 ? `${String(mustPass.length)}종 전부 통과` : `★차단됨: ${overblocked.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★★지금 막히는 무해한 이름들이 **조용히 풀리지 않는다** — 풀려면 같은 커밋에서 위 자격증명 표본이 여전히 전부 막힌다는 걸 보여야 한다(아침에 그 증명 없이 풀었다가 24종을 뚫었다)",
        quietlyUnblocked.length === 0,
        quietlyUnblocked.length === 0
          ? `${String(knownOverBlocked.length)}종 여전히 차단(치르는 값 — 이름만으론 apiKey 와 chartKey 를 못 가른다)`
          : `★풀렸다: ${quietlyUnblocked.join(", ")} — 자격증명 표본을 다시 재라`,
      ),
    );

    return out;
  },
};
