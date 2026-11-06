/**
 * 회귀: **미설정 사용자의 codex 기본 모델 = 공식 Codex 가 고르는 모델** (2026-11-05, 정태님 승인 — v0.82).
 *
 * 사고: 빌트인 풀의 codex 모델을 `/models` 응답의 **첫 원소**로 골랐다 — «응답이 최신·추천순» 이라는 확인 안 된 전제다.
 *  공식(openai/codex `388aee4b`)은 `priority` 오름차순 안정 정렬 → `visibility == list` 첫 모델이고, 원격에 노출 모델이 없거나
 *  비면 번들 카탈로그로 보충한다. 공식 번들 카탈로그조차 배열 첫 원소(priority 2)와 기본(priority 1)이 다르다.
 * 본다: 공식 규칙(순서 무관·동률=응답 순서·숨김 건너뜀)·고르지 않음(노출 0·빈 목록·누락·범위 밖·알 수 없는 값·만료 → 정적 표) ·
 *  신선도=마지막 성공(같은 응답 재성공도 기록, 실패는 연장 안 함) · 실제 갱신→디스크→**갱신 없는 새 프로세스**의 첫 선택 ·
 *  필드 하나씩의 변경/철회 전이 · 실행 풀=`/models`=대시보드 · 표시 목록 원순서 · 다른 provider 정책·키 불변.
 * 등급: **실행**(단위는 실제 함수, 흐름은 자식 프로세스).
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_codex-default-child.ts");
const DAY = 86_400_000;
type J = {
  before?: string | null; selected?: string | null; runtime?: string | null; pool?: string | null; screen?: string | null;
  dashboard?: string | null; models?: string[] | null; diskPriority?: Record<string, number> | null;
  diskVisibility?: Record<string, string> | null; diskSucceededAt?: number | null; now?: number; error?: string;
  diskReasoning?: Record<string, string> | null; diskFloor?: Record<string, string> | null; diskToolSearch?: Record<string, boolean> | null;
  diskAnthropic?: { models: string[] | null; succeededAt: number | null }; memReasoning?: string | null; memToolSearch?: boolean | null;
};
const step = async (mode: string, home: string): Promise<J> => {
  const r = await spawnWithin(60_000, `codex-default(${mode})`, ["--import", "tsx", CHILD, mode, home], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  return line === undefined ? { error: r.err.slice(-300) } : (JSON.parse(line) as J);
};
const STATIC = "codex:gpt-5.5";
/** 실행·화면·대시보드가 모두 같은 codex 스펙인가. */
const sameEverywhere = (j: J, spec: string): boolean =>
  j.runtime === spec && j.pool === spec && j.screen === spec && j.dashboard === spec;
/** 갱신 뒤 선택과 그 값이 세 소비처에 같은가(`null` = 고르지 않음 → 정적 표). */
const lands = (j: J, model: string | null): boolean =>
  j.selected === model && sameEverywhere(j, model === null ? STATIC : `codex:${model}`);
const s = (j: J): string => JSON.stringify(j).slice(0, 400);

export const check: RegressionCheck = {
  name: "codex-default-official-priority",
  guards: "미설정 사용자의 codex 기본 모델을 /models 응답 첫 원소로 고르던 것 — 공식 Codex 는 priority·visibility 로 고른다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const cat = await import("../../core/llm-runtime/model-catalog.js");
    const pick = (rows: Array<[string, unknown, unknown]>, succeeded: number | null = Date.now(), fetchedAt = Date.now()): string | null => {
      const priority: Record<string, number> = {};
      const visibility: Record<string, string> = {};
      for (const [slug, p, v] of rows) {
        if (p !== undefined) priority[`codex:${slug}`] = p as number;
        if (v !== undefined) visibility[`codex:${slug}`] = v as string;
      }
      cat.__setCatalogForTest({
        fetchedAt, models: { codex: rows.map((r) => r[0]) }, priority, visibility,
        ...(succeeded === null ? {} : { succeededAt: { codex: succeeded } }),
      });
      return cat.catalogDefaultModel("codex") ?? null;
    };
    try {
      const byPriority = pick([["a", 2, "list"], ["b", 1, "list"], ["c", 7, "list"]]);
      const hidden = pick([["auto", 0, "hide"], ["n", 1, "none"], ["s", 2, "list"]]);
      const ties = [pick([["x", 3, "list"], ["y", 3, "list"]]), pick([["y", 3, "list"], ["x", 3, "list"]])];
      const missing = pick([["a", 1, "list"], ["b", undefined, "list"]]);
      const unknownVis = pick([["a", 1, "list"], ["b", 2, "experimental"]]);
      const i32 = [pick([["a", 2_147_483_648, "list"]]), pick([["a", -2_147_483_649, "list"]]), pick([["a", 1.5, "list"]]),
        pick([["a", -2_147_483_648, "list"], ["b", 2_147_483_647, "list"]])];
      const emptyList = pick([]);
      const fresh = [pick([["a", 1, "list"]], null), pick([["a", 1, "list"]], Date.now() - 8 * DAY),
        pick([["a", 1, "list"]], Date.now(), Date.now() - 8 * DAY)];
      out.push(
        assert("★배열 순서가 아니라 priority 로 고른다(첫 원소 priority 2 · 최소 priority 1)", byPriority === "b", byPriority),
        assert("★동률은 응답 순서(안정 정렬) — 순서를 뒤집으면 답도 뒤집힌다", ties[0] === "x" && ties[1] === "y", ties),
        assert("★숨김(hide·none) 모델은 priority 가 더 작아도 건너뛴다", hidden === "s", hidden),
        assert("★노출 모델이 없으면 고르지 않는다(공식은 번들로 보충 — 우리 번들 자리는 정적 표)",
          pick([["h2", 5, "hide"], ["h1", 4, "none"]]) === null, String(pick([["h2", 5, "hide"], ["h1", 4, "none"]]))),
        assert("★한 모델이라도 priority 가 없으면 고르지 않는다(전부-아니면-없음 → 정적 표)", missing === null, String(missing)),
        assert("알 수 없는 visibility 값이면 고르지 않는다", unknownVis === null, String(unknownVis)),
        assert("★priority 는 i32 — 범위 밖(위·아래)·소수면 고르지 않고 경계값은 받는다",
          i32[0] === null && i32[1] === null && i32[2] === null && i32[3] === "a", i32),
        assert("빈 목록이면 고르지 않는다", emptyList === null, String(emptyList)),
        assert("★마지막 성공 조회가 없거나(옛 캐시) 7일 넘었으면 고르지 않는다 — 전역 fetchedAt 이 아니라 성공 시각",
          fresh[0] === null && fresh[1] === null && fresh[2] === "a", fresh),
      );
      // 7일 경계 — 시계를 고정해 결정적으로 본다(정확히 7일은 아직 신선, 1ms 넘으면 만료).
      const realNow = Date.now;
      const T = realNow();
      Date.now = () => T;
      try {
        const edge = pick([["a", 1, "list"]], T - 7 * DAY, T);
        const past = pick([["a", 1, "list"]], T - 7 * DAY - 1, T);
        out.push(assert("★7일 경계 — 정확히 7일은 신선, 그보다 1ms 오래되면 고르지 않는다", edge === "a" && past === null, `${String(edge)}/${String(past)}`));
      } finally {
        Date.now = realNow;
      }
      // 다른 provider 정책 불변 — anthropic 은 패밀리(순위 재료가 있어도 안 쓴다), 순서 없는 목록은 고르지 않는다.
      cat.__setCatalogForTest({
        fetchedAt: Date.now(), unranked: ["zzcompat"],
        models: { anthropic: ["claude-fable-9", "claude-opus-9"], zzcompat: ["emb", "chat"] },
        priority: { "anthropic:claude-fable-9": 0 }, visibility: { "anthropic:claude-fable-9": "list" },
        succeededAt: { anthropic: Date.now() },
      });
      out.push(assert("anthropic·순서 없는 provider 선택은 그대로",
        cat.catalogDefaultModel("anthropic") === "claude-opus-9" && cat.catalogDefaultModel("zzcompat") === undefined,
        `${cat.catalogDefaultModel("anthropic")}/${String(cat.catalogDefaultModel("zzcompat"))}`));
    } finally {
      cat.__setCatalogForTest(null);
    }

    // ── 실제 갱신 → 디스크 → 갱신 없는 새 프로세스 ───────────────────────────────
    // 자식은 순서대로 같은 홈을 이어 쓴다. `restart` = 갱신 없이 디스크만 읽는 새 프로세스(재시작 직후 첫 턴).
    const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "codex-default-"));
    const run = async (modes: string[]): Promise<J[]> => {
      const r: J[] = [];
      for (const m of modes) r.push(await step(m, home));
      return r;
    };
    const [seed, first, rs1, ageGlobal] = await run(["seed-old", "first", "restart", "age-global"]);
    out.push(
      assert("옛 캐시(메타·성공 시각 없음)·갱신 전 → 고르지 않고 정적 표 — 실행·화면·대시보드 같음",
        seed.before === null && lands(seed, null), s(seed)),
      assert("★갱신 뒤 공식 기본(priority 최소 노출) — 실행·`/models`·대시보드가 같은 값",
        first.before === null && lands(first, "m-sol"), s(first)),
      assert("표시 목록은 백엔드 순서 그대로 · 다른 provider 의 메타는 안 지운다",
        JSON.stringify(first.models) === JSON.stringify(["m-astra", "m-sol", "m-terra", "auto-review"])
          && first.diskPriority?.["other:x"] === 3 && first.diskVisibility?.["other:x"] === "list",
        s(first)),
      assert("★재시작 직후 갱신 전 첫 선택이 갱신 뒤와 같다(디스크 복원)", rs1.before === "m-sol" && lands(rs1, "m-sol"), s(rs1)),
      assert("전역 fetchedAt 이 8일 전이어도 마지막 성공이 최근이면 그대로", ageGlobal.before === "m-sol", s(ageGlobal)),
    );

    // 신선도 — 같은 응답의 재성공도 성공 시각을 디스크까지 갱신하고, 실패는 연장하지 않는다.
    const [age6, same, rs2, age8, failExpired, rs3] = await run(["age6", "same", "restart", "age8", "fail", "restart"]);
    const t6 = age6.diskSucceededAt ?? 0;
    const t8 = age8.diskSucceededAt ?? 0;
    out.push(
      assert("6일 된 성공은 아직 신선(선택 유지)", age6.before === "m-sol" && (age6.now ?? 0) - t6 >= 6 * DAY - 60_000, s(age6)),
      assert("★내용이 같은 응답을 다시 받아도 성공 시각이 지금으로 디스크에 기록된다",
        (same.diskSucceededAt ?? 0) > t6 + 5 * DAY && (same.now ?? 0) - (same.diskSucceededAt ?? 0) < 60_000 && lands(same, "m-sol"), s(same)),
      assert("…그래서 재시작 직후에도 같은 선택", rs2.before === "m-sol", s(rs2)),
      assert("8일 된 성공이면 고르지 않는다(정적 표)", age8.before === null && lands(age8, null), s(age8)),
      assert("★만료 상태에서 조회가 실패해도 성공 시각은 그대로(실패가 신선도를 연장하지 않는다) · 선택 없음 유지",
        failExpired.before === null && lands(failExpired, null) && failExpired.diskSucceededAt === t8 && rs3.before === null, s(failExpired)),
    );

    // 필드 하나씩의 전이 — 매번 BASE 로 되돌린 뒤 한 필드만 바꾸고, 갱신 없는 재시작까지 본다.
    const [, repri, rsR, , hide, rsH] = await run(["first", "reprioritize", "restart", "first", "hide", "restart"]);
    const [, wp, rsWp, , wv, rsWv] = await run(["first", "withdraw-priority", "restart", "first", "withdraw-visibility", "restart"]);
    const [, hiddenOnly, rsHo, preEmpty, empty, rsE, back, fail] = await run(["first", "hidden-only", "restart", "first-rich", "empty", "restart", "first", "fail"]);
    const gone = (j: J, slug: string): boolean =>
      j.diskPriority?.[`codex:${slug}`] === undefined && j.diskVisibility?.[`codex:${slug}`] === undefined;
    out.push(
      assert("★priority 만 바뀌어도 선택·디스크·재시작이 따라간다",
        lands(repri, "m-terra") && repri.diskPriority?.["codex:m-terra"] === 0 && repri.diskVisibility?.["codex:m-terra"] === "list" && rsR.before === "m-terra",
        `${s(repri)} / ${s(rsR)}`),
      assert("★visibility 만 바뀌어도(최우선이 숨겨짐) 다음 노출 모델로 · priority 는 그대로 · 재시작도 같음",
        lands(hide, "m-astra") && hide.diskVisibility?.["codex:m-sol"] === "hide" && hide.diskPriority?.["codex:m-sol"] === 1 && rsH.before === "m-astra",
        `${s(hide)} / ${s(rsH)}`),
      assert("★priority 철회 → 옛 값이 디스크에 남지 않고 고르지 않는다 · 재시작도 같음 · 다른 provider 키 보존",
        lands(wp, null) && gone(wp, "m-astra") && wp.diskPriority?.["other:x"] === 3 && rsWp.before === null && lands(rsWp, null),
        `${s(wp)} / ${s(rsWp)}`),
      assert("★visibility 철회 → 옛 값이 디스크에 남지 않고 고르지 않는다 · 재시작도 같음",
        lands(wv, null) && gone(wv, "m-astra") && wv.diskVisibility?.["other:x"] === "list" && rsWv.before === null,
        `${s(wv)} / ${s(rsWv)}`),
      assert("★노출 모델 없는 성공 응답 → 고르지 않는다(숨김 모델을 기본으로 쓰지 않는다) · 재시작도 같음",
        lands(hiddenOnly, null) && rsHo.before === null, `${s(hiddenOnly)} / ${s(rsHo)}`),
      assert("★빈 목록 성공 응답 → 옛 추천이 살아남지 않는다(목록·메타 교체, 성공 시각 기록) · 재시작도 같음",
        empty.before === "m-sol" && lands(empty, null) && JSON.stringify(empty.models) === "[]" && gone(empty, "m-sol")
          && (empty.now ?? 0) - (empty.diskSucceededAt ?? 0) < 60_000 && rsE.before === null,
        `${s(empty)} / ${s(rsE)}`),
      assert("★빈 성공 응답은 codex 의 부수 메타(설계 강도·최저 강도·도구 검색)도 교체한다 — 갱신 전엔 있었다",
        preEmpty.memReasoning === "low" && preEmpty.memToolSearch === true && preEmpty.diskReasoning?.["codex:m-sol"] === "low"
          && empty.memReasoning === null && empty.memToolSearch === null
          && empty.diskReasoning?.["codex:m-sol"] === undefined && empty.diskFloor?.["codex:m-sol"] === undefined
          && empty.diskToolSearch?.["codex:m-sol"] === undefined,
        `${s(preEmpty)} / ${JSON.stringify({ r: empty.diskReasoning, f: empty.diskFloor, t: empty.diskToolSearch, mr: empty.memReasoning })}`),
      assert("★다른 provider(anthropic)의 빈 성공 응답은 종전처럼 건너뛴다 — 목록·메타·성공 시각 보존",
        JSON.stringify(empty.diskAnthropic) === JSON.stringify({ models: ["claude-opus-9"], succeededAt: 12_345 })
          && empty.diskReasoning?.["anthropic:claude-opus-9"] === "high",
        JSON.stringify({ a: empty.diskAnthropic, r: empty.diskReasoning })),
      assert("조회 실패면 직전 목록·메타 보존(같은 선택)",
        lands(back, "m-sol") && fail.before === "m-sol" && lands(fail, "m-sol"), `${s(back)} / ${s(fail)}`),
    );
    return out;
  },
};
