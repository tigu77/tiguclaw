/**
 * 회귀: **설정 파일이 없는(빌트인 프로파일) 상태에서도 프로파일 배지 색을 고를 수 있다** (2026-10-14 정태님 신고).
 *
 * 사고: 빌트인 프로파일은 디스크에 없고 매번 조립된다. 색 저장은 `models.profiles.<name>` 만 찾아서 고쳐서,
 *  설정 파일이 없으면 «'high' 프로파일을 못 찾았습니다» 400 이 났다.
 * ★반대 방향 함정: 색을 저장하려고 빌트인을 `models.profiles` 에 적으면 **사용자 프로파일이 생겨 자동 조립이 꺼진다**
 *  (인증을 바꿔도 안 따라오는 박제가 된다). 그래서 색만 `models.builtinColors` 에 두고, 이 검사는
 *  «색이 보인다» 와 «여전히 빌트인이다» 를 같이 본다.
 *
 * 등급: **실행** — 임시 홈(설정 파일 없음) + 실제 함수. 라우트 배선만 소스 확인.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSource } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "builtin-profile-color",
  guards:
    "설정 파일 없는 빌트인 상태에서 프로파일 색을 고르면 «프로파일을 못 찾음» 400 이던 것 + 그걸 고치려 빌트인을 프로파일로 적어 자동 조립이 꺼지는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const home = await mkdtemp(path.join(tmpdir(), "tiguclaw-bpc-"));
    const prevHome = process.env.TIGUCLAW_HOME;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.TIGUCLAW_HOME = home;
    process.env.ANTHROPIC_API_KEY = "sk-test-builtin-profile-color"; // 빌트인 조립에 인증된 provider 하나가 필요하다
    const { __resetPathsCache, getPaths } = await import("../../core/paths.js");
    __resetPathsCache?.();
    try {
      const { resolveModelProfiles, setResolvedProfileColor } = await import("../../core/llm-runtime/builtin-profiles.js");
      const file = getPaths().settings;
      const readRoot = async (): Promise<Record<string, unknown>> =>
        existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>) : {};

      const before = resolveModelProfiles(home);
      const set = setResolvedProfileColor("high", "#FF8800");
      const after = resolveModelProfiles(home);
      const root = await readRoot();
      const models = (root.models ?? {}) as Record<string, unknown>;
      out.push(
        assert(
          "★★설정 파일이 없어도 빌트인 'high' 에 색이 들어가고 화면 목록에 그 색이 실린다",
          before.builtin && set && after.profiles.high?.color === "#ff8800",
          `빌트인=${String(before.builtin)} 저장=${String(set)} 색=${String(after.profiles.high?.color)}`,
        ),
      );
      out.push(
        assert(
          "★★색을 저장해도 **여전히 빌트인**이다 — `models.profiles` 를 만들지 않는다(만들면 자동 조립이 꺼진다)",
          after.builtin && models.profiles === undefined && (models.builtinColors as Record<string, unknown> | undefined)?.high === "#ff8800",
          JSON.stringify(models),
        ),
      );
      const cleared = setResolvedProfileColor("high", undefined);
      const rootCleared = await readRoot();
      out.push(
        assert(
          "지우면 기본색으로 돌아가고 빈 `models: {}` 를 남기지 않는다",
          cleared && resolveModelProfiles(home).profiles.high?.color === undefined && rootCleared.models === undefined,
          JSON.stringify(rootCleared),
        ),
      );
      const badName = setResolvedProfileColor("nope", "#112233");
      const badColor = setResolvedProfileColor("high", "red");
      out.push(
        assert(
          "빌트인에 없는 이름·틀린 형식은 거절한다(조용한 성공 금지)",
          !badName && !badColor,
          `없는 이름=${String(badName)} · 틀린 형식=${String(badColor)}`,
        ),
      );

      // 사용자 프로파일이 있으면 지금처럼 그 프로파일 안에 쓴다 — 빌트인 색 칸은 건드리지 않는다.
      await writeFile(file, JSON.stringify({ models: { profiles: { mine: { pool: ["anthropic:claude-sonnet-5"] } } } }), "utf8");
      const userSet = setResolvedProfileColor("mine", "#00aa00");
      const userRoot = await readRoot();
      const um = userRoot.models as { profiles?: Record<string, { color?: string }>; builtinColors?: unknown };
      out.push(
        assert(
          "사용자 프로파일이 있으면 색은 그 프로파일 안(`models.profiles.<name>.color`)에 — 빌트인 칸은 안 생긴다",
          userSet && um.profiles?.mine?.color === "#00aa00" && um.builtinColors === undefined && !setResolvedProfileColor("high", "#123456"),
          JSON.stringify(um),
        ),
      );

      const route = await readSource("../../../plugins/http-bridge/routes-settings.ts");
      out.push(
        assert(
          "배선: 색 라우트가 빌트인까지 아는 쓰기(`setResolvedProfileColor`)를 부른다",
          route.includes("setResolvedProfileColor(name") && !/[^d]setProfileColor\(name/.test(route),
          "routes-settings.ts",
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
