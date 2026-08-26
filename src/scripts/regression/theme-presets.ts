/**
 * 회귀: **테마 프리셋은 파일이 곧 목록이고, 세 겹의 순서가 곧 기능이다** (2026-08-26).
 *
 * ★언어와 **같은 모양**으로 뒀다(`locales/<lang>.json` + settings `locale`). 그러니 언어에서
 *  이미 배운 실패 모드가 여기에도 그대로 온다:
 *
 *  ① **손 목록으로 되돌아가기** — 이름을 코드에 적기 시작하면 파일 없는 테마가 목록에 뜨고,
 *     사용자가 홈에 놓은 테마는 안 뜬다.
 *  ② **설치 안 된 이름을 골라둔 상태** — `settings.theme` 이 오타면 조용히 무시돼야 한다
 *     (화면이 깨지는 것보다 기본 팔레트가 낫다).
 *  ③ ★**순서가 뒤집히면 아무것도 안 덮이는데 화면은 멀쩡히 뜬다.**
 *     `app.css` → `theme-preset.css` → `theme.css` 여야 개인 손질이 프리셋을 이긴다.
 *  ④ **dist 복사 누락** — `themes/` 가 배포본에 안 실리면 고른 테마가 "설치 안 된 이름" 이
 *     되어 조용히 무시된다(언어 카탈로그가 같은 이유로 이미 복사 대상이다).
 *
 * 등급: 동작 검사(임시 홈에 파일을 놓고 `availableThemes`/`readTheme`/`readThemeCss` 호출)
 *      + 순서·복사 대조.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "theme-presets",
  guards:
    "테마 프리셋 목록을 코드에 적으면 사용자가 홈에 놓은 테마가 안 뜨던 부류 + settings 의 오타 이름이 화면을 깨는 것 + 세 겹 순서가 뒤집혀 개인 오버라이드가 조용히 무시되는 것 + themes/ 가 dist 에 안 실려 배포본에서만 테마가 무시되는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const home = process.env.TIGUCLAW_HOME ?? "";
    const { availableThemes, readTheme, readThemeCss } = await import(
      "../../core/theme.js"
    );

    // ── ① 파일이 곧 목록 ──────────────────────────────────────────────────────
    const bundled = availableThemes();
    out.push(
      assert(
        "번들 프리셋이 목록에 뜬다(빈손 통과 금지)",
        bundled.includes("light") && bundled.includes("dark"),
        JSON.stringify(bundled),
      ),
    );

    mkdirSync(path.join(home, "themes"), { recursive: true });
    writeFileSync(
      path.join(home, "themes", "probe-theme.css"),
      ":root { --accent: #123456; }\n",
      "utf8",
    );
    const withHome = availableThemes();
    out.push(
      assert(
        "★홈에 `themes/<이름>.css` 를 놓으면 그게 곧 선택지다(코드 변경 0)",
        withHome.includes("probe-theme"),
        JSON.stringify(withHome),
      ),
      assert(
        "목록에 파일 없는 이름이 섞이지 않는다(손 목록이 아니라 파일이 정한다)",
        withHome.every((t) => ["light", "dark", "probe-theme"].includes(t)),
        JSON.stringify(withHome),
      ),
    );

    // ── ② 고르기 ─────────────────────────────────────────────────────────────
    const settings = path.join(home, "settings.json");
    const write = (o: Record<string, unknown>): void =>
      writeFileSync(settings, JSON.stringify(o) + "\n", "utf8");

    write({ theme: "probe-theme" });
    out.push(
      assert(
        "고른 프리셋의 CSS 가 나온다",
        readTheme() === "probe-theme" && readThemeCss().includes("#123456"),
        `theme=${readTheme()} css=${JSON.stringify(readThemeCss().trim())}`,
      ),
    );

    write({ theme: "nope-not-installed" });
    out.push(
      assert(
        "★설치 안 된 이름은 조용히 무시된다(화면이 깨지는 것보다 기본 팔레트가 낫다)",
        readTheme() === "" && readThemeCss() === "",
        `theme=${JSON.stringify(readTheme())} css길이=${readThemeCss().length}`,
      ),
    );

    write({ theme: "../../etc/passwd" });
    out.push(
      assert(
        "★경로 모양 이름은 통과하지 못한다",
        readTheme() === "" && readThemeCss() === "",
        `theme=${JSON.stringify(readTheme())}`,
      ),
    );

    write({});
    out.push(
      assert(
        "안 고른 상태가 정상이다(기본 팔레트)",
        readTheme() === "" && readThemeCss() === "",
        `theme=${JSON.stringify(readTheme())}`,
      ),
    );

    // ── ③ 세 겹의 순서 ────────────────────────────────────────────────────────
    const html = readFileSync(
      path.join(REPO, "packages/dashboard/index.html"),
      "utf8",
    );
    const iApp = html.indexOf('href="/app.css"');
    const iPreset = html.indexOf('href="/theme-preset.css"');
    const iUser = html.indexOf('href="/theme.css"');
    out.push(
      assert(
        "★순서가 app.css → 프리셋 → 개인 오버라이드다(뒤집히면 조용히 안 덮인다)",
        iApp >= 0 && iPreset > iApp && iUser > iPreset,
        `app=${iApp} preset=${iPreset} user=${iUser}`,
      ),
    );

    // ── ④ 배포본에도 실리는가 ─────────────────────────────────────────────────
    const copier = readFileSync(path.join(REPO, "bin/copy-dist-assets.mjs"), "utf8");
    out.push(
      assert(
        "★`themes/` 가 dist 복사 대상이다(빠지면 배포본에서만 테마가 무시된다)",
        /copyTree\("themes"/.test(copier),
        /copyTree\("themes"/.test(copier) ? "복사 대상" : "★빠졌다",
      ),
      // ★실사고(2026-08-26): `fs.cp` 는 덮어쓰기만 하고 **원본에서 사라진 파일은 dist 에
      //  남긴다.** `nord.css` 를 지우고 배포했는데 배포본 목록엔 그대로 떴다. 목록의 정본이
      //  "파일" 인 구조에서 **지운 것이 안 지워지면 그 구조 자체가 거짓말**이 된다.
      assert(
        "★목록의 정본이 파일인 트리는 prune 한다(지운 테마·언어가 배포본에 남지 않게)",
        /copyTree\("themes", \{ prune: true \}\)/.test(copier) &&
          /copyTree\("locales", \{ prune: true \}\)/.test(copier),
        `themes=${/copyTree\("themes", \{ prune: true \}\)/.test(copier)} locales=${/copyTree\("locales", \{ prune: true \}\)/.test(
          copier,
        )}`,
      ),
    );

    // ── ⑥b 이름은 **파일명 그대로** 쓴다 (2026-08-26) ──────────────────────────
    //  ★프리셋 이름을 번역하면 손 목록이 생기고, 사용자가 홈에 놓은 테마는 애초에 번역할
    //   방법이 없다(스킬·에이전트·스케줄 이름과 같은 부류 — 사용자 콘텐츠는 번역 밖이다).
    //   그래서 카탈로그에 테마 **이름** 키가 있으면 안 된다. 목록 라벨은 파일명이 정본이다.
    const ko = JSON.parse(
      readFileSync(path.join(REPO, "locales/ko.json"), "utf8"),
    ) as Record<string, string>;
    const nameKeys = Object.keys(ko).filter((k) => /^theme\.name\./.test(k));
    out.push(
      assert(
        "★카탈로그가 프리셋 이름을 들고 있지 않다(번역표 = 손 목록)",
        nameKeys.length === 0,
        nameKeys.length === 0 ? "이름 키 0" : JSON.stringify(nameKeys),
      ),
      assert(
        "★목록에 번역된 특수 항목이 없다(전부 파일명 그대로)",
        ko["theme.preset.none"] === undefined,
        ko["theme.preset.none"] === undefined
          ? "특수 케이스 0"
          : `아직 남음: ${JSON.stringify(ko["theme.preset.none"])}`,
      ),
    );

    // ── ⑥c 세는 것과 보이는 것이 같은가 (2026-08-26 사용자 지적) ────────────────
    //  ★"목록엔 dark·light 둘인데 설명은 1개라고 한다" — 개수를 **파일 수**에서 가져왔는데
    //   목록 앞에 "프리셋 없음" 이라는 **특수 케이스**가 끼어 있었기 때문이다. 문구로 덮지
    //   않고 `themes/dark.css` 를 만들어 케이스를 없앴다 — 이제 목록·개수·선택이 전부
    //   "파일이 곧 목록" 하나로 설명된다(언어와 동형).
    const view = readFileSync(
      path.join(REPO, "packages/dashboard/js/view-models.js"),
      "utf8",
    );
    out.push(
      assert(
        "★테마 개수를 선택지에서 센다(파일 수를 세면 dark 가 빠져 어긋난다)",
        /const opts = list\.map/.test(view) &&
          /String\(opts\.length\)/.test(view.replace(/\/\/[^\n]*\n/g, "")),
        /theme\.preset\.none/.test(view) ? "★아직 특수 케이스가 있다" : "파일이 곧 목록",
      ),
    );

    // ── ⑦ 캐스케이드 레이어 — **라이트 모드에서 오버라이드가 조용히 무시되던 것** ──────
    //  ★실사고(2026-08-26). 순서가 아니라 **특이도** 문제였다: 기본 팔레트의 라이트 블록은
    //   `:root[data-theme="light"]`(0,2,0)이고 오버라이드는 보통 `:root`(0,1,0)이라, 뒤에
    //   얹혀도 진다. 실측으로 다크에선 `#ff00aa` 가 먹고 라이트에선 기본값이 남았다.
    //   레이어는 특이도를 이기므로 `base < preset < user` 로 못박으면 어느 모드에서든 이긴다.
    const { withLayer } = await import("../../core/theme.js");
    const wrapped = withLayer("tigu-user", ":root { --accent: #ff00aa; }");
    const base = withLayer("tigu-base", ":root { --accent: #000; }", true);
    out.push(
      assert(
        "오버라이드가 user 레이어로 감싸진다",
        wrapped.startsWith("@layer tigu-user {") && wrapped.includes("#ff00aa"),
        JSON.stringify(wrapped),
      ),
      assert(
        "★레이어 순서가 base → preset → user 다(뒤집히면 오버라이드가 진다)",
        base.startsWith("@layer tigu-base, tigu-preset, tigu-user;"),
        JSON.stringify(base.split("\n")[0]),
      ),
      assert(
        "순서 선언은 **가장 먼저 파싱되는 시트에서만** 나온다",
        !wrapped.includes("@layer tigu-base, tigu-preset, tigu-user;"),
        wrapped.includes("@layer tigu-base,") ? "중복 선언" : "1회",
      ),
      assert(
        "빈 내용은 빈 문자열이다(빈 @layer 블록을 내보내지 않는다)",
        withLayer("tigu-user", "") === "" && withLayer("tigu-preset", "   ") === "",
        JSON.stringify(withLayer("tigu-user", "")),
      ),
    );

    const server = readFileSync(
      path.join(REPO, "packages/dashboard/index.ts"),
      "utf8",
    );
    out.push(
      assert(
        "★세 시트가 전부 레이어로 나간다(하나라도 빠지면 그 층만 특이도 싸움을 한다)",
        /withLayer\("tigu-base", css, true\)/.test(server) &&
          /withLayer\("tigu-preset"/.test(server) &&
          /withLayer\("tigu-user"/.test(server),
        `base=${/withLayer\("tigu-base"/.test(server)} preset=${/withLayer\("tigu-preset"/.test(
          server,
        )} user=${/withLayer\("tigu-user"/.test(server)}`,
      ),
    );

    return out;
  },
};
