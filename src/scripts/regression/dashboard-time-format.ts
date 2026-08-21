/**
 * 회귀: **시간 표기 정본이 하나이고, 실제로 그 값을 낸다** (2026-08-21).
 *
 * 배경: 상대시간("3분 전")은 대시보드에 **아예 없었다** — grep 히트는 전부 주석이었고,
 * 하마터면 "이미 있으니 재사용" 으로 넘어갈 뻔했다. 경과시간(`fmtElapsed`)은 반대로
 * `background-drawer.js` 안에 **갇혀** 있어 다른 카드가 못 썼고, 그래서 상대시간을 붙이면서
 * 두 번째 사본이 생길 뻔했다.
 *
 * ★**이 검사는 소스 린트가 아니다.** 두 함수가 DOM 을 안 만지는 순수 함수라 잘라내
 *  **실행**한다. 이 레포의 상수다 — 검사가 껄끄러우면 코드가 잘못 놓인 것이고, 반대로
 *  제대로 놓였으면 실행해서 지킬 수 있다.
 *
 * 지키는 것 둘:
 *  ①경계값이 맞는가 — 59초는 "방금", 60초는 "1분 전"(끝을 흐리면 사용자가 못 믿는다)
 *  ②정본이 **하나**인가 — 사본이 생기면 파일마다 "3분 전" 기준이 갈린다
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JS_DIR = path.join(REPO, "packages/dashboard/js");

/** `const <name> = (` 부터 짝 맞는 `};` 까지 잘라낸다(중괄호 깊이 계수). */
const sliceFn = (src: string, name: string): string | null => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      depth++;
      seen = true;
    } else if (c === "}") {
      depth--;
      if (seen && depth === 0) return src.slice(start, i + 1) + ";";
    }
  }
  return null;
};

export const check: RegressionCheck = {
  name: "dashboard-time-format",
  guards:
    "시간 표기가 카드마다 제 사본을 갖고 기준이 갈리던 것 + 경계값(방금↔1분 전)이 흐려지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const util = readFileSync(path.join(JS_DIR, "util.js"), "utf8");

    const agoSrc = sliceFn(util, "fmtAgo");
    const elapsedSrc = sliceFn(util, "fmtElapsed");
    out.push(
      assert(
        "★시간 포매터 정본이 util.js 에 있다(카드 파일이 아니라)",
        agoSrc !== null && elapsedSrc !== null,
        `fmtAgo=${agoSrc !== null} fmtElapsed=${elapsedSrc !== null}`,
      ),
    );
    if (agoSrc === null || elapsedSrc === null) return out;

    // ★실행한다 — 문자열 존재가 아니라 **값**을 본다.
    const { fmtAgo, fmtElapsed } = new Function(
      `${agoSrc}${elapsedSrc}return { fmtAgo, fmtElapsed };`,
    )() as { fmtAgo: (ts: number) => string; fmtElapsed: (ms: number) => string };

    const now = Date.now();
    const ago = (secAgo: number): string => fmtAgo(now - secAgo * 1000);
    const agoCases: Array<[number, string]> = [
      [0, "방금"],
      [59, "방금"],
      [60, "1분 전"],
      [3599, "59분 전"],
      [3600, "1시간 전"],
      [86_399, "23시간 전"],
      [86_400, "1일 전"],
      [86_400 * 29, "29일 전"],
      [86_400 * 30, "1개월 전"],
      [86_400 * 330, "11개월 전"],
      [86_400 * 365, "1년 전"], // 30일=1개월 근사라 12개월째가 곧 1년이다.
    ];
    const agoBad = agoCases.filter(([s, want]) => ago(s) !== want);
    out.push(
      assert(
        "★상대시간 경계가 맞다(59초=방금 · 60초=1분 전 · 24시간=1일 전 …)",
        agoBad.length === 0,
        agoBad.length === 0
          ? `${agoCases.length}개 경계 전부 OK`
          : `★어긋남: ${agoBad.map(([s, w]) => `${s}s→"${ago(s)}"(기대 "${w}")`).join(", ")}`,
      ),
    );

    // 미래 시각·쓰레기값은 사용자에게 떠넘기지 않는다.
    out.push(
      assert(
        "★미래 시각은 '방금'으로 접는다(시계 어긋남에 '-3분 전'을 보여주지 않는다)",
        fmtAgo(now + 60_000) === "방금" &&
          fmtAgo(0) === "" &&
          fmtAgo(Number.NaN) === "",
        `future="${fmtAgo(now + 60_000)}" zero="${fmtAgo(0)}" nan="${fmtAgo(Number.NaN)}"`,
      ),
    );

    const elapsedCases: Array<[number, string]> = [
      [0, "0s"],
      [59_000, "59s"],
      [60_000, "1m 0s"],
      [3_599_000, "59m 59s"],
      [3_600_000, "1h 0m"],
      [-5_000, "0s"], // 음수는 0 으로 바닥
    ];
    const elBad = elapsedCases.filter(([ms, want]) => fmtElapsed(ms) !== want);
    out.push(
      assert(
        "★경과시간 경계가 맞다(60s=1m 0s · 1h=1h 0m · 음수=0s)",
        elBad.length === 0,
        elBad.length === 0
          ? `${elapsedCases.length}개 경계 전부 OK`
          : `★어긋남: ${elBad.map(([m, w]) => `${m}ms→"${fmtElapsed(m)}"(기대 "${w}")`).join(", ")}`,
      ),
    );

    // ★② 정본이 하나인가 — 사본이 생기면 "3분 전" 기준이 파일마다 갈린다.
    //  주석은 세지 않는다(결함을 *설명한* 글을 코드로 세면 상시 실패한다).
    const dupes: string[] = [];
    for (const f of readdirSync(JS_DIR)) {
      if (!f.endsWith(".js") || f === "util.js") continue;
      const src = readFileSync(path.join(JS_DIR, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const name of ["fmtAgo", "fmtElapsed"]) {
        if (src.includes(`const ${name} = (`)) dupes.push(`${f}:${name}`);
      }
    }
    out.push(
      assert(
        "★시간 포매터 사본이 없다 — 정본은 util.js 한 곳",
        dupes.length === 0,
        dupes.length === 0 ? "사본 0" : `★사본: ${dupes.join(", ")}`,
      ),
    );
    return out;
  },
};
