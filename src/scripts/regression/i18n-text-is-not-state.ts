/**
 * 회귀: **화면에 보이는 글자를 상태로 쓰지 않는다** (2026-08-25).
 *
 * ★영어를 넣기로 하면서 잠복이 하나 실물이 됐다. 잡 카드가 `labelEl.textContent === "(작업)"`
 *  으로 *"아직 이름이 없다"* 를 판정하는 자리가 **세 곳** 있었다(`background-drawer.js`
 *  :925·:932, `view-agents.js`:47). 그 문구가 미래핑인 동안엔 우연히 맞았다.
 *
 * ★위험한 것은 **감싸는 순간 조용해진다**는 점이다. `ko` 카탈로그는 키==값 항등 매핑이라
 *  번역을 태워도 그대로 통과한다 — 개발 기계에선 영원히 초록이고, **다른 언어에서만**
 *  매니저 라벨 로직이 죽는다. 자기 회귀가 자기가 못 본 것을 못 잡는 전형이라
 *  ([[feedback_scope_of_a_fix]]), 부류 자체를 소스에서 막는다.
 *
 * ★같은 부류로 **번역 값이 객체 키가 되는 것**도 있었다(`meta[i18n("경로")] = ...`).
 *  라벨이 `ko` 에선 "경로", `en` 에선 "Path" 라 **어느 입력이 충돌하는지가 언어마다
 *  달라진다.** 그건 `appendKvPairs` 로 자리를 없앴고, 여기선 비교 축만 지킨다.
 *
 * ★등급: **소스 게이트 + 행동 게이트.** ①은 카탈로그를 기준으로 소스를 스캔하고(손 목록 0
 *  — 키 목록은 `ko.json` 이 정한다, [[feedback_hand_maintained_lists]]), ②는 진짜
 *  `setJobLabel` 을 두 언어로 돌린다. ③은 **스캐너가 눈을 잃으면 빨개지게** 한다
 *  ([[feedback_gate_must_actually_run]]: 항상 초록인 가짜 검사가 반대편 실패다).
 */
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const readRel = (rel: string): Promise<string> => readFile(new URL(rel, import.meta.url), "utf8");

/** `x === "문구"` / `x !== "문구"` 에서 문자열만 걷는다(주석 줄은 뺀다). */
const COMPARE = /[!=]==\s*(["'])((?:[^"'\\\n]|\\.)*?)\1/g;

/**
 * 소스에서 **화면 문구와 비교하는 자리**를 찾는다.
 *
 * ★대조 대상은 카탈로그의 **값**(=화면에 보이는 글자)이지 키가 아니다. 키를 추상 이름으로
 *  옮긴 뒤엔 `"bg.job.untitled"` 와 비교할 사람은 없고, 위험한 것은 여전히
 *  `textContent === "(작업)"` 처럼 **표시 문구**를 판정에 쓰는 자리다. 값으로 봐야 규칙이
 *  살아 있다(키로 보면 이 검사는 통과만 하는 장식이 된다).
 * ★한 글자 값(요일 `월`·화자 `나`)은 뺀다 — 화면 문구와 무관한 비교에 오탐이 나고,
 *  오탐 나는 게이트는 아무도 안 돌린다([[feedback_gate_must_actually_run]]).
 */
const findCatalogCompares = (src: string, keys: ReadonlySet<string>): string[] => {
  const hits: string[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    // 주석은 뺀다 — 이 파일과 수정 이력이 위반 형태를 **설명**하고 있고, 설명은 코드가 아니다
    // ([[feedback_gate_must_actually_run]]: 검사 대상은 마크업이지 그걸 설명하는 글이 아니다).
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const code = line.split("//")[0]!;
    COMPARE.lastIndex = 0;
    for (const m of code.matchAll(COMPARE)) {
      if (keys.has(m[2]!)) hits.push(`${i + 1}:${JSON.stringify(m[2])}`);
    }
  }
  return hits;
};

/** 이름 붙은 최상위 `const` 한 줄을 원문 그대로 떼어낸다(값이 바뀌면 검사도 따라간다). */
const grabConst = (src: string, name: string): string => {
  const m = src.match(new RegExp(`^\\s*const ${name} = .*$`, "m"));
  if (m === null) throw new Error(`${name} 정의를 못 찾음 — 구조가 바뀌었나`);
  return m[0];
};

/** 6칸 들여쓴 화살표 함수 정의 하나를 통째로 떼어낸다. */
const grabFn = (src: string, name: string): string => {
  const from = src.indexOf(`      const ${name} = (`);
  if (from < 0) throw new Error(`${name} 정의를 못 찾음 — 구조가 바뀌었나`);
  const end = src.indexOf("\n      };", from);
  if (end < 0) throw new Error(`${name} 정의의 끝을 못 찾음`);
  return src.slice(from, end + "\n      };".length);
};

/** `util.js` 의 `i18n` 정의만(=`applyI18n` 앞까지). */
const sliceI18n = (src: string): string => {
  const from = src.indexOf("      const i18n = (key, params) => {");
  const to = src.indexOf("      const applyI18n");
  if (from < 0 || to < 0) throw new Error("i18n 정의를 못 찾음 — 구조가 바뀌었나");
  return src.slice(from, to);
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const ko = JSON.parse(await readRel("../../../locales/ko.json")) as Record<string, string>;
  /** 화면에 보이는 글자 = 카탈로그의 값. 한 글자짜리는 뺀다(오탐 방지, 위 주석). */
  const keys = new Set(Object.values(ko).filter((v) => v.trim().length > 1));

  // ── ① 화면 문구를 비교에 쓰는 자리가 **하나도 없다** ──────────────────────────
  //  ★js 파일 목록을 손으로 적지 않는다 — 새 화면 모듈이 조용히 검사 밖으로 나간다.
  const jsDir = new URL("../../../packages/dashboard/js/", import.meta.url);
  const jsFiles = (await readdir(jsDir)).filter((f) => f.endsWith(".js"));
  const offenders: string[] = [];
  let scanned = 0;
  for (const f of jsFiles) {
    const src = await readFile(new URL(f, jsDir), "utf8");
    scanned += 1;
    for (const hit of findCatalogCompares(src, keys)) offenders.push(`${f}:${hit}`);
  }
  out.push(
    assert(
      "★화면 문구를 `===`/`!==` 비교에 쓰는 자리가 없다 — 번역하면 그 판정이 언어마다 갈린다",
      offenders.length === 0,
      offenders.length === 0
        ? `${scanned}개 모듈 · 화면 문구 ${keys.size}개 대조 · 0건`
        : `★${offenders.length}건: ${offenders.slice(0, 5).join(" · ")}`,
    ),
    // 스캔 대상이 0이면 위 단언은 공허하게 초록이다.
    assert(
      "★스캔한 화면 모듈·문구가 실제로 있다(0이면 위 검사가 통째로 공허하다)",
      scanned >= 20 && keys.size >= 100,
      `모듈 ${scanned}개 · 문구 ${keys.size}개`,
    ),
  );

  // ── ② 진짜 `setJobLabel` 을 **두 언어로** 돌린다 ─────────────────────────────
  //  상태(`label`·`hasLabel`)는 같고 **표시만** 달라야 한다. 이게 뒤집히면 라벨 판정이
  //  언어에 매인 것이다.
  const util = await readRel("../../../packages/dashboard/js/util.js");
  const constants = await readRel("../../../packages/dashboard/js/constants.js");
  const drawer = await readRel("../../../packages/dashboard/js/background-drawer.js");
  const source = [
    sliceI18n(util),
    grabConst(constants, "JOB_LABEL_FALLBACK"),
    grabFn(drawer, "setJobLabel"),
    "this.__set = setJobLabel; this.__fallback = JOB_LABEL_FALLBACK;",
  ].join("\n");

  const runUnder = (
    locale: string,
    strings: Record<string, string>,
  ): { fallback: string; empty: Record<string, unknown>; named: Record<string, unknown> } => {
    const ctx: Record<string, unknown> = { window: { __TIGU_I18N__: { locale, strings } } };
    vm.createContext(ctx);
    vm.runInContext(source, ctx);
    const set = ctx.__set as (e: Record<string, unknown>, t: string) => void;
    const mk = (): Record<string, unknown> => ({ labelEl: { textContent: "" } });
    const empty = mk();
    set(empty, "");
    const named = mk();
    set(named, "정산");
    return { fallback: ctx.__fallback as string, empty, named };
  };

  const asKo = runUnder("ko", ko);
  const asEn = runUnder("en", { ...ko, "bg.job.untitled": "(untitled)" });
  const textOf = (e: Record<string, unknown>): string =>
    String((e.labelEl as { textContent: string }).textContent);

  out.push(
    assert(
      "★번역이 실려도 **상태는 같다**(이름 없음 판정이 언어를 안 탄다)",
      asKo.empty.hasLabel === false &&
        asEn.empty.hasLabel === false &&
        asKo.empty.label === "" &&
        asEn.empty.label === "",
      `ko=${JSON.stringify({ h: asKo.empty.hasLabel, l: asKo.empty.label })} en=${JSON.stringify({ h: asEn.empty.hasLabel, l: asEn.empty.label })}`,
    ),
    assert(
      "이름이 있으면 두 언어 모두 그 이름이 상태이자 표시다",
      asKo.named.hasLabel === true &&
        asEn.named.hasLabel === true &&
        asKo.named.label === "정산" &&
        textOf(asEn.named) === "정산",
      `ko=${JSON.stringify(asKo.named.label)} en=${JSON.stringify(textOf(asEn.named))}`,
    ),
    // ★여기가 판별력이다 — 표시가 **실제로 달라져야** 위 단언이 의미를 갖는다. 폴백 문구가
    //  두 언어에서 같으면 "상태가 같다" 는 아무것도 증명하지 않는다.
    assert(
      "★표시는 언어를 탄다(폴백 문구가 실제로 번역된다 — 안 그러면 위 단언이 공허하다)",
      asKo.fallback !== asEn.fallback &&
        textOf(asKo.empty) === asKo.fallback &&
        textOf(asEn.empty) === "(untitled)",
      `ko=${JSON.stringify(textOf(asKo.empty))} en=${JSON.stringify(textOf(asEn.empty))}`,
    ),
  );

  // ── ③ 스캐너가 **눈을 잃으면 빨개진다** ──────────────────────────────────────
  //  ①은 정상일 때 0건이라, 수집 정규식을 통째로 죽여도 0건이라 초록이다. 합성 위반을
  //  넣어 실제로 잡히는지 본다(그리고 무관한 문자열은 안 잡히는지도).
  const displayText = ko["bg.job.untitled"] ?? "(작업)";
  const sample = [
    `if (entry.labelEl.textContent === ${JSON.stringify(displayText)}) return;`,
    `// if (x === ${JSON.stringify(displayText)}) — 주석은 코드가 아니다`,
    'if (mode !== "compact") return;',
  ].join("\n");
  const found = findCatalogCompares(sample, keys);
  out.push(
    assert(
      "★스캐너가 위반을 실제로 잡는다(합성 입력 1건)",
      found.length === 1 && found[0]!.startsWith("1:"),
      `잡은 것=${JSON.stringify(found)} (기대: 1행 1건)`,
    ),
    assert(
      "카탈로그에 없는 문자열 비교는 안 잡는다(오탐이면 아무도 이 검사를 안 돌린다)",
      !found.some((h) => h.includes("compact")),
      JSON.stringify(found),
    ),
  );

  // ── ④ 카탈로그 값이 **마크업으로** 들어가지 않는다 ──────────────────────────
  //  ★언어 파일은 사용자가 받아서 홈에 놓는 데이터다 — 남이 만든 것을 받아 쓰라고 만든
  //   기능이라 신뢰 등급이 낮다. 그 값을 `innerHTML` 에 넣으면 **번역 파일 하나가 대시보드
  //   XSS 벡터**가 되고, 같은 오리진에 `/api/messages`(=비서에게 임의 지시 = 도구 실행)가
  //   있어 대가가 크다. 태그가 섞인 문구는 `i18nNodes` 로 조립한다(문구는 늘 텍스트 노드).
  {
    const bad: string[] = [];
    for (const f of jsFiles) {
      const src = await readFile(new URL(f, jsDir), "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i]!.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        // `innerHTML` 대입문이 같은 문장 안에서 `i18n(` 을 부르는가(다음 줄까지 이어붙임 포함).
        const stmt = lines.slice(i, i + 6).join("\n").split(";")[0]!;
        if (/\binnerHTML\s*(\+)?=/.test(lines[i]!) && /\bi18n\(/.test(stmt) && !/escHtml\(/.test(stmt)) {
          bad.push(`${f}:${i + 1}`);
        }
      }
    }
    out.push(
      assert(
        "★카탈로그 값을 innerHTML 로 넣지 않는다(언어 파일이 XSS 벡터가 된다 — i18nNodes 로 조립할 것)",
        bad.length === 0,
        bad.length === 0 ? "0건" : `★${bad.length}건: ${bad.slice(0, 5).join(" · ")}`,
      ),
      assert(
        "★그 조립 프리미티브가 실제로 있다(없으면 위 규칙을 지킬 방법이 없다)",
        /const i18nNodes = \(key, parts\) =>/.test(util),
        /i18nNodes/.test(util) ? "i18nNodes 확인" : "★util.js 에 i18nNodes 가 없다",
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "i18n-text-is-not-state",
  guards:
    "화면에 보이는 글자를 상태로 쓰던 것 — 그 문구를 번역하는 순간 `ko` 에선 항등 매핑이라 통과하고 다른 언어에서만 조용히 죽는다(잡 라벨 판정 3곳이 그랬다)",
  run,
};
export default check;
