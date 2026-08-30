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
 * ★등급: **행동 게이트**. 소스를 훑는 게 아니라 실제 파서에 넣는다.
 *
 * ★**파서를 바꿨다** (2026-08-17, 전체검토 C-1). 종전엔 `new Function(src)` 였는데 그건
 *  소스를 **함수 본문**으로 파싱한다 — 그래서 **최상위 `return`** 이 합법이 된다. 함수 밖으로
 *  코드를 옮기다 남기는 가장 흔한 형태인데, 그 한 줄로 파일 전체가 브라우저에서 죽는데도
 *  8단언이 전부 초록이었다(실측: `new Function` 통과 / `vm.Script`·`node --check`·브라우저는
 *  `Illegal return statement`). 검사가 "실제 파서에 넣는다" 고 적어놨지만 **넣은 파서가
 *  브라우저와 다른 문맥**이었다. 이제 `vm.Script`(스크립트 문맥 = 브라우저와 같은 규칙)로 본다.
 */
import vm from "node:vm";
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
        new vm.Script(src, { filename: f });
      } catch (e) {
        broken.push(`${f}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
      }
    }

    const out: Assertion[] = [
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

    // ── ★**파일 간 최상위 이름 충돌** — 뒤에 로드되는 파일이 통째로 죽는다 ────────
    //  (2026-08-17, 전체검토 C-2) 대시보드 js 는 모듈이 아니라 **스크립트 33개**를 순서대로
    //  로드한다 → 같은 최상위 `const/let/class` 이름이 두 파일에 있으면 뒤 파일이
    //  `Identifier 'X' has already been declared` 로 **통째로** 죽는다. 위 ①의 파일 단위
    //  파싱으로는 원리적으로 안 보인다.
    //
    //  ★이 판정은 `src/scripts/verify-dashboard-js.mjs` 에 **이미 정확하게** 있었다 —
    //   이어붙여 한 번에 파싱하는 것(브라우저 전역 스코프와 같은 조건). 문제는 **아무도 안
    //   부른다는 것**이었다(package.json 정의 1곳뿐, CI·배포 어디서도 안 돌았다).
    //
    // ★**옮길 때 파서가 아니라 짐작을 옮겼다** (2026-08-31, 적대 검토 F5). 여기 온 것은
    //  들여쓰기 6칸 정규식이었고, 그게 함수 안 지역변수를 최상위로 세는 바람에 IIFE 예외를
    //  덧대야 했다 — **어림을 옮기고 어림의 구멍을 덧댄 것**이다. 실측으로 두 갈래가 뚫렸다:
    //    (a) `channel-hints.js` 끝에 **4칸** 들여쓰기로 `const CATEGORIES` → 스위트 초록.
    //        이 레포엔 포매터·린터가 **없어서** 6칸을 강제하는 게 아무것도 없다 — 새 파일을
    //        2칸/4칸으로 쓰면 그 파일 전체가 사각이 된다.
    //    (b) IIFE 앵커(`(function(){ … })();`)를 유지한 채 진짜 전역을 하나 만들면 파일이
    //        통째로 제외된다.
    //  둘 다 브라우저에선 뒤 파일이 `SyntaxError` 로 죽고, 증상은 콘솔의 `X is not defined`
    //  하나뿐이다 — 이 검사가 처음 생긴 원인("showEndpoints is not defined")과 같은 그림이다.
    //
    // ★그래서 **파서로 판정한다.** 들여쓰기는 최상위의 근사일 뿐인데 파서는 그걸 정확히
    //  안다. 근사가 없으니 IIFE 예외도 필요 없다 — IIFE 안은 애초에 전역이 아니라서 파서가
    //  충돌로 세지 않는다. 이름은 실패했을 때만, **역시 파싱으로** 찾는다(누적 파싱 → 처음
    //  깨지는 파일 / `let <이름>;` 탐침 → 먼저 선언한 파일). 메시지를 위해 짐작을 되살리지
    //  않는다.
    const manifest = JSON.parse(
      await readFile(new URL("_manifest.json", dir), "utf8"),
    ) as string[];
    const sources: Array<{ file: string; src: string }> = [];
    for (const f of manifest) {
      sources.push({ file: f, src: await readFile(new URL(f, dir), "utf8") });
    }
    const join = (upTo: number): string =>
      sources
        .slice(0, upTo)
        .map(({ file, src }) => `\n// ==== ${file} ====\n${src}`)
        .join("");
    const parseCombined = (code: string): string | null => {
      try {
        new vm.Script(code, { filename: "dashboard-combined.js" });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const combinedError = parseCombined(join(sources.length));
    let where = "";
    if (combinedError !== null) {
      const culprit = sources.findIndex((_, i) => parseCombined(join(i + 1)) !== null);
      const dup = /Identifier '([^']+)' has already been declared/.exec(combinedError);
      if (dup !== null && culprit >= 0) {
        const name = dup[1] ?? "";
        const first = sources
          .slice(0, culprit)
          .find(({ src }) => parseCombined(`${src}\nlet ${name};`) !== null);
        where = ` · '${name}' 먼저 선언 ${first?.file ?? "(못 찾음)"} ↔ ${sources[culprit]?.file ?? "?"}`;
      } else if (culprit >= 0) {
        where = ` · 깨지는 파일 ${sources[culprit]?.file ?? "?"}`;
      }
    }
    out.push(
      assert(
        `★파일 간 최상위 **렉시컬** 충돌 0(뒤 파일이 통째로 죽는다 · ${manifest.length}개를 이어붙여 파싱)`,
        combinedError === null,
        // ★문구가 판정보다 넓으면 안 된다 (적대 검토 F7). 파서가 잡는 건 `const`·`let`·
        //  `class` 이고, 최상위 `function`·`var` 중복은 **에러가 아니라 조용한 덮어쓰기**다.
        //  종전 문구("중복 최상위 선언 0")는 안 보는 것까지 봤다고 말했다.
        combinedError === null
          ? `${String(manifest.length)}개 통합 파싱 OK — const·let·class 기준(function·var 중복은 파서가 안 잡는다)`
          : `★${combinedError}${where}`,
      ),
    );

    // ★로드 순서의 **정본이 둘**이면 검사와 브라우저가 다른 순서를 본다 (C-L5).
    //  매니페스트(검사·번들러가 쓰는 것)와 index.html(브라우저가 쓰는 것)이 같아야 한다.
    const html = await readFile(new URL("../index.html", dir), "utf8");
    const tags = [...html.matchAll(/script src="\/js\/([^"]+)"/g)].map((m) => m[1] ?? "");
    const sameOrder = JSON.stringify(manifest) === JSON.stringify(tags);
    out.push(
      assert(
        "★매니페스트와 index.html 의 로드 순서가 같다(정본이 둘이면 갈린다)",
        sameOrder,
        sameOrder
          ? `${manifest.length}개 순서 일치`
          : `★불일치 — 매니페스트 ${manifest.length}개 / 태그 ${tags.length}개`,
      ),
    );

    // ★디스크 == 매니페스트 (2026-08-25 적대 검토 F5). 이 판정은 종전에
    //  `scripts/verify-dashboard-split.mjs` **에만** 있었는데, 그 스크립트는 호출부가 0이고
    //  게다가 상시 FAIL 상태로 다시 돌아가 있었다 — `feedback_gate_must_actually_run` 이
    //  기록한 사고(고아 js 파일 몇 주 생존)와 **같은 기제로 같은 판정을 두 번 잃었다.**
    //  그래서 자동으로 도는 자리(이 스위트)로 옮긴다. 손으로 부르는 게이트는 안 돈다.
    const onDisk = (await readdir(dir))
      .filter((f) => f.endsWith(".js"))
      .sort();
    const inManifest = [...manifest].sort();
    const orphans = onDisk.filter((f) => !inManifest.includes(f));
    const missing = inManifest.filter((f) => !onDisk.includes(f));
    out.push(
      assert(
        "★js/ 의 파일 집합 == 매니페스트(고아 파일은 죽은 코드고, 빠진 파일은 404 다)",
        orphans.length === 0 && missing.length === 0,
        orphans.length === 0 && missing.length === 0
          ? `${onDisk.length}개 일치`
          : `★고아 ${orphans.join(" ")} · 누락 ${missing.join(" ")}`,
      ),
    );

    return out;
  },
};
