/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 회귀: **헤더 브랜드 옆 부제 = 버전만**(`v0.76.0`) (2026-10-25 사용자 결정 — «대시보드 · v0.76.0» 에서 «대시보드 ·» 를 뺐다).
 *
 * 재는 것(동작 — 실제 마크업 조각 + 실제 `restoreActiveTurns`(activity.js)·`i18n`·`applyI18n`(util.js)을 VM 에서, 카탈로그는 진짜 `catalogForClient`):
 *  ① 한·영 모두 health 성공 → 부제가 정확히 `v<버전>`(구분점·«대시보드»/«Dashboard» 없음)
 *  ② health 전·실패·응답에 버전 없음 → 부제가 비어 있다(빈 구분점·채우지 못한 자리표시자 없음)
 *  ③ 번역 재적용(`applyI18n`, 언어 전환 때 도는 것) 뒤에도 부제가 버전 그대로 · 메뉴 제목(`nav-title`, 같은 키 `app.sub`)은 «대시보드»/«Dashboard» 그대로
 *  ④ 탭 제목·`application-name` 은 손대지 않았다(마크업).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { makeDomContext } from "./_mini-dom.js";
import { catalogForClient } from "../../core/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const section = (s: string, start: string, end: string): string => {
  const a = s.indexOf(start);
  if (a < 0) throw new Error(`제품 경계 없음: ${start}`);
  const b = s.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`제품 경계 없음: ${end}`);
  return s.slice(a, b + end.length);
};

const html = src("packages/dashboard/index.html");
const subLine = /<div[^>]*id="app-sub"[^>]*>[^<]*<\/div>/.exec(html)?.[0] ?? "";
const navLine = /<div class="nav-title"[^>]*>[^<]*<\/div>/.exec(html)?.[0] ?? "";

/** 한 화면 — 마크업 두 줄을 그리고, health 응답(또는 실패)으로 부팅 갱신을 한 번 돌린다. */
const boot = async (locale: string, health: "ok" | "fail" | "pending" | "noversion"): Promise<{ sub: string; nav: string; afterApply: string; navAfter: string }> => {
  const { document, window, ctx } = makeDomContext({
    currentView: "chat", showOverview() {}, setTimeout: () => 0, markTurnActive() {},
    appVersion: "", appAssets: "",
    fetch: () =>
      health === "ok" ? Promise.resolve({ json: async () => ({ version: "0.76.0", active_turn_threads: [] }) })
      : health === "noversion" ? Promise.resolve({ json: async () => ({ active_turn_threads: [] }) })
      : health === "fail" ? Promise.reject(new Error("down"))
      : new Promise(() => {}),
  });
  window.__TIGU_I18N__ = catalogForClient(locale);
  document.body.innerHTML = `${subLine}${navLine}`;
  vm.createContext(ctx);
  const util = src("packages/dashboard/js/util.js");
  vm.runInContext(section(util, "      const i18n = (key, params) => {", "\n      };"), ctx);
  vm.runInContext(section(util, "      const applyI18n = (root) => {", "\n      };"), ctx);
  const act = src("packages/dashboard/js/activity.js");
  vm.runInContext(section(act, "      const activeThreadsFromHealth = (h) => {", "\n      };"), ctx);
  vm.runInContext(section(act, "      function restoreActiveTurns() {", "\n      }"), ctx);
  vm.runInContext("applyI18n(document); restoreActiveTurns();", ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const sub = document.getElementById("app-sub")?.textContent ?? "(없음)";
  const nav = document.querySelector(".nav-title")?.textContent ?? "(없음)";
  vm.runInContext("applyI18n(document)", ctx);
  return { sub, nav, afterApply: document.getElementById("app-sub")?.textContent ?? "(없음)", navAfter: document.querySelector(".nav-title")?.textContent ?? "(없음)" };
};

export const check: RegressionCheck = {
  name: "header-sub-version-only",
  guards: "2026-10-25 헤더 부제를 «대시보드 · v…» 에서 버전만으로 — 구분점·빈 구분점·번역 재적용 뒤 «대시보드» 복귀가 없어야 한다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const koOk = await boot("ko", "ok"), enOk = await boot("en", "ok");
    const koFail = await boot("ko", "fail"), enPending = await boot("en", "pending");
    const koNoVer = await boot("ko", "noversion"), enNoVer = await boot("en", "noversion");
    out.push(
      assert("마크업 조각을 찾았다(부제·메뉴 제목)", subLine !== "" && navLine !== "", `${subLine} · ${navLine}`),
      assert(
        "① 한·영 health 성공 → 부제가 정확히 `v0.76.0`",
        koOk.sub === "v0.76.0" && enOk.sub === "v0.76.0",
        `ko=${JSON.stringify(koOk.sub)} en=${JSON.stringify(enOk.sub)}`,
      ),
      assert(
        "② health 실패·미도착·응답에 버전 없음 → 부제가 비어 있다(빈 구분점·«대시보드»·채우지 못한 `{version}` 없음)",
        koFail.sub === "" && enPending.sub === "" && koNoVer.sub === "" && enNoVer.sub === "",
        `실패 ko=${JSON.stringify(koFail.sub)} · 미도착 en=${JSON.stringify(enPending.sub)} · 버전 없음 ko=${JSON.stringify(koNoVer.sub)} en=${JSON.stringify(enNoVer.sub)}`,
      ),
      assert(
        "③ 번역 재적용 뒤에도 부제는 버전 그대로 · 메뉴 제목은 «대시보드»/«Dashboard»",
        koOk.afterApply === "v0.76.0" && enOk.afterApply === "v0.76.0" && koOk.navAfter === "대시보드" && enOk.navAfter === "Dashboard" && koFail.afterApply === "",
        JSON.stringify({ ko: koOk, en: enOk, koFail }),
      ),
      assert(
        "④ 탭 제목·application-name 은 그대로",
        /<title>티구클로 대시보드<\/title>/.test(html) && /<meta name="application-name" content="티구클로 대시보드" \/>/.test(html),
        `${/<title>[^<]*<\/title>/.exec(html)?.[0] ?? "(제목 없음)"} · ${/<meta name="application-name"[^>]*>/.exec(html)?.[0] ?? "(없음)"}`,
      ),
    );
    return out;
  },
};
