/**
 * 회귀: **설정 파일이 없는(빌트인) 상태에서도 화면에 보이는 프로파일을 기본·세션 프로파일로 고를 수 있고, 실제로 그게 돈다**
 * (2026-10-14 — 정태님의 배지 색 신고와 같은 부류를 이어서 확인).
 *
 * 사고 셋(같은 뿌리 — «파일에 적힌 프로파일만» 으로 판정):
 *  ① 기본·세션 프로파일 지정 라우트가 `loadModelProfiles` 로 검사해 화면의 high/mid/low 를 «존재하지 않는 프로파일» 400.
 *  ② 세션 프로파일이 저장돼 있어도 라우터가 `resolveProfileChain`(파일만)으로 풀어 **조용히** 무시.
 *  ③ 화면은 빌트인이면 무조건 high 를 기본이라 표시 — 실행은 `models.default` 를 등급으로 따른다(말과 실행이 갈림).
 *
 * 등급: **실행** — 임시 홈(설정 파일 없음) + 실제 함수. 라우트·라우터 배선만 소스 확인.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSource } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "builtin-profile-selection",
  guards:
    "설정 파일 없는 빌트인 상태에서 화면의 high/mid/low 를 기본·세션 프로파일로 고르면 400 이고, 세션 프로파일은 저장돼도 조용히 무시되며, 화면이 실제와 다른 기본을 말하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const home = await mkdtemp(path.join(tmpdir(), "tiguclaw-bps-"));
    const prevHome = process.env.TIGUCLAW_HOME;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.TIGUCLAW_HOME = home;
    process.env.ANTHROPIC_API_KEY = "sk-test-builtin-profile-selection"; // 빌트인 조립에 인증된 provider 하나가 필요하다
    const { __resetPathsCache, getPaths } = await import("../../core/paths.js");
    __resetPathsCache?.();
    try {
      const bp = await import("../../core/llm-runtime/builtin-profiles.js");
      const rt = await import("../../core/llm-runtime/index.js");
      const { setDefaultProfile } = await import("../../core/settings.js");
      const specs = (xs: { provider?: string; adapter?: string; model: string }[]): string => xs.map((s) => `${s.provider ?? s.adapter}:${s.model}`).join(",");

      const midSel = bp.isSelectableProfile("mid", home);
      const nopeSel = bp.isSelectableProfile("nope", home);
      out.push(
        assert(
          "★★빌트인 상태에서 화면의 등급(mid)은 고를 수 있고, 없는 이름은 못 고른다",
          midSel && !nopeSel && bp.resolveModelProfiles(home).builtin,
          `mid=${String(midSel)} · nope=${String(nopeSel)}`,
        ),
      );

      const before = bp.effectiveDefaultProfileName(home);
      setDefaultProfile("mid");
      const after = bp.effectiveDefaultProfileName(home);
      const runPool = specs(rt.resolveModelSpecs(undefined, home));
      const midPool = specs(rt.resolveTier("mid", home));
      out.push(
        assert(
          "★★기본을 mid 로 고르면 화면이 말하는 기본(mid)과 실제로 도는 풀(빌트인 mid)이 같다 — 여전히 빌트인",
          before === "high" && after === "mid" && runPool !== "" && runPool === midPool && bp.resolveModelProfiles(home).builtin,
          `전=${before} 후=${after} · 실행=${runPool} · mid=${midPool}`,
        ),
      );

      const low = specs(rt.resolveTier("low", home));
      const lowBuiltin = bp.builtinTierPool("low", home).join(",");
      out.push(
        assert(
          "★세션 프로파일을 푸는 함수(`resolveTier`)가 빌트인 등급을 실제 풀로 푼다(종전엔 빈 체인 → 조용히 무시)",
          low !== "" && low === lowBuiltin,
          `low=${low} · 빌트인 low=${lowBuiltin}`,
        ),
      );

      // 화면 목록 라우트를 **실행**해 기본 표시를 본다 — 문자열 대조로는 «빌트인이면 high» 로 되돌린 변이가 살았다(적대 검토 M2).
      // ★경로를 변수로 넘긴다 — 리터럴이면 `npm run build`(rootDir=src)가 plugins 를 끌어와 TS6059 로 깨진다(공개 CI 빌드).
      const routesUrl = new URL("../../../plugins/http-bridge/routes-settings.js", import.meta.url).href;
      const { handleGetModelProfiles } = (await import(routesUrl)) as { handleGetModelProfiles: (ctx: unknown) => Promise<void> };
      const listed = async (): Promise<{ name: string; isDefault: boolean; description?: string }[]> => {
        let body = "";
        const res = { writeHead: () => res, end: (b: string) => { body = b; } };
        await handleGetModelProfiles({ req: {}, res, url: new URL("http://x/model-profiles") });
        return (JSON.parse(body) as { profiles: { name: string; isDefault: boolean; description?: string }[] }).profiles;
      };
      const shown = await listed();
      const shownDefault = shown.find((p) => p.isDefault)?.name;
      const mainDesc = shown.filter((p) => (p.description ?? "").includes("메인 턴")).map((p) => p.name).join(",");
      out.push(
        assert(
          "★★화면 목록(라우트 실행)이 기본으로 표시하는 것과 «메인 턴» 설명이 둘 다 실제 기본(mid)에 붙는다",
          shownDefault === "mid" && mainDesc === "mid",
          `isDefault=${String(shownDefault)} · «메인 턴»=${mainDesc}`,
        ),
      );
      setDefaultProfile("zzz-unknown");
      const normalized = bp.effectiveDefaultProfileName(home);
      setDefaultProfile("mid");
      out.push(
        assert(
          "모르는 기본 이름은 빌트인이 실제로 쓰는 high 로 정규화해 말한다(실행 `builtinTierFor` 와 같은 판정)",
          normalized === "high",
          `기본=zzz-unknown → 표시 ${normalized}`,
        ),
      );
      const sessMid = specs(rt.resolveSessionProfilePool("mid", home));
      out.push(
        assert(
          "★빌트인 상태에서 세션 프로파일 mid 는 빌트인 mid 풀로 풀린다(라우터가 쓰는 함수)",
          sessMid !== "" && sessMid === midPool,
          `세션 mid=${sessMid}`,
        ),
      );

      // 사용자 프로파일이 생기면 그것만 고를 수 있다 — 빌트인 등급 이름은 더 이상 목록에 없다.
      await writeFile(getPaths().settings, JSON.stringify({ models: { default: "mine", profiles: { mine: { pool: ["anthropic:claude-sonnet-5"] } } } }), "utf8");
      const mineSel = bp.isSelectableProfile("mine", home);
      const staleMid = specs(rt.resolveSessionProfilePool("mid", home));
      out.push(
        assert(
          "★★사용자 프로파일이 생기면 세션에 남은 옛 등급(mid)은 빌트인으로 새지 않고 기본으로 간다(사용자 설정이 통째로 이긴다 — 적대 검토 P3)",
          staleMid === "",
          `세션 mid → ${staleMid === "" ? "빈 풀(기본으로)" : staleMid}`,
        ),
      );
      const lowSel = bp.isSelectableProfile("low", home);
      const def = bp.effectiveDefaultProfileName(home);
      out.push(
        assert(
          "사용자 프로파일이 있으면 그 목록이 기준이다(빌트인 등급은 고를 수 없고 기본은 `models.default` 그대로)",
          mineSel && !lowSel && def === "mine",
          `mine=${String(mineSel)} · low=${String(lowSel)} · 기본=${def}`,
        ),
      );

      const route = await readSource("../../../plugins/http-bridge/routes-settings.ts");
      const router = await readSource("../../core/router.ts");
      const selCalls = (route.match(/isSelectableProfile\(/g) ?? []).length;
      out.push(
        assert(
          "배선: 기본·세션 지정 라우트 둘 다 `isSelectableProfile`, 화면 기본은 `effectiveDefaultProfileName`, 라우터 세션 프로파일은 `resolveSessionProfilePool`",
          selCalls >= 2 && route.includes("effectiveDefaultProfileName()") && !route.includes("loadModelProfiles()") &&
            router.includes("resolveSessionProfilePool(profileName"),
          `isSelectableProfile 호출 ${selCalls} · 라우터 resolveTier=${String(router.includes("resolveSessionProfilePool(profileName"))}`,
        ),
      );
    } finally {
      if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prevHome;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      __resetPathsCache?.();
      await rm(home, { recursive: true, force: true });
    }
    return out;
  },
};
