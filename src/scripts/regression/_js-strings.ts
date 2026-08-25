/**
 * 대시보드 js 에서 **문자열 리터럴만** 정확히 걷는다(주석·정규식 회피).
 *
 * ★정규식으로 주석을 자르면 문자열 안의 `//` 나 주석 안의 따옴표에서 어긋난다. 실제로
 *  `i18n-keys-complete` 가 주석 속 예시를 키로 세어 오탐했고, 조사 스크립트는 문구 안의
 *  괄호(`… action(`)에 속아 콘솔 로그를 화면 문구로 오분류했다. 판정이 소스를 읽는
 *  자리에선 작은 토크나이저가 정규식보다 싸다.
 *
 * ★이스케이프는 **소스 표기 그대로** 둔다(`\n` 은 두 글자). 카탈로그와 소스 어느 쪽을
 *  기준으로 보든 같은 문자열을 보게 하려는 것이고, 둘이 갈리면 그 자체가 결함이다.
 */
export interface JsString {
  readonly line: number;
  readonly quote: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly hasExpr: boolean;
}

export const scanJsStrings = (src: string): JsString[] => {
  const out: JsString[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  let prev = "";
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    // 정규식 리터럴 — 나눗셈과 구분(직전 유의미 문자로 근사).
    if (c === "/" && !"])}".includes(prev) && !/[\w$]/.test(prev)) {
      let j = i + 1;
      let cls = false;
      let ok = false;
      while (j < n) {
        const d = src[j]!;
        if (d === "\n") break;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) {
          ok = true;
          break;
        }
        j += 1;
      }
      if (ok) {
        i = j + 1;
        prev = "/";
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const startLine = line;
      const start = i;
      let j = i + 1;
      let val = "";
      let hasExpr = false;
      while (j < n) {
        const d = src[j]!;
        if (d === "\\") {
          val += d + (src[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (c === "`" && d === "$" && src[j + 1] === "{") {
          hasExpr = true;
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === "{") depth += 1;
            else if (src[j] === "}") depth -= 1;
            else if (src[j] === "\n") line += 1;
            j += 1;
          }
          val += "${}";
          continue;
        }
        if (d === c) break;
        if (d === "\n") {
          if (c !== "`") break;
          line += 1;
        }
        val += d;
        j += 1;
      }
      out.push({ line: startLine, quote: c, value: val, start, end: j + 1, hasExpr });
      i = j + 1;
      prev = c;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
};

/** 문자열 **내부만** 공백으로 가린 사본 — 괄호 균형 같은 구문 판정에 쓴다. */
export const maskJsStrings = (src: string, strings: readonly JsString[]): string => {
  const buf = src.split("");
  for (const s of strings) {
    for (let i = s.start + 1; i < s.end - 1 && i < buf.length; i += 1) {
      if (buf[i] !== "\n") buf[i] = " ";
    }
  }
  return buf.join("");
};
