/**
 * 회귀: **모바일 헤더가 넘치지 않는다 — 무엇이 떠 있든** (2026-10-20 정태님: *«모바일 대시보드에서 업데이트 버튼이 뜰 때
 * 패널이 밀려서 보여»*).
 *
 * 사고: 낱말 접기(검색·백그라운드)가 `@media (max-width:359px)` 고정 문턱이었다. 09-09 헤드리스 실측이 «320px 까지 안 넘친다» 였는데
 * **업데이트 칩이 숨은 상태에서 잰 값**이었다. 칩(+«?»)이 뜨면 헤더가 443px 를 요구해 430px 이하 폰에서 넘쳤고, 홈 화면에선
 * 페이지 폭 자체가 443px 로 넓어져 화면 전체가 밀렸다.
 *
 * ★그래서 이 검사는 문턱 숫자를 안 본다 — **진짜 `header-fit.js` 를** 가짜 헤더(접기 단계마다 폭이 줄어드는) 위에서 돌려,
 *  «넘치지 않는 가장 적은 단계» 를 고르는지 · 헤더에 무엇이 뜨면 다시 재는지 · 데스크톱은 안 접는지를 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const REPO = path.resolve(import.meta.dirname, "../../..");

/** 접기 단계별로 줄어드는 폭 — 칩·«?» 는 `chipShown` 일 때만 자리를 차지한다(칩이 뜨는 순간이 사고의 조건). */
const BASE = 300, WORDS = 60, CHIP = 50, NOTES = 30, BRAND = 40;

type Run = { classes: string[]; remeasureAfterChip: string[]; observeOpts: unknown; bodyObserved: boolean };

const runFit = (viewport: number, opts: { desktop?: boolean; chipShown?: boolean } = {}): Run => {
  const cls = new Set<string>();
  let chipShown = opts.chipShown ?? true;
  const header = {
    classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)) },
    get scrollWidth() {
      return BASE + (cls.has("fit-words") ? 0 : WORDS) + (chipShown ? (cls.has("fit-chip") ? 0 : CHIP) + (cls.has("fit-notes") ? 0 : NOTES) : 0) + (cls.has("fit-brand") ? 0 : BRAND);
    },
    get clientWidth() { return viewport; },
  };
  let moCallback: () => void = () => {};
  let observeOpts: unknown = null;
  let bodyObserved = false;
  const body = { tag: "body" };
  const frames: Array<() => void> = [];
  const flush = (): void => { while (frames.length > 0) frames.shift()?.(); };
  const sandbox = {
    document: { querySelector: (s: string) => (s === "header" ? header : null), fonts: undefined, body },
    window: { matchMedia: () => ({ matches: opts.desktop !== true, addEventListener: () => {} }), addEventListener: () => {} },
    requestAnimationFrame: (fn: () => void) => void frames.push(fn),
    MutationObserver: class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe(t: unknown, o: unknown) { if (t === header) { moCallback = this.cb; observeOpts = o; } else if (t === body) bodyObserved = true; }
    },
    setTimeout: (fn: () => void) => void frames.push(fn),
  };
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/header-fit.js"), "utf8");
  vm.runInNewContext(src, sandbox);
  flush();
  const classes = [...cls].sort();
  // 칩이 숨었다가 뜨는 경우 — 처음엔 칩 없이 맞았다가, 칩이 뜨면(헤더의 `hidden` 변화) 다시 재야 한다.
  chipShown = false; cls.clear(); moCallback(); flush();
  chipShown = true; moCallback(); flush();
  return { classes, remeasureAfterChip: [...cls].sort(), observeOpts, bodyObserved };
};

export const check: RegressionCheck = {
  name: "mobile-header-fits",
  guards:
    "모바일에서 업데이트 칩이 뜨면 헤더가 넘쳐 화면 전체가 밀리던 것 — 낱말 접기가 칩이 숨은 상태에서 잰 고정 폭 문턱(359px)이었다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const wide = runFit(520);
    const fitsAfterWords = runFit(420); // 300+50+30+40
    const needsChip = runFit(370); // 300+30+40
    const needsNotes = runFit(340); // 300+40
    const needsAll = runFit(300);
    const tooNarrow = runFit(250);
    const noChip = runFit(360, { chipShown: false }); // 300+60+40 > 360 → 낱말만
    const desktopWide = runFit(520, { desktop: true });
    const desktopTight = runFit(370, { desktop: true });
    out.push(
      assert(
        "★넘치지 않는 **가장 적은** 단계만 접는다 — 넓으면 안 접고, 모자란 만큼 낱말 → 칩 기호 → «?»·⭐ → 브랜드 낱말 순서로",
        wide.classes.length === 0 &&
          fitsAfterWords.classes.join() === "fit-words" &&
          needsChip.classes.join() === "fit-chip,fit-words" &&
          needsNotes.classes.join() === "fit-chip,fit-notes,fit-words" &&
          needsAll.classes.join() === "fit-brand,fit-chip,fit-notes,fit-words" &&
          tooNarrow.classes.join() === "fit-brand,fit-chip,fit-notes,fit-words" &&
          noChip.classes.join() === "fit-words",
        JSON.stringify({ wide: wide.classes, fitsAfterWords: fitsAfterWords.classes, needsChip: needsChip.classes, needsNotes: needsNotes.classes, needsAll: needsAll.classes, tooNarrow: tooNarrow.classes, noChip: noChip.classes }),
      ),
    );
    out.push(
      assert(
        "★★칩이 **나중에 떠도** 다시 잰다(헤더의 `hidden` 변화를 본다 · 자기 클래스 변화는 안 봐서 맴돌지 않는다) — 처음 잴 때 칩이 숨어 있던 것이 사고의 조건",
        needsChip.remeasureAfterChip.join() === "fit-chip,fit-words" &&
          JSON.stringify((needsChip.observeOpts as { attributeFilter?: string[] })?.attributeFilter) === JSON.stringify(["hidden"]),
        JSON.stringify({ after: needsChip.remeasureAfterChip, opts: needsChip.observeOpts }),
      ),
    );
    out.push(
      assert(
        "★데스크톱도 **넘칠 때만** 접는다(패널이 헤더를 밀면 넘친다 — 넓으면 그대로) · 패널 여닫기(body class)에 다시 잰다",
        desktopWide.classes.length === 0 && desktopTight.classes.join() === "fit-chip,fit-words" && desktopTight.bodyObserved,
        JSON.stringify({ wide: desktopWide.classes, tight: desktopTight.classes, body: desktopTight.bodyObserved }),
      ),
    );
    // CSS: 접기 규칙이 그 클래스 아래에 있고, 다 접어도 모자란 극단에서 헤더가 페이지를 넓히지 않는다.
    const css = stripComments(readSourceSync("packages/dashboard/app.css"));
    const rules = {
      words: /header\.fit-words #bg-toggle \.bg-word, header\.fit-words #chat-search-btn \.cs-word, header\.fit-words #wg-toggle \.wg-word \{\s*display:none/.test(css),
      chip: /header\.fit-chip #update-chip \{[^}]*font-size:0/.test(css) && /header\.fit-chip #update-chip::before \{[^}]*content:/.test(css),
      notes: /header\.fit-notes #update-notes[^{]*\{\s*display:none/.test(css),
      brand: /header\.fit-brand \.brand > span[^{]*\{\s*display:none/.test(css),
      overflow: /header \{\s*overflow:hidden;?\s*\}/.test(css),
    };
    out.push(assert("단계마다 접는 CSS 가 있고, 헤더가 `overflow:hidden` 이라 페이지 폭을 넓히지 않는다", Object.values(rules).every(Boolean), JSON.stringify(rules)));
    // 브라우저가 실제로 싣는가(매니페스트 + index.html).
    const html = readSourceSync("packages/dashboard/index.html");
    const manifest = JSON.parse(readSourceSync("packages/dashboard/js/_manifest.json")) as string[];
    const loaded = { html: /<script src="\/js\/header-fit\.js"><\/script>/.test(html), manifest: manifest.includes("header-fit.js") };
    out.push(assert("header-fit.js 가 페이지에 실린다", loaded.html && loaded.manifest, JSON.stringify(loaded)));
    return out;
  },
};
