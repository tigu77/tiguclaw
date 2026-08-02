/**
 * 회귀: **도구 카드 diff 에 실제 파일 줄 번호가 붙는다** (2026-08-01 신규 기능).
 *
 * Claude Code 는 편집 카드에 줄 번호가 나오는데 대시보드는 안 나오던 갭(원칙 1: 슈퍼셋).
 *
 * ★번호는 **표시용**이라 틀려도 조용하다 — 그래서 검사가 필요하다. 틀린 번호는 번호가
 *  없는 것보다 나쁘다(클릭해 가 보면 딴 줄이다). 이 검사가 지키는 것은 세 가지다:
 *   ①맞을 때 맞는가 ②**못 구할 때 지어내지 않는가**(파일 없음·상한 초과) ③삭제된 줄에
 *   결과 파일 번호를 붙이지 않는가.
 *
 * ★상한이 이 기능의 핵심 위험이다. 위치 계산은 파일을 읽는다 — 실측 15KB 0.07ms ·
 *  131KB 0.64ms · **4MB 18.9ms**. 상한이 없으면 표시용 편의 기능이 상시 데몬을 멎게 한다
 *  (오늘 고친 jsonl 전량 재읽기와 같은 병). 그래서 상한 초과 시 **번호를 포기**하는지 본다.
 *
 * ★계산은 **한 곳**이다: 데이터(어느 줄에서 시작하나)는 `_activity-diff.ts` 가 세 어댑터
 *  몫으로 한 번, 표시(각 줄 번호)는 `virtualization.js` 의 `buildDiffBlock` 이 세 화면
 *  (채팅·이력·드로어) 몫으로 한 번. 어댑터·화면마다 계산하면 어긋난다.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "diff-line-numbers",
  guards:
    "편집 카드 줄 번호 — 맞는 번호·못 구하면 생략(지어내지 않음)·큰 파일 상한·삭제 줄에 번호 안 붙임",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { buildActivityDiff, lineOfMatch } = await import(
      "../../core/llm-runtime/adapters/_activity-diff.js"
    );

    // ★① 순수 계산 — 몇 번째 줄인가. 1-based, 첫 줄이 1.
    const doc = "가\n나\n다\n라\n";
    const pure: Array<[string, unknown, unknown]> = [
      ["첫 줄은 1", 1, lineOfMatch(doc, "가")],
      ["셋째 줄은 3", 3, lineOfMatch(doc, "다")],
      ["여러 줄 needle 은 시작 줄", 2, lineOfMatch(doc, "나\n다")],
      ["없으면 null", null, lineOfMatch(doc, "없는것")],
      ["빈 needle 은 null(0번째 줄을 만들지 않는다)", null, lineOfMatch(doc, "")],
    ];
    const badPure = pure.filter(([, want, got]) => want !== got);
    out.push(
      assert(
        `★줄 위치 계산 ${pure.length}종이 옳다`,
        badPure.length === 0,
        badPure.length === 0
          ? `${pure.length}종 정확`
          : badPure.map(([d, w, g]) => `${d}: 기대 ${String(w)} 실제 ${String(g)}`).join(" / "),
      ),
    );

    const dir = mkdtempSync(path.join(tmpdir(), "tgc-diffline-"));
    try {
      // ★② 실제 편집 — 파일을 읽어 시작 줄을 붙인다.
      const f = path.join(dir, "sample.ts");
      writeFileSync(f, "l1\nl2\nl3\nTARGET\nl5\n", "utf8");
      const d = buildActivityDiff("Edit", {
        file_path: f,
        old_string: "TARGET",
        new_string: "REPLACED",
      });
      out.push(
        assert(
          "★Edit 의 시작 줄이 실제 위치와 같다(4번째 줄)",
          d?.startLine === 4,
          `startLine=${String(d?.startLine)}`,
        ),
      );

      // ★③ 못 구하는 경우 — **지어내지 않는다**. 여기가 이 기능의 안전핀이다.
      const gone = buildActivityDiff("Edit", {
        file_path: path.join(dir, "없는파일.ts"),
        old_string: "TARGET",
        new_string: "X",
      });
      out.push(
        assert(
          "★파일이 없으면 줄 번호를 생략한다(diff 자체는 그대로 나온다)",
          gone !== undefined && gone.startLine === undefined,
          `diff=${gone === undefined ? "없음(★diff 까지 사라지면 안 된다)" : "있음"} startLine=${String(gone?.startLine)}`,
        ),
      );
      const nomatch = buildActivityDiff("Edit", {
        file_path: f,
        old_string: "파일에 없는 문자열",
        new_string: "X",
      });
      out.push(
        assert(
          "이미 편집된 뒤라 old_string 이 없으면 생략한다(틀린 번호 0)",
          nomatch?.startLine === undefined,
          `startLine=${String(nomatch?.startLine)}`,
        ),
      );

      // ★④ 크기 상한 — 표시용 기능이 데몬을 멎게 하지 않는다.
      //  상한 바로 아래는 되고, 위는 포기해야 한다. 둘 다 안 보면 상한이 있으나 마나다.
      const big = path.join(dir, "big.txt");
      writeFileSync(big, `${"x".repeat(3 * 1024 * 1024)}\nTARGET\n`, "utf8"); // 3MB > 상한 2MB
      const t0 = Date.now();
      const bigD = buildActivityDiff("Edit", {
        file_path: big,
        old_string: "TARGET",
        new_string: "X",
      });
      const elapsed = Date.now() - t0;
      out.push(
        assert(
          "★상한(2MB) 넘는 파일은 번호를 포기한다 — 읽지 않는다",
          bigD !== undefined && bigD.startLine === undefined,
          `3MB → startLine=${String(bigD?.startLine)} (${elapsed}ms)`,
        ),
      );
      const okSize = path.join(dir, "ok.txt");
      writeFileSync(okSize, `${"y\n".repeat(200_000)}TARGET\n`, "utf8"); // ~400KB, 상한 아래
      const okD = buildActivityDiff("Edit", {
        file_path: okSize,
        old_string: "TARGET",
        new_string: "X",
      });
      out.push(
        assert(
          "상한 아래(400KB)는 정상적으로 번호가 나온다(과잉 포기 0)",
          okD?.startLine === 200_001,
          `startLine=${String(okD?.startLine)} (기대 200001)`,
        ),
      );

      // ★⑤ Write 는 파일 전체를 새로 쓰므로 **읽지 않고** 1번 줄부터다.
      const w = buildActivityDiff("Write", { file_path: path.join(dir, "새파일.ts"), content: "a\nb\n" });
      out.push(
        assert(
          "Write 는 파일이 아직 없어도 1번 줄부터다(읽지 않고 확정)",
          w?.startLine === 1,
          `startLine=${String(w?.startLine)}`,
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // ★⑥ 표시 계산 — 실제 배포되는 프런트 함수를 꺼내 돌린다(문자열 확인 아님).
    const vfile = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../packages/dashboard/js/virtualization.js",
    );
    const vsrc = await readFile(vfile, "utf8");
    const m = /const diffLineNos = \([\s\S]*?\n {6}\};/.exec(vsrc);
    out.push(
      assert(
        "표시 계산 함수를 배포 파일에서 꺼낸다(검사 전제)",
        m !== null,
        m === null ? "★diffLineNos 를 못 찾음 — 검사 불가" : `${m[0].length}자`,
      ),
    );
    if (m !== null) {
      const ctx: { diffLineNos?: (l: unknown, s: unknown) => Array<number | null> } = {};
      vm.createContext(ctx);
      vm.runInContext(`${m[0]}\nthis.diffLineNos = diffLineNos;`, ctx);
      const nos = ctx.diffLineNos as (l: unknown, s: unknown) => Array<number | null>;
      const lines = [
        { op: " ", text: "ctx" },   // 10
        { op: "-", text: "old" },   // 번호 없음(결과 파일에 없다)
        { op: "-", text: "old2" },  // 번호 없음
        { op: "+", text: "new" },   // 11
        { op: " ", text: "tail" },  // 12
      ];
      const got = nos(lines, 10);
      out.push(
        assert(
          "★삭제된 줄엔 번호가 없고, 나머지는 결과 파일 기준으로 이어진다",
          JSON.stringify(got) === JSON.stringify([10, null, null, 11, 12]),
          `${JSON.stringify(got)} (기대 [10,null,null,11,12])`,
        ),
      );
      const none = nos(lines, undefined);
      out.push(
        assert(
          "★시작 줄을 모르면 전부 번호 없음(0 이나 1 로 때우지 않는다)",
          none.every((x) => x === null),
          JSON.stringify(none),
        ),
      );
      // ★번호가 하나도 없으면 **칸 자체를 안 만든다** — 빈 칸만 남으면 코드가 밀려 보인다.
      //  (`Math.max(0, ...)` 로 뭉뚱그려 폭 1 이 나오던 것을 헤드리스 실측에서 잡았다.
      //   "없음" 과 "0" 은 다르다.)
      const mw = /const diffNoWidth = \([\s\S]*?\n {6}\};/.exec(vsrc);
      if (mw !== null) {
        const cw: { diffNoWidth?: (n: unknown) => number } = {};
        vm.createContext(cw);
        vm.runInContext(`${mw[0]}\nthis.diffNoWidth = diffNoWidth;`, cw);
        const width = cw.diffNoWidth as (n: unknown) => number;
        const cases: Array<[string, number, number]> = [
          ["★번호가 전부 없으면 폭 0(빈 칸 0)", 0, width([null, null])],
          ["빈 배열도 폭 0", 0, width([])],
          ["가장 큰 번호에 폭을 맞춘다", 3, width([9, null, 100])],
          ["한 자리면 1", 1, width([7])],
        ];
        const bad = cases.filter(([, w, g]) => w !== g);
        out.push(
          assert(
            `★번호 칸 폭 판정 ${cases.length}종이 옳다`,
            bad.length === 0,
            bad.length === 0
              ? `${cases.length}종 정확`
              : bad.map(([d, w, g]) => `${d}: 기대 ${w} 실제 ${g}`).join(" / "),
          ),
        );
      } else {
        out.push(assert("★diffNoWidth 를 못 찾음 — 검사 불가", false, "추출 실패"));
      }
      out.push(
        assert(
          "빈 diff 도 안전하다",
          JSON.stringify(nos([], 5)) === "[]" && JSON.stringify(nos(undefined, 5)) === "[]",
          "빈 배열",
        ),
      );
    }

    // ★⑦ 배선 — 렌더러가 그 함수를 **실제로 쓰는가**. 안 쓰면 위 ⑥은 죽은 코드를 검사한 것이다.
    const { sourceHas } = await import("./_wiring.js");
    const wired = await sourceHas("../../../packages/dashboard/js/virtualization.js", [
      /const nos = diffLineNos\(diff\.lines, diff\.startLine\);/,
      /const noW = diffNoWidth\(nos\);/,
      /noSpan\.className = "dl-no";/,
    ]);
    out.push(
      assert(
        "★diff 렌더러가 줄 번호를 실제로 그린다",
        wired.ok,
        wired.ok ? "배선 확인" : `누락 ${wired.missing.join(" ")}`,
      ),
    );
    // ★경로 클릭 = 복사 (2026-08-02) — 에디터 직접 열기는 **의도적으로 안 한다**:
    //  브라우저는 file:// 를 못 열고, 데몬이 OS `open` 을 대신 실행하면 대시보드에
    //  로그인이 없다(포트에 닿는 것이 곧 권한). 폰에서 누르면 **데몬 기계에서** 창이 떠
    //  누른 사람은 보지도 못한다 — 복사는 전 환경에서 되고 위험 0이라 여기부터 간다.
    //  ★단 "서버가 OS 로 여는 건 무조건 위험" 은 **틀린 단언**이다: 이미 `/open-path`(폴더
    //   열기)가 있고 **등록된 프로젝트 경로 화이트리스트 + execFile(no shell)** 로 닫혀
    //   있다. 나중에 파일 열기를 붙인다면 그 선례를 따르면 된다(임의 경로 금지가 핵심).
    //  ★핸들러 **한 덩어리**로 본다 — `stopPropagation` 은 파일 곳곳에 있어서 따로 찾으면
    //   내 핸들러에서 빠져도 딴 데 걸린다(변이에서 실제로 빠져나갔다).
    // 위에서 이미 읽은 vsrc 재사용(같은 파일을 두 번 읽지 않는다).
    const copyHandler =
      /ps\.addEventListener\("click", \(e\) => \{[\s\S]{0,400}e\.stopPropagation\(\);[\s\S]{0,400}navigator\.clipboard\.writeText\(pathText\)/.test(
        vsrc,
      );
    const wiredCopy = { ok: copyHandler, missing: copyHandler ? [] : ["핸들러 한 덩어리"] };
    out.push(
      assert(
        "★경로를 클릭하면 `경로:줄` 을 복사한다(부모 토글은 안 뺏는다)",
        wiredCopy.ok,
        wiredCopy.ok ? "복사 배선 확인" : `누락 ${wiredCopy.missing.join(" ")}`,
      ),
    );
    const css = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/dashboard/app.css"),
      "utf8",
    );
    out.push(
      assert(
        "거터 스타일이 있다(없으면 번호가 코드와 붙어 읽을 수 없다)",
        /\.dl-no\s*\{/.test(css),
        /\.dl-no\s*\{/.test(css) ? "확인" : "★.dl-no 규칙 없음",
      ),
    );
    return out;
  },
};
