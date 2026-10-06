/**
 * 회귀 보조: **서버 문구는 이제 카탈로그에 있다** (2026-10-06 서버 문구 키화).
 *
 * 종전엔 «사용자에게 이 말을 하나» 를 소스의 영어 리터럴로 grep 했다. 문구가 `translate("srv.…")` 로 옮겨가면서 소스엔 키만 남는다.
 * `withSrvText(src)` 는 소스가 **실제로 부르는** `srv.` 키의 영어 값을 소스 뒤에 붙여 준다 — 그래서 검사는 여전히
 * «그 파일이 이 문장을 내보낸다» 를 본다(키를 안 부르면 문장도 안 붙는다). 자리표시자는 `{name}` 꼴로 남는다.
 */
import { readFileSync } from "node:fs";

let cache: Record<string, string> | undefined;
export const enCatalog = (): Record<string, string> =>
  (cache ??= JSON.parse(readFileSync(new URL("../../../locales/en.json", import.meta.url), "utf8")) as Record<string, string>);

/** 소스 + 그 소스가 문자열로 언급하는 srv 키들의 영어 값(키당 한 줄, `/*srv:키*\/ 값`). */
export const withSrvText = (src: string): string => {
  const en = enCatalog();
  const keys = [...new Set([...src.matchAll(/["'`](srv\.[\w.]+)["'`]/g)].map((m) => m[1]!))];
  return `${src}\n${keys.map((k) => `/*srv:${k}*/ ${en[k] ?? ""}`).join("\n")}`;
};

/** 이 키의 영어 값(없으면 빈 문자열). */
export const srvEn = (key: string): string => enCatalog()[key] ?? "";
