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
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_WIDGET_MAX,
  normalizeHomeWidgets,
  readHomeWidgets,
  writeHomeWidgets,
} from "../../core/home-widgets.js";
import {
  callPluginDataRoute,
  clearPluginDataCache,
  registerPluginDataRoutes,
  unregisterPluginDataRoutes,
} from "../../core/plugins/data-routes.js";
import { getPaths } from "../../core/paths.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

const KNOWN = new Set(["weather"]);

export const check: RegressionCheck = {
  name: "home-widgets-and-data-routes",
  guards:
    "홈 배치가 모르는 플러그인·중복 id·자격증명을 받아들이는 것 + 배치 쓰기가 settings.json 의 다른 키를 날리는 것 + 위젯 데이터가 브라우저마다 외부를 부르는 것(캐시 없음) + 실패를 캐시해 새로고침이 안 먹는 것 + /plugin-data 게이트 누락 + configure_home 이 한 어댑터에만 실리는 것",
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
    const bridge = read("plugins/http-bridge/index.ts");
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

    return out;
  },
};
