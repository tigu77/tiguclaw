/**
 * 회귀: **플러그인이 브라우저에 파일을 실을 수 있고, 그 밖으로는 못 나간다** (2026-08-28).
 *
 * ★설계: `docs/decisions/2026-08-28-widget-platform.md` §E.1 (증분 0). 위젯의 **브라우저
 *  코드**를 플러그인이 들고 올 수 있게 하는 유일한 길이라, 이게 없으면 위젯 플랫폼이
 *  시작하지 못한다. 그리고 새로 여는 **파일 서빙 경로**라 트래버설이 곧 유출이다.
 *
 * ★**소스 grep 으로는 못 지킨다.** 경로 트래버설은 인코딩·중복 슬래시·`..` 접힘이 얽혀서
 *  "`..` 를 검사하는 코드가 있나" 로는 판별이 안 된다. 그래서 판정을 순수 함수로 뽑고
 *  (`core/plugin-assets.ts`) 여기서 **실제로 뚫어본다**(principle-check Q7).
 *
 * ★**첫 판에 실제로 뚫렸다.** 플러그인 *이름*을 안 가둬서 `/plugin-asset/../SYSTEM.js` 가
 *  통과했다 — `plugin` 이 `..` 이면 base(`<root>/<plugin>/web`) **자체가 위로 이동**해서,
 *  그 아래를 확인하는 containment 검사가 멀쩡히 초록을 냈다. 검사가 아니라 **프로브가**
 *  잡았다. 그래서 그 케이스가 아래 표에 있다.
 *
 * 등급: **동작 검사** — 판정은 직접 호출(진리표 전수). 배선(라우트가 그 판정을 쓰나·전부
 * 404 로 답하나)만 소스 대조이고, 그 사실을 아래에 적어 둔다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_ASSET_PREFIX,
  resolvePluginAsset,
  resolvePluginAssetIn,
} from "../../core/plugin-assets.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOT = "/app/plugins";

/** `[요청, 기대]` — 기대는 `ok` 또는 실패 사유. */
const CASES: Array<[string, string]> = [
  // ── 되어야 하는 것 ──
  ["/plugin-asset/weather/widget.js", "ok"],
  ["/plugin-asset/weather/widget.css", "ok"],
  ["/plugin-asset/weather/icons/rain.svg", "ok"],
  ["/plugin-asset/weather/deep/er/x.js", "ok"],
  // ── 나가려는 것 ──
  ["/plugin-asset/weather/../../../etc/passwd.js", "escape"],
  ["/plugin-asset/weather/../secret.js", "escape"],
  ["/plugin-asset/../SYSTEM.js", "escape"], // ★첫 판이 뚫린 자리(이름 미가둠)
  ["/plugin-asset/../../x.js", "escape"],
  ["/plugin-asset/./weather/w.js", "escape"], // `.` 도 직계 자식이 아니다
  ["/plugin-asset/..%2f..%2fSYSTEM.js", "escape"], // 인코딩된 탈출
  ["/plugin-asset/weather/..%2f..%2fetc%2fpasswd.js", "escape"],
  ["/plugin-asset/weather%2f..%2f..%2fx.js", "escape"],
  // ── 줄 수 없는 종류 ──
  ["/plugin-asset/weather/index.ts", "type"], // 플러그인 소스
  ["/plugin-asset/weather/.env", "type"],
  // ★`.json` 은 **허용한다** (2026-08-28). 플러그인이 자기 번역 카탈로그를 들고 오려면
  //  필요하고, 위험하지 않다: base 가 `<plugin>/web/` 이라 `package.json`·`settings.json`
  //  은 **그 밖**이고 containment 가 이미 막는다(아래 두 줄이 그걸 실행으로 확인한다).
  //  첫 판은 자리를 안 보고 확장자만 보고 막았다 — 근거가 틀렸다.
  ["/plugin-asset/weather/locales/ko.json", "ok"],
  ["/plugin-asset/weather/../package.json", "escape"],
  ["/plugin-asset/weather/../settings.json", "escape"],
  // ── 모양이 아닌 것 ──
  ["/plugin-asset/weather/", "shape"],
  ["/plugin-asset/weather", "shape"],
  ["/plugin-asset/", "shape"],
  ["/plugin-asset/weather/a\0.js", "shape"],
  ["/plugin-asset/weather/..\\..\\x.js", "shape"], // 윈도우 구분자
  ["/plugin-asset/weather/%zz.js", "shape"], // 깨진 인코딩
  ["/js/app.js", "shape"], // 우리 라우트가 아님
];

export const check: RegressionCheck = {
  name: "plugin-assets-are-contained",
  guards:
    "플러그인이 위젯 브라우저 코드를 실을 길이 없던 것 + 그 길을 열면서 생기는 경로 트래버설(플러그인 폴더엔 소스·package.json·설정이 같이 산다)",
  run: async (): Promise<Assertion[]> => {
    // ── ① 판정 진리표 — 전수, 실제 호출 ──
    const wrong = CASES.filter(([url, want]) => {
      const r = resolvePluginAsset(ROOT, url);
      return (r.ok ? "ok" : r.reason) !== want;
    });

    const okOnes = CASES.filter(([, w]) => w === "ok").map(([u]) => resolvePluginAsset(ROOT, u));
    const escaped = okOnes.filter((r) => !r.ok || !r.file.startsWith(`${ROOT}/`));

    const dash = readFileSync(path.join(REPO, "packages/dashboard/index.ts"), "utf8");
    const core = readFileSync(path.join(REPO, "src/core/plugin-assets.ts"), "utf8");

    return [
      assert(
        "★★경로 판정이 진리표대로다(**실제로 뚫어본다** — 소스 grep 이 아니다)",
        wrong.length === 0,
        wrong.length === 0
          ? `${CASES.length}케이스 통과`
          : `★틀림: ${wrong.map(([u, w]) => `${u}(기대 ${w})`).join(" / ")}`,
      ),
      assert(
        "★통과한 것은 **전부** 플러그인 루트 아래다(허용 케이스가 조용히 밖을 가리키지 않는다)",
        escaped.length === 0,
        escaped.length === 0
          ? `${okOnes.length}건 전부 루트 안`
          : `★밖: ${escaped.map((r) => (r.ok ? r.file : "?")).join(", ")}`,
      ),
      assert(
        "★★플러그인 **이름**도 가둔다(루트의 직계 자식만 — 이걸 빼면 base 가 위로 이동해 아래 검사가 무력해진다)",
        (() => {
          const r = resolvePluginAsset(ROOT, "/plugin-asset/../SYSTEM.js");
          return !r.ok && r.reason === "escape";
        })(),
        (() => {
          const r = resolvePluginAsset(ROOT, "/plugin-asset/../SYSTEM.js");
          return r.ok ? `★뚫림 → ${r.file}` : `막힘(${r.reason})`;
        })(),
      ),
      assert(
        "★**디코드를 먼저** 한다(안 하면 `%2e%2e%2f` 가 문자열 비교를 그대로 통과한다)",
        /decodeURIComponent/.test(core) &&
          core.indexOf("decodeURIComponent") < core.indexOf("path.resolve"),
        `디코드=${/decodeURIComponent/.test(core)} · resolve 보다 앞=${core.indexOf("decodeURIComponent") < core.indexOf("path.resolve")}`,
      ),
      assert(
        "★브라우저에 주는 확장자가 **닫힌 집합**이다(플러그인 소스·설정·키가 안 샌다)",
        (() => {
          const bad = [".ts", ".env", ".md", ".db", ".mjs", ""].filter((e) => {
            const r = resolvePluginAsset(ROOT, `/plugin-asset/w/x${e}`);
            return r.ok;
          });
          return bad.length === 0;
        })(),
        (() => {
          const bad = [".ts", ".env", ".md", ".db", ".mjs", ""].filter(
            (e) => resolvePluginAsset(ROOT, `/plugin-asset/w/x${e}`).ok,
          );
          return bad.length === 0 ? "전부 거절" : `★허용됨: ${bad.join(",")}`;
        })(),
      ),
      // ── ② 배선 — 여기부터는 소스 대조다 ──
      assert(
        "★라우트가 **그 판정을 쓴다**(인라인으로 다시 짜면 두 벌이 되고 갈린다)",
        /resolvePluginAssetIn\(\s*\[path\.join\(appRoot\(\), "plugins"\), getPaths\(\)\.commonPlugins\]/.test(
          dash,
        ),
        /resolvePluginAssetIn\(/.test(dash) ? "공유 판정(두 뿌리)" : "★인라인 재구현",
      ),
      // ★설치 형태 — 번들과 홈 둘 다 서빙하되 **번들이 이긴다**(로더와 같은 우선순위).
      //  ★실물 유무를 가짜 `exists` 로 **실행해서** 확인한다(fs 없이 우선순위를 시험한다).
      ...(() => {
        const ROOTS = ["/app/plugins", "/home/plugins"];
        const only = (f: string) => (p: string): boolean => p === f;
        const both = resolvePluginAssetIn(ROOTS, "/plugin-asset/w/x.js", () => true);
        const homeOnly = resolvePluginAssetIn(
          ROOTS,
          "/plugin-asset/w/x.js",
          only("/home/plugins/w/web/x.js"),
        );
        const nowhere = resolvePluginAssetIn(ROOTS, "/plugin-asset/w/x.js", () => false);
        const esc = resolvePluginAssetIn(ROOTS, "/plugin-asset/../SYSTEM.js", () => true);
        return [
          assert(
            "★★둘 다 있으면 **번들이 이긴다**(홈에서 코어 플러그인 자산을 가로채지 못한다)",
            both.ok && both.file === "/app/plugins/w/web/x.js",
            both.ok ? both.file : `막힘(${both.reason})`,
          ),
          assert(
            "★★홈에만 있으면 **홈을 준다**(모양만 보고 첫 뿌리를 돌려주면 설치한 게 404 다 — 실제로 그랬다)",
            homeOnly.ok && homeOnly.file === "/home/plugins/w/web/x.js",
            homeOnly.ok ? homeOnly.file : `★막힘(${homeOnly.reason})`,
          ),
          assert(
            "★어느 뿌리에도 없으면 준다고 하지 않는다",
            !nowhere.ok,
            nowhere.ok ? `★${nowhere.file}` : `막힘(${nowhere.reason})`,
          ),
          assert(
            "★가둠은 **뿌리마다 따로** 판정한다(합쳐서 한 번 보면 한쪽의 `..` 가 다른 쪽으로 샌다)",
            !esc.ok && esc.reason === "escape",
            esc.ok ? `★뚫림 → ${esc.file}` : `막힘(${esc.reason})`,
          ),
        ];
      })(),
      assert(
        "★막힌 이유를 **밖에 안 알려준다**(사유가 새면 그게 탐색 도구가 된다 — 전부 404)",
        (() => {
          const i = dash.indexOf(`pathname.startsWith(${"PLUGIN_ASSET_PREFIX"})`);
          const body = i >= 0 ? dash.slice(i, i + 1200) : "";
          return body !== "" && !/r\.reason/.test(body) && (body.match(/writeHead\(404/g) ?? []).length >= 2;
        })(),
        (() => {
          const i = dash.indexOf(`pathname.startsWith(${"PLUGIN_ASSET_PREFIX"})`);
          const body = i >= 0 ? dash.slice(i, i + 1200) : "";
          return `사유 노출=${/r\.reason/.test(body)} · 404 분기 ${(body.match(/writeHead\(404/g) ?? []).length}곳`;
        })(),
      ),
      assert(
        "★캐시를 안 건다(`/update` 로 자산이 바뀌는데 지문이 없다 — 걸면 옛 위젯이 뜬다)",
        (() => {
          const i = dash.indexOf(`pathname.startsWith(${"PLUGIN_ASSET_PREFIX"})`);
          const body = i >= 0 ? dash.slice(i, i + 1200) : "";
          return /"Cache-Control": "no-store"/.test(body);
        })(),
        (() => {
          const i = dash.indexOf(`pathname.startsWith(${"PLUGIN_ASSET_PREFIX"})`);
          const body = i >= 0 ? dash.slice(i, i + 1200) : "";
          return (/max-age/.test(body) ? "★max-age 가 붙었다" : "no-store");
        })(),
      ),
      assert(
        "★접두사를 **한 곳**에서 가져온다(라우트와 검사가 같은 글자를 쓴다)",
        PLUGIN_ASSET_PREFIX === "/plugin-asset/" && /PLUGIN_ASSET_PREFIX/.test(dash),
        `${PLUGIN_ASSET_PREFIX} · 라우트가 상수 사용=${/PLUGIN_ASSET_PREFIX/.test(dash)}`,
      ),
    ];
  },
};
