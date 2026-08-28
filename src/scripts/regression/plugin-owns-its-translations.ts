/**
 * 회귀: **번역은 플러그인 책임이다** (2026-08-28, 정태님).
 *
 * ★실제로 어기고 있었다. 서버가 문장을 안 만들게 하려고(2026-08-26 규약) WMO 코드만 싣고
 *  문장을 화면에서 만들게 했는데, **화면이 한국어로만** 만들었다 — `맑음`·`구름 조금` 이
 *  영어 화면에도 그대로 떴다. 서버에서 한 언어로 만드나 화면에서 한 언어로 만드나 **같은
 *  잘못**이다. 자리를 옮겼을 뿐이었다.
 *
 * ★코어 카탈로그에 남의 문구를 넣을 수는 없다 — 플러그인마다 늘어나고, 우리가 번역할 수도
 *  없다. 그래서 플러그인이 `web/locales/<lang>.json` 을 들고 오고, 호스트가 **현재 언어로**
 *  받아 `ctx.t` 에 실어준다.
 *
 * ★**없으면 키가 그대로 보인다.** 조용히 한 언어로 박는 것보다 낫다 — 키가 보이면 누군가
 *  고치지만, 한국어가 박혀 있으면 **영어 사용자만 겪고 아무도 모른다**(실제로 그랬다).
 *
 * 지키는 것 셋:
 *  ① 위젯 소스에 **문장이 없다**(키만) — 없으면 이 사고가 그대로 재발한다
 *  ② 카탈로그가 **두 언어 다** 있고 **키가 같다**(한쪽만 있으면 그 언어에서 키가 보인다)
 *  ③ 호스트가 **플러그인 것을 먼저** 본다 — 코어 카탈로그가 이기면 남의 키를 우리가 들어야 한다
 *
 * 등급: **혼합** — ①②는 실제 파일을 읽어 대조(실행), ③은 배선 대조.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGINS = path.join(REPO, "plugins");

/** 주석을 걷고 **따옴표 안의 한글**만 본다 — 설명하는 글은 대상이 아니다. */
const sentencesIn = (src: string): string[] => {
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "").replace(/(^|\s)\/\/[^\n]*$/gm, "$1");
  return [...code.matchAll(/["'`]([^"'`]*[가-힣][^"'`]*)["'`]/g)].map((m) => m[1] as string);
};

export const check: RegressionCheck = {
  name: "plugin-owns-its-translations",
  guards:
    "위젯이 서버 대신 화면에서 문장을 만들되 한 언어로만 만들어, 다른 언어 사용자에게 한국어가 그대로 뜨던 것 — 그리고 그걸 코어 카탈로그로 해결하려 하면 남의 문구를 우리가 드는 것이 된다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const host = readFileSync(
      path.join(REPO, "packages/dashboard/js/widget-host.js"),
      "utf8",
    );

    // 위젯을 가진 플러그인 전수 — 손 목록을 만들지 않는다.
    const withWidgets = readdirSync(PLUGINS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => {
        try {
          return readdirSync(path.join(PLUGINS, n, "web")).includes("widget.js");
        } catch {
          return false;
        }
      });

    out.push(
      assert(
        "★위젯을 가진 플러그인을 **찾았다**(0이면 아래가 전부 미검사다)",
        withWidgets.length > 0,
        withWidgets.join(", ") || "(없음)",
      ),
    );

    for (const name of withWidgets) {
      const web = path.join(PLUGINS, name, "web");
      const src = readFileSync(path.join(web, "widget.js"), "utf8");
      const found = sentencesIn(src);
      out.push(
        assert(
          `★★[${name}] 위젯 소스에 **문장이 없다**(키만 — 박아 두면 다른 언어 사용자만 겪고 아무도 모른다)`,
          found.length === 0,
          found.length === 0 ? "문장 0" : `★박힌 문장: ${found.slice(0, 4).join(" / ")}`,
        ),
      );

      let ko: Record<string, unknown> = {};
      let en: Record<string, unknown> = {};
      let read = true;
      try {
        ko = JSON.parse(readFileSync(path.join(web, "locales", "ko.json"), "utf8")) as Record<string, unknown>;
        en = JSON.parse(readFileSync(path.join(web, "locales", "en.json"), "utf8")) as Record<string, unknown>;
      } catch {
        read = false;
      }
      const kk = Object.keys(ko).sort();
      const ek = Object.keys(en).sort();
      const onlyKo = kk.filter((k) => !ek.includes(k));
      const onlyEn = ek.filter((k) => !kk.includes(k));
      out.push(
        assert(
          `★[${name}] 카탈로그가 **두 언어 다** 있다(한쪽만 있으면 그 언어에서 키가 그대로 보인다)`,
          read && kk.length > 0 && ek.length > 0,
          read ? `ko ${kk.length}키 · en ${ek.length}키` : "★못 읽음",
        ),
        assert(
          `★[${name}] 두 카탈로그의 **키가 같다**(한쪽에만 있는 키는 그 언어에서만 깨진다)`,
          onlyKo.length === 0 && onlyEn.length === 0,
          onlyKo.length === 0 && onlyEn.length === 0
            ? `${kk.length}키 일치`
            : `★ko 만: [${onlyKo.join(",")}] · en 만: [${onlyEn.join(",")}]`,
        ),
      );

      // 위젯이 실제로 쓰는 키가 카탈로그에 있나 — 오타를 잡는다.
      // ★**동적 키도 본다.** `ctx.t("dow." + n)` 처럼 이어붙이는 호출은 정적으로 전체 키를
      //  알 수 없다 — 그렇다고 건너뛰면 그 축이 통째로 미검사가 된다. 접두사를 뽑아
      //  **그걸로 시작하는 키가 카탈로그에 있는지** 본다(오타 `dwo.` 는 그래도 걸린다).
      const calls = [...src.matchAll(/ctx\.t\(\s*["']([^"']+)["']\s*([+),])/g)].map((m) => ({
        key: m[1] as string,
        dynamic: m[2] === "+",
      }));
      const missing = calls
        .filter((c) =>
          c.dynamic
            ? !Object.keys(ko).some((k) => k.startsWith(c.key))
            : !(c.key in ko),
        )
        .map((c) => c.key + (c.dynamic ? "*" : ""));
      out.push(
        assert(
          `★[${name}] 위젯이 부르는 키가 **전부 카탈로그에 있다**(동적 키는 접두사로 — 오타는 화면에 키로 뜬다)`,
          missing.length === 0 && calls.length > 0,
          missing.length === 0
            ? `${calls.length}호출 확인(동적 ${calls.filter((c) => c.dynamic).length})`
            : `★없는 키: ${missing.join(", ")}`,
        ),
      );
    }

    // ── 서버 쪽 호스트도 언어를 준다 ──
    const shost = readFileSync(path.join(REPO, "src/core/plugins/host.ts"), "utf8");
    // ★**예제 플러그인은 배포본에 없다**(2026-08-29, 제공자 약관 때문에 제외). 그래서 이
//  단언은 dev 에서만 돈다 — **건너뛰는 사실을 증거란에 남긴다.** 조용한 면제는 이 레포가
//  금지하는 것이고([[feedback_gate_must_actually_run]]), 안 적으면 다음 사람이 "이 검사가
//  뭘 봤나" 를 알 수 없다.
    const wxPath = path.join(REPO, "plugins/weather/src/open-meteo.ts");
    const wx = existsSync(wxPath) ? readFileSync(wxPath, "utf8") : null;
    out.push(
      assert(
        "★서버 호스트도 **설정 언어를 준다**(외부 API 에 언어를 넘겨야 하는 플러그인이 있다)",
        /readonly locale: string;/.test(shost) && /locale: readLocale\(\)/.test(shost),
        /locale: readLocale\(\)/.test(shost) ? "host.locale" : "★없음",
      ),
      assert(
        "★★플러그인이 언어를 **박지 않는다**(첫 판은 `language=ko` 를 박아 영어 사용자가 한국어 지명을 받았다)",
        wx === null || (!/language=ko/.test(wx) && /language=\$\{lang\}/.test(wx)),
        wx === null
          ? "예제 플러그인 없음(배포본) — 대상 없음"
          : /language=ko/.test(wx)
            ? "★박혀 있다"
            : "설정 언어를 쓴다",
      ),
    );

    // ── 호스트 배선 ──
    out.push(
      // ★**코어 테이블로 안 넘어간다** (2026-08-28 정태님 지적). 폴백이 있으면 플러그인이
      //  `common.cancel` 같은 키로 **우리 문구를 조용히 집고**, 나중에 우리가 그 문구를
      //  고치면 남의 위젯 의미가 같이 바뀐다. 빠진 키가 "되는 것처럼" 보이는 것도 나쁘다.
      assert(
        "★★플러그인 카탈로그가 **유일한 출처**다(코어 테이블로 안 넘어간다 — 넘어가면 남의 문구를 우리가 드는 셈이고 키 충돌이 조용히 성립한다)",
        /const own = catalogs\.get\(owner\)/.test(host) &&
          /if \(raw === undefined\) return String\(key\);/.test(host) &&
          !/i18n\(key, params\)/.test(host),
        /i18n\(key, params\)/.test(host) ? "★코어로 폴백한다" : "플러그인 카탈로그만",
      ),
      assert(
        "★★플러그인이 **설정 언어를 안다**(카탈로그로 못 푸는 축 — 날짜 서식·외부 API 인자)",
        /locale: \(window\.__TIGU_I18N__ && window\.__TIGU_I18N__\.locale\)/.test(host),
        /ctx[\s\S]{0,400}?locale:/.test(host) ? "ctx.locale 있음" : "★없음",
      ),
      assert(
        "★현재 언어로 받아온다(고정 언어면 번역이 있어도 안 쓰인다)",
        /window\.__TIGU_I18N__ && window\.__TIGU_I18N__\.locale/.test(host) &&
          /\/locales\/" \+ encodeURIComponent\(locale\)/.test(host),
        /encodeURIComponent\(locale\)/.test(host) ? "현재 언어" : "★고정",
      ),
      assert(
        "★카탈로그는 **덤**이다 — 없거나 못 받아도 위젯은 뜬다",
        /\.catch\(\(\) => \{ \/\* 없으면 없는 대로 \*\/ \}\)/.test(host),
        /없으면 없는 대로/.test(host) ? "실패 무해" : "★실패가 위젯을 막는다",
      ),
    );
    return out;
  },
};
