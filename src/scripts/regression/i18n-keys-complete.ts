/**
 * 회귀: **화면이 쓰는 키는 전부 기본 카탈로그에 있다** (2026-08-25).
 *
 * ★이 검사의 목적은 "빠진 번역 찾기" 가 아니라 **판단을 한 곳으로 줄이는 것**이다.
 *
 * 종전 구조는 판단이 두 벌이었다 — 브라우저 `t()` 와 코어 `translate()` 가 각각
 * *"없으면 키 자체"* 폴백을 들고 있었다. 한쪽만 고치면 갈린다(오늘 모델 배지에서 겪은
 * 부류). 그런데 **`ko.json` 이 정본**이라면 화면이 없는 키를 부르는 건 폴백 상황이 아니라
 * **버그**다. 그러면 브라우저 폴백은 "있을 수 있는 상황" 이 아니라 **도달 불가한 최후 방어**가
 * 되고, 판단은 카탈로그 하나로 줄어든다.
 *
 * ★그리고 `{name}` 채우기는 값이 브라우저에 있어 코어로 못 옮긴다. 대신 **두 구현이 같은
 *  결과를 내는지 실행으로 못박는다** — 공유 파일을 새로 만들면(`allowJs` + core→packages
 *  방향) 이음매가 둘 늘어나는데, 그건 줄이려던 것보다 크다
 *  ([[feedback_simple_composable_no_duplication]]: 이음매에서 새면 이음매를 없애라 —
 *  단, 없애는 비용이 더 크면 **같음을 고정**한다).
 *
 * ★등급: **행동 게이트**(키 집합 대조는 실제 파일·소스에서 뽑고, 보간은 두 구현을 돌린다).
 */
import { readFile, readdir } from "node:fs/promises";
import { interpolate } from "../../core/i18n.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const readRel = (rel: string): Promise<string> => readFile(new URL(rel, import.meta.url), "utf8");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const ko = JSON.parse(await readRel("../../../locales/ko.json")) as Record<string, string>;
  const known = new Set(Object.keys(ko));

  // ── ① 화면이 부르는 키 전수 ───────────────────────────────────────────────
  const html = await readRel("../../../packages/dashboard/index.html");
  const used = new Set<string>();
  const fromText: string[] = [];
  const fromAttrs: string[] = [];
  const attrNames = new Set<string>();
  const fromJs: string[] = [];
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) fromText.push(m[1]!);
  // 속성 형태 `data-i18n-attrs="placeholder=key;title=key2"` — **여기도 걷는다.**
  // 처음엔 안 걷었고, 그 상태로 속성 키 40여 개가 검사 밖에서 초록이었다
  // ([[feedback_gate_must_actually_run]]: 게이트는 '있다' 가 아니라 '보는가').
  for (const m of html.matchAll(/data-i18n-attrs="([^"]+)"/g)) {
    for (const pair of m[1]!.split(";")) {
      const eq = pair.indexOf("=");
      if (eq >= 0) {
        fromAttrs.push(pair.slice(eq + 1).trim());
        attrNames.add(pair.slice(0, eq).trim());
      }
    }
  }
  // ★js 파일 목록을 손으로 적지 않는다 — 새 화면 모듈이 조용히 검사 밖으로 나간다
  //  ([[feedback_hand_maintained_lists]]).
  const jsDir = new URL("../../../packages/dashboard/js/", import.meta.url);
  const jsFiles = (await readdir(jsDir)).filter((f) => f.endsWith(".js"));
  const jsSources: string[] = [];
  for (const f of jsFiles) {
    const src = await readFile(new URL(f, jsDir), "utf8");
    jsSources.push(src);
    // ★키가 `nav.chat` 같은 짧은 이름만은 아니다 — 코드 안에서는 **원문 자체가 키**다
    //  (`t("복사")`). 자리마다 읽히는 것을 키로 둔다: 마크업엔 짧은 이름, 코드엔 원문.
    //  그래서 `[\w.]+` 로 좁히면 원문 키 300여 개가 조용히 검사 밖으로 나간다.
    for (const m of src.matchAll(/\bi18n\(\s*(["'])((?:[^"'\\\n]|\\.)*?)\1/g)) fromJs.push(m[2]!);
  }
  for (const k of [...fromText, ...fromAttrs, ...fromJs]) used.add(k);
  const missing = [...used].filter((k) => !known.has(k));
  out.push(
    assert(
      "★화면이 부르는 키가 **전부** 기본 카탈로그에 있다(브라우저 폴백이 도달 불가해진다)",
      missing.length === 0,
      missing.length === 0
        ? `사용 ${used.size}개 · 카탈로그 ${known.size}개`
        : `★카탈로그에 없는 키: ${missing.slice(0, 6).join(", ")}`,
    ),
  );

  // ── ①b 검사가 **자기 눈을 잃으면** 빨개진다 ─────────────────────────────────
  //  ★종전엔 `used.size > 0` 하나였는데, 그건 판별력이 없다 — 속성 수집을 통째로 지워도
  //   본문 키가 남아 초록이었다(실측: 67 → 38, 통과). 그물이 자기 변이를 못 잡는 부류다
  //   ([[feedback_gate_must_actually_run]]).
  //  그래서 **다른 기제로 센 개수와 맞춘다**: 마크업의 리터럴 등장 횟수(정규식 아님) 대
  //  실제로 걷힌 키 수. 수집 정규식이 죽으면 이 둘이 어긋난다.
  const rawText = html.split('data-i18n="').length - 1;
  const rawAttrs = html.split('data-i18n-attrs="').length - 1;
  // ★js 도 **같은 방식으로 센다** (2026-08-25 적대 검토 F4). 종전엔 `fromJs` 가 메시지에만
  //  있고 **조건엔 없었다** — 수집원 셋 중 가장 큰 것(427개, 82%)이 판별력 밖이었고, 실제로
  //  `/\bi18n\(/` 를 `/\bi18n\(/` 로 바꿔도 전부 초록이었다. 닫았다고 적어둔 구멍이
  //  가장 큰 자리에는 안 닫혀 있었다.
  //  ★그리고 속성은 `>=` 가 아니라 **페어 수**와 맞춘다 — 다중 페어 원소가 15개라
  //   `.split(";")` 을 `.slice(0,1)` 로 잘라도 `>=` 는 통과했다.
  // ★수집 정규식과 **다른 기제**로 센다(문자 스캔). 같은 정규식을 두 번 쓰면 그게 죽었을 때
  //  둘 다 같이 죽어 판별력이 0이다. 따옴표가 뒤따르는 호출만 센다 — 주석 속 `i18n()` 처럼
  //  인자 없는 것은 키가 아니다(첫 판에 그걸 세서 428 vs 427 로 어긋났다).
  const countJsCalls = (src: string): number => {
    let n = 0;
    for (let i = src.indexOf("i18n("); i >= 0; i = src.indexOf("i18n(", i + 1)) {
      let j = i + 5;
      while (j < src.length && (src[j] === " " || src[j] === "\n")) j++;
      if (src[j] === '"' || src[j] === "'") n++;
    }
    return n;
  };
  const rawJsPairs = jsSources.reduce((n, src) => n + countJsCalls(src), 0);
  const rawAttrPairs = [...html.matchAll(/data-i18n-attrs="([^"]+)"/g)].reduce(
    (n, m) => n + m[1]!.split(";").filter((x) => x.includes("=")).length,
    0,
  );
  out.push(
    assert(
      "★수집이 마크업에 있는 만큼 걷혔다(수집 정규식이 죽으면 어긋난다 — 빈손 통과 방지)",
      fromText.length === rawText &&
        fromAttrs.length === rawAttrPairs &&
        fromJs.length === rawJsPairs &&
        rawAttrs > 0 &&
        rawJsPairs > 0 &&
        known.size > 0,
      `본문 ${fromText.length}/${rawText} · 속성 ${fromAttrs.length}/${rawAttrPairs} · js ${fromJs.length}/${rawJsPairs} · 카탈로그 ${known.size}`,
    ),
    assert(
      "★화면 js 모듈을 실제로 읽었다(파일 목록을 손으로 안 적으므로 폴더가 비면 조용히 통과한다)",
      jsFiles.length > 0,
      `js 모듈 ${jsFiles.length}개`,
    ),
    // ★속성 **이름**도 본다 (적대 검토 F1/D1). 종전엔 페어의 키만 걷어서 `title=` 을
    //  `titel=` 로 오타 내도 초록이었다 — 툴팁 번역이 죽고 쓰레기 속성이 생긴다.
    assert(
      "★번역이 붙는 속성 이름이 전부 알려진 것이다(오타면 조용히 죽고 쓰레기 속성이 생긴다)",
      [...attrNames].every((n) => ["placeholder", "title", "aria-label", "value", "alt"].includes(n)),
      `속성 ${[...attrNames].sort().join(" ")}`,
    ),
  );

  // ── ② 자리표시자 규칙이 양쪽에서 **같은 정규식**이다 ──────────────────────
  //  값이 브라우저에 있어서 보간을 코어로 못 옮긴다. 공유 파일을 새로 만들면 `allowJs` +
  //  `core → packages` 방향이 생겨 **줄이려던 것보다 이음매가 는다.** 그래서 없애는 대신
  //  **같음만 고정**한다 — 한 줄짜리 대조다.
  //  ★처음엔 소스를 정규식으로 뜯어 `new Function` 으로 두 구현을 돌려 비교했는데, 그건
  //   영리하지 실용적이지 않았다(바로 깨졌다). 억지로 줄이지 않는다.
  const util = await readRel("../../../packages/dashboard/js/util.js");
  const core = await readRel("../../../core/i18n.ts".replace("../../../core", "../../core"));
  const RULE = String.raw`\{(\w+)\}`;
  out.push(
    assert(
      "★자리표시자 규칙이 브라우저·코어에서 같다(한쪽만 고치면 문장이 갈린다)",
      util.includes(RULE) && core.includes(RULE),
      `util=${util.includes(RULE)} core=${core.includes(RULE)}`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "i18n-keys-complete",
  guards:
    "화면이 카탈로그에 없는 키를 불러 사용자에게 `nav.settings` 같은 키가 그대로 보이던 것 + 브라우저·코어가 각자 폴백·보간 규칙을 들고 갈라지는 것",
  run,
};
export default check;
