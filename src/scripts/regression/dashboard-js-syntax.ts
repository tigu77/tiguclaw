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
    //  ★이 판정은 `src/scripts/verify-dashboard-js.mjs` 에 **이미 정확하게** 있었다. 문제는
    //   **아무도 안 부른다는 것**이었다 — package.json 정의 1곳뿐이고 CI·배포 어디서도 안
    //   돈다(전수 조사 확인). `feedback_gate_must_actually_run` 과 같은 형상인데 이번엔
    //   오탐이 아니라 **호출부 부재**다. 그 스크립트는 `verify-` 접두라 public 싱크에서
    //   제외되므로 회귀가 부를 수 없다 — 그래서 **판정을 자동으로 도는 자리로 옮긴다.**
    const manifest = JSON.parse(
      await readFile(new URL("_manifest.json", dir), "utf8"),
    ) as string[];
    // 최상위 선언 = 들여쓰기 6칸(이 레포 대시보드 js 관습). 함수 안은 더 깊다.
    const TOP_DECL = /^ {6}(?:const|let|class)\s+([A-Za-z_$][\w$]*)/;
    /**
     * ★**IIFE 로 감싼 모듈은 전역을 안 만든다** — 검사 대상이 아니다 (2026-08-23).
     *
     *  들여쓰기 6칸을 최상위로 보는 건 이 레포 관습에 기댄 어림이다. 그 관습을 안 따르는
     *  파일(예: 2칸 들여쓰기 + 전체 IIFE)에서는 **함수 안 지역변수가 6칸에 걸려** 충돌로
     *  오인된다 — 실제로 `chat-search.js` 의 `const r`·`const data` 가 그렇게 잡혔다.
     *  그 파일은 전역을 하나도 안 만들므로 위험이 0인데 빨간불이 났다.
     *  ★오탐은 게이트를 죽인다(`feedback_gate_must_actually_run` — 상시 FAIL 이면 아무도
     *   안 본다). 위험이 없는 형태는 대상에서 뺀다.
     */
    const isIifeWrapped = (src: string): boolean =>
      /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*\((?:\(\)|function)/.test(src) &&
      /\}\)\(\);?\s*$/.test(src.trimEnd());
    const owner = new Map<string, string>();
    const dupes: string[] = [];
    let skipped = 0;
    for (const f of manifest) {
      const src = await readFile(new URL(f, dir), "utf8");
      if (isIifeWrapped(src)) { skipped += 1; continue; }
      for (const line of src.split("\n")) {
        const m = TOP_DECL.exec(line);
        if (m === null) continue;
        const name = m[1] ?? "";
        const first = owner.get(name);
        if (first !== undefined) dupes.push(`${name}: ${first} ↔ ${f}`);
        else owner.set(name, f);
      }
    }
    out.push(
      assert(
        `★파일 간 최상위 이름 충돌 0(뒤 파일이 통째로 죽는다 · ${manifest.length}개 대조)`,
        dupes.length === 0,
        dupes.length === 0
          ? `최상위 이름 ${owner.size}개 전부 유일(IIFE 모듈 ${skipped}개는 전역 0이라 제외)`
          : `★충돌: ${dupes.join(" · ")}`,
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

    return out;
  },
};
