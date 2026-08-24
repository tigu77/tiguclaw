/**
 * 회귀: **이력 렌더가 필드를 잃지 않는다** + 커서·검색의 짝 맞는 갱신 (2026-08-23 5차).
 *
 * ★**등급: 배선 린트다.** 소스를 본다 — 동작을 안 돌린다.
 *  이 파일들(`history-render.js`·`virtualization.js`·`chat-search.js`)은 DOM 에 묶여 있어
 *  Node 에서 순수 함수로 못 뽑는다. 헤드리스로만 실증 가능하고 그건 스위트에 넣기엔
 *  비싸다 — 백로그 26번. **그러니 이 검사가 초록이라고 "동작이 확인됐다" 고 읽지 마라.**
 *  지키는 것은 *구조* 뿐이다: "손으로 열거하지 않는다", "짝지어 지운다", "질의를 닫는다".
 *  ([[feedback_gate_must_actually_run]] — 지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘다.)
 *
 * 왜 그래도 두는가: 여기서 깨진 것들이 전부 **손으로 열거하다 빠뜨린** 부류였고, 그건
 * 소스 모양으로 잡히는 몇 안 되는 종류다.
 *  - `notice`·`model` 을 전달 목록에서 빠뜨림 (2026-07-27) — 새로고침하면 사라졌다
 *  - `id` 를 빠뜨림 (2026-08-23) — `[data-ts]` 31개 / `[data-id]` **0개**, 프루닝 커서
 *    복구가 통째로 무효였다. **같은 자리에서 세 번째**였다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * 소스를 읽되 **주석을 걷어낸다.**
 *
 * ★오늘만 세 번 같은 오탐을 냈다 — 주석 안의 `setTimeout(fn, Infinity)`, 주석 안의
 *  `<style>`(verify-dashboard-split, 몇 주 상시 FAIL), 주석 안의 `` `++seq` ``.
 *  **검사 대상은 코드이지 그것을 설명하는 글이 아니다.** 배선 린트를 쓸 거면 최소한
 *  이건 지켜야 한다. [[feedback_gate_must_actually_run]]
 */
const read = async (rel: string): Promise<string> => {
  const raw = await readFile(new URL(rel, import.meta.url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // ★따옴표·백틱 뒤의 `//` 는 주석이 아니다 — 문자열 안 `"a//b"` 를 지워 오탐했다
    //  (오늘의 "주석 안의 코드를 셌다" 의 거울상 — 이번엔 코드 안의 글을 주석으로 셌다).
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const hist = await read("../../../packages/dashboard/js/history-render.js");
  const vt = await read("../../../packages/dashboard/js/virtualization.js");
  const search = await read("../../../packages/dashboard/js/chat-search.js");

  // ── ① 열거하지 않는다 ─────────────────────────────────────────────────────────
  {
    const spread = /return buildHistoryDiv\(\{\s*\.\.\.entry,\s*role\s*\}\)/.test(hist);
    out.push(
      assert(
        "★이력 메시지는 entry 를 **통째로** 넘긴다(필드를 손으로 열거하지 않는다)",
        spread,
        spread
          ? "spread 확인"
          : "★열거로 돌아갔다 — 같은 자리에서 notice·model·id 를 세 번 빠뜨렸다",
      ),
    );
  }

  // ── ② 커서의 두 번째 축을 DOM 에 심는다 ────────────────────────────────────────
  {
    // `div` 를 명시한다 — `head.dataset.id` 로 옮기는 변이가 통과했다.
    const plants = /div\.dataset\.id = String\(entry\.id\)/.test(hist);
    out.push(
      assert(
        "복합 커서의 id 축을 DOM 에 심는다(프루닝 후 복구용)",
        plants,
        plants ? "dataset.id 확인" : "★안 심는다 — 프루닝 커서 복구가 통째로 무효가 된다",
      ),
    );
  }

  // ── ③ 프루닝은 **두 키를 짝지어** 지운다 ───────────────────────────────────────
  {
    const plain = /renderedMsgKeys\.delete\(k\)/.test(vt);
    const withId = /renderedMsgKeys\.delete\(k \+ "\|#" \+ rid\)/.test(vt);
    out.push(
      assert(
        "★프루닝이 평문 키와 행 키를 **둘 다** 지운다",
        plain && withId,
        plain && withId
          ? "대칭 확인"
          : `★${plain ? "행 키" : "평문 키"} 삭제가 없다 — 잘려나간 행이 다시 안 온다`,
      ),
    );
  }

  // ── ④ (프루닝 커서 판단은 이제 **동작 검사**가 본다) ─────────────────────────
  //  `vtCursorFromNodes` 를 순수 함수로 뽑아 `cursor-collects-ties` 가 직접 돌린다
  //  ("화면 최古 1000 vs 미래 9000" 을 실제로 넣어 본다). 여기 있던 소스 린트는
  //  같은 것을 더 약하게 보므로 **지웠다** — 두 게이트가 같은 축을 다른 강도로 보면
  //  약한 쪽이 초록이라 강한 쪽을 무디게 만든다.

  // ── ★`activeThreadKey` 를 세우는 자리는 **전부** 백그라운드 스코프를 다시 판정한다 ──
  //  2026-08-24 사용자 신고: "새로고침하면 백그라운드 패널에 잡이 사라진다 / 세션을 변경하면
  //  다시 정상". 탭 전환·새 탭·닫기 셋은 `refreshBgScope()` 를 부르는데 **부팅 복원만** 빠져
  //  있었다. 스크립트가 plain `<script src>` 라 다운로드 대기 중 fetch 콜백이 끼어들면 카드가
  //  기본 `activeThreadKey` 로 스코프돼 숨는다 — **콜드 로드 × 비기본 세션**에서만 나므로
  //  간헐적으로 보이고, 그래서 오래 살아남았다. 손으로 맞춘 네 자리 = 드리프트 신호.
  {
    const tabs = await read("../../../packages/dashboard/js/tabs.js");
    const acty = await read("../../../packages/dashboard/js/activity.js");
    const assigns =
      (tabs.match(/activeThreadKey\s*=\s*[^=]/g) ?? []).length +
      (acty.match(/activeThreadKey\s*=\s*[^=]/g) ?? []).length;
    const refreshes = (tabs.match(/refreshBgScope\(\)/g) ?? []).length;
    out.push(
      assert(
        "★세션을 바꾸는 모든 자리가 백그라운드 스코프를 다시 판정한다",
        refreshes >= assigns,
        `activeThreadKey 대입 ${assigns}곳 · refreshBgScope 호출 ${refreshes}곳` +
          (refreshes >= assigns
            ? ""
            : " — ★빠진 자리가 있다: 그 경로로 들어오면 잡 카드가 남의 세션 기준으로 숨는다"),
      ),
    );
  }

  // ── ⑤ 질의를 닫는 모든 자리가 seq 를 올린다 ────────────────────────────────────
  {
    // `run()` 의 세 갈래(짧은 질의·정상 질의)가 전부 카운터를 올려야 늦게 온 응답이
    // 화면을 덮지 않는다. `loadMore` 는 **읽기만** 한다(올리면 형제 질의를 죽인다).
    // 낱말 경계 필수 — 없으면 `xseq += 1` 도 센다(실측으로 뚫렸다).
    const bumps = (search.match(/(?<![A-Za-z0-9_])seq \+= 1|\+\+(?<![A-Za-z0-9_])seq\b/g) ?? []).length;
    const observes = /const my = seq;/.test(search);
    out.push(
      assert(
        "★검색: 질의를 여닫는 자리는 seq 를 올리고, 더보기는 읽기만 한다",
        bumps === 2 && observes,
        `올리는 자리 ${bumps}곳(기대 2) · 더보기 관찰=${String(observes)}` +
          (bumps === 2 && observes
            ? ""
            : " — ★지운 질의의 결과가 되살아나거나, 더보기가 새 질의를 죽인다"),
      ),
    );
  }
  return out;
};

export const check: RegressionCheck = {
  name: "history-entry-passthrough",
  guards:
    "이력 렌더가 필드를 손으로 열거하다 notice·model·id 를 세 번 빠뜨린 것(새로고침하면 사라지고, 프루닝 커서 복구가 무효였다) + 프루닝 키 삭제 비대칭 + 검색의 늦은 응답이 지운 질의를 되살리던 것. ★등급=배선 린트(소스를 본다, 동작 아님)",
  run,
};
export default check;
