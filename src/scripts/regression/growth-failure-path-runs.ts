/**
 * 회귀: **반복 실패 학습 경로를 실제로 돌린다** (2026-10-09 전체 적대 검토 G).
 *
 * 종전엔 `analyzeFailurePattern` 을 실행하는 검사가 0건이었다. 그 사이 세 결함이 살아 있었다:
 *  ① SELF_GROWTH.md 를 읽다 일시 오류(권한·핸들 고갈)가 나면 «빈 파일» 로 보고 새 지침 하나로 덮어 —
 *     사용자가 승격한 지침까지 통째로 사라졌다. 손으로 고치다 머리 줄이 깨진 블록도 같은 길로 버려졌다.
 *  ② 같은 실패가 재발할 때마다 «행동 지침을 자동 반영했습니다» 알림·이벤트가 다시 나갔다(새로 바뀐 게 없는데).
 *  ③ 재발해도 지침의 만료 시계가 갱신되지 않아, 계속 재발하는 실패의 지침도 120일 뒤 사라졌다.
 *
 * 등급: **동작** — 격리 홈의 실제 DB·실제 SELF_GROWTH.md. LLM 판단은 회귀 가드가 막아 «불확실» 로 떨어진다(그 갈래도 실제 경로).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Result = { memoryName: string; autoLanded: boolean; target: string; landedNow: boolean } | null;

export const check: RegressionCheck = {
  name: "growth-failure-path-runs",
  guards: "반복 실패 학습이 일시 읽기 오류에 지침을 통째로 지우던 것 · 재발마다 «반영했습니다» 를 다시 보내던 것 · 재발해도 만료 시계가 안 돌던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const prevHome = process.env.TIGUCLAW_HOME;
    const home = mkdtempSync(path.join(tmpdir(), "growth-failure-"));
    process.env.TIGUCLAW_HOME = home;
    try {
      const { __resetPathsCache, getPaths } = await import("../../core/paths.js");
      __resetPathsCache?.();
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const md = await import("../../store/self-growth-md.js");
      const { analyzeFailurePattern } = await loadPluginModule<{
        analyzeFailurePattern: (i: { errorKind: string; adapter: string; message: string; count: number }) => Promise<Result>;
      }>("../../../plugins/self-growth/src/failure.ts");
      const file = getPaths().selfGrowthMd;
      const failure = { errorKind: "timeout", adapter: "codex", message: "upstream timed out after 30s", count: 3 };

      // ② 재발은 새 소식이 아니다
      const first = await analyzeFailurePattern(failure);
      const second = await analyzeFailurePattern(failure);
      out.push(
        assert(
          "② 처음은 «새로 기록», 재발은 «이미 있음» — 알림·이벤트는 처음 한 번만",
          first?.landedNow === true && second?.landedNow === false && second?.memoryName === first?.memoryName,
          `1차=${first?.landedNow} 2차=${second?.landedNow}`,
        ),
      );

      // ③ 지침이 있는 실패가 재발하면 만료 시계를 다시 건다(본문·출처는 그대로, 알림 없음)
      const directiveKey = (first?.memoryName ?? "").replace(/^feedback_growth_failure_/, "failure_");
      await md.upsertDirective({ key: directiveKey, text: "사용자가 다듬은 지침", source: "user" });
      const old = Date.now() - 100 * 24 * 3600_000;
      writeFileSync(file, readFileSync(file, "utf8").replace(/"updatedAt":\d+/, `"updatedAt":${old}`));
      const third = await analyzeFailurePattern(failure);
      const after = await md.getDirective(directiveKey);
      out.push(
        assert(
          "③ 재발하면 지침의 만료 시계를 갱신한다 — 본문·출처는 그대로, 새 소식은 아니다",
          third?.target === "directive" && third.landedNow === false && (after?.updatedAt ?? 0) > old + 1000 &&
            after?.text === "사용자가 다듬은 지침" && after?.source === "user",
          `target=${third?.target} landedNow=${third?.landedNow} updatedAt갱신=${(after?.updatedAt ?? 0) > old + 1000} source=${after?.source}`,
        ),
      );

      // ① 못 읽으면 쓰지 않는다 · 깨진 블록이 있으면 쓰지 않는다
      const before = readFileSync(file, "utf8");
      let unreadable = "건너뜀(win32·root)";
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        chmodSync(file, 0o000);
        const r = await md.upsertDirective({ key: "failure_other", text: "새 지침" });
        chmodSync(file, 0o644);
        unreadable = r === null && readFileSync(file, "utf8") === before ? "ok" : `덮었다(r=${r === null ? "null" : "값"})`;
      }
      const broken = `${before}\n<!-- directive: hand-edited {"key":"hand", 깨진 json} -->\n### 손으로\n사용자 메모\n<!-- /directive -->\n`;
      writeFileSync(file, broken);
      const r2 = await md.upsertDirective({ key: "failure_other2", text: "새 지침" });
      const keptBroken = readFileSync(file, "utf8") === broken;
      const stillReads = (await md.getDirective(directiveKey))?.text === "사용자가 다듬은 지침";
      out.push(
        assert("① 일시 읽기 오류면 쓰지 않는다(빈 파일로 보고 덮지 않는다)", unreadable === "ok" || unreadable.startsWith("건너뜀"), unreadable),
        assert(
          "① 읽지 못한 블록이 있으면 쓰지 않는다 — 그래도 읽기는 나머지 지침을 그대로 준다",
          r2 === null && keptBroken && stillReads,
          `upsert=${r2 === null ? "거절" : "썼다"} 파일보존=${keptBroken} 읽기=${stillReads}`,
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
