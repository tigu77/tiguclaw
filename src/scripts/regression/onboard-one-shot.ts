/**
 * 회귀: **`tiguclaw onboard` 하나로 끝난다** — 깃풀 이후 손으로 할 게 없다 (사용자 2026-08-13).
 *
 * 사용자가 원하는 흐름: `git pull` → `tiguclaw onboard` → (이후엔) `tiguclaw update`.
 * 여기서 지키는 건 그 흐름을 **조용히 끊는** 두 자리다.
 *
 * ① **codex 인증 단계가 켜지는가.** onboard 는 codex provider 일 때만 OAuth 발급을 돌린다.
 *    그 판정이 종전엔 `REGION_A_MODELS` 접두 **유추**였는데, 같은 날 모델을 "자동"(프로파일·
 *    env 를 일부러 비움)으로 두는 모드를 넣으면서 그 값이 비게 됐다 — 즉 codex 를 골라도
 *    인증 단계를 통째로 건너뛰고 **무인증으로 데몬이 뜬다.** 에러도 안 난다(빈 값이니까).
 *    같은 날 만든 두 변경이 서로를 밟은 것 — `A 를 바꿨는데 A 에 의존하던 B 를 안 봄`.
 *
 * ② **deps 가 없을 때 첫 명령이 스택으로 죽지 않는가.** onboard 는 tsx 경로라
 *    `node_modules` 가 필요한데, 새 clone·pull 직후엔 없을 수 있다. 종전엔
 *    MODULE_NOT_FOUND 한 줄로 죽었고, "먼저 npm install" 안내는 **init 이 끝난 뒤**에야
 *    나온다 — 도달할 수가 없는 안내였다.
 *
 * ★등급: ①은 **실행**(판정을 순수 함수로 뽑아 실제 .env 본문으로 돌린다).
 *  ②는 배선 린트(회귀 프로세스에서 `npm ci` 를 돌릴 수는 없다).
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "onboard-one-shot",
  guards:
    "모델 자동 모드에서 REGION_A_MODELS 가 비어 codex 인증 단계가 통째로 건너뛰어지던 것(무인증 부팅) + deps 없는 첫 clone 에서 tiguclaw 명령이 MODULE_NOT_FOUND 로 죽던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { codexProviderFromEnvBody } = await import("../../core/onboard-provider.js");

    // ★자동 모드의 .env — 모델을 아무것도 안 적는다. 그래도 codex 인증은 필요하다.
    const autoEnv = "TIGUCLAW_PROVIDER=codex\nREGION_A_MODELS=\nMODEL_TIER_HIGH=\n";
    out.push(
      assert(
        "★모델을 자동으로 둬도 codex 인증 단계가 켜진다(무인증 부팅 방지)",
        codexProviderFromEnvBody(autoEnv),
        "TIGUCLAW_PROVIDER=codex → true",
      ),
    );

    // 다른 provider 를 codex 로 오인하지 않는다(있지도 않은 인증 흐름을 태우면 설치가 멈춘다).
    out.push(
      assert(
        "codex 가 아니면 인증 단계를 안 켠다",
        !codexProviderFromEnvBody("TIGUCLAW_PROVIDER=claude-sub\nREGION_A_MODELS=\n"),
        "claude-sub → false",
      ),
    );

    // ★옛 설치 호환 — 그때 쓴 .env 엔 새 키가 없다. 폴백이 죽으면 기존 사용자가 재인증을 잃는다.
    out.push(
      assert(
        "★새 키가 없는 옛 .env 는 REGION_A_MODELS 로 폴백한다",
        codexProviderFromEnvBody("REGION_A_MODELS=codex:gpt-5.5\n"),
        "레거시 폴백",
      ),
    );
    out.push(
      assert(
        "명시 키가 있으면 그게 이긴다(유추보다 먼저)",
        !codexProviderFromEnvBody(
          "TIGUCLAW_PROVIDER=anthropic\nREGION_A_MODELS=codex:gpt-5.5\n",
        ),
        "명시 우선",
      ),
    );

    // ② deps 부트스트랩 — 첫 명령이 스택으로 죽지 않는다.
    const bin = await readFile(new URL("../../../bin/tiguclaw.mjs", import.meta.url), "utf8");
    const boots =
      /if \(!existsSync\(tsxEntry\)\) \{/.test(bin) && /"ci" : "install"/.test(bin);
    out.push(
      assert(
        "★deps 가 없으면 첫 실행이 알아서 설치한다(MODULE_NOT_FOUND 로 안 죽는다)",
        boots,
        boots ? "tsx 부재 시 npm ci/install" : "★부트스트랩 없음 — 첫 사용자가 스택을 본다",
      ),
    );
    // ★데몬 라이프사이클은 이 경로를 **타면 안 된다** — 그게 dep-free 인 이유다
    //  (깨진 node_modules 에서도 stop/restart/update 가 되어야 한다). 부트스트랩을
    //  분기 밖으로 올리면 그 성질이 조용히 사라진다.
    const lifecycleFirst = bin.indexOf("LIFECYCLE.has(cmd)") < bin.indexOf("existsSync(tsxEntry)");
    out.push(
      assert(
        "★부트스트랩은 tsx 분기 안에만 있다(라이프사이클은 계속 dep-free)",
        lifecycleFirst,
        lifecycleFirst ? "분기 안" : "★라이프사이클도 npm 을 타게 됐다",
      ),
    );

    // init 이 자동 모드에서 **아무것도 안 쓰는가** — 쓰면 그 값에 고정돼 자동 최신이 죽는다.
    const init = await readFile(new URL("../init.ts", import.meta.url), "utf8");
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const cli = await readFile(path.join(REPO, "src/cli.ts"), "utf8");
    const pkg = await readFile(path.join(REPO, "package.json"), "utf8");
    const writesNothing =
      /if \(modelMode === "auto"\) \{/.test(init) &&
      /seedModelProfiles\(buildSeedProfiles\(answers\), "high"\);/.test(init) &&
      init.indexOf('if (modelMode === "auto") {') <
        init.indexOf("seedModelProfiles(buildSeedProfiles(answers)");
    out.push(
      assert(
        "★자동 모드는 프로파일을 시드하지 않는다(시드하면 자동 최신이 죽는다)",
        writesNothing,
        writesNothing ? "auto 분기가 시드 앞" : "★자동인데도 시드한다 — 그 시점 값에 고정",
      ),
    );

    // ★안내가 **다음 행동을 남기는가** (2026-08-19 사용자 지적: "구독으로 쓰고 싶으면
    //  토큰 받아오는 방법 안내가 있나?"). 종전 문구는 *"Claude Code CLI 에서
    //  `claude setup-token` 실행"* 이었는데, **처음 설치하는 사람에게 그 CLI 가 깔려
    //  있을 이유가 없다.** 없으면 "그런 명령이 없습니다" 에서 막히고, 어디서 구하는지는
    //  우리 문서 어디에도 없었다(README 포함 0건).
    //  ★install.sh 헤더가 적어둔 것과 같은 규칙이다 — **어느 경로로 끝나든 다음 행동이
    //   남아야 한다.** 반쯤 설치된 상태로 사람을 버리지 않는다.
    // ★계약이 **바뀌었다** (2026-08-27). 종전 요구는 *"설치 명령을 알려줘라"* 였는데, 이제는
    //  **우리가 대신 발급한다** — Agent SDK 가 `claude` 바이너리를 의존성으로 같이 깔고
    //  (실측 259MB) 거기에 `setup-token` 이 있으므로, 사용자에게 같은 것을 한 번 더 받게 할
    //  이유가 없다. 그러니 옛 단언은 **낡아서** 빨간불이 난 것이지 코드가 나빠진 게 아니다.
    //  ★다만 그 게이트가 지키던 **원칙은 그대로다**: *"어느 경로로 끝나든 다음 행동이
    //   남아야 한다."* 그래서 약화시키지 않고 **더 강한 형태**로 바꾼다 — 안내가 아니라
    //   **자동 실행**을 요구한다. 되돌아가면(다시 붙여넣기를 시키면) 빨간불이다.
    {
      const sub = /if \(provider === "claude-sub"\) \{[\s\S]{0,1600}?\n {2}\}/.exec(init)?.[0] ?? "";
      const asksPaste = /askRequired\(|await ask\(/.test(sub);
      out.push(
        assert(
          "★구독 토큰을 사용자에게 받아 적게 하지 않는다(대신 발급한다)",
          sub !== "" && !asksPaste && /claude-auth/.test(sub),
          sub === ""
            ? "★claude-sub 분기를 못 찾음(검사 전제)"
            : asksPaste
              ? "★다시 붙여넣기를 시킨다 — 자동 발급으로 되돌려라"
              : "자동 발급 안내",
        ),
        assert(
          "★온보드가 claude 구독도 **실제로** 대신 발급한다(codex 와 대칭)",
          /providerIsClaudeSub\(\)/.test(cli) && /"claude-auth"/.test(cli),
          `판정=${/providerIsClaudeSub\(\)/.test(cli)} · 실행=${/"claude-auth"/.test(cli)}` +
            " — 한쪽만 자동이면 그 비대칭이 곧 사용자 심부름이다",
        ),
        assert(
          "★발급 스크립트가 실재한다(가리키는 곳이 비면 안내가 막다른 길이 된다)",
          existsSync(path.join(REPO, "src/scripts/claude-auth.ts")) &&
            /"claude-auth":/.test(pkg),
          `파일=${existsSync(path.join(REPO, "src/scripts/claude-auth.ts"))} · npm 스크립트=${/"claude-auth":/.test(pkg)}`,
        ),
      );
    }

    return out;
  },
};
