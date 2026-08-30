/**
 * 회귀: **자리표시자가 호출부와 맞는다** (2026-08-26).
 *
 * ★기존 `i18n-catalogs-and-coverage` 는 **en ↔ ko 만** 대조한다. 그래서 **양쪽을 같이 고치면
 *  무음**이다 — `{turns}` 를 두 카탈로그에서 같이 지우면 화면에서 숫자가 조용히 사라지고,
 *  두 카탈로그에 같이 `{oops}` 를 넣으면 화면에 `{oops}` 가 그대로 뜬다. 둘 다 실증됐고
 *  스위트는 초록이었다. 빠져 있던 축은 **호출부**다(적대 검토 G축 ①).
 *
 * 두 방향을 본다:
 *  - **카탈로그에 있는데 아무도 안 채운다** → 화면에 `{x}` 가 그대로 보인다.
 *  - **호출이 채우려는데 카탈로그에 없다** → 그 값이 조용히 사라진다.
 *
 * ★채우는 방법이 셋이다 — 파서가 셋을 다 알아야 오탐이 안 난다:
 *  `i18n(k, {a})` · `i18n(k).replace("{a}", …)` · `i18n(k).split("{a}")`(조각 사이에 DOM 삽입).
 *
 * ★파서가 두 번 오탐했고 둘 다 기록해 둔다(다음에 같은 함정을 다시 판다):
 *  ① `i18n(k)` 뒤의 **감싸는 객체**까지 인자로 읽었다(`{ label: i18n(k), icon: … }` → icon 을
 *     자리표시자로 셌다) → 문자열을 가린 뒤 **괄호 짝**으로 인자 범위를 자른다.
 *  ② 정규식 `ident:` 가 **삼항의 콜론**을 먹었다(`e.message ? x : e` → `message`) →
 *     최상위(brace depth 1)에서 앞 글자가 `{`·`,` 인 것만 키로 센다.
 *
 * ★**서버 생산자도 같이 본다**(2026-08-26). `i18n-keys-complete` 는 `index.html`+`js/*.js`
 *  만 걷어서 `.ts` 가 내보내는 `{ key, params }`(=`DisplayText`)는 **수집 대상이 아니었다.**
 *  오타 키는 화면에 키 원문이 뜨고, 자리표시자가 어긋나면 값이 사라진 문장이 된다.
 *  ★슬롯 객체(`{ key: "system", text, channel }`)와 가르는 기준은 **점**이다 — 카탈로그
 *   583키가 전부 `a.b` 꼴이고 점 없는 키는 0이다(실측). 규칙이 깨지면 아래 단언이 먼저 운다.
 *
 * 등급: 대조 검사(소스 토크나이저 + 카탈로그). 판정 대상은 **화면 js + 서버 생산자** 다.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanJsStrings, maskJsStrings } from "./_js-strings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JS_DIR = path.join(REPO, "packages/dashboard/js");

/** 문자열 값 안의 `{name}` 들. */
const placeholdersOf = (v: string): string[] => [
  ...new Set([...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string)),
];

/** 객체 리터럴의 **최상위** 키만(중첩·삼항 회피). shorthand(`{err}`)도 키로 센다. */
const topLevelKeys = (objText: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let prev = "";
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i] as string;
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      prev = ch;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      if (depth === 0) break;
      prev = ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (depth === 1 && (prev === "{" || prev === ",") && /[A-Za-z_$]/.test(ch)) {
      let end = i;
      while (end < objText.length && /[\w$]/.test(objText[end] as string)) end += 1;
      let q = end;
      while (q < objText.length && /\s/.test(objText[q] as string)) q += 1;
      const nxt = objText[q];
      if (nxt === ":" || nxt === "," || nxt === "}") out.push(objText.slice(i, end));
      i = end - 1;
      prev = "i";
      continue;
    }
    prev = ch;
  }
  return out;
};

export interface CallSiteScan {
  /** 키 → 그 키를 부르는 곳들이 **채우는** 자리표시자 이름의 합집합. */
  filled: Map<string, Set<string>>;
  /** params 가 변수라 정적으로 못 읽는 키 — 판정에서 뺀다(오탐 0 우선). */
  dynamic: Set<string>;
}

/** 화면 js 한 파일에서 `i18n(...)` 호출을 걷는다. */
export const scanCallSites = (sources: readonly string[]): CallSiteScan => {
  const filled = new Map<string, Set<string>>();
  const dynamic = new Set<string>();
  for (const src of sources) {
    const strs = scanJsStrings(src);
    const masked = maskJsStrings(src, strs);
    for (let i = src.indexOf("i18n("); i >= 0; i = src.indexOf("i18n(", i + 1)) {
      let j = i + 5;
      while (j < src.length && /\s/.test(src[j] as string)) j += 1;
      const lit = strs.find((s) => s.start === j);
      if (lit === undefined) continue; // 키가 리터럴이 아닌 호출은 대상 밖
      // ★인자 범위를 **괄호 짝**으로 자른다(문자열은 가려져 있다).
      let depth = 0;
      let close = -1;
      for (let m = i + 4; m < masked.length; m++) {
        const ch = masked[m];
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            close = m;
            break;
          }
        }
      }
      if (close < 0) continue;
      const key = lit.value;
      const set = filled.get(key) ?? new Set<string>();
      filled.set(key, set);

      const argTail = src.slice(lit.end, close);
      if (/,\s*\{/.test(argTail)) {
        for (const k of topLevelKeys(argTail.slice(argTail.indexOf("{")))) set.add(k);
      } else if (/,\s*[A-Za-z_$]/.test(argTail)) {
        dynamic.add(key);
      }
      // 체이닝으로 채우는 둘 — `.replace("{a}", …)` · `.split("{a}")`.
      // ★**바로 뒤에 붙은 것만** 센다. 첫 판은 뒤 200자를 훑어서 **다음 문장**의
      //  `.split("{code}")` 를 앞 호출의 것으로 셌다(실증: `common.loading:code`).
      //  창으로 읽으면 문장 경계를 못 본다 — 괄호 짝으로 한 칸씩 따라간다.
      let cur = close + 1;
      for (;;) {
        let t = cur;
        while (t < src.length && /\s/.test(src[t] as string)) t += 1;
        const m = /^\.(?:replace|split)\(\s*["'`]\{(\w+)\}/.exec(src.slice(t, t + 80));
        if (m === null) break;
        set.add(m[1] as string);
        // 이 호출의 짝 `)` 까지 건너뛴다(문자열은 마스킹된 소스에서 본다).
        let d2 = 0;
        let next = -1;
        for (let q = t; q < masked.length; q++) {
          const c2 = masked[q];
          if (c2 === "(") d2 += 1;
          else if (c2 === ")") {
            d2 -= 1;
            if (d2 === 0) {
              next = q;
              break;
            }
          }
        }
        if (next < 0) break;
        cur = next + 1;
      }
    }
  }
  return { filled, dynamic };
};

/**
 * 서버가 내보내는 `{ key: "a.b", params: { … } }` 를 걷는다.
 *
 * ★키에 **점이 있어야** 대상이다 — `{ key: "system", text, channel }` 같은 슬롯 객체를
 *  거르기 위해서다(첫 판이 그걸 "카탈로그에 없는 키" 15건으로 오탐했다).
 * ★`params` 는 **shorthand**(`{ state, status }`)가 흔하다 — `topLevelKeys` 가 그걸 안다
 *  (정규식 `ident:` 로 읽던 첫 판은 4건을 "안 채워짐" 으로 오탐했다).
 */
/**
 * 서버가 키와 인자를 함께 내보내는 **모양들** — 이름만 다르고 판정은 같다.
 *
 * ★`{ reasonKey, reasonArgs }` 를 여기 등록한 이유 (2026-08-31): 플러그인 거부 사유가
 *  같은 게임에 들어왔는데(`plugins.reason.*`) 이 축 밖이었다. 그쪽 검사 파일에 파서를
 *  하나 더 두려다 되돌렸다 — **같은 판단이 두 곳이면 갈린다**. 게다가 새 파서는 템플릿
 *  안의 `${name}` 을 감싸는 객체로 오인해 첫 판에 8건을 오탐했고, 그건 이 파일이 이미
 *  세 번 겪고 토크나이저로 넘어간 함정이다. 모양이 늘면 **여기 한 줄** 늘린다.
 */
const EMIT_SHAPES: ReadonlyArray<{ key: string; args: string }> = [
  { key: "key", args: "params" },
  { key: "reasonKey", args: "reasonArgs" },
  { key: "errorKey", args: "errorArgs" },
];

export const scanServerEmits = (
  sources: readonly string[],
): Array<{ key: string; params: Set<string> }> => {
  const out: Array<{ key: string; params: Set<string> }> = [];
  for (const src of sources) {
    const masked = maskJsStrings(src, scanJsStrings(src));
    for (const shape of EMIT_SHAPES) {
      const at = new RegExp(`(?<![a-zA-Z])${shape.key}:\\s*"([a-zA-Z0-9._-]+)"`, "g");
      // ★키 **이름**은 원본에서 읽는다(가린 소스엔 문자열 속 글자가 없다 — 첫 판이 그래서
      //  수집 0이 됐다). 위치는 길이가 보존되므로 가린 소스와 같다.
      for (const m of src.matchAll(at)) {
        const key = m[1] as string;
        if (!key.includes(".")) continue; // 슬롯 객체 등 — i18n 키가 아니다
        // ★**그 객체 안**만 본다. 창(예: 뒤 400자)으로 읽으면 **다음 문장의 인자**를
        //  삼킨다 — 실증: `{ key: "inv.schedule.neverRan" }`(params 없음)가 바로 다음 줄
        //  `inv.schedule.reboot` 의 `params: { state, status }` 를 자기 것으로 셌다.
        //  이 파일에서 같은 부류(창이 경계를 못 봄)로 **세 번** 걸렸다.
        // ★여는 괄호는 **가려진 소스**에서 뒤로 찾는다 — 문자열·템플릿 안의 `{` 는
        //  이미 공백이라 `` `${name} …` `` 같은 사유 문장에 속지 않는다.
        const open = masked.lastIndexOf("{", m.index ?? 0);
        if (open < 0) continue;
        let d = 0;
        let close = -1;
        for (let q = open; q < masked.length; q++) {
          const c = masked[q];
          if (c === "{") d += 1;
          else if (c === "}") {
            d -= 1;
            if (d === 0) {
              close = q;
              break;
            }
          }
        }
        const body = close < 0 ? "" : src.slice(open, close + 1);
        const pm = new RegExp(`${shape.args}:\\s*\\{`).exec(body);
        const params = new Set<string>();
        if (pm !== null) {
          for (const k of topLevelKeys(body.slice(pm.index + pm[0].length - 1))) params.add(k);
        }
        out.push({ key, params });
      }
    }
  }
  return out;
};

export const check: RegressionCheck = {
  name: "i18n-placeholders-match-callsites",
  guards:
    "자리표시자를 en↔ko 로만 대조해서, 두 카탈로그를 같이 고치면 무음이던 것 — {turns} 를 양쪽에서 지우면 숫자가 사라지고 양쪽에 {oops} 를 넣으면 화면에 그대로 뜬다(둘 다 실증). 호출부라는 축이 통째로 빠져 있었다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const files = readdirSync(JS_DIR).filter((f) => f.endsWith(".js"));
    const sources = files.map((f) => readFileSync(path.join(JS_DIR, f), "utf8"));
    const ko = JSON.parse(
      readFileSync(path.join(REPO, "locales/ko.json"), "utf8"),
    ) as Record<string, string>;
    const { filled, dynamic } = scanCallSites(sources);

    // 빈손 통과 금지 — 수집이 죽으면 아래 단언이 전부 "위반 0" 으로 초록이 된다.
    const withPh = Object.values(ko).filter((v) => /\{\w+\}/.test(v)).length;
    out.push(
      assert(
        "★수집이 실제로 걷혔다(호출·자리표시자 키가 0이면 아래는 미검사다)",
        files.length > 0 && filled.size > 50 && withPh > 50,
        `js ${files.length}개 · 호출 키 ${filled.size} · 자리표시자 있는 카탈로그 키 ${withPh}`,
      ),
    );

    const unfilled: string[] = [];
    const unknown: string[] = [];
    for (const [key, params] of filled) {
      if (dynamic.has(key)) continue;
      const v = ko[key];
      if (typeof v !== "string") continue;
      const ph = placeholdersOf(v);
      if (ph.length === 0 && params.size === 0) continue;
      for (const p of ph) if (!params.has(p)) unfilled.push(`${key}:{${p}}`);
      for (const p of params) if (!ph.includes(p)) unknown.push(`${key}:${p}`);
    }

    out.push(
      assert(
        "★카탈로그의 자리표시자를 호출부가 전부 채운다(안 채우면 화면에 {x} 가 그대로 뜬다)",
        unfilled.length === 0,
        unfilled.length === 0
          ? "미충족 0"
          : `★${unfilled.length}건: ${unfilled.slice(0, 6).join(", ")}`,
      ),
      assert(
        "★호출부가 넘기는 값이 카탈로그에 자리를 갖는다(없으면 그 값이 조용히 사라진다)",
        unknown.length === 0,
        unknown.length === 0
          ? "미사용 0"
          : `★${unknown.length}건: ${unknown.slice(0, 6).join(", ")}`,
      ),
      assert(
        "params 가 변수라 못 읽는 호출은 판정에서 빠진다(오탐 0 우선 — 개수를 남긴다)",
        true,
        `동적 ${dynamic.size}개${dynamic.size > 0 ? `: ${[...dynamic].slice(0, 4).join(", ")}` : ""}`,
      ),
    );

    // ── 서버 생산자 축 ────────────────────────────────────────────────────────
    // ★`providers.ts` 한 파일에서 **디렉터리로** 넓혔다 (2026-08-31) — 같은 폴더의
    //  `manager.ts`·`settings.ts` 가 거부 사유 키를 내는데 대상 밖이었다. 파일 이름을
    //  적으면 넷째가 조용히 빠진다([[feedback_hand_maintained_lists]]).
    const tsFiles = [
      "src/core/plugins",
      "plugins/http-bridge",
      "src/core/prompt-assembly.ts",
    ].filter((f) => existsSync(path.join(REPO, f)));
    const emits = scanServerEmits(
      // ★디렉터리도 있다(`plugins/http-bridge`) — 공용 리더가 그 아래 `.ts` 를 전부 본다.
      tsFiles.map((f) => readSourceSync(f)),
    );
    const badKey: string[] = [];
    const badPh: string[] = [];
    for (const e of emits) {
      const v = ko[e.key];
      if (typeof v !== "string") {
        badKey.push(e.key);
        continue;
      }
      for (const p of placeholdersOf(v)) if (!e.params.has(p)) badPh.push(`${e.key}:{${p}}`);
      for (const p of e.params) if (!placeholdersOf(v).includes(p)) badPh.push(`${e.key}:${p}?`);
    }
    out.push(
      assert(
        "★서버 생산자를 실제로 걷었다(0이면 아래 둘은 미검사다)",
        emits.length >= 10,
        `${tsFiles.length}개 파일 · { key, params } ${emits.length}건`,
      ),
      assert(
        "★서버가 내보내는 키가 카탈로그에 있다(없으면 화면에 키 원문이 뜬다)",
        badKey.length === 0,
        badKey.length === 0 ? "미등록 0" : `★${badKey.length}건: ${badKey.slice(0, 6).join(", ")}`,
      ),
      assert(
        "★서버가 내보내는 자리표시자가 params 와 맞는다(어긋나면 값이 사라진 문장이 된다)",
        badPh.length === 0,
        badPh.length === 0 ? "불일치 0" : `★${badPh.length}건: ${badPh.slice(0, 6).join(", ")}`,
      ),
    );
    return out;
  },
};
