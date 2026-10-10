/**
 * 회귀: **한도 조회가 끝나도·🔄 를 눌러도 플러그인 화면의 입력칸이 지워지지 않는다** (2026-10-09 전체 적대 검토).
 *
 * 사고: 구독 한도는 상세 카드가 열릴 때 provider 하나씩 묻는다(claude CLI 2.3초·시한 25초). 조회가 끝나면
 *  `loadUsage` 가, 🔄 를 누르면 그 핸들러가 `renderPluginsView()` 로 **화면 전체**를 다시 그렸다 — 그 사이
 *  적고 있던 설치 입력칸·열어 둔 로그인 붙여넣기 칸이 사라졌다. 같은 날 🔄 다시 켜기 타이머에서 같은 부류를
 *  고쳤다(버튼만 갱신). 고침: 한도 블록(🔄 + `.plugin-auth-usage`)만 갈아 끼운다.
 *
 * 등급: **동작** — 진짜 view-plugins.js 를 부팅 순서대로 싣고(vm), 조회 응답을 손으로 늦게 돌려준다.
 */
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "dashboard-plugin-usage-keeps-inputs",
  guards:
    "플러그인 화면에서 한도 조회가 끝나거나 🔄 를 누르면 화면 전체가 다시 그려져 설치 입력칸·로그인 붙여넣기 칸이 지워지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const clock = makeClock();
    const pending: Array<(pct: number) => void> = [];
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      ids: ["plugins-list", "plugins-count", "plugins-search"],
      fetch: async (url: string) => {
        if (url.startsWith("/api/plugins"))
          return jsonResponse({ items: [{ name: "sub-auth", enabled: true, needsFacts: [{ kind: "auth", value: "codex" }] }] });
        if (url.startsWith("/api/auth-providers"))
          return jsonResponse({
            providers: [{ provider: "codex", authenticated: true, hasUsage: true, login: { label: "login" } }],
          });
        if (url.startsWith("/api/auth-usage"))
          return new Promise((resolve) => {
            pending.push((pct) => resolve(jsonResponse({ usage: { windows: [{ windowSeconds: 18_000, remainingPercent: pct }] } })));
          });
        return jsonResponse({}, 404);
      },
      stubs: "const setChatPanel = () => {};",
    });
    const root = dash.document.getElementById("detail-panel") as MElement;
    dash.run("showPlugins()");
    await clock.advance(10);

    // 사용자가 적고 있던 것 — 설치 이름 · 열어 둔 로그인 칸
    const input = root.querySelector(".plugin-install-input");
    const panel = root.querySelector(".plugin-auth-panel");
    if (input) input.value = "my-plugin";
    if (panel) panel.hidden = false;
    const usageText = (): string => root.querySelector(".plugin-auth-usage")?.textContent ?? "";
    const kept = (): boolean =>
      input !== null &&
      root.querySelector(".plugin-install-input") === input &&
      input.value === "my-plugin" &&
      panel !== null &&
      root.querySelector(".plugin-auth-panel") === panel &&
      panel.hidden === false;
    const loadingText = usageText();

    // ① 첫 조회가 끝난다
    pending.shift()?.(63);
    await clock.advance(10);
    const first = usageText();
    out.push(
      assert(
        "전제 — 카드가 열리며 한도를 물었고(«확인하는 중»), 답이 오면 그 숫자가 그려진다",
        loadingText !== "" && first.includes("63"),
        `조회 중 «${loadingText}» → 답 뒤 «${first}»`,
      ),
    );
    out.push(
      assert(
        "★★한도 조회가 끝나도 설치 입력칸(적던 값)·열어 둔 로그인 칸이 **같은 노드로 남는다**",
        kept(),
        `입력칸 유지=${String(root.querySelector(".plugin-install-input") === input)} 값=${JSON.stringify(input?.value)} 로그인칸 유지=${String(root.querySelector(".plugin-auth-panel") === panel)} 열림=${String(panel?.hidden === false)}`,
      ),
    );

    // ② 🔄 를 누른다 — 누른 즉시 «확인하는 중», 답이 오면 새 숫자
    const rf = root.querySelector(".usage-refresh");
    rf?.click();
    await clock.advance(1);
    const during = usageText();
    const keptDuring = kept();
    pending.shift()?.(41);
    await clock.advance(10);
    const after = usageText();
    out.push(
      assert(
        "★★🔄 를 눌러도(누른 즉시·답이 온 뒤 둘 다) 입력칸·로그인 칸이 남는다",
        rf !== null && keptDuring && kept(),
        `누른 즉시 유지=${String(keptDuring)} · 답 뒤 유지=${String(kept())}`,
      ),
    );
    out.push(
      assert(
        "★그래도 한도 블록은 **갱신된다** — 누른 즉시 «확인하는 중», 답 뒤 새 숫자(블록 갱신을 통째로 끄면 위는 초록이다)",
        !during.includes("63") && during !== "" && after.includes("41") && !after.includes("63"),
        `누른 즉시 «${during}» → 답 뒤 «${after}»`,
      ),
    );
    out.push(assert("그 과정에 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"));
    return out;
  },
};
