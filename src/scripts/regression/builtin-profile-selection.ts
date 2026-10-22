/**
 * 회귀: **설정 파일이 없는(빌트인) 상태의 프로파일은 `default` 하나이고, 화면이 말하는 것과 실제로 도는 것이 같다**
 * (2026-10-14 배지 색 신고 부류 → 2026-10-22 정태님: «처음 아무것도 셋팅하지 않은 유저를 위한 것뿐이지»).
 *
 * 지키는 것:
 *  ① 빌트인 상태에서 화면의 프로파일(`default`)을 고를 수 있고, 없는 이름은 못 고른다(종전 사고: 파일에 적힌 것만 봐서 400).
 *  ② 등급 이름(high/mid/low)은 **프로파일이 없으면 기본 풀**로 풀린다 — 빌트인 상태에서도, 사용자 프로파일이 생긴 뒤에도.
 *     ★2026-10-22 사고: 사용자가 high 하나만 적자 화면엔 high 만 남는데 `low` 서브에이전트는 빌트인 haiku 로 돌았다.
 *  ③ 세션에 남은 옛 이름은 고를 수 없는 이름이면 빈 풀(라우터가 기본으로) — 빌트인으로 새지 않는다.
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
    "설정 파일 없는 빌트인 상태에서 화면의 프로파일을 고르면 400 이던 것 + 사용자가 프로파일 하나만 적자 화면엔 그것만 남는데 등급 이름(low 등)은 빌트인 모델로 돌던 것(화면과 실행이 갈림)",
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

      const defSel = bp.isSelectableProfile("default", home);
      const midSel = bp.isSelectableProfile("mid", home);
      const nopeSel = bp.isSelectableProfile("nope", home);
      const names = Object.keys(bp.resolveModelProfiles(home).profiles).join(",");
      out.push(
        assert(
          "★★빌트인 상태의 프로파일은 `default` 하나이고 그것만 고를 수 있다(등급·없는 이름은 목록에 없다)",
          names === "default" && defSel && !midSel && !nopeSel && bp.resolveModelProfiles(home).builtin,
          `목록=${names} · default=${String(defSel)} · mid=${String(midSel)} · nope=${String(nopeSel)}`,
        ),
      );

      const runPool = specs(rt.resolveModelSpecs(undefined, home));
      const tierPools = ["high", "mid", "low", "default"].map((t) => specs(rt.resolveTier(t, home)));
      const chainLow = rt.resolveModelChain("low", home).map((p) => specs(p)).join(" | ");
      const nanoPool = specs(rt.resolveTier("nano", home)); // ★nano 는 등급이 아니다(2026-10-22 «나노는 아예 빼기로») — 프로파일이 없으면 안 풀린다
      out.push(
        assert(
          "★★빌트인 상태에서 등급 이름(default·high·mid·low)은 메인 턴과 같은 풀로 풀린다(별칭) — 체인도 그 한 풀 · nano 는 등급이 아니라 안 풀린다",
          runPool !== "" && runPool === bp.builtinPool(home).join(",") && tierPools.every((p) => p === runPool) && chainLow === runPool && nanoPool === "",
          `실행=${runPool} · 등급=${tierPools.join(" / ")} · low 체인=${chainLow} · nano=${nanoPool || "(안 풀림)"}`,
        ),
      );

      // 기본 포인터가 무엇이든(옛 빌트인 시절 mid 를 골라 둔 설치) 빌트인 상태의 기본은 `default` 하나다.
      setDefaultProfile("mid");
      const afterMid = bp.effectiveDefaultProfileName(home);
      const runAfterMid = specs(rt.resolveModelSpecs(undefined, home));
      setDefaultProfile("zzz-unknown");
      const afterUnknown = bp.effectiveDefaultProfileName(home);
      out.push(
        assert(
          "옛 포인터(mid·모르는 이름)가 남아 있어도 빌트인 상태의 기본 표시는 `default` 이고 실행 풀은 그대로다",
          afterMid === "default" && afterUnknown === "default" && runAfterMid === runPool,
          `mid→${afterMid} · zzz→${afterUnknown} · 실행=${runAfterMid}`,
        ),
      );

      // 화면 목록 라우트를 **실행**해 기본 표시를 본다 — 문자열 대조로는 «빌트인이면 high» 로 되돌린 변이가 살았다(적대 검토 M2).
      // ★경로를 변수로 넘긴다 — 리터럴이면 `npm run build`(rootDir=src)가 plugins 를 끌어와 TS6059 로 깨진다(공개 CI 빌드).
      const routesUrl = new URL("../../../plugins/http-bridge/routes-settings.js", import.meta.url).href;
      const { handleGetModelProfiles } = (await import(routesUrl)) as { handleGetModelProfiles: (ctx: unknown) => Promise<void> };
      const listed = async (): Promise<{ name: string; isDefault: boolean }[]> => {
        let body = "";
        const res = { writeHead: () => res, end: (b: string) => { body = b; } };
        await handleGetModelProfiles({ req: {}, res, url: new URL("http://x/model-profiles") });
        return (JSON.parse(body) as { profiles: { name: string; isDefault: boolean }[] }).profiles;
      };
      const shown = await listed();
      out.push(
        assert(
          "★화면 목록(라우트 실행)도 `default` 하나를 기본으로 보여 준다",
          shown.length === 1 && shown[0]!.name === "default" && shown[0]!.isDefault,
          JSON.stringify(shown.map((p) => [p.name, p.isDefault])),
        ),
      );
      const sessMid = specs(rt.resolveSessionProfilePool("mid", home));
      out.push(
        assert(
          "세션에 남은 옛 등급(mid)은 고를 수 없는 이름이라 빈 풀 — 라우터가 기본으로 보낸다",
          sessMid === "",
          `세션 mid → ${sessMid === "" ? "빈 풀(기본으로)" : sessMid}`,
        ),
      );

      // ★사용자가 하나만 적으면 **그게 이긴다** — 화면도 실행도. 등급 이름은 그 기본 프로파일로 간다.
      await writeFile(getPaths().settings, JSON.stringify({ models: { profiles: { high: { pool: ["anthropic:claude-opus-4-8"], fallback: "spare" }, spare: { pool: ["anthropic:claude-sonnet-5"] } } } }), "utf8");
      const userNames = Object.keys(bp.resolveModelProfiles(home).profiles).join(",");
      const userRun = specs(rt.resolveModelSpecs(undefined, home));
      const userLow = specs(rt.resolveTier("low", home));
      const userLowChain = rt.resolveModelChain("low", home).map((p) => specs(p)).join(" | ");
      out.push(
        assert(
          "★★사용자가 high 하나만 적으면 메인 턴·`low` 등급 모두 그 모델이고 빌트인(haiku 등)으로 새지 않는다 — 체인은 그 프로파일의 폴백까지",
          userNames === "high,spare" && userRun === "anthropic:claude-opus-4-8" && userLow === userRun &&
            userLowChain === "anthropic:claude-opus-4-8 | anthropic:claude-sonnet-5",
          `목록=${userNames} · 메인=${userRun} · low=${userLow} · low 체인=${userLowChain}`,
        ),
      );
      // ★적어 둔 `low` 가 기본보다 이긴다 — 서브에이전트·매니저가 지나는 체인에서도(레드팀 10-22: 등급 판정을 프로파일 조회 앞으로 옮기는
      //  변이가 살았다 — 위 사례는 사용자 프로파일 = 기본이라 두 결과가 같았다). 기본(main)과 다른 low 를 두고 체인 전체를 본다.
      await writeFile(getPaths().settings, JSON.stringify({ models: { default: "main", profiles: {
        main: { pool: ["anthropic:claude-opus-5"] }, low: { pool: ["anthropic:claude-haiku-4-5"], fallback: "spare" }, spare: { pool: ["anthropic:claude-sonnet-5"] },
      } } }), "utf8");
      const ownLowChain = rt.resolveModelChain("low", home).map((p) => specs(p)).join(" | ");
      const ownLowTier = specs(rt.resolveTier("low", home));
      out.push(
        assert(
          "★★사용자가 적은 `low` 는 기본보다 이긴다 — 체인(서브에이전트·매니저)은 그 프로파일과 폴백, 기본은 맨 끝",
          ownLowChain === "anthropic:claude-haiku-4-5 | anthropic:claude-sonnet-5 | anthropic:claude-opus-5" && ownLowTier === "anthropic:claude-haiku-4-5",
          `low 체인=${ownLowChain} · low=${ownLowTier}`,
        ),
      );
      await writeFile(getPaths().settings, JSON.stringify({ models: { default: "mine", profiles: { mine: { pool: ["anthropic:claude-sonnet-5"] } } } }), "utf8");
      const staleMid = specs(rt.resolveSessionProfilePool("mid", home));
      const mineSel = bp.isSelectableProfile("mine", home);
      const lowSel = bp.isSelectableProfile("low", home);
      const def = bp.effectiveDefaultProfileName(home);
      out.push(
        assert(
          "사용자 프로파일이 있으면 그 목록이 기준이다(등급 이름은 고를 수 없고 세션의 옛 mid 는 빈 풀 · 기본은 `models.default` 그대로)",
          mineSel && !lowSel && def === "mine" && staleMid === "",
          `mine=${String(mineSel)} · low=${String(lowSel)} · 기본=${def} · 세션 mid=${staleMid === "" ? "빈 풀" : staleMid}`,
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
