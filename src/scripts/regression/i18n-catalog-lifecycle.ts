/**
 * 회귀: **배포본 카탈로그는 프로세스 수명 동안 고정, 홈 덮어쓰기는 실시간 — 그리고 화면과 서버가 같은 순서로 폴백한다** (2026-10-07 적대 검토).
 *
 *  P2 — 업데이트는 파일을 바꾼 뒤 재시작한다. 그 사이 **옛 코드가 새 카탈로그**를 읽으면 키 이름을 바꾼 문구는 키 그대로,
 *       자리표시자를 바꾼 문구는 `{sec}` 그대로 사용자에게 갔다(업데이트 결과·재시작 알림이 정확히 그 창에 나간다).
 *  P3 — 반쯤 번역한 언어에서 서버(`translate`)는 영어로, 화면(`catalogForClient`)은 한국어로 폴백해 같은 키가 두 언어로 나왔다.
 *
 * 등급: **동작** — 임시 폴더의 실제 파일을 고치며 읽개를 돌리고, 같은 키를 두 경로로 뽑아 비교한다.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalogForClient, createCatalogLoader, translate } from "../../core/i18n.js";
import { getPaths } from "../../core/paths.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "i18n-catalog-lifecycle",
  guards:
    "업데이트 직후 재시작 전까지 옛 코드가 새 카탈로그를 읽어 키 이름·{자리표시자} 가 사용자에게 가던 것 + 반쯤 번역한 언어에서 화면과 서버가 다른 언어로 폴백하던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-catalog-"));
    const homeLocales = path.join(getPaths().home, "locales");
    const zz = path.join(homeLocales, "zz.json");
    try {
      // ── P2 — 배포본 고정 · 홈 실시간 ─────────────────────────────────────
      const appDir = path.join(root, "app");
      const homeDir = path.join(root, "home");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      const appFile = path.join(appDir, "en.json");
      writeFileSync(appFile, JSON.stringify({ "srv.k": "old {sec}" }));
      const load = createCatalogLoader(() => ({ appDir, homeDir }));
      const first = load("en")["srv.k"];
      // 업데이트가 배포본을 바꿨다(키·자리표시자 변경) — 시각도 확실히 다르게.
      writeFileSync(appFile, JSON.stringify({ "srv.renamed": "new {seconds}" }));
      utimesSync(appFile, new Date(), new Date(Date.now() + 5_000));
      const afterUpdate = load("en")["srv.k"];
      const homeFile = path.join(homeDir, "en.json");
      writeFileSync(homeFile, JSON.stringify({ "srv.k": "mine" }));
      const homeLive = load("en")["srv.k"];
      writeFileSync(homeFile, JSON.stringify({ "srv.k": "mine2" }));
      utimesSync(homeFile, new Date(), new Date(Date.now() + 10_000));
      const homeLive2 = load("en")["srv.k"];
      // 홈이 바뀌어 다시 합친 뒤에도 배포본은 옛 판이다(캐시가 가려 주는 경우가 아니라 고정이어야 한다).
      const renamedAfterRemerge = load("en")["srv.renamed"];

      // ── P3 — 같은 키를 두 경로로 ─────────────────────────────────────────
      mkdirSync(homeLocales, { recursive: true });
      writeFileSync(zz, JSON.stringify({ "nav.settings": "ZZ-settings" }));
      const client = catalogForClient("zz").strings;
      const keys = Object.keys(client);
      const diff = keys.filter((k) => client[k] !== translate(k, undefined, "zz"));
      const sample = { client: client["chat.send"], server: translate("chat.send", undefined, "zz") };
      // ★실제 언어로도 본다 — 가상 언어(zz)만 보면 «그 언어가 기본 언어와 같을 때» 층이 접혀 영어가 덮는 결함이 안 보였다
      //  (2026-10-07 돌쇠 실사고: locale=ko 인데 대시보드가 영어).
      const real = (["ko", "en"] as const).map((l) => {
        const c = catalogForClient(l).strings;
        return { l, settings: c["nav.settings"], diff: Object.keys(c).filter((k) => c[k] !== translate(k, undefined, l)).length };
      });

      return [
        assert(
          "★배포본 카탈로그는 처음 읽은 판으로 고정된다 — 업데이트가 파일을 바꿔도 재시작 전 옛 코드는 옛 문구(키·{자리표시자} 새지 않음)",
          first === "old {sec}" && afterUpdate === "old {sec}" && renamedAfterRemerge === undefined,
          `처음=${String(first)} · 파일 교체 뒤=${String(afterUpdate)} · 홈 변경 뒤 새 키=${String(renamedAfterRemerge)}`,
        ),
        assert(
          "★홈 덮어쓰기는 재시작 없이 다음 문장부터(사용자가 고친 문구)",
          homeLive === "mine" && homeLive2 === "mine2",
          `${String(homeLive)} → ${String(homeLive2)}`,
        ),
        assert(
          "★설정 언어가 그대로 화면에 나온다 — ko 면 한국어(기본 언어와 같아도 영어가 덮지 않는다) · en 이면 영어 · 서버와 일치",
          real[0]!.settings === "설정" && real[1]!.settings === "Settings" && real.every((r) => r.diff === 0),
          JSON.stringify(real),
        ),
        assert(
          "★반쯤 번역한 언어에서 화면과 서버가 같은 문구를 낸다(폴백 순서 일치 — 그 언어 → 영어 → 기본)",
          keys.length > 100 && diff.length === 0 && client["nav.settings"] === "ZZ-settings",
          diff.length === 0 ? `${keys.length}키 일치 · 빠진 키 예 ${JSON.stringify(sample)}` : `갈림 ${diff.length}: ${diff.slice(0, 4).join(", ")}`,
        ),
      ];
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(zz, { force: true });
    }
  },
};
