/**
 * 회귀: **메뉴의 숫자 칸마다 그 칸을 채우는 코드가 있다** (2026-10-22 사용자 — «대시보드 메뉴에서 플러그인 개수가 0으로 보여»).
 *
 * 사고: 08-28 플러그인 메뉴를 만들 때 `index.html` 에 `<span id="nav-plugin-count">0</span>` 을 박고 채우는 코드를 안 달았다 —
 *  다른 메뉴(공급자·모델·이벤트·프로젝트·엔드포인트·능력)는 각자 뷰가 그 칸을 쓰는데 플러그인만 없어서, 두 달 가까이 늘 «0» 이었다.
 *  화면은 멀쩡히 뜨고 오류도 없어 아무 검사에도 안 걸렸다(부품은 검사되는데 이음매는 안 검사된다).
 *
 * 지키는 것:
 *  ① `index.html` 의 `nav-*-count` 칸 **전부**에 그 id 를 쓰는 스크립트가 있다 — 이름을 손으로 적지 않고 HTML 에서 뽑는다(새 메뉴도 자동 대상)
 *  ② 플러그인 수는 화면을 안 열어도 맞는다 — 진짜 `view-plugins.js` 의 `fetchPluginCount` 가 `/api/plugins` 의 항목 수를 쓴다
 *  ③ 부팅이 그 갱신을 부른다(다른 메뉴처럼 주기 갱신 포함)
 *
 * 등급: ① 배선 대조 · ② 동작(미니 DOM) · ③ 배선 대조.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

export const check: RegressionCheck = {
  name: "dashboard-nav-counts-wired",
  guards: "메뉴의 숫자 칸을 HTML 에 0 으로 박고 채우는 코드를 안 달아 플러그인 수가 늘 0 이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const html = readFileSync("packages/dashboard/index.html", "utf8");
    const ids = [...html.matchAll(/id="(nav-[a-z-]+-count)"/g)].map((m) => m[1]!);
    const jsDir = "packages/dashboard/js";
    const js = readdirSync(jsDir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(path.join(jsDir, f), "utf8")).join("\n");
    const orphans = ids.filter((id) => !js.includes(`getElementById("${id}")`));
    out.push(
      assert(
        "★① 메뉴 숫자 칸마다 그 칸을 쓰는 스크립트가 있다(HTML 에서 뽑은 전부)",
        ids.length >= 5 && orphans.length === 0,
        orphans.length === 0 ? `${ids.length}칸 모두 배선` : `★채우는 코드 없음: ${orphans.join(", ")}`,
      ),
    );

    const dash = bootDashboard({
      clock: makeClock(), i18n: i18nForContext, allIds: true,
      fetch: async (url: string) => (String(url).startsWith("/api/plugins") ? jsonResponse({ items: [{ name: "a" }, { name: "b" }, { name: "c" }] }) : jsonResponse({}, 404)),
    });
    const before = String(dash.document.getElementById("nav-plugin-count")?.textContent ?? "");
    await dash.run(`typeof fetchPluginCount === "function" ? fetchPluginCount() : null`);
    const after = String(dash.document.getElementById("nav-plugin-count")?.textContent ?? "");
    out.push(
      assert(
        "★② 플러그인 화면을 안 열어도 메뉴 수가 `/api/plugins` 항목 수(3)로 맞는다",
        after === "3",
        `전=${before} · 후=${after}`,
      ),
    );

    const boot = readFileSync(path.join(jsDir, "activity.js"), "utf8");
    out.push(
      assert(
        "③ 부팅이 플러그인 수 갱신을 부르고 주기 갱신도 건다(다른 메뉴와 같은 자리)",
        /\n\s*fetchPluginCount\(\);/.test(boot) && /setInterval\(fetchPluginCount, \d+\)/.test(boot),
        (boot.match(/^.*fetchPluginCount.*$/gm) ?? ["(activity.js 에 fetchPluginCount 없음)"]).map((l) => l.trim()).join(" | "),
      ),
    );
    return out;
  },
};
