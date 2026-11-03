/**
 * 회귀: **확정 지침이 매 턴 실리는 모양** — 0건 비용 0 · user 먼저 · 줄 순서 고정 · 상한 선별 (2026-08-02 → 2026-11-03 이관).
 *
 * ★종전엔 `growth-loop-closes`(자가성장 루프가 닫히는가) 안에 있었다. 그 회귀의 플러그인 스캔은 플러그인과 함께 지웠고,
 *  남는 것은 코어 주입(`formatSelfGrowthDirectives`)의 동작이다 — 확정 지침은 `confirm_feedback`(user)과 옛 자동 지침(auto,
 *  기존 파일에 남은 데이터)을 계속 싣는다. 슬롯의 안정(system) 채널 배치는 `prompt-channel-split` 이, set→실림·retire→빠짐은
 *  `feedback-capture-confirms-to-directives` 가 본다 — 여기는 그 둘이 안 보는 **렌더 규칙**만 본다.
 *
 * 등급: **동작** — 격리 홈의 실제 SELF_GROWTH.md 에 쓰고 실제 주입 함수를 부른다.
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "confirmed-directives-render",
  guards:
    "확정 지침이 0건인데 비용이 들거나, 머리글이 사라진 기능 이름을 달거나, user 가 auto 뒤로 밀리거나, 재발 갱신이 줄 순서를 흔들어 캐시를 깨거나, 상한에서 최근에 다시 확인된 것이 빠지던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ★④ 동작 — 실제로 렌더되는가(문자열 확인 아님).
    const { formatSelfGrowthDirectives } = await import("../../core/prompt-assembly.js");
    const { upsertDirective, deleteDirective } = await import("../../store/self-growth-md.js");
    const empty = formatSelfGrowthDirectives();
    await upsertDirective({
      key: "_regr_growth_loop",
      text: "회귀 검증용 임시 지침.",
      source: "auto",
      group: "probe",
    });
    const withOne = formatSelfGrowthDirectives();
    await deleteDirective("_regr_growth_loop");
    const cleaned = formatSelfGrowthDirectives();
    out.push(
      assert(
        "★지침 0건이면 비용 0, 1건 넣으면 렌더(머리글 `## 확정 지침` — 뺀 기능 이름을 달지 않는다), 지우면 다시 0",
        empty === "" && withOne.split("\n")[0] === "## 확정 지침" && withOne.includes("회귀 검증용 임시 지침") && cleaned === "",
        `빈값=${JSON.stringify(empty)} · 1건=${withOne.length}자 · 정리후=${JSON.stringify(cleaned)}`,
      ),
    );
    // user 확정이 auto 보다 먼저 — auto 는 TTL 대상이라 뒤로 밀려야 한다.
    await upsertDirective({ key: "_regr_a", text: "auto 것", source: "auto" });
    await upsertDirective({ key: "_regr_u", text: "user 것", source: "user" });
    const both = formatSelfGrowthDirectives();
    await deleteDirective("_regr_a");
    await deleteDirective("_regr_u");
    out.push(
      assert(
        "user 확정이 auto 보다 먼저 실린다(영구가 앞, TTL 대상이 뒤)",
        both.indexOf("user 것") < both.indexOf("auto 것"),
        both.replace(/\n/g, " | ").slice(0, 90),
      ),
    );

    // ★순서와 상한 — 줄 순서는 **만든 순서**(재발 갱신이 줄을 흔들면 프리픽스 캐시가 깨진다), 상한에 닿으면 **최근에 다시
    //  확인된 것**을 남긴다(만든 순서로 고르면 계속 재발하는 오래된 지침이 빠졌다 — 2026-10-10 재검토).
    {
      const { renderFile } = await import("../../store/self-growth-md.js");
      const { getPaths } = await import("../../core/paths.js");
      const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
      const long = (tag: string): string => `${tag} ` + "가".repeat(600); // 줄당 ≈1.8KB → 상한(4KB)에 둘만 들어간다
      const mk = (key: string, text: string, createdAt: number, updatedAt: number) => ({ key, text, source: "auto" as const, createdAt, updatedAt });
      const file = getPaths().selfGrowthMd;
      const render = (ds: ReturnType<typeof mk>[]): string => {
        wf(file, renderFile(ds));
        return formatSelfGrowthDirectives();
      };
      const order = (t: string): string => [...t.matchAll(/\] (S\d)/g)].map((m) => m[1]).join(",");
      const small = [mk("s1", "S1 첫째", 1, 1), mk("s2", "S2 둘째", 2, 2), mk("s3", "S3 셋째", 3, 3)];
      const before = order(render(small));
      const afterRefresh = order(render([mk("s1", "S1 첫째", 1, 99), small[1]!, small[2]!])); // S1 이 재발로 갱신됐다
      const capped = order(render([mk("s1", long("S1"), 1, 99), mk("s2", long("S2"), 2, 2), mk("s3", long("S3"), 3, 3)]));
      // user 확정은 만든 시각과 무관하게 맨 앞(재검토: 앞 검사는 user 가 더 늦게 만들어져 정렬 없이도 통과했다)
      const userFirst = order(render([{ ...mk("s1", "S1 사용자", 0, 0), source: "user" as never }, small[1]!, small[2]!]));
      rm(file, { force: true });
      out.push(
        assert(
          "★지침 줄 순서는 만든 순서로 고정(재발 갱신이 줄을 안 흔든다) · 상한이면 최근에 다시 확인된 것을 남긴다",
          before === "S3,S2,S1" && afterRefresh === before && capped === "S3,S1" && userFirst === "S1,S3,S2",
          { 갱신전: before, 갱신후: afterRefresh, 상한: capped, 사용자먼저: userFirst },
        ),
      );
    }

    return out;
  },
};
