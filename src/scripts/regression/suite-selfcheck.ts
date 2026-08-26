/**
 * 회귀: **스위트 자신을 본다** — 통째로 사라지지 않았나 · 증거가 관측을 보여주나 (2026-08-26).
 *
 * 적대 검토 G축 ② 의 둘을 한 자리에서 닫는다. 둘 다 *"검사가 있다"* 와 *"검사가 판별한다"*
 * 의 차이에 관한 것이다.
 *
 * **① 총건수 하한이 없었다.** `run.ts` 는 `checks.length === 0` 만 본다 — 파일이 하나라도
 * 있으면 통과다. 그래서 단언이 **절반으로 줄어도** 스위트는 초록으로 "통과 — N건" 을 찍고,
 * 그 N 을 아무도 안 본다. 실제로 이 레포에서 같은 기제가 두 번 있었다(대조할 언어가 0이면
 * 단언이 **생성 자체가 안 돼** 52→50 으로 조용히 줄었다).
 *
 * **② 실패해도 관측값이 안 찍히는 단언.** `assert(name, cond, "true 여야")` 처럼 증거란에
 * **기대값**을 적으면, 빨간불을 봐도 *무엇이 관측됐는지* 알 수 없다. 로그가 1차 진단면인
 * 우리 배치에선(원격 불가한 설치본이 있다) 이게 곧 진단 불가다
 * ([[feedback_logs_must_stand_alone]]).
 *
 * ★**전수 수정 대신 상한을 둔다.** 150건이 50개 파일에 흩어져 있어 일괄 수정은 값 대비
 *  위험이 크다. 대신 **늘어나면 빨간불**로 막고, 고칠 때마다 이 숫자를 내린다.
 *  ★이건 손 목록이 아니라 **숫자 하나**다 — 이름을 열거하면 그 목록이 드리프트하지만,
 *  숫자는 갈릴 수가 없다. 그리고 어느 파일이 나쁜지는 검사가 **매번 세어서 알려준다**.
 *
 * ★조건이 리터럴 `true` 인 것은 센 대상이 아니다 — *"확인 못 함"* 같은 **일부러 통과시키는
 *  표식**이고, 그건 이 레포가 권장하는 형태다(조용한 통과보다 낫다).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanJsStrings, maskJsStrings } from "./_js-strings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 단언 총수의 **하한**. 성장 추적용이 아니라 **붕괴 감지용**이라 넉넉히 아래로 잡는다 —
 * 매번 올리면 그 자체가 유지비이고, 잡으려는 건 "스위트가 반토막 났다" 이지 "3건 줄었다" 가
 * 아니다. (2026-08-26 실측 1,600여 건.)
 */
const MIN_ASSERTIONS = 1_200;

/**
 * 증거가 고정 문자열인 단언의 **상한**. 고칠 때마다 내린다(늘리지 마라).
 *
 * ★첫 측정은 147 이었는데 주석을 가리자 **150** 이 됐다 — 코드가 나빠진 게 아니라 **스캐너가
 *  정확해진 것**이다(인자 사이 주석 때문에 셋을 놓치고 있었다). 숫자를 남길 땐 그게 *무엇을
 *  잰 값인지*도 같이 남겨야 다음 사람이 "늘었네" 로 오해하지 않는다.
 */
const MAX_EVIDENCE_FREE = 150;

interface Found {
  file: string;
  cond: string;
  got: string;
}

/**
 * 주석을 **공백으로 덮는다**(길이 보존 — 오프셋이 원본과 같아야 잘라 쓸 수 있다).
 *
 * ★없으면 검사가 **자기 설명글을 코드로 센다.** 이 파일이 정확히 그랬다 — 헤더에 적은
 *  예시 `assert(name, cond, "true 여야")` 를 위반 1건으로 세어 상한을 넘겼다. 오늘 같은
 *  부류(검사 대상은 규칙이지 그걸 설명하는 글이 아니다)로 **세 번째**다.
 */
const blankComments = (src: string, masked: string): string => {
  const buf = src.split("");
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "/" && masked[i + 1] === "/") {
      while (i < masked.length && masked[i] !== "\n") buf[i++] = " ";
    } else if (masked[i] === "/" && masked[i + 1] === "*") {
      while (i < masked.length && !(masked[i] === "*" && masked[i + 1] === "/")) {
        if (buf[i] !== "\n") buf[i] = " ";
        i++;
      }
      buf[i] = " ";
      if (i + 1 < buf.length) buf[i + 1] = " ";
      i++;
    }
  }
  return buf.join("");
};

/** `assert(name, cond, got)` 셋을 최상위 콤마로 갈라 읽는다(문자열·주석은 가린다). */
export const scanAsserts = (src: string): Array<{ cond: string; got: string }> => {
  const out: Array<{ cond: string; got: string }> = [];
  const maskedStrings = maskJsStrings(src, scanJsStrings(src));
  const masked = blankComments(maskedStrings, maskedStrings);
  for (let i = masked.indexOf("assert("); i >= 0; i = masked.indexOf("assert(", i + 1)) {
    let depth = 0;
    let close = -1;
    for (let q = i + 6; q < masked.length; q++) {
      const c = masked[q];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          close = q;
          break;
        }
      }
    }
    if (close < 0) continue;
    const codeOnly = blankComments(src, maskedStrings);
    const body = codeOnly.slice(i + 7, close);
    const mb = masked.slice(i + 7, close);
    const cuts: number[] = [];
    let d = 0;
    for (let q = 0; q < mb.length; q++) {
      const c = mb[q] as string;
      if ("([{".includes(c)) d += 1;
      else if (")]}".includes(c)) d -= 1;
      else if (c === "," && d === 0) cuts.push(q);
    }
    if (cuts.length < 2) continue;
    out.push({
      cond: body.slice((cuts[0] as number) + 1, cuts[1] as number).trim(),
      got: body
        .slice((cuts[1] as number) + 1)
        .trim()
        .replace(/,\s*$/, ""),
    });
  }
  return out;
};

/** 보간이 없는 순수 문자열 리터럴 = 관측값이 실릴 수 없는 증거. */
const isStaticLiteral = (got: string): boolean =>
  /^(["'])(?:[^\\]|\\.)*?\1$/.test(got);

export const check: RegressionCheck = {
  name: "suite-selfcheck",
  guards:
    "run.ts 가 checks.length === 0 만 봐서 단언이 절반으로 줄어도 '통과 — N건' 으로 초록이던 것 + 증거란에 기대값(\"true 여야\")을 적어 빨간불을 봐도 무엇이 관측됐는지 알 수 없던 것",
  run: async (): Promise<Assertion[]> => {
    const files = readdirSync(DIR).filter(
      (f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "run.ts",
    );
    let total = 0;
    const evidenceFree: Found[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(DIR, f), "utf8");
      for (const a of scanAsserts(src)) {
        total += 1;
        // 리터럴 `true` = 일부러 통과시키는 표식(스킵·"확인 못 함") — 대상 아님.
        if (a.cond !== "true" && isStaticLiteral(a.got)) {
          evidenceFree.push({ file: f, cond: a.cond.slice(0, 40), got: a.got.slice(0, 40) });
        }
      }
    }

    const worst = [...new Map<string, number>(
      files.map((f) => [f, evidenceFree.filter((e) => e.file === f).length]),
    )]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([f, n]) => `${f}(${n})`)
      .join(", ");

    return [
      assert(
        "★스캐너가 실제로 걷었다(0이면 아래 둘은 미검사다)",
        files.length > 20 && total > 500,
        `검사 파일 ${files.length}개 · assert ${total}건`,
      ),
      assert(
        `★단언 총수가 하한을 넘는다(스위트가 통째로 줄어도 '통과' 로 보이던 것)`,
        total >= MIN_ASSERTIONS,
        `${total}건 / 하한 ${MIN_ASSERTIONS} — 밑돌면 검사가 사라진 것이지 통과가 아니다`,
      ),
      assert(
        "★증거가 기대값뿐인 단언이 늘지 않았다(빨간불을 봐도 관측을 모른다)",
        evidenceFree.length <= MAX_EVIDENCE_FREE,
        `${evidenceFree.length}건 / 상한 ${MAX_EVIDENCE_FREE}` +
          (worst === "" ? "" : ` · 많은 곳: ${worst}`) +
          " — 고칠 때마다 상한을 내려라",
      ),
    ];
  },
};
