/**
 * 회귀: **대시보드 js 가 파싱된다** (2026-08-08).
 *
 * `packages/dashboard/js/*.js` 는 **typecheck 밖**이다(tsconfig include 는 `src/**`). 브라우저가
 * 런타임에 로드하므로 구문 오류가 **모든 게이트를 통과해 배포되고**, 화면엔 "그냥 안 그려짐"
 * 으로만 보인다 — 콘솔을 열어야 알 수 있다.
 *
 * ★실제로 그렇게 냈다. 로드 순서 가드를 정규식으로 자동 치환하다 괄호 중첩을 잘못 잘라
 * `Uncaught SyntaxError: missing ) after argument list` 를 **라이브 대시보드에 배포**했고,
 * 회귀 598건은 전부 초록이었다(그 검사는 `typeof` 문자열만 봤다). 사용자가 콘솔을 보고
 * 알려줘서 알았다.
 *
 * 이 레포는 같은 병을 이미 앓았다 — `plugins/` 가 typecheck 밖이라 구문 오류가 부팅 때만
 * 드러났고(v0.3.1 사고) `verify:plugins` 로 닫았다. 대시보드 js 는 **그 게이트가 없는 쪽**이다.
 *
 * ★등급: **행동 게이트**. 소스를 훑는 게 아니라 실제 파서(`new Function`)에 넣는다.
 */
import { readdir, readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "dashboard-js-syntax",
  guards:
    "대시보드 js 구문 — typecheck 밖이라 깨진 채 배포되고 화면엔 '안 그려짐' 으로만 보인다",
  run: async (): Promise<Assertion[]> => {
    const dir = new URL("../../../packages/dashboard/js/", import.meta.url);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".js"));
    } catch {
      return [assert("대시보드 js 디렉터리 없음(배포 레포 아님)", true, "건너뜀")];
    }

    const broken: string[] = [];
    for (const f of files) {
      const src = await readFile(new URL(f, dir), "utf8");
      try {
        // 실행하지 않고 **파싱만** 한다. 구문 오류면 여기서 throw.
        new Function(src);
      } catch (e) {
        broken.push(`${f}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
      }
    }

    return [
      assert(
        "js 파일을 실제로 읽었다(빈손으로 통과하지 않게)",
        files.length >= 10,
        `${files.length}개`,
      ),
      assert(
        "★전부 파싱된다 — 구문 오류가 배포되면 화면이 통째로 안 그려진다",
        broken.length === 0,
        broken.length === 0 ? `${files.length}개 정상` : broken.join(" · "),
      ),
    ];
  },
};
