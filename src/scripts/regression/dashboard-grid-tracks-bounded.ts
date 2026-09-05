/**
 * 회귀: **격자 트랙은 화면을 넘지 않는다** — 대시보드 CSS 의 모든 grid 가 열을 명시하고,
 * 한 칸짜리 트랙은 바닥이 `0` 이다 (2026-09-04).
 *
 * 사고: 모바일 인벤토리 **상세가 통째로 화면 밖으로 나갔다**(390 뷰포트에서 문서 696px,
 *  오른쪽 글자가 잘리고 페이지가 옆으로 스크롤). 범인은 `.detail-card`·`.views` 가
 *  **열을 안 적은 grid** 였다는 것 — 열을 안 적으면 암시적 열이 `auto`(=max-content) 라
 *  **제일 넓은 자식 하나가 트랙 폭을 정하고 형제 전부가 같이 밀려난다.** 정의 본문 한 덩이가
 *  머리글·요약카드·메타까지 끌고 나갔다.
 *
 * ★**데스크톱에선 안 보인다** — 폭이 넉넉하면 같은 규칙이 멀쩡히 그려진다. `dashboard-md-wrap`
 *  과 정확히 같은 부류이고, 그 검사의 주석은 이미 이 결함을 **다른 자리에서** 기록해 뒀다:
 *  «`.md` 가 grid 안에 놓이면 트랙이 벌어져 형제까지 끌고 나간다». 그때는 내용물을 끊었고
 *  (`overflow-wrap:anywhere`), 이번엔 트랙 자체를 닫았다. 내용물마다 반복하지 않으려면
 *  **격자 쪽 성질**을 지켜야 한다 — 그게 이 검사다.
 *
 * ★판정은 **이름 목록이 아니라 파일에서 파생**한다([[feedback_hand_maintained_lists]]):
 *  `display:grid` 를 켜는 규칙을 전부 긁어 «이 선택자에 열 정의가 있나» 를 묻는다. 내일
 *  누가 새 스택 격자를 만들면 목록을 고치지 않아도 걸린다.
 *
 * ★등급: **배선 린트**(소스 스캔). 한계를 정직하게 적는다 — CSS 캐스케이드는 노드에서
 *  계산할 수 없다. 이 검사는 «선택자마다 열 선언이 어딘가 있다»까지만 본다. 실제 픽셀
 *  판정은 헤드리스(CDP)로 했고(390 에서 696 → 390), 그건 브라우저가 있어야 하는 일이다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 주석을 걷고 **잎 규칙**(중괄호 안에 중괄호가 없는 블록)만 뽑는다 — @media·@layer 는 자연히 건너뛴다. */
const leafRules = (css: string): Array<{ selector: string; body: string }> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim(),
    body: m[2] ?? "",
  }));

const selectorParts = (selector: string): string[] =>
  selector
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("@"));

export const check: RegressionCheck = {
  name: "dashboard-grid-tracks-bounded",
  guards:
    "열을 안 적은 grid 의 암시적 `auto` 트랙이 제일 넓은 자식에 맞춰 벌어져, 모바일에서 상세 화면 전체가 가로로 튀어나가던 것 — 데스크톱에선 안 보인다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let css: string;
    try {
      css = await readFile(new URL("../../../packages/dashboard/app.css", import.meta.url), "utf8");
    } catch {
      return [assert("app.css 없음(배포 레포 아님)", true, "건너뜀")];
    }

    const rules = leafRules(css);
    const gridOn = new Set<string>();
    const hasColumns = new Set<string>();
    // 한 칸짜리 트랙의 **값**들 — 바닥이 `0` 인지 본다(`1fr` 은 min 이 auto=min-content).
    const singleTrack: Array<{ sel: string; value: string }> = [];
    for (const { selector, body } of rules) {
      const parts = selectorParts(selector);
      if (parts.length === 0) continue;
      if (/display\s*:\s*(inline-)?grid/.test(body)) for (const p of parts) gridOn.add(p);
      const cols = /grid-template-columns\s*:\s*([^;]+)/.exec(body)?.[1]?.trim();
      if (cols === undefined) continue;
      for (const p of parts) {
        hasColumns.add(p);
        // 한 칸짜리 = `repeat()` 도 아니고 공백으로 갈린 다중 트랙도 아닌 값. 다중 트랙·
        // auto-fill 격자는 여기서 판정하지 않는다(그건 «몇 칸이냐» 의 문제라 화면마다 다르다).
        const bare = cols.replace(/\([^)]*\)/g, "");
        if (!/^repeat\b/.test(cols) && !/\s/.test(bare.trim())) singleTrack.push({ sel: p, value: cols });
      }
    }

    out.push(
      assert(
        "app.css 에서 grid 규칙을 찾는다(선택자 파싱이 죽으면 이 검사는 무의미하다)",
        gridOn.size >= 10,
        `display:grid 선택자 ${gridOn.size}개 · 열 선언 ${hasColumns.size}개`,
      ),
    );

    const unbounded = [...gridOn].filter((s) => !hasColumns.has(s)).sort();
    out.push(
      assert(
        "★모든 grid 가 열을 명시한다 — 안 적으면 암시적 `auto` 트랙이 제일 넓은 자식만큼 벌어진다",
        unbounded.length === 0,
        unbounded.length === 0
          ? `${gridOn.size}개 전부 열 선언 있음`
          : `★열 없는 grid: ${unbounded.join(" · ")} — 좁은 화면에서 형제까지 끌고 나간다`,
      ),
    );

    const loose = singleTrack.filter((t) => !/^minmax\(\s*0/.test(t.value)).sort((a, b) => a.sel.localeCompare(b.sel));
    out.push(
      assert(
        "★한 칸짜리 트랙은 바닥이 0 이다(`1fr` 은 min 이 min-content 라 안 줄어든다)",
        loose.length === 0,
        loose.length === 0
          ? `한 칸 트랙 ${singleTrack.length}개 전부 minmax(0,…)`
          : `★바닥 없는 한 칸 트랙: ${loose.map((t) => `${t.sel}=${t.value}`).join(" · ")}`,
      ),
    );

    return out;
  },
};
export default check;
