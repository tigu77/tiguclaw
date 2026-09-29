/**
 * 회귀: **옛 `.env` 모델 설정(REGION_A_MODELS·MODEL_TIER_*)은 한 번 프로파일로 옮겨지고, 런타임은 그 env 를 읽지 않는다** (2026-09-29).
 *
 * 정태님 결정(«A: 한 번 옮기고 없애기»): 모델은 세션 기본 프로파일 → 빌트인, 두 층이다. 사이에 끼어 있던 옛 env 층을 없앤다.
 * ★옮기다 드러난 원래 결함: 설치 마법사가 2026-08-24 부터 프로파일을 **메모리 모양(`{ spec }`)** 으로 써서 통째로 무시됐다 —
 *  수동 모드 설치는 사실 `.env` 의 REGION_A_MODELS 로 돌고 있었다. 그래서 이 검사는 «옮긴 게 **읽히는가**» 까지 본다.
 * 러너의 공유 홈 settings.json 을 쓰므로 앞뒤로 원본을 되돌린다(`gateway-models-list-matches-resolution` 과 같은 방식).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "legacy-model-env-migrates",
  guards:
    "옛 .env 모델 줄이 프로파일과 나란히 두 번째 층으로 남아 /model·doctor 가 틀리게 말하던 것 + 마법사가 읽히지 않는 모양으로 프로파일을 써서 수동 설치가 .env 로 돌던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { planLegacyModelMigration, migrateLegacyModelEnv } = await import("../../core/legacy-model-env.js");
    const { loadModelProfiles, getDefaultProfileName, profileToSettingsJson } = await import("../../core/settings.js");
    const { resolveModelSpecs, resolveTier, specLabel, describeBasePool } = await import("../../core/llm-runtime/index.js");
    const { getPaths } = await import("../../core/paths.js");

    // 키 순서와 무관한 비교(읽기 쪽이 키를 다른 순서로 채운다).
    const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
      x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x);
    // ① 판정 — 순수 함수.
    const BUILTIN = ["anthropic:claude-opus-5"];
    const same = planLegacyModelMigration({ REGION_A_MODELS: "codex:a,anthropic:b", MODEL_TIER_HIGH: "codex:a, anthropic:b", MODEL_TIER_MID: "anthropic:m", MODEL_TIER_LOW: "anthropic:c" }, 0, BUILTIN);
    const diff = planLegacyModelMigration({ REGION_A_MODELS: "codex:main", MODEL_TIER_HIGH: "codex:a" }, 0, BUILTIN);
    // ★등급만(자동 설치에 MODEL_TIER_NANO 만 적은 모양) — 메인은 옛날처럼 **빌트인**이어야 한다(적대 검토 P-1: 종전엔 nano 가 메인이 됐다).
    const tiersOnly = planLegacyModelMigration({ MODEL_TIER_NANO: "ollama:q" }, 0, BUILTIN);
    const tiersOnlyNoAuth = planLegacyModelMigration({ MODEL_TIER_NANO: "ollama:q" }, 0, []);
    out.push(
      assert(
        "★판정: 메인이 등급과 같으면 그 등급이 기본 · 다르면 `default` · ★등급만이면 지금 빌트인 메인을 `default` 로(메인이 등급으로 안 바뀐다) · ★인증 0 이면 아직 안 옮김(자리표시가 메인으로 굳지 않게 · 첫 프로파일이 메인이 되지 않게) · 이미 홈 프로파일이 있거나 값이 없으면 안 옮김",
        same?.defaultName === "high" && Object.keys(same.profiles).join(",") === "high,mid,low" && !same.frozeBuiltinMain &&
          diff?.defaultName === "default" && diff.profiles.default?.pool[0]?.spec === "codex:main" && diff.profiles.high !== undefined &&
          tiersOnly?.defaultName === "default" && tiersOnly.profiles.default?.pool[0]?.spec === "anthropic:claude-opus-5" && tiersOnly.frozeBuiltinMain &&
          tiersOnly.profiles.nano !== undefined && tiersOnlyNoAuth === null &&
          planLegacyModelMigration({ REGION_A_MODELS: "codex:a" }, 1, BUILTIN) === null && planLegacyModelMigration({ REGION_A_MODELS: " " }, 0, BUILTIN) === null,
        { same, diff, tiersOnly, tiersOnlyNoAuth },
      ),
    );

    // ② 실제로 옮긴다 — 읽히는 모양·백업(원본)·합치기·한 번만(표식)·옮긴 뒤 해석이 같다·깨진 파일은 안 건드림.
    const file = getPaths().settings;
    const backupFile = `${file}.before-legacy-model-env`;
    const marker = `${file}.legacy-model-env-migrated`;
    const prev = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const cleanup = () => { rmSync(backupFile, { force: true }); rmSync(marker, { force: true }); };
    // ★데몬 cwd 에 프로젝트 프로파일이 있어도 홈 판정은 홈만 본다(적대 검토 P-3) — 이 cwd 로 확인한다.
    const cwd = mkdtempSync(path.join(tmpdir(), "legacy-model-cwd-"));
    mkdirSync(path.join(cwd, ".tiguclaw"), { recursive: true });
    writeFileSync(path.join(cwd, ".tiguclaw", "settings.json"), JSON.stringify({ models: { profiles: { proj: { pool: ["anthropic:proj"] } } } }));
    const prevCwd = process.cwd();
    try {
      cleanup();
      // 마법사가 5주 동안 써 온 모양(읽히지 않는 `{ spec }`) + 무관한 원문 항목 + 옛 .env — 이 설치는 사실 env 로 돌고 있었다.
      const original = JSON.stringify({ theme: "dark", models: { profiles: { high: { pool: [{ spec: "codex:gpt-6-sol" }] }, typo: { pool: "oops" } }, default: "high" } });
      writeFileSync(file, original);
      process.chdir(cwd);
      const env = { REGION_A_MODELS: "codex:gpt-6-sol,anthropic:claude-opus-5", MODEL_TIER_HIGH: "codex:gpt-6-sol,anthropic:claude-opus-5", MODEL_TIER_MID: "anthropic:claude-sonnet-5", MODEL_TIER_LOW: "anthropic:claude-haiku-4-5" };
      const moved = migrateLegacyModelEnv(env, () => BUILTIN);
      const home = getPaths().home;
      const after = loadModelProfiles(home);
      const def = getDefaultProfileName(home); // 아래에서 파일을 비우기 전에 잡는다.
      const raw = JSON.parse(readFileSync(file, "utf8")) as { theme?: string; models?: { profiles?: Record<string, unknown> } };
      const backupIsOriginal = existsSync(backupFile) && readFileSync(backupFile, "utf8") === original;
      const main = resolveModelSpecs(undefined, home).map(specLabel).join(",");
      const mid = resolveTier("mid", home).map(specLabel).join(",");
      const low = resolveTier("low", home).map(specLabel).join(",");
      // ★한 번만 — 사용자가 프로파일을 비워도(자동으로 되돌리려는 의도) 다시 옮기지 않는다(적대 검토 P-2).
      writeFileSync(file, JSON.stringify({ theme: "dark", models: { profiles: {} } }));
      const again = migrateLegacyModelEnv(env, () => BUILTIN);
      const stillEmpty = Object.keys(loadModelProfiles(home)).length === 0 && readFileSync(backupFile, "utf8") === original;
      out.push(
        assert(
          "★읽히지 않던 시드 + 옛 .env → 읽히는 프로파일(프로젝트 층이 있어도 홈만 판정) · 다른 설정·무관한 원문 항목 보존 · 백업은 **원본** · 메인·mid·low 가 옛 env 와 같은 모델 · 비운 뒤 재부팅해도 다시 안 옮기고 백업도 안 덮는다",
          moved?.join(",") === "high,mid,low" && Object.keys(after).join(",") === "high,mid,low" && def === "high" &&
            raw.theme === "dark" && raw.models?.profiles?.typo !== undefined && backupIsOriginal &&
            main === "codex:gpt-6-sol,anthropic:claude-opus-5" && mid === "anthropic:claude-sonnet-5" && low === "anthropic:claude-haiku-4-5" &&
            again === null && stillEmpty,
          { moved, after: Object.keys(after), def, theme: raw.theme, typo: raw.models?.profiles?.typo !== undefined, main, mid, low, backupIsOriginal, again, stillEmpty },
        ),
      );
      // ★기본 지정이 실제로 쓰인다 — 메인이 `low` 와 같으면 기본은 low 인데 첫 프로파일은 high 다(포인터가 없으면 high 로 샌다 — G-1).
      //  + 백업은 **처음 원본만** — 앞선 시도가 백업을 만들고 표식 전에 죽었으면 그 백업을 덮지 않는다(P-2b).
      cleanup();
      writeFileSync(file, "{}");
      writeFileSync(backupFile, "OLDEST");
      migrateLegacyModelEnv({ REGION_A_MODELS: "anthropic:claude-haiku-4-5", MODEL_TIER_HIGH: "codex:gpt-6-sol", MODEL_TIER_LOW: "anthropic:claude-haiku-4-5" }, () => BUILTIN);
      const lowMain = resolveModelSpecs(undefined, home).map(specLabel).join(",");
      const keptOldest = readFileSync(backupFile, "utf8") === "OLDEST";
      out.push(
        assert(
          "★메인이 low 와 같으면 기본=low(첫 프로파일 high 로 새지 않는다) · 백업은 처음 원본만(덮지 않는다)",
          lowMain === "anthropic:claude-haiku-4-5" && keptOldest,
          { lowMain, keptOldest },
        ),
      );
      // 깨진 settings.json — 그 위에 덮지 않는다(백업·표식도 안 남긴다: 다음 부팅에 고쳐지면 그때 옮긴다).
      cleanup();
      writeFileSync(file, "{ 깨진");
      const broken = migrateLegacyModelEnv(env, () => BUILTIN);
      out.push(
        assert(
          "깨진 settings.json 은 덮지 않는다 · 표식·백업을 남기지 않아 고쳐진 뒤 다음 부팅에 옮긴다",
          broken === null && readFileSync(file, "utf8") === "{ 깨진" && !existsSync(marker) && !existsSync(backupFile),
          { broken, marker: existsSync(marker), backup: existsSync(backupFile) },
        ),
      );
      // ★인증 0(빌트인 메인이 빔) · 등급만 — 이번엔 **안 옮긴다**: 설정·표식·백업 없음. 인증이 생긴 부팅에서 옮긴다
      //  (재검토 P-A: 자리표시 `anthropic:(default)` 가 메인으로 영구히 굳었다 · G: 보류 때 표식을 쓰거나 콜백을 무시해도 초록이었다).
      cleanup();
      rmSync(file, { force: true });
      const tierEnv = { MODEL_TIER_HIGH: "anthropic:claude-opus-5" };
      const deferred = [migrateLegacyModelEnv(tierEnv, () => []), migrateLegacyModelEnv(tierEnv, () => [])];
      const deferredClean = !existsSync(file) && !existsSync(marker) && !existsSync(backupFile);
      const later = migrateLegacyModelEnv(tierEnv, () => BUILTIN);
      const laterDef = getDefaultProfileName(home);
      const laterMain = loadModelProfiles(home)[laterDef]?.pool.map((e) => e.spec).join(",");
      out.push(
        assert(
          "★인증 0 이면 등급만 있는 env 를 옮기지 않는다(설정·표식·백업 없음 · 몇 번 부팅해도) · 인증이 생긴 부팅에서 빌트인 메인을 기본으로 옮긴다",
          deferred.every((r) => r === null) && deferredClean &&
            later !== null && laterDef === "default" && laterMain === BUILTIN.join(",") && existsSync(marker),
          { deferred, deferredClean, later, laterDef, laterMain },
        ),
      );
      // 쓰는 모양 — 읽기의 **거울**: 파일로 쓰고 다시 읽으면 같은 프로파일이다(색·설명·폴백·강도·속도).
      const prof = { description: "d", pool: [{ spec: "a:b" }, { spec: "c:d", reasoning: "high", speed: "fast" as const }], fallback: "low", color: "#12ab34" };
      writeFileSync(file, JSON.stringify({ models: { profiles: { rt: profileToSettingsJson(prof) } } }));
      const back = loadModelProfiles(home).rt;
      out.push(
        assert(
          "★프로파일 → 파일 모양 → 다시 읽기가 왕복한다(색·설명·폴백·강도·속도 보존)",
          canon(back) === canon(prof),
          { back, prof },
        ),
      );
    } finally {
      process.chdir(prevCwd);
      if (prev === undefined) rmSync(file, { force: true }); else writeFileSync(file, prev);
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }

    // ②-b ★옛 env 는 **어떤 모양으로도** 안 읽힌다 — 프로파일 0개에서 env 를 깔고 메인·등급·게이트웨이 풀을 동작으로 본다
    //  (정규식 잔재 검사는 `process.env["…"]` 같은 괄호 접근을 못 봤다 — 적대 검토 G-2).
    {
      const saved = { ...process.env };
      const file2 = getPaths().settings;
      const prev2 = existsSync(file2) ? readFileSync(file2, "utf8") : undefined;
      try {
        writeFileSync(file2, "{}");
        Object.assign(process.env, { REGION_A_MODELS: "codex:legacy-main", MODEL_TIER_HIGH: "codex:legacy-high", MODEL_TIER_MID: "codex:legacy-mid", MODEL_TIER_LOW: "codex:legacy-low", MODEL_TIER_NANO: "codex:legacy-nano" });
        const { resolveGatewayRuntime } = await import(new URL("../../../plugins/http-bridge/gateway.ts", import.meta.url).href) as { resolveGatewayRuntime: () => { poolRaw: string } };
        const seen = [
          ...resolveModelSpecs(undefined, getPaths().home), ...resolveTier("high"), ...resolveTier("mid"), ...resolveTier("low"), ...resolveTier("nano"),
        ].map((s) => s.model);
        const gw = resolveGatewayRuntime().poolRaw;
        const base = describeBasePool(getPaths().home);
        out.push(
          assert(
            "★프로파일이 없어도 옛 env 는 메인·high·mid·low·nano·게이트웨이 풀 어디에도 안 쓰인다 · 출처는 빌트인",
            !seen.some((m) => m.startsWith("legacy-")) && !gw.includes("legacy-") && base.source === "builtin",
            { seen, gw, base: base.source },
          ),
        );
      } finally {
        for (const k of ["REGION_A_MODELS", "MODEL_TIER_HIGH", "MODEL_TIER_MID", "MODEL_TIER_LOW", "MODEL_TIER_NANO"]) {
          if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
        if (prev2 === undefined) rmSync(file2, { force: true }); else writeFileSync(file2, prev2);
      }
    }
    // ②-c 출처 판정 — 기본 프로파일이 안 풀리면 «프로파일» 이라 하지 않는다(적대 검토 P-8).
    {
      const file3 = getPaths().settings;
      const prev3 = existsSync(file3) ? readFileSync(file3, "utf8") : undefined;
      try {
        writeFileSync(file3, JSON.stringify({ models: { default: "x", profiles: { x: { pool: ["nosuch:model"] } } } }));
        const unresolved = describeBasePool(getPaths().home);
        writeFileSync(file3, JSON.stringify({ models: { default: "x", profiles: { x: { pool: ["anthropic:claude-opus-5"] } } } }));
        const ok = describeBasePool(getPaths().home);
        out.push(
          assert(
            "★출처: 기본 프로파일이 풀리면 «프로파일 'x'» · 안 풀리면 «빌트인(프로파일 'x' 가 안 풀림)»",
            unresolved.source === "builtin" && unresolved.profileUnresolved === "x" && ok.source === "profile" && ok.profile === "x",
            { unresolved, ok },
          ),
        );
      } finally {
        if (prev3 === undefined) rmSync(file3, { force: true }); else writeFileSync(file3, prev3);
      }
    }

    // ③ 배선·잔재 — 부팅이 옮기고, 런타임·표시·진단 어디에도 그 env 를 읽는 코드가 없다(주석 제외).
    const { readSourceSync } = await import("./_wiring.js");
    const entry = readSourceSync("src/index.ts");
    const reads = (src: string): boolean =>
      src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).some((l) => /process\.env\.(REGION_A_MODELS|MODEL_TIER_)|env\.REGION_A_MODELS|"MODEL_TIER_(HIGH|MID|LOW|NANO)"/.test(l));
    const files = [
      "src/index.ts", "src/core/llm-runtime/index.ts", "src/core/entry/models-command.ts", "src/scripts/doctor.ts",
      "plugins/http-bridge/gateway.ts", "src/scripts/init.ts",
    ];
    const leftovers = files.filter((f) => reads(readSourceSync(f)));
    out.push(
      assert(
        "★부팅이 플러그인 로드 뒤·채널 시작 전에 옮긴다(빌트인이 구독 인증까지 보고 적힌다) · 런타임·/model·/models·doctor·게이트웨이·마법사 어디에도 옛 env 모델 줄을 읽거나 쓰는 코드가 없다",
        /console\.error\("loadPlugins failed:", e\);\s*\}\s*(\/\/[^\n]*\n\s*)*migrateLegacyModelEnv\(process\.env, \(\) => resolveModelSpecs\(\)\.filter\(\(s\) => s\.model !== ""\)\.map\(specLabel\)\);/.test(entry) &&
          entry.indexOf("migrateLegacyModelEnv(process.env") < entry.indexOf("await ch.start(serializedHandler)") && leftovers.length === 0,
        { leftovers },
      ),
    );
    return out;
  },
};
