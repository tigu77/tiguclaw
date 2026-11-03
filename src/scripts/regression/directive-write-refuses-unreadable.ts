/**
 * 회귀: **확정 지침 파일을 못 읽으면 쓰지 않는다** (2026-10-09 전체 적대 검토 G → 2026-11-03 코어 회귀로 이관).
 *
 * ★사고: `SELF_GROWTH.md` 를 읽다 일시 오류(권한·핸들 고갈)가 나면 «빈 파일» 로 보고 새 지침 하나로 덮어 —
 *  사용자가 승격한 지침까지 통째로 사라졌다. 손으로 고치다 머리 줄이 깨진 블록도 같은 길로 버려졌다.
 * ★이 보호(`self-growth-md.ts` `readDirectivesRaw(forWrite)`)는 코어 저장소의 것이다. 종전엔 자가성장 플러그인의 실패 학습
 *  회귀(`growth-failure-path-runs`) 안에 들어 있었다 — 플러그인을 빼며 그 회귀를 지우면 코어 보호가 그물을 잃는다(설계 §7-ⓒ).
 *  그래서 쓰는 길(`upsertDirective` — `confirm_feedback` 이 부르는 그 함수)을 직접 부른다.
 *
 * 등급: **동작** — 격리 홈의 실제 SELF_GROWTH.md.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "directive-write-refuses-unreadable",
  guards: "확정 지침 파일을 일시적으로 못 읽거나 깨진 블록이 있을 때 «빈 파일» 로 보고 새 지침 하나로 덮어 사용자 지침을 통째로 지우던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const prevHome = process.env.TIGUCLAW_HOME;
    const home = mkdtempSync(path.join(tmpdir(), "directive-unreadable-"));
    process.env.TIGUCLAW_HOME = home;
    try {
      const { __resetPathsCache, getPaths } = await import("../../core/paths.js");
      __resetPathsCache?.();
      const md = await import("../../store/self-growth-md.js");
      const file = getPaths().selfGrowthMd;
      const KEY = "regr-user-rule";
      await md.upsertDirective({ key: KEY, text: "사용자가 다듬은 지침", source: "user" });
      const before = readFileSync(file, "utf8");

      let unreadable = "건너뜀(win32·root)";
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        chmodSync(file, 0o000);
        const r = await md.upsertDirective({ key: "regr-other", text: "새 지침", source: "user" });
        chmodSync(file, 0o644);
        unreadable = r === null && readFileSync(file, "utf8") === before ? "ok" : `덮었다(r=${r === null ? "null" : "값"})`;
      }
      const broken = `${before}\n<!-- directive: hand-edited {"key":"hand", 깨진 json} -->\n### 손으로\n사용자 메모\n<!-- /directive -->\n`;
      writeFileSync(file, broken);
      const r2 = await md.upsertDirective({ key: "regr-other2", text: "새 지침", source: "user" });
      const del = await md.deleteDirective(KEY);
      const keptBroken = readFileSync(file, "utf8") === broken;
      const stillReads = (await md.getDirective(KEY))?.text === "사용자가 다듬은 지침";
      out.push(
        assert("일시 읽기 오류면 쓰지 않는다(빈 파일로 보고 덮지 않는다)", unreadable === "ok" || unreadable.startsWith("건너뜀"), unreadable),
        assert(
          "읽지 못한 블록이 있으면 set·retire 둘 다 쓰지 않는다 — 그래도 읽기는 나머지 지침을 그대로 준다",
          r2 === null && del === false && keptBroken && stillReads,
          `upsert=${r2 === null ? "거절" : "썼다"} retire=${del ? "썼다" : "거절"} 파일보존=${keptBroken} 읽기=${stillReads}`,
        ),
      );
    } finally {
      if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prevHome;
      const { __resetPathsCache } = await import("../../core/paths.js");
      __resetPathsCache?.();
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
