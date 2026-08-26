/**
 * 회귀: **번역이 조용히 깨지지 않는다** (2026-08-25, 영어 추가와 함께).
 *
 * 한글-키를 추상 키로 옮기면서 생긴 새 실패 모드를 닫는다. 셋 다 개발 기계에선 안 보인다 —
 * `ko` 는 언제나 멀쩡하고 **다른 언어에서만** 틀리기 때문이다.
 *
 *  ① **고아 키** — 문구를 고치며 키 이름을 바꾸면 `en.json` 의 그 항목은 아무도 안 부른다.
 *     부분 번역은 설계상 허용이므로(폴백) *빠진 것*은 통과시키고, **소스에 없는 것**만 막는다.
 *  ② **자리표시자 어긋남** — `{n}` 을 빠뜨린 번역은 숫자가 통째로 사라진 문장을 만든다.
 *     빈 자리는 남기게 돼 있어 크래시는 안 나고, 그래서 **조용하다**.
 *  ③ **미래핑 한국어** — 새로 쓴 화면 문구를 카탈로그에 안 넣으면 `en` 에서 한국어가 샌다.
 *     콘솔 로그와 `?perf=1` 개발 HUD 는 화면이 아니라 진단면이라 범위 밖이다.
 *
 * ★그리고 **카탈로그 값에 리터럴 이스케이프를 두지 않는다**. 옛 한글-키 시절엔 값이
 *  `\n…`(역슬래시+n 두 글자)이었는데, 그때는 조회가 빗나가 폴백이 가려줬다. 추상 키로
 *  옮기자 조회가 맞기 시작하면서 **화면에 역슬래시가 그대로 보이게** 됐다(실제로 4건).
 *
 * ★등급: 소스·자산 게이트. 카탈로그 파일과 실제 소스를 읽어 대조한다.
 */
import { readFile, readdir } from "node:fs/promises";
import { scanJsStrings, maskJsStrings } from "./_js-strings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const BASE = "ko";
const HANGUL = /[가-힣]/;
const PLACEHOLDER = /\{(\w+)\}/g;
/**
 * 화면이 아니라 **진단면**인 파일(콘솔 로그와 같은 등급)은 i18n 대상이 아니다.
 *
 * ★판정을 **파일 자신의 선언**으로 옮겼다 (2026-08-26 G축 ②). 종전엔 여기 파일명
 *  목록(`DIAGNOSTIC_ONLY = {"perf.js"}`)을 뒀는데, 새 진단 파일이 생기면 **이 파일을**
 *  고쳐야 했고 그건 아무도 안 한다([[feedback_hand_maintained_lists]]). 파일이 스스로
 *  `@diagnostic-only` 를 달면 목록이 사라지고, 파일을 옮기거나 지워도 따라간다.
 * ★반대 방향도 좋아진다 — 진단면이 나중에 사용자 대면이 되면 **그 파일에서** 표식을 떼게
 *  되고, 그 순간 검사가 바로 본다(목록이면 조용히 면제가 남는다).
 */
const DIAGNOSTIC_MARK = "@diagnostic-only";

const readRel = (rel: string): Promise<string> => readFile(new URL(rel, import.meta.url), "utf8");
const placeholders = (s: string): Set<string> =>
  new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]!));

/** 이 문자열이 `console.X(...)` 안에 있나 — 문자열 내부를 가린 소스로 괄호를 센다. */
const insideConsoleCall = (masked: string, at: number): boolean => {
  const win = masked.slice(Math.max(0, at - 600), at);
  let depth = 0;
  for (let k = win.length - 1; k >= 0; k -= 1) {
    const ch = win[k]!;
    if (ch === ")") depth += 1;
    else if (ch === "(") {
      if (depth === 0) return /console\s*\.\s*\w+\s*$/.test(win.slice(0, k));
      depth -= 1;
    } else if (ch === ";" && depth === 0) break;
  }
  return false;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── 카탈로그 읽기 — **파일이 곧 목록**이다(손 목록 0) ────────────────────────
  const localesDir = new URL("../../../locales/", import.meta.url);
  const files = (await readdir(localesDir)).filter((f) => f.endsWith(".json")).sort();
  const catalogs = new Map<string, Record<string, string>>();
  for (const f of files) {
    catalogs.set(
      f.slice(0, -5),
      JSON.parse(await readFile(new URL(f, localesDir), "utf8")) as Record<string, string>,
    );
  }
  const base = catalogs.get(BASE) ?? {};
  const others = [...catalogs.keys()].filter((l) => l !== BASE);

  out.push(
    // ★`others` 가 비면 ①고아·②자리표시자 단언이 **생성 자체가 안 되고** 스위트는 조용히
    //  건수만 줄어든다(적대 검토 A-F5/D5: 52→50, 초록). 대조할 언어가 있어야 검사가 있다.
    assert(
      "★대조할 다른 언어 카탈로그가 있다(0이면 고아·자리표시자 검사가 사라진다)",
      others.length >= 1,
      `기본=${BASE} · 대조=${others.join(", ") || "(없음)"}`,
    ),
    assert(
      "★기본 카탈로그가 있고 비어 있지 않다(없으면 화면이 키로 뜬다)",
      Object.keys(base).length >= 100,
      `${BASE}.json ${Object.keys(base).length}키 · 설치 언어 ${[...catalogs.keys()].join(", ")}`,
    ),
  );

  // ── ① 고아 키 ───────────────────────────────────────────────────────────────
  for (const loc of others) {
    const cat = catalogs.get(loc)!;
    const orphans = Object.keys(cat).filter((k) => base[k] === undefined);
    out.push(
      assert(
        `★${loc}.json 에 **소스가 안 부르는 키**가 없다(문구를 고치면 번역이 조용히 고아가 된다)`,
        orphans.length === 0,
        orphans.length === 0
          ? `${Object.keys(cat).length}키 · 고아 0`
          : `★고아 ${orphans.length}개: ${orphans.slice(0, 6).join(", ")}`,
      ),
    );
  }

  // ── ①b ★빈 값 금지 (2026-08-26) ─────────────────────────────────────────────
  //  ★`""` 는 *키 부재*가 아니라 **값**이라, 조회(`??`)도 병합(스프레드)도 그걸 이긴다.
  //   반쯤 번역한 파일에 `"chat.send": ""` 이 있으면 **빈 버튼**이 된다 — 화면은 멀쩡히
  //   뜨고 에러도 0이라 눈으로는 안 잡힌다. 이 기능(언어를 파일 하나로 늘린다)의 핵심
  //   실패 모드가 정확히 그것이다. 조회·병합 쪽은 이제 빈 값을 「없음」으로 치지만,
  //   **애초에 카탈로그에 안 들어가는 것**이 낫다(폴백은 안전망이지 목표가 아니다).
  for (const loc of [BASE, ...others]) {
    const cat = catalogs.get(loc) ?? {};
    const empties = Object.entries(cat)
      .filter(([, v]) => typeof v !== "string" || v.trim() === "")
      .map(([k]) => k);
    out.push(
      assert(
        `★${loc}.json 에 빈 값이 없다(빈 값은 기본 언어를 이겨서 빈 화면이 된다)`,
        empties.length === 0,
        empties.length === 0
          ? `${Object.keys(cat).length}키 · 빈 값 0`
          : `★빈 값 ${empties.length}개: ${empties.slice(0, 6).join(", ")}`,
      ),
    );
  }

  // ── ② 자리표시자 ────────────────────────────────────────────────────────────
  for (const loc of others) {
    const cat = catalogs.get(loc)!;
    const bad: string[] = [];
    for (const [k, v] of Object.entries(cat)) {
      const b = base[k];
      if (b === undefined) continue; // ①이 따로 본다
      const pb = placeholders(b);
      const pv = placeholders(v);
      if (pb.size !== pv.size || [...pb].some((p) => !pv.has(p))) {
        bad.push(`${k}(ko=${[...pb].sort().join(",")} ${loc}=${[...pv].sort().join(",")})`);
      }
    }
    out.push(
      assert(
        `★${loc}.json 의 자리표시자가 기본과 같다(하나만 빠져도 값이 사라진 문장이 된다)`,
        bad.length === 0,
        bad.length === 0 ? "전부 일치" : `★어긋남 ${bad.length}: ${bad.slice(0, 4).join(" · ")}`,
      ),
    );
  }

  // ── 리터럴 이스케이프 ───────────────────────────────────────────────────────
  {
    const bad: string[] = [];
    for (const [loc, cat] of catalogs) {
      for (const [k, v] of Object.entries(cat)) if (v.includes("\\")) bad.push(`${loc}:${k}`);
    }
    out.push(
      assert(
        "★카탈로그 값에 리터럴 이스케이프(`\\n` 두 글자)가 없다 — 화면에 역슬래시가 그대로 보인다",
        bad.length === 0,
        bad.length === 0 ? "0건" : `★${bad.length}건: ${bad.slice(0, 5).join(", ")}`,
      ),
    );
  }

  // ── ③ 미래핑 한국어 ─────────────────────────────────────────────────────────
  const jsDir = new URL("../../../packages/dashboard/js/", import.meta.url);
  const jsFiles = (await readdir(jsDir)).filter((f) => f.endsWith(".js"));
  const leaks: string[] = [];
  let scanned = 0;
  let logSkipped = 0;
  const diagnostic: string[] = [];
  for (const f of jsFiles) {
    const src = await readFile(new URL(f, jsDir), "utf8");
    if (src.includes(DIAGNOSTIC_MARK)) {
      diagnostic.push(f);
      continue;
    }
    const strings = scanJsStrings(src);
    const masked = maskJsStrings(src, strings);
    scanned += 1;
    for (const s of strings) {
      if (!HANGUL.test(s.value)) continue;
      // `i18n("…")` 의 키 자리는 대상이 아니다(키는 ASCII 여야 하고, 그건 아래에서 본다).
      if (/\bi18n\(\s*$/.test(src.slice(Math.max(0, s.start - 12), s.start))) continue;
      if (insideConsoleCall(masked, s.start)) {
        logSkipped += 1;
        continue;
      }
      leaks.push(`${f}:${s.line} ${JSON.stringify(s.value.slice(0, 40))}`);
    }
  }
  out.push(
    assert(
      "★화면 모듈에 카탈로그를 안 타는 한국어가 없다(다른 언어에서 한국어가 샌다)",
      leaks.length === 0,
      leaks.length === 0
        ? `${scanned}개 모듈 · 콘솔 로그 ${logSkipped}건은 범위 밖(진단면)`
        : `★${leaks.length}건: ${leaks.slice(0, 5).join(" · ")}`,
    ),
    // 스캔이 아무것도 안 보면 위 단언은 공허하게 초록이다.
    assert(
      "★스캔이 실제로 소스를 봤다(모듈 수·콘솔 제외 건수가 0이 아니다)",
      scanned >= 20 && logSkipped > 0,
      `모듈 ${scanned} · 콘솔 제외 ${logSkipped}`,
    ),
    // ★면제를 **보이게** 한다. 이 항목의 병은 면제 자체가 아니라 **조용한 면제**였다 —
    //  파일명 목록은 아무도 다시 안 보고, 그래서 면제가 영원히 남는다. 이름을 매번 찍으면
    //  검사 결과를 보는 사람이 "얘가 왜 빠져 있지" 를 물을 수 있다.
    assert(
      "진단면 면제가 몇 개인지 보인다(조용한 면제 금지 — 늘면 눈에 띈다)",
      diagnostic.length <= 2,
      diagnostic.length === 0
        ? "면제 0"
        : `면제 ${diagnostic.length}개: ${diagnostic.join(", ")} — @diagnostic-only 선언`,
    ),
  );

  // ── 키는 ASCII 다 ───────────────────────────────────────────────────────────
  //  ★한국어를 키로 되돌리면 다시 한국어가 피벗 언어가 된다(그게 이 이관의 이유다).
  {
    const korean = Object.keys(base).filter((k) => HANGUL.test(k));
    out.push(
      assert(
        "★카탈로그 키가 언어 중립이다(한국어를 키로 쓰면 다른 언어 사용자가 한국어를 식별자로 다뤄야 한다)",
        korean.length === 0,
        korean.length === 0 ? "전부 추상 키" : `★한국어 키 ${korean.length}: ${korean.slice(0, 4).join(", ")}`,
      ),
    );
  }

  // ── 서버는 **화면 문구를 만들지 않는다** ────────────────────────────────────
  //  ★2026-08-25 사용자 지적: *"인증됨은 인증 여부값이고 어댑터도 타입인데 굳이 언어가
  //   그대로 올 필요가 있을까?"* — 맞다. 데몬은 하나인데 대시보드를 보는 사람의 언어는
  //   브라우저마다 다를 수 있어 **서버가 고른 언어는 애초에 맞을 수가 없다.** 게다가 그
  //   문장이 쓰던 사실은 같은 응답의 `views[].data` 에 이미 구조화돼 있었다(중복).
  //  그래서 모듈 레지스트리가 내보내는 표시 필드엔 한국어가 없어야 한다 — 값이거나
  //  `{ key, params }` 스펙이거나 둘 중 하나다(`DisplayText`).
  {
    // ★생산자 **파일 이름을 손으로 적지 않는다** — 처음엔 두 개만 적었다가 세 번째
    //  (`http-bridge` 의 인벤토리 스케줄 설명)를 통째로 놓쳤다
    //  ([[feedback_hand_maintained_lists]]). 대시보드에 값을 내보내는 **자리**를 훑는다.
    const producerDirs = [
      new URL("../../core/plugins/", import.meta.url),
      new URL("../../../plugins/", import.meta.url),
    ];
    const producers: URL[] = [];
    const walk = async (dir: URL): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const child = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "dist") continue;
          await walk(child);
        } else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) {
          // ★**화면에 값을 내보내는 파일만** 본다. 기억 레코드(`analysis.ts`)·모델용 지침
          //  (`directives.ts`)도 `description:` 을 쓰지만 화면이 아니다.
          //
          //  ★기준을 **이름에서 모양으로** 바꿨다 (2026-08-26 G축 ②). 종전엔 `DisplayText`
          //   같은 **타입 이름을 언급하는가**로 골랐는데, 우리 플러그인 계약은 *구조적*이라
          //   (`{id, load}`) 타입을 import 할 의무가 **없다** — 타입을 안 쓰고 같은 모양을
          //   내보내는 생산자는 통째로 안 보였다. 이제 **무엇을 만들어 내보내는가**로 고른다:
          //   `{ key: "a.b" }`(DisplayText 스펙) 또는 `views:`/`actions:`/뷰 `kind:`.
          //   ★`.js` 도 본다(종전 `.ts` 만 — 배포본·드롭인 생산자가 0% 커버였다).
          //   ★전환 시점에 둘이 **같은 3개**를 고르는 걸 확인했다(동작 변화 0, 견고성만 상승).
          const body = await readFile(child, "utf8");
          const emitsDisplay =
            /\{\s*key:\s*"[a-z0-9_-]+\.[a-z0-9._-]+"/.test(body) ||
            /(?:^|\s)views:\s*\[/m.test(body) ||
            /(?:^|\s)actions:\s*\[/m.test(body) ||
            /kind:\s*"(?:summary-card|metric-card|table|list|badge)"/.test(body);
          if (emitsDisplay) producers.push(child);
        }
      }
    };
    for (const d of producerDirs) await walk(d);
    // ★선별이 죽으면 아래 단언이 전부 "위반 0" 으로 초록이 된다. 실제 와이어 생산자 둘이
    //  잡혔는지 이름으로 확인한다 — 목록이 아니라 **하한**이다(더 잡히는 건 정상).
    const picked = producers.map((u) => u.pathname);
    out.push(
      assert(
        "★생산자 선별이 살아 있다(죽으면 아래 위반 검사가 전부 무의미해진다)",
        producers.length >= 2 &&
          picked.some((p) => p.endsWith("core/plugins/providers.ts")) &&
          picked.some((p) => p.includes("http-bridge")),
        `${producers.length}개: ${picked.map((p) => p.split("/").slice(-2).join("/")).join(", ")}`,
      ),
    );
    const bad: string[] = [];
    let checked = 0;
    for (const rel of producers) {
      const src = await readFile(rel, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i]!.trimStart();
        checked += 1;
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        // ★**줄이 아니라 문장**을 본다 (2026-08-26 적대 검토 C1). 종전엔 필드명과 한글이
        //  같은 줄에 있을 때만 걸렸는데, 이 릴리스가 실제로 지운 두 위반은 **둘 다 다줄
        //  삼항**이었다 — 그래서 지운 코드를 글자 그대로 되돌려도 초록이었다. 그물이
        //  자기가 막겠다고 적은 바로 그 모양을 못 잡고 있었다.
        //  `:` 뿐 아니라 `=` 도 본다(`const summary = authenticated ? …` 가 그 모양이다).
        //  ★비교 연산자(`t.name === x`)에 걸리지 않게 **프로퍼티/선언 모양**만 본다.
        //   `[:=]` 로 넓혔더니 `===` 가 걸려 8줄 창이 무관한 한국어를 쓸어 담았다(오탐 1건).
        const FIELD = /(^|[{,(]\s*)(title|summary|label|description|name)\s*:/;
        const DECL = /\b(?:const|let|var)\s+(?:title|summary|label|description|name)\b/;
        if (!FIELD.test(t) && !DECL.test(t)) continue;
        const stmt: string[] = [];
        for (let j = i; j < Math.min(lines.length, i + 8); j += 1) {
          const u = lines[j]!.trimStart();
          if (!u.startsWith("//") && !u.startsWith("*") && !u.startsWith("/*")) stmt.push(u);
          // 문장의 끝 — 객체 필드는 `,`, 대입문은 `;` 로 닫힌다.
          if (u.endsWith(";") || u.endsWith(",")) break;
        }
        const joined = stmt.join(" ");
        if (HANGUL.test(joined)) {
          bad.push(`${rel.pathname.split("/").pop()}:${i + 1} ${joined.slice(0, 60)}`);
        }
      }
    }
    out.push(
      // ★수집이 **스스로 0이 되면** 위 단언은 공허하게 초록이다 — 생산자 판별이 타입 이름
      //  문자열 매칭이라 리팩터 한 번에 눈이 멀 수 있다(적대 검토 A-F5). 최소치를 박는다.
      assert(
        "★생산자 파일을 실제로 찾았다(0개면 위 검사가 통째로 공허하다)",
        producers.length >= 3 && checked >= 500,
        `생산자 ${producers.length}개 · ${checked}줄`,
      ),
      assert(
        "★서버가 화면 문구를 만들지 않는다(모듈 표시 필드에 한국어 0 — 값이거나 {key,params} 스펙이다)",
        bad.length === 0,
        bad.length === 0
          ? `${producers.length}개 생산자 파일 · ${checked}줄 검사 · 0건`
          : `★${bad.length}건: ${bad.slice(0, 4).join(" · ")}`,
      ),
      assert(
        "★그 스펙 타입이 실제로 있다(없으면 위 규칙을 지킬 방법이 없다)",
        /export type DisplayText =\s*\|\s*string\s*\|\s*\{ key: string;/.test(
          await readRel("../../core/plugins/providers.ts"),
        ),
        "DisplayText 확인",
      ),
    );
  }

  // ── 검사 자신의 눈 ──────────────────────────────────────────────────────────
  //  정상일 때 위 단언들은 전부 0건이라, 수집이 통째로 죽어도 초록이다. 합성 입력으로
  //  스캐너가 실제로 무언가를 잡는지 본다([[feedback_gate_must_actually_run]]).
  {
    const sample = [
      'const a = "화면에 보이는 한국어";',
      'console.warn("로그다 — 이건 범위 밖(" + x + ") 무시");',
      'const c = i18n("nav.chat");',
      "// 주석의 한국어는 코드가 아니다",
    ].join("\n");
    const strings = scanJsStrings(sample);
    const masked = maskJsStrings(sample, strings);
    const found = strings.filter(
      (s) =>
        HANGUL.test(s.value) &&
        !/\bi18n\(\s*$/.test(sample.slice(Math.max(0, s.start - 12), s.start)) &&
        !insideConsoleCall(masked, s.start),
    );
    out.push(
      assert(
        "★스캐너가 화면 한국어만 정확히 잡는다(합성 입력: 화면 1 · 로그 2 · 키 0 · 주석 0)",
        found.length === 1 && found[0]!.value === "화면에 보이는 한국어",
        `잡은 것=${JSON.stringify(found.map((s) => s.value))}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "i18n-catalogs-and-coverage",
  guards:
    "번역이 조용히 깨지던 것 — 문구를 고치면 다른 언어 카탈로그가 고아가 되고, 자리표시자가 빠지면 값이 사라진 문장이 되고, 새 문구를 카탈로그에 안 넣으면 한국어가 샌다. 셋 다 `ko` 에선 멀쩡해서 개발 기계에선 안 보인다",
  run,
};
export default check;
