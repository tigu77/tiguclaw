/**
 * 회귀: **위젯 선언 — 설치했는데 왜 안 보이지** (2026-09-08).
 *
 * 사고: `running-work` 이 회사 PC 에서 안 보였다. 고장이 아니라 **홈마다 손으로 넣어야
 * 했던 것**이고, 넣을 UI 도 없었고 자동 편입도 없었다. 뿌리는 하나 — 등록소가 브라우저에
 * 있어서(`web/widget.js` 의 `tiguWidgets.register`) **코어가 위젯 목록을 몰랐다.**
 *
 * 지키는 것 다섯:
 *  ① **선언이 검사된다** — 나쁜 칸은 그 칸만 떨어지고 이유가 남는다(오타 하나에 통째로 X).
 *  ② **`default` 는 번들에서만 산다** — 사용자가 깐 플러그인이 자기를 홈에 앉히지 못한다.
 *  ③ **자동 편입은 한 번뿐이다** — 껐는데 재시작마다 되살아나면 그건 고장으로 읽힌다.
 *  ④ **토글이 배치를 만든다** — 켜면 생기고 끄면 사라지고, 껐다 켜도 둘로 늘지 않는다.
 *  ⑤ ★**선언과 실물이 같다** — 매니페스트의 id 가 `web/widget.js` 가 등록하는 이름과
 *     다르면, 화면엔 토글이 뜨는데 홈엔 **빈 카드**가 뜬다(이음매 검사).
 *
 * 등급: 전부 **동작**(실제로 읽고 쓰고 판정한다). ⑤만 두 파일의 사실 대조다.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readWidgetSpecs } from "../../core/plugins/widgets.js";
import { readSourceSync, stripComments } from "./_wiring.js";
import { availableHomeWidgetsFrom } from "../../core/plugins/manager.js";
import {
  HOME_WIDGET_MAX,
  readHomeWidgets,
  seedDefaultHomeWidgets,
  setHomeWidgetEnabled,
  writeHomeWidgets,
} from "../../core/home-widgets.js";
import { getPaths } from "../../core/paths.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 번들 플러그인 전부 — 목록을 손으로 적지 않는다(디스크가 답한다). */
const bundledManifests = (): { name: string; dir: string; raw: unknown }[] => {
  const root = path.join(REPO, "plugins");
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const pkg = path.join(root, d.name, "package.json");
      try {
        const j = JSON.parse(readFileSync(pkg, "utf8")) as {
          tiguclaw?: { widgets?: unknown };
        };
        return [{ name: d.name, dir: path.join(root, d.name), raw: j.tiguclaw?.widgets }];
      } catch {
        return [];
      }
    });
};

export const check: RegressionCheck = {
  name: "home-widget-declaration",
  guards:
    "위젯 선언이 검사 없이 들어오는 것 + 설치한 플러그인이 스스로 홈에 앉는 것 + 사용자가 끈 위젯이 재시작마다 되살아나는 것 + 껐다 켜면 위젯이 둘로 늘어나는 것 + 매니페스트 id 와 web/widget.js 의 등록 이름이 갈려 홈에 빈 카드가 뜨는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 선언 검사 ────────────────────────────────────────────────────────
    const ok = readWidgetSpecs([{ id: "live", size: "wide", default: true }, { id: "b" }]);
    out.push(
      assert(
        "★좋은 선언은 통과하고 기본값은 size=small · default=false (설정이 필요한 위젯이 실수로 홈에 앉지 않는다)",
        ok.problems.length === 0 &&
          ok.specs.length === 2 &&
          ok.specs[1]?.size === "small" &&
          ok.specs[1]?.default === false,
        JSON.stringify(ok),
      ),
    );
    const bad = readWidgetSpecs([
      { id: "Live" },
      { id: "ok" },
      { id: "ok" },
      { id: "x", size: "huge" },
      { id: "y", default: "yes" },
      "nope",
    ]);
    out.push(
      assert(
        "★대문자 id · 중복 · 범위 밖 size · 참거짓 아닌 default · 객체 아님 을 각각 떨어뜨리고 이유를 남긴다(오타 하나가 선언 전체를 죽이지 않는다)",
        bad.specs.length === 1 && bad.specs[0]?.id === "ok" && bad.problems.length === 5,
        JSON.stringify(bad),
      ),
    );

    // ── ② default 는 번들에서만 ────────────────────────────────────────────
    const spec = readWidgetSpecs([{ id: "live", size: "wide", default: true }]).specs;
    const fromBundled = availableHomeWidgetsFrom([
      { name: "running-work", source: "bundled", widgets: spec },
    ]);
    const fromHome = availableHomeWidgetsFrom([
      { name: "evil", source: "home", widgets: spec },
    ]);
    out.push(
      assert(
        "★★설치한(home) 플러그인이 `default: true` 라고 선언해도 자동 편입되지 않는다 — 홈은 사용자 자기 자리다(`core?` 와 같은 규칙: 유효성을 선언이 아니라 **위치**로 판정)",
        fromBundled[0]?.default === true && fromHome[0]?.default === false,
        `bundled=${fromBundled[0]?.default} home=${fromHome[0]?.default}`,
      ),
    );
    out.push(
      assert(
        "★그래도 **목록에는 남는다** — 안 남기면 상세 화면에서 켤 수단이 사라진다",
        fromHome.length === 1 && fromHome[0]?.type === "evil/live",
        JSON.stringify(fromHome),
      ),
    );

    // ── ③④ 자동 편입 · 토글 (동작) ────────────────────────────────────────
    const settings = getPaths().settings;
    const AV = [
      { type: "running-work/live", size: "wide" as const, default: true },
      { type: "weather/forecast", size: "small" as const, default: false },
    ];
    const known = new Set(["running-work", "weather"]);
    writeFileSync(settings, JSON.stringify({ theme: "dusk" }, null, 2), "utf8");

    const first = seedDefaultHomeWidgets(AV);
    const afterSeed = readHomeWidgets(known).widgets;
    out.push(
      assert(
        "★`default: true` 인 위젯이 홈에 자동으로 놓인다 — `default: false` 는 안 놓인다(설정이 필요한 위젯이 빈 채로 뜨지 않는다)",
        first.length === 1 &&
          afterSeed.length === 1 &&
          afterSeed[0]?.type === "running-work/live" &&
          afterSeed[0]?.size === "wide",
        JSON.stringify({ first, afterSeed }),
      ),
    );
    out.push(
      assert(
        "다시 불러도 안 늘어난다(부팅마다 설정이 다시 쓰이지 않게)",
        seedDefaultHomeWidgets(AV).length === 0 &&
          readHomeWidgets(known).widgets.length === 1,
        JSON.stringify(readHomeWidgets(known).widgets),
      ),
    );
    const kept = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    out.push(
      assert(
        "자동 편입이 `settings.json` 의 다른 키를 안 날린다",
        kept.theme === "dusk",
        JSON.stringify(kept),
      ),
    );

    setHomeWidgetEnabled("running-work/live", false, AV);
    const offed = readHomeWidgets(known).widgets;
    const reseed = seedDefaultHomeWidgets(AV);
    out.push(
      assert(
        "★★사용자가 끄면 **다시 안 놓인다** — 되살아나면 그건 고장으로 읽히고, 끄는 유일한 방법이 «플러그인 삭제» 가 된다",
        offed.length === 0 && reseed.length === 0 && readHomeWidgets(known).widgets.length === 0,
        JSON.stringify({ offed, reseed, now: readHomeWidgets(known).widgets }),
      ),
    );
    setHomeWidgetEnabled("running-work/live", true, AV);
    setHomeWidgetEnabled("running-work/live", true, AV);
    out.push(
      assert(
        "★켜기는 멱등이다 — 두 번 눌러도 카드가 둘로 늘지 않는다",
        readHomeWidgets(known).widgets.length === 1,
        JSON.stringify(readHomeWidgets(known).widgets),
      ),
    );
    // ★**놓은 주체가 누구든 «거기 있다» 는 물어본 것이다** (2026-09-09, 적대 검토 F2).
    //  위의 ③은 «빈 홈 → 자동 편입 → 끔 → 재부팅» **한 경로만** 밟았다. 사용자가
    //  `configure_home` 으로 (또는 이 기능 이전에) 기본 위젯을 **먼저** 놓아둔 홈에서는
    //  자동 편입이 `add` 가 비어 파일을 안 건드렸고, `seeded` 가 영영 안 적혔다 —
    //  그래서 끄면 다음 부팅에 되살아났다. 껐다→되살아남이 끝나지 않는 부류다.
    writeFileSync(
      settings,
      JSON.stringify(
        {
          dashboard: {
            home: {
              widgets: [{ id: "pre", type: "running-work/live", size: "wide", config: {} }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const preSeed = seedDefaultHomeWidgets(AV);
    setHomeWidgetEnabled("running-work/live", false, AV);
    const preOff = readHomeWidgets(known).widgets;
    const preReseed = seedDefaultHomeWidgets(AV);
    out.push(
      assert(
        "★★**이미 놓여 있던** 기본 위젯을 끄면 재부팅해도 안 되살아난다 — 자동 편입이 «건너뛴 것»도 `seeded` 에 적어야 «이미 물어봤다» 가 성립한다",
        preSeed.length === 0 &&
          preOff.length === 0 &&
          preReseed.length === 0 &&
          readHomeWidgets(known).widgets.length === 0,
        JSON.stringify({ preSeed, preOff, preReseed, now: readHomeWidgets(known).widgets }),
      ),
    );

    // ★**id 는 만드는 자리에서 읽는 쪽 규칙을 지킨다** (2026-09-09, 적대 검토 F3).
    //  `idForType` 이 64자로 자른 뒤 `freeId` 가 `-2` 를 덧붙여 66자를 만들면,
    //  `normalizeHomeWidgets` 가 그 칸을 떨어뜨리는데 `seeded` 엔 «놓았다» 가 남아
    //  **영영 안 놓인다.** 중복 id 방어는 있었는데 **길이 축**이 없었다 — 같은
    //  «조용히 접힘» 이 다른 문으로 들어온다.
    const longOwner = `p${"a".repeat(40)}`;
    const longType = `${longOwner}/w${"b".repeat(30)}`;
    const longBase = longType.replace("/", "-").slice(0, 64);
    const LONG_AV = [{ type: longType, size: "small" as const, default: true }];
    writeFileSync(
      settings,
      JSON.stringify(
        {
          // 사용자가 잘린 id 를 이미 선점한 경우 → `freeId` 가 꼬리를 붙여야 한다.
          dashboard: { home: { widgets: [{ id: longBase, type: "weather/forecast", config: {} }] } },
        },
        null,
        2,
      ),
      "utf8",
    );
    seedDefaultHomeWidgets(LONG_AV);
    const longKnown = new Set([longOwner, "weather"]);
    const longRes = readHomeWidgets(longKnown);
    out.push(
      assert(
        "★★자동 편입이 만든 id 가 **읽는 쪽 상한(64자)을 안 넘는다** — 넘으면 그 칸이 떨어지는데 seeded 엔 «놓았다» 가 남아 영영 안 놓인다",
        longRes.widgets.length === 2 &&
          longRes.rejected.length === 0 &&
          longRes.widgets.every((w) => w.id.length <= 64) &&
          longRes.widgets.some((w) => w.type === longType),
        JSON.stringify({ ids: longRes.widgets.map((w) => `${w.id}(${w.id.length})`), rejected: longRes.rejected }),
      ),
    );
    writeHomeWidgets([]);

    // ★자기 검토에서 잡은 둘 — **읽는 쪽이 거부할 값을 쓰지 않는다** (2026-09-08).
    //  자동 편입이 중복 id·캡 초과를 써두면 `normalizeHomeWidgets` 가 그 칸을 떨어뜨리는데
    //  `seeded` 엔 «놓았다» 가 남아 **다시는 안 놓인다** — 조용히 접히는 부류다.
    writeHomeWidgets([]);
    writeFileSync(
      settings,
      JSON.stringify(
        {
          dashboard: {
            home: {
              // 사용자가 그 id 를 이미 다른 위젯에 붙여둔 경우.
              widgets: [{ id: "running-work-live", type: "weather/forecast", config: {} }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    seedDefaultHomeWidgets(AV);
    const collided = readHomeWidgets(known).widgets;
    out.push(
      assert(
        "★★자동 편입이 **이미 쓰이는 id 를 피한다** — 부딪히면 읽는 쪽이 그 칸을 떨어뜨리는데 seeded 엔 «놓았다» 가 남아 영영 안 놓인다",
        collided.length === 2 &&
          collided.some((w) => w.type === "running-work/live") &&
          new Set(collided.map((w) => w.id)).size === 2,
        JSON.stringify(collided),
      ),
    );

    const full = Array.from({ length: HOME_WIDGET_MAX }, (_, i) => ({
      id: `f${i}`,
      type: "weather/forecast",
      config: {},
    }));
    writeFileSync(
      settings,
      JSON.stringify({ dashboard: { home: { widgets: full } } }, null, 2),
      "utf8",
    );
    const capSeed = seedDefaultHomeWidgets(AV);
    const capToggle = setHomeWidgetEnabled("running-work/live", true, AV);
    out.push(
      assert(
        `★★캡(${HOME_WIDGET_MAX})이 찼으면 자동 편입은 **안 적고**(다음에 자리가 나면 놓인다) 토글은 **거절한다**(되는 척하는 스위치를 만들지 않는다)`,
        capSeed.length === 0 &&
          readHomeWidgets(known).widgets.length === HOME_WIDGET_MAX &&
          capToggle.ok === false &&
          (capToggle.reason ?? "").includes(String(HOME_WIDGET_MAX)),
        JSON.stringify({ capSeed, capToggle }),
      ),
    );
    writeHomeWidgets([]);

    const ghost = setHomeWidgetEnabled("ghost/thing", true, AV);
    out.push(
      assert(
        "돌고 있는 플러그인의 것이 아니면 거부하고 이유를 남긴다",
        ghost.ok === false && (ghost.reason ?? "").includes("ghost/thing"),
        JSON.stringify(ghost),
      ),
    );
    writeHomeWidgets([]);

    // ── ⑤-0 선언이 **화면까지 간다** (소비자↔생산자) ───────────────────────
    // ★실측으로 여기서 끊겼다 (2026-09-08). 코어까지 다 됐는데 `/plugins` 응답 조립이
    //  필드를 **골라 담는 손 목록**이라 `widgets` 가 조용히 빠졌고, 화면은 스위치를
    //  하나도 못 그렸다 — 타입체커도 회귀도 전부 초록이었다(빠뜨린 필드는 타입이 아니다).
    //  ★정직하게: 이건 **소스 대조**다. 동작은 격리 데몬을 띄워 확인했다.
    //  ★**주석을 걷어내고 본다** (2026-09-09, 적대 검토 F5). raw 로 훑으면 필드를 지우고
    //   그 자리에 «여기서 widgets: p.widgets 를 실어 보낸다» 는 주석만 남겨도 초록이다 —
    //   이 게이트가 막겠다던 결함 그 자체가 주석 한 줄로 통과한다.
    const listRoute = stripComments(
      readSourceSync("plugins/http-bridge/routes-inventory.ts"),
    );
    out.push(
      assert(
        "★★`/plugins` 응답이 `widgets` 를 실어 보낸다 — 조립이 손으로 필드를 고르는 자리라, 빠지면 코어가 다 돼도 화면엔 스위치가 없다",
        /widgets:\s*p\.widgets/.test(listRoute),
        (listRoute.match(/^\s*\w+: p\.\w+,$/gm) ?? []).length + "개 필드 전달 중",
      ),
    );

    // ── ⑤ 선언 ↔ 실물 (이음매) ─────────────────────────────────────────────
    for (const p of bundledManifests()) {
      const specs = readWidgetSpecs(p.raw).specs;
      if (specs.length === 0) continue;
      let js = "";
      try {
        // ★여기도 주석을 걷는다 — 주석 속 `register("…")` 는 등록이 아니다(F5 와 같은 부류).
        js = stripComments(readFileSync(path.join(p.dir, "web", "widget.js"), "utf8"));
      } catch {
        /* 없으면 아래에서 걸린다 */
      }
      const missing = specs
        .map((w) => `${p.name}/${w.id}`)
        .filter((t) => !js.includes(`register("${t}"`));
      out.push(
        assert(
          `★★${p.name}: 선언한 위젯 id 가 web/widget.js 의 등록 이름과 같다 — 갈리면 상세엔 토글이 뜨는데 홈엔 **빈 카드**가 뜬다(선언이 실물을 못 따라간 것)`,
          missing.length === 0,
          missing.length === 0 ? `${specs.length}개 일치` : `등록 없음: ${missing.join(", ")}`,
        ),
      );
    }

    return out;
  },
};
