/**
 * 회귀: **한 줄 프리뷰가 사용자의 글자를 먹지 않는다** (2026-08-23 2라운드 D2).
 *
 * `stripMarkdownText` 는 전체 활동 한 줄 프리뷰와 검색 스니펫에 쓰인다 — 거기 오는 것은
 * 로그·셸 출력·사용자 문장이 대부분이다. 마크다운 기호를 벗기려다 **평문을 먹으면
 * 진단면이 거짓이 된다**(화면엔 멀쩡한 문장이 보이는데 실제 값과 다르다 — 조용하다).
 *
 * ★같은 함수가 하루에 **양쪽으로 두 번** 틀렸다:
 *   ①`split().join()` 으로 무조건 지워 `2**10` → `210`, `5 > 3` → `5 3`
 *   ②그걸 고치며 닫는 문맥을 `.`·`,` 까지 넓혀 `ls *.md *.ts` → `ls .md .ts`
 *     (여는 `*` 가 공백을 건너 다음 `*` 까지 삼켰다 — 셸 글로브 16개 중 12개 파손)
 *   두 번 다 **소스 문자열 검사만 있어서** 스위트는 초록이었다. 그래서 이 검사는
 *   구현을 안 보고 **케이스 표를 돌린다** — 정규식을 어떻게 짜든 표가 판정한다.
 *
 * ★브라우저 파일이지만 순수 함수라 Node 에서 그대로 돌릴 수 있다 — 헤드리스가 필요 없다.
 *  ([[feedback_simple_composable_no_duplication]] "검사가 껄끄러우면 코드가 잘못 놓인 것")
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** `markdown.js` 에서 순수 함수 본문만 떼어 온다(브라우저 전역 의존 0인 함수라 가능). */
const loadStripFn = async (): Promise<(s: string) => string> => {
  const src = await readFile(
    new URL("../../../packages/dashboard/js/markdown.js", import.meta.url),
    "utf8",
  );
  const start = src.indexOf("const stripMarkdownText = ");
  if (start < 0) throw new Error("stripMarkdownText 를 못 찾았다 — 이름이 바뀌었나?");
  const arrow = src.indexOf("(raw) => {", start);
  const CLOSE = "\n      }";
  const end = src.indexOf(`${CLOSE};`, arrow);
  if (arrow < 0 || end < 0) throw new Error("stripMarkdownText 본문 경계를 못 찾았다");
  const fnText = src.slice(arrow, end + CLOSE.length); // "(raw) => { … }"
  // eslint-disable-next-line no-new-func
  return new Function(`return ${fnText}`)() as (s: string) => string;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const strip = await loadStripFn();

  /** [입력, 기대] — 기대가 입력과 같으면 "손대지 마라". */
  const groups: Array<[string, Array<[string, string]>]> = [
    [
      "셸 글로브를 먹지 않는다",
      [
        ["ls *.md *.ts", "ls *.md *.ts"],
        ["rm -f *.log *.tmp", "rm -f *.log *.tmp"],
        ["git add *.ts *.js", "git add *.ts *.js"],
        ["*.env 와 *.key 는 제외!", "*.env 와 *.key 는 제외!"],
        ["backup *.db, *.db-wal, *.db-shm", "backup *.db, *.db-wal, *.db-shm"],
      ],
    ],
    [
      "연산자·리다이렉션·식별자를 먹지 않는다",
      [
        ["2**10 은 1024", "2**10 은 1024"],
        ["2 ** 10 과 3 ** 4", "2 ** 10 과 3 ** 4"],
        ["5 > 3 이다", "5 > 3 이다"],
        ["echo a > b.txt", "echo a > b.txt"],
        ["some_var_name", "some_var_name"],
        ["a*b*c", "a*b*c"],
        ["ptr *p", "ptr *p"],
        ["10 * 3 = 30 * 1", "10 * 3 = 30 * 1"],
        ["#!/usr/bin/env", "#!/usr/bin/env"],
        ["#5 이슈", "#5 이슈"],
        ["- [ ] 체크박스", "- [ ] 체크박스"],
      ],
    ],
    [
      "★한국어·기호 문맥에서도 벗긴다(3라운드 회귀 — 여는 문맥을 열거해 놓쳤다)",
      [
        // 여는 `**` 앞 문맥을 `[\s(]` 로 **열거**했더니 이 제품이 상시 쓰는 기호가 전부
        // 빠졌다. 실측: docs 에서 화면에 `**` 가 남는 줄이 커밋 전 251 → 후 316(+26%),
        // 전체 활동 뷰는 147/147 이 raw. 열거 대신 "낱말 안에서만 안 연다" 로 판정한다.
        ["★**굵게** 입니다", "★굵게 입니다"],
        ["· **굵게**", "· 굵게"],
        ["「**중요**」", "「중요」"],
        ["[**a**]", "[a]"],
        ["▸**스텝**", "▸스텝"],
        ["*중요*한", "중요한"], // 한국어 조사는 바로 붙는다 — 닫는 쪽 문맥 조건 금지
        ["**_굵은 기울임_**", "굵은 기울임"],
        ["***굵은기울임***", "굵은기울임"],
        ["x~~y~~z", "x~~y~~z"], // 취소선도 같은 규칙(여기만 예외면 낱말 안에서 벗겨진다)
      ],
    ],
    [
      "★경로·글로브·식별자를 먹지 않는다(4라운드 회귀 — 여는 판정을 너무 넓혔다)",
      [
        // `(?<![\p{L}\p{N}_])` 로 넓히자 `/ = ' [ .` 뒤에서도 `_` 가 강조를 열어
        // **`_` 소실 478줄**(직전 판 4줄)이 됐다. 이득보다 손실이 컸다. 실측 코퍼스 115,394줄.
        ["_workspace/phase4_canUseTool_spike.md", "_workspace/phase4_canUseTool_spike.md"],
        ["cp *.log /tmp/_bk_/", "cp *.log /tmp/_bk_/"],
        ["src/**/*.ts", "src/**/*.ts"],
        ["skills/*/SKILL.md", "skills/*/SKILL.md"],
        ["daemon-*.log", "daemon-*.log"],
        ["console.*가", "console.*가"],
        ["ERROR [_main_]", "ERROR [_main_]"], // 닫는 `_` 뒤가 낱말 아님이어도 안 벗긴다
        ["a = b_c_d", "a = b_c_d"],
      ],
    ],
    [
      "★번호 표기(①②③)의 굵게가 **반쪽만** 벗겨지지 않는다(4라운드 회귀)",
      [
        // 여는 판정이 바깥 `*` 만 막고 안쪽 `*` 는 통과시켜 `③**굵게**` → `③*굵게*` 가
        // 됐다(확정 51줄 중 46줄이 이 표기). `\p{N}` 이 `③`(No)까지 막은 게 뿌리 —
        // 십진수(`\p{Nd}`)만 막아야 `2**10` 을 지키면서 `③**굵게**` 를 연다.
        ["③**워커 실패**(원인)", "③워커 실패(원인)"],
        ["① **첫째**", "① 첫째"],
        ["2**10 은 1024", "2**10 은 1024"], // 십진수는 여전히 막는다
        ["_기울임_ 입니다", "기울임 입니다"], // `_` 도 정상 문맥에선 벗긴다
      ],
    ],
    [
      "★한 줄에 구분자가 여럿이어도 병합하지 않는다(5차 검토)",
      [
        // `span()` 을 공유하며 `_` 규칙의 안쪽 클래스가 `_` 를 허용하게 조용히 넓어져
        // 한 줄에 기울임이 둘이면 **병합**됐다. 리팩터가 계약을 바꿨는데 기록이 없었다.
        ["run _foo_ then _bar_", "run foo then bar"],
        ["①**실측표**(…)", "①실측표(…)"], // 굵게가 막히면 기울임이 반쪽만 벗겼다
        ['--include="*.ts"', '--include="*.ts"'],
        ['"src/**/*.ts"', '"src/**/*.ts"'],
        ["grep -v node_modules", "grep -v node_modules"],
        ["MCP_CALL_TIMEOUT_MS", "MCP_CALL_TIMEOUT_MS"],
      ],
    ],
    [
      "★한 줄에 구분자가 **둘 이상**일 때 두 번째까지 삼키지 않는다(6라운드)",
      [
        // ★단일 토큰 케이스로는 이 축이 **원리적으로** 안 보인다. 4점으로 고친 실물이
        //  전부 "한 줄에 구분자 둘" 인데 표엔 단일 토큰만 있어서, 그 수정을 통째로
        //  되돌려도 스위트가 초록이었다(6라운드 실증). 백로그 28번을 적어놓고 다음
        //  커밋이 또 단일 토큰만 넣었다 — 그래서 여기에 실물을 박는다.
        [
          'grep -rn "x" --include="*.ts" --include="*.mjs" src',
          'grep -rn "x" --include="*.ts" --include="*.mjs" src',
        ],
        [
          '"ignore": ["node_modules/**", "dist/**", ".next/**"]',
          '"ignore": ["node_modules/**", "dist/**", ".next/**"]',
        ],
        [
          "sed -E 's/(TOKEN=.{4}).*/\\1…/;s/(KEY=.{4}).*/\\1…/'",
          "sed -E 's/(TOKEN=.{4}).*/\\1…/;s/(KEY=.{4}).*/\\1…/'",
        ],
        [
          "find . -name '*.md' | wc -l; find . -name '*.md' -delete",
          "find . -name '*.md' | wc -l; find . -name '*.md' -delete",
        ],
        ['{"a_b": "*", "c": "**", "glob": "src/**/*.ts"}', '{"a_b": "*", "c": "**", "glob": "src/**/*.ts"}'],
        ["- `*핫딜*웹*`", "- *핫딜*웹*"], // 코드스팬 안은 글자 그대로
      ],
    ],
    [
      "★진짜 강조 **안에 따옴표**가 있어도 벗긴다(6라운드 — NO_QUOTE 철회)",
      [
        // "진짜 강조 안에 따옴표는 드물다" 고 근거 없이 적고 막았더니 라이브 1,120줄이
        // 걸렸고 화면에 `**` 가 남는 줄이 4.9배가 됐다. 재지 않고 적은 대가다.
        ['**1. 앱 내 "구매(Buy)" 기능**', '1. 앱 내 "구매(Buy)" 기능'],
        ["**그건 '지금 이 턴'이 아니다**", "그건 '지금 이 턴'이 아니다"],
      ],
    ],
    [
      "진짜 마크다운은 벗긴다(반대편 — 항상 통과하는 가짜 검사 방지)",
      [
        ["**굵게** 입니다", "굵게 입니다"],
        ["*기울임*.", "기울임."],
        ["(*기울임*)", "(기울임)"],
        ["~~취소~~ 됨", "취소 됨"],
        ["`코드` 블록", "코드 블록"],
        ["# 제목", "제목"],
        ["> 인용", "인용"],
        ["[글자](http://x)", "글자"],
        ["**굵게**, 그리고 *기울임*!", "굵게, 그리고 기울임!"],
      ],
    ],
  ];

  for (const [title, cases] of groups) {
    const bad = cases.filter(([i, e]) => strip(i) !== e);
    out.push(
      assert(
        `★프리뷰: ${title}`,
        bad.length === 0,
        bad.length === 0
          ? `${cases.length}종 통과`
          : `★${bad.length}/${cases.length} 파손 — ${bad
              .map(([i, e]) => `${JSON.stringify(i)}→${JSON.stringify(strip(i))}(기대 ${JSON.stringify(e)})`)
              .join(" · ")}`,
      ),
    );
  }
  return out;
};

export const check: RegressionCheck = {
  name: "preview-text-survives",
  guards:
    "한 줄 프리뷰·검색 스니펫이 마크다운을 벗기려다 평문을 먹던 것 — 양방향으로 두 번(무조건 삭제 → 2**10 이 210 / 닫는 문맥 과확장 → ls *.md *.ts 가 ls .md .ts). 둘 다 소스 문자열 검사뿐이라 초록이었다",
  run,
};
export default check;
