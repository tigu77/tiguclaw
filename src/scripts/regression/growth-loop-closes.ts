/**
 * 회귀: **자가성장 루프가 실제로 닫힌다** (2026-08-02, DB 실측에서 나옴).
 *
 * 사용자가 "이게 자가성장이 된다고 볼 수 있나" 라고 물어 DB 를 열었더니 루프가 세 군데
 * 끊겨 있었다. 관측은 도는데(스킬 제안 8건 생성) **5주간 한 건도 닫히지 않았다** —
 * 전부 `created_at == updated_at`.
 *
 *   ①**배달** — 메모리 인덱스는 `ORDER BY updated_at DESC` + 캡 8,192B 인데 실제 합계가
 *     18,669B 였다. 제안은 `updated_at` 이 생성 시각에 고정이라 시간이 갈수록 밀려
 *     **8건 중 5건이 컨텍스트 밖**이었다(실측). 비서는 **못 본 것을 안 본 것으로** 알았다.
 *   ②**수명** — 만료 기계(`archiveStaleReflections`, updatedAt 90일)는 있는데
 *     **시계가 안 갔다**. 재발 안 하는 제안도 영원히 남았다.
 *   ③**적재→행동** — 확정 지침(`SELF_GROWTH.md`)을 코어가 프롬프트에 **안 실었다**.
 *     포인터 메모리가 "작업 전에 Read 하라" 고 말할 뿐이었고 그 포인터도 캡 안에 있었다.
 *
 * ★고친 방식: **새 기계를 만들지 않았다.** ①②는 "재발 시 갱신" 한 줄로 기존 두 기계
 *  (인덱스 정렬·아카이브 TTL)가 제 기능을 하게 했고, ③은 안정 채널 슬롯 하나다.
 *
 * ★자동 채택은 **여전히 안 한다** — 스킬 작성은 능력 표면 변경이라 human-gated.
 *  여기서 고친 건 *신호의 세기와 수명*이지 *결정 권한*이 아니다.
 */
import { readFileSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

export const check: RegressionCheck = {
  name: "growth-loop-closes",
  guards:
    "스킬 제안이 재발해도 갱신 안 돼 인덱스 밖으로 밀리고 만료도 안 되던 것 + 확정 지침이 프롬프트에 안 실리던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ★① 재발이 **갱신**인가 — 무시면 두 기계가 다 죽는다.
    //  ★한 파일이 아니라 **플러그인 전체**를 본다 — 같은 병이 세 곳에 있었다
    //   (skill_proposal · skill_improve · segment reflection · drift). 하나만 고치면
    //   나머지가 남고, 이름을 열거하면 네 번째가 생길 때 빠진다.
    const { readdirSync } = await import("node:fs");
    const srcDir = path.join(REPO, "plugins/self-growth/src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    const OLD = /getMemory\([A-Za-z]+\) !== undefined\) return null;/;
    const stale = files.filter((f) => OLD.test(readFileSync(path.join(srcDir, f), "utf8")));
    out.push(
      assert(
        `★"이미 있으면 무시" 패턴이 self-growth 전체에 없다(${files.length}파일)`,
        stale.length === 0,
        stale.length === 0 ? "잔존 0" : `★잔존: ${stale.join(", ")} — 재발이 신호를 못 키운다`,
      ),
    );
    // 판정이 한 곳인가 — 세 곳이 각자 세면 또 갈린다.
    const analysis = read("plugins/self-growth/src/analysis.ts");
    const skills = read("plugins/self-growth/src/skills.ts");
    out.push(
      assert(
        "★재발 판정·박기가 공용 헬퍼 한 곳이다(isStrongerSignal · upsertReflection)",
        /export const isStrongerSignal/.test(analysis) &&
          /export const upsertReflection/.test(analysis) &&
          /isStrongerSignal\(/.test(skills) &&
          /upsertReflection\(/.test(skills),
        "공용 헬퍼 사용 확인",
      ),
    );
    // 새 관측일 때만 — 같은 창 재스캔까지 갱신하면 만료 시계가 영원히 안 돈다.
    const callers = (analysis + skills).match(/isStrongerSignal\(/g) ?? [];
    out.push(
      assert(
        `신호가 세졌을 때만 갱신한다(호출 ${callers.length}곳)`,
        callers.length >= 4 && /next > prior/.test(analysis),
        `isStrongerSignal 호출 ${callers.length}곳 · 비교식 ${/next > prior/.test(analysis)}`,
      ),
    );

    // ★② 만료 기계가 growth 제안을 대상으로 삼는가(시계가 가면 실제로 걷힌다).
    const eff = read("plugins/self-growth/src/efficiency.ts");
    out.push(
      assert(
        "만료(아카이브)가 growth 산출물을 updatedAt 기준으로 걷는다",
        /startsWith\(`feedback_\$\{SELF_NAMESPACE\}_`\)/.test(eff) &&
          /m\.updatedAt <= cutoffMs/.test(eff),
        "archiveStaleReflections 대상 확인",
      ),
    );
    // 삭제가 아니라 아카이브여야 한다(정리 ≠ 삭제 — 콜드 레코드 보존).
    out.push(
      assert(
        "만료는 아카이브다(물리 삭제 0 — 콜드 레코드 보존)",
        /archiveMemory\(m\.name\)/.test(eff) && !/deleteMemory\(m\.name\)/.test(eff),
        /archiveMemory/.test(eff) ? "아카이브 확인" : "★물리 삭제",
      ),
    );

    // ★③ 확정 지침이 **매 턴 실리는가** — 여기가 비면 앞의 관측·확정이 전부 무의미하다.
    const pa = read("src/core/prompt-assembly.ts");
    out.push(
      assert(
        "★확정 지침(SELF_GROWTH.md)이 컨텍스트 슬롯으로 실린다",
        /\{ key: "selfGrowth", text: formatSelfGrowthDirectives\(\), channel: "system" \}/.test(pa),
        /formatSelfGrowthDirectives/.test(pa) ? "슬롯 확인" : "★루프 마지막 칸이 비어 있다",
      ),
    );
    // 안정 채널이어야 한다 — user 채널로 새면 매 턴 프리픽스 캐시가 깨진다.
    out.push(
      assert(
        "지침 슬롯이 안정(system) 채널이다(캐시 파괴 0)",
        /key: "selfGrowth"[^}]*channel: "system"/.test(pa),
        "system 채널 확인",
      ),
    );

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
        "★지침 0건이면 비용 0, 1건 넣으면 렌더, 지우면 다시 0",
        empty === "" && withOne.includes("회귀 검증용 임시 지침") && cleaned === "",
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

    // ★⑤ 자동 채택 금지가 유지되는가 — 신호를 키운 것이지 권한을 준 게 아니다.
    out.push(
      assert(
        "★제안은 여전히 제안이다(스킬 작성은 human-gated)",
        /execution_boundary/.test(skills) && /self-growth 는 제안만/.test(skills),
        /self-growth 는 제안만/.test(skills) ? "경계 문구 유지" : "★자율 작성으로 넘어감",
      ),
    );
    return out;
  },
};
