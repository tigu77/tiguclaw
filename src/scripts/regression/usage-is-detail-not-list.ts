/**
 * 회귀: **한도 조회가 목록을 막지 않는다** (2026-09-09 정태님).
 *
 * 사고: 플러그인 메뉴를 열면 몇 초씩 멈췄다. 화면은 `/api/plugins` 뒤에 `/api/auth-providers`
 * 를 **순차로** 기다리는데, 그 목록 라우트가 응답 전에 **모든 provider 의 사용량을 전부**
 * 가져오고 있었다 — claude 는 `claude -p /usage` 하위 프로세스를 띄우고(시한 **25초**,
 * `usage-cli.mjs`), codex 는 외부 엔드포인트를 때린다(5초).
 *
 * ★그런데 그 숫자를 그리는 자리는 **상세 카드 하나뿐**이다(`buildPluginCard`) — 목록 행엔
 *  아예 안 나온다. **아무도 안 볼 수도 있는 숫자 때문에 메뉴 전체가 멈췄다.**
 * ★더 나쁜 건 의도가 원래 그게 아니었다는 것이다: `codex-subscription-auth/usage.ts` 머리말이
 *  *"구독 플러그인 **상세를 열 때** 한 번 가져온다"* 라고 적어두고 배선만 목록에 붙어 있었다.
 *  자리를 옮기니 «느린 provider 가 목록을 막는다» 는 문제 자체가 사라졌다(비동기로 뒤에서
 *  채우는 부품을 새로 만들 필요가 없었다).
 * ★그리고 목록 라우트 주석은 *"한 provider 가 **느리거나** 실패해도 나머지는 그린다 —
 *  `allSettled` 로 서로를 안 막는다"* 고 했는데, 코드는 `Promise.all` 이었고 어느 쪽이든
 *  **가장 느린 것을 끝까지 기다린다.** 실패만 처리되고 느림은 전혀 처리되지 않았다.
 *
 * ★**선언이 두 벌이었다** — `auth-registry.ts` 와 `plugins/host.ts` 가 각자 `getUsage` 를
 *  선언한다. `force` 를 한쪽에만 넓혔더니 플러그인은 저쪽을 보고 있어 **인자가 조용히
 *  사라질 뻔했다**(타입체커가 잡았다). 둘이 갈리지 않는지 여기서 센다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

/** 함수 하나의 본문만 떼어 본다 — 옆 함수의 같은 낱말에 걸리지 않게. */
const bodyOf = (src: string, name: string): string => {
  const i = src.indexOf(`export const ${name} =`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport const ", i + 1);
  return src.slice(i, j < 0 ? src.length : j);
};

export const check: RegressionCheck = {
  name: "usage-is-detail-not-list",
  guards:
    "플러그인 메뉴가 몇 초씩 멈추던 것 — 목록 라우트가 응답 전에 모든 provider 의 사용량을 " +
    "기다렸고(claude CLI 시한 25초), 정작 그 숫자는 상세 카드에서만 그려진다",
  async run(): Promise<Assertion[]> {
    const auth = stripComments(readSourceSync("plugins/http-bridge/routes-auth.ts"));
    const list = bodyOf(auth, "handleAuthProviders");
    const one = bodyOf(auth, "handleAuthUsage");
    const view = stripComments(readSourceSync("packages/dashboard/js/view-plugins.js"));
    const out: Assertion[] = [];

    out.push(
      assert(
        "★★목록 라우트(`/auth-providers`)가 **사용량을 안 기다린다** — 그 숫자는 상세에서만 그려지는데, 목록이 기다리면 아무도 안 볼 수도 있는 값 때문에 메뉴 전체가 멈춘다(claude CLI 시한 25초)",
        // ★**부르는 것만** 본다 — `p.getUsage !== undefined`(능력이 있나)는 정당하고,
        //  그게 화면에 «조회를 걸지 말지» 를 알려주는 재료다. 낱말을 통째로 금지하면
        //  옳은 코드를 위반으로 세고, 그러면 게이트를 지우게 된다(첫 판이 그랬다).
        list !== "" && !/getUsage\s*\(/.test(list) && !/getUsage\b(?![\s]*[!=]==)/.test(
          list.replace(/getUsage\s*!==\s*undefined/g, ""),
        ),
        list === ""
          ? "★handleAuthProviders 를 못 찾음"
          : `본문 ${list.split("\n").length}행 · 호출 ${(list.match(/getUsage\s*\(/g) ?? []).length}회 · 능력확인 ${(list.match(/getUsage\s*!==\s*undefined/g) ?? []).length}회`,
      ),
    );
    out.push(
      assert(
        "★상세용 라우트가 **provider 하나만** 조회한다 — 목록처럼 전부 돌면 옮긴 의미가 없다",
        one !== "" && /searchParams\.get\("provider"\)/.test(one) && !/listAuthProviders/.test(one),
        one === "" ? "★handleAuthUsage 없음" : `provider 인자 ${/searchParams/.test(one)} · 전체열거 ${/listAuthProviders/.test(one)}`,
      ),
    );
    out.push(
      assert(
        "★새로고침(`force`)이 라우트까지 닿는다 — 캐시의 일은 재렌더를 접는 것이라, 사용자가 다시 누른 것은 정의상 그 중복이 아니다",
        /force/.test(one) && /force=1/.test(view),
        JSON.stringify({ 라우트: /force/.test(one), 화면: /force=1/.test(view) }),
      ),
    );

    // ★선언 두 벌이 갈리지 않는가 — 갈리면 인자가 조용히 사라진다.
    const reg = readSourceSync("src/core/llm-runtime/auth-registry.ts");
    const host = readSourceSync("src/core/plugins/host.ts");
    const sig = (s: string): string =>
      (s.match(/getUsage\?\(([^)]*)\)/) ?? ["", "★없음"])[1] ?? "";
    out.push(
      assert(
        "★★`getUsage` 선언 **두 벌의 인자가 같다**(`auth-registry` ↔ `plugins/host`) — 한쪽만 넓히면 플러그인은 저쪽을 보고 라우트는 이쪽을 봐서 인자가 조용히 사라진다",
        sig(reg) === sig(host) && sig(reg) !== "★없음",
        JSON.stringify({ "auth-registry": sig(reg), "plugins/host": sig(host) }),
      ),
    );
    return out;
  },
};
