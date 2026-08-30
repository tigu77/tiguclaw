/**
 * 회귀: **설정이 없으면 인증된 provider 로 기본 풀을 조립한다** (사용자 요청 2026-08-13).
 *
 * 종전: `settings.json` 에 프로파일이 없으면 → `REGION_A_MODELS` env → 없으면
 * `DEFAULT_MODEL_SPEC`(claude, 모델 미지정). 그래서 **codex 만 인증한 설치도 claude 로
 * 흘렀고**(있지도 않은 인증을 때린다), 등급 이름(high/mid/low)은 아무 의미가 없었다 —
 * 서브에이전트가 `model: low` 를 선언해도 전부 같은 어댑터 디폴트였다.
 *
 * ★이 검사가 지키는 진짜 함정 — **claude 구독 사용자의 조용한 누락.** 인증 판정을
 *  `conn.apiKey`(=`ANTHROPIC_API_KEY`) 하나로 하면, 키 없이 `CLAUDE_CODE_OAUTH_TOKEN` 만
 *  가진 구독 사용자가 풀에서 통째로 빠진다. 형식은 멀쩡하고 에러도 안 나고, 그냥 그
 *  사람 설치에서만 claude 가 안 뽑힌다. 그래서 판정을 한 곳(`claudeAuthAvailable`)에 두고
 *  **어댑터의 실행 가드도 같은 함수를 부르게** 했다 — 여기서 그 배선을 확인한다.
 *
 * ★등급: 조립·우선순위·폴백 = **실행**(실제 함수 + env 조작 + 임시 settings.json).
 *  어댑터 가드 공유 = 배선 린트(실행하려면 Claude SDK 를 태워야 한다).
 */
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSource } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** LLM 자격증명 env 를 통째로 저장/복원 — 다른 검사로 새면 안 된다. */
const CRED_ENV = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_OAUTH_TOKEN",
  "OPENAI_CODEX_OAUTH_REFRESH",
  "OPENAI_CODEX_OAUTH_EXPIRES",
  "REGION_A_MODELS",
  "MODEL_TIER_HIGH",
  "MODEL_TIER_MID",
  "MODEL_TIER_LOW",
] as const;

export const check: RegressionCheck = {
  name: "builtin-profiles-from-adapters",
  guards:
    "프로파일 미설정 설치가 인증하지도 않은 claude 로 흐르고 등급 이름이 아무 의미 없던 것 + claude 구독 사용자(키 없이 OAuth 토큰)가 인증 판정에서 조용히 빠지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { builtinTierPool, builtinTierProviders, isRegisteredProvider } = await import(
      "../../core/llm-runtime/builtin-profiles.js"
    );
    const { resolveModelSpecs, resolveTier } = await import(
      "../../core/llm-runtime/index.js"
    );
    const { providerAuthAvailable } = await import(
      "../../core/llm-runtime/provider-availability.js"
    );
    const { registerAuthProvider, getAuthProvider } = await import(
      "../../core/llm-runtime/auth-registry.js"
    );
    const { codexAuthProvider, ensureFreshAccessToken } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-auth.js"
    );
    const {
      __setCatalogForTest: setCatalog,
      __setCodexHiddenForTest: setHidden,
      catalogNote,
    } = await import("../../core/llm-runtime/model-catalog.js");

    const saved = new Map<string, string | undefined>();
    for (const k of CRED_ENV) saved.set(k, process.env[k]);
    const only = (...set: string[]): void => {
      for (const k of CRED_ENV) delete process.env[k];
      for (const k of set) process.env[k] = "x";
    };

    // 사용자 설정이 **없는** 임시 프로젝트 — 빌트인이 실제로 도는 조건.
    const empty = await mkdtemp(path.join(tmpdir(), "tiguclaw-bp-empty-"));
    const configured = await mkdtemp(path.join(tmpdir(), "tiguclaw-bp-cfg-"));
    try {
      await writeFile(
        path.join(configured, "settings.json"),
        JSON.stringify({
          models: { default: "high", profiles: { high: { pool: ["openai:my-model"] } } },
        }),
        "utf8",
      );

      // ── codex: **등록 ≠ 인증** ─────────────────────────────────────────────
      // ★심(auth-provider)이 아예 없으면 codex 어댑터는 AuthProviderMissingError 로 죽는다.
      //  실행이 못 하는 것을 "가용" 이라 말하면 풀에 빈 자리를 넣는 것과 같다.
      //  (이 검사는 등록 **전에** 해야 하므로 맨 앞이다 — 아래에서 등록한다.)
      only("OPENAI_CODEX_OAUTH_TOKEN");
      if (getAuthProvider("codex") === undefined) {
        out.push(
          assert(
            "★auth-provider 심이 없으면 토큰이 있어도 가용 아님",
            !providerAuthAvailable("codex", empty),
            "미등록 → false",
          ),
        );
      }
      registerAuthProvider(codexAuthProvider); // 이후는 데몬과 같은 상태(부팅 시 등록).

      // ★등록은 무조건 일어난다 — 토큰을 한 번도 발급 안 한 설치에서도. 등록을 인증으로
      //  치면 그런 설치가 매 폴백마다 codex 를 한 번씩 때리고, `/models` 는 "인증됨" 이라
      //  거짓말한다(내가 처음 그렇게 짰다).
      only();
      out.push(
        assert(
          "★등록됐어도 토큰이 0이면 가용 아님(등록 ≠ 인증)",
          !providerAuthAvailable("codex", empty),
          "토큰 0 → false",
        ),
      );

      // ★refresh 토큰만 남은 설치 — access 는 비어도 어댑터가 새로 받아온다. access 만
      //  보는 판정은 이 사용자에게만 codex 를 조용히 뺀다(claude 구독과 같은 부류).
      only("OPENAI_CODEX_OAUTH_REFRESH");
      out.push(
        assert(
          "★access 없이 refresh 만 있어도 인증으로 본다",
          providerAuthAvailable("codex", empty),
          "refresh-only → true",
        ),
      );

      // 실행과 같은 조건인가 — "가용" 이라 해놓고 실행이 던지면 풀에 넣은 의미가 없다.
      only();
      let threw = false;
      try {
        await ensureFreshAccessToken();
      } catch {
        threw = true;
      }
      out.push(
        assert(
          "★토큰 0이면 실행도 던진다(판정과 실행이 같은 조건)",
          threw,
          threw ? "throw" : "★가용 아님이라 했는데 실행은 통과 — 판정이 실행과 갈렸다",
        ),
      );

      // ★구독 사용자 — 키는 없고 OAuth 토큰만. 여기서 anthropic 이 빠지면 그 설치는
      //  claude 를 영영 못 쓴다(에러도 없이).
      only("CLAUDE_CODE_OAUTH_TOKEN");
      const subPool = builtinTierPool("high", empty);
      out.push(
        assert(
          "★claude 구독(키 없이 OAuth 토큰)도 인증으로 인정된다",
          subPool.length === 1 && subPool[0].startsWith("anthropic:"),
          `풀=${JSON.stringify(subPool)}`,
        ),
      );

      // codex 만 인증 — claude 를 넣으면 안 된다(있지도 않은 인증을 때린다).
      only("OPENAI_CODEX_OAUTH_TOKEN");
      const codexPool = builtinTierPool("high", empty);
      out.push(
        assert(
          "★codex 만 인증했으면 codex 만 담는다(미인증 provider 를 안 넣는다)",
          codexPool.length === 1 && codexPool[0].startsWith("codex:"),
          `풀=${JSON.stringify(codexPool)}`,
        ),
      );

      // 둘 다 인증 — 한 풀에 나란히(교차 provider 안전망이 기본으로 성립), anthropic 이 앞.
      only("ANTHROPIC_API_KEY", "OPENAI_CODEX_OAUTH_TOKEN");
      const bothPool = builtinTierPool("high", empty);
      out.push(
        assert(
          "★둘 다 인증하면 한 풀에 교차 provider 로 담긴다(anthropic 먼저)",
          bothPool.length === 2 &&
            bothPool[0].startsWith("anthropic:") &&
            bothPool[1].startsWith("codex:"),
          `풀=${JSON.stringify(bothPool)}`,
        ),
      );

      // 등급이 실제로 갈린다 — 셋이 같은 값이면 등급 이름이 다시 무의미해진다.
      only("ANTHROPIC_API_KEY");
      const hi = builtinTierPool("high", empty);
      const lo = builtinTierPool("low", empty);
      out.push(
        assert(
          "★high 와 low 가 다른 모델이다(등급이 이름뿐이 아니다)",
          hi.length > 0 && lo.length > 0 && hi[0] !== lo[0],
          `high=${hi[0]} low=${lo[0]}`,
        ),
      );

      // 메인 턴이 빌트인으로 흐른다 — 설정도 env 도 없을 때.
      const main = resolveModelSpecs(undefined, empty);
      out.push(
        assert(
          "★설정·env 가 하나도 없으면 메인 턴이 빌트인 high 로 돈다",
          main.length > 0 && main[0].model === hi[0].split(":")[1],
          `메인=${main.map((s) => `${s.provider}:${s.model}`).join(",")}`,
        ),
      );

      // 등급 해석(서브에이전트·매니저) 도 빌트인으로.
      const tier = resolveTier("low", empty);
      out.push(
        assert(
          "★등급 이름(low)이 빌트인 풀로 해석된다",
          tier.length > 0 && tier[0].model === lo[0].split(":")[1],
          `low=${tier.map((s) => s.model).join(",")}`,
        ),
      );

      // ★사용자 설정이 이긴다 — 빌트인은 "없을 때만" 이다. 이게 깨지면 사용자가 적어둔
      //  모델을 우리가 조용히 덮어쓴다(가장 나쁜 실패).
      const userMain = resolveModelSpecs(undefined, configured);
      out.push(
        assert(
          "★settings.json 에 적힌 게 있으면 그게 이긴다(빌트인이 덮지 않는다)",
          userMain.length === 1 && userMain[0].model === "my-model",
          `메인=${userMain.map((s) => s.model).join(",")}`,
        ),
      );

      // env(REGION_A_MODELS)도 빌트인보다 앞이다 — 명시 설정 우선 규칙은 한 방향이어야 한다.
      only("ANTHROPIC_API_KEY");
      process.env.REGION_A_MODELS = "codex:from-env";
      const envMain = resolveModelSpecs(undefined, empty);
      out.push(
        assert(
          "REGION_A_MODELS 도 빌트인보다 앞이다",
          envMain.length === 1 && envMain[0].model === "from-env",
          `메인=${envMain.map((s) => s.model).join(",")}`,
        ),
      );

      // 인증이 하나도 없으면 빈 풀 — 기존 폴백(어댑터 디폴트)이 그대로 산다(회귀 0).
      only();
      out.push(
        assert(
          "인증이 없으면 빈 풀(기존 폴백 경로 보존)",
          builtinTierPool("high", empty).length === 0,
          "빈 풀",
        ),
      );

      // ── 최신 자동 추정(카탈로그) ─────────────────────────────────────────────
      // ★사용자 요청: "최신 자동 추정이 가능한지가 중요한 부분이야". 백엔드가 주는 실물
      //  목록이 정적 표를 **이겨야** 의미가 있다 — 안 그러면 조회만 하고 안 쓰는 셈이다.
      only("ANTHROPIC_API_KEY", "OPENAI_CODEX_OAUTH_TOKEN");
      setCatalog({
        fetchedAt: Date.now(),
        models: {
          // 일부러 뒤섞어 둔다 — 순서가 아니라 **패밀리**로 고르는지 본다.
          anthropic: ["claude-fable-9", "claude-opus-9", "claude-sonnet-9", "claude-haiku-9"],
          codex: ["codex-auto-review", "gpt-9.9-sol", "gpt-9.9-mini"],
        },
      });
      const live = builtinTierPool("high", empty);
      out.push(
        assert(
          "★카탈로그가 정적 표를 이긴다(조회만 하고 안 쓰면 무의미)",
          live[0] === "anthropic:claude-opus-9" && live[1] === "codex:gpt-9.9-sol",
          `풀=${JSON.stringify(live)}`,
        ),
      );
      out.push(
        assert(
          "★anthropic 은 패밀리로 고른다(최신 첫 항목을 그냥 쓰면 fable 이 끼어든다)",
          !live[0].includes("fable"),
          `high=${live[0]}`,
        ),
      );
      const noSpecial = JSON.stringify(builtinTierPool("high", empty));
      out.push(
        assert(
          "특수 목적 모델(codex-auto-*)은 등급 후보가 아니다",
          !noSpecial.includes("codex-auto"),
          noSpecial,
        ),
      );
      const liveLow = builtinTierPool("low", empty);
      out.push(
        assert(
          "codex low 는 -mini 를 집는다(형제 모델을 등급인 척 가르지 않는다)",
          liveLow[1] === "codex:gpt-9.9-mini",
          `low=${JSON.stringify(liveLow)}`,
        ),
      );

      // ★늙은 캐시는 안 쓴다 — 낡은 값을 최신인 척하면 정적 표보다 나쁘다.
      setCatalog({
        fetchedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        models: { anthropic: ["claude-opus-9"] },
      });
      const stale = builtinTierPool("high", empty);
      out.push(
        assert(
          "★한 달 된 캐시는 버리고 정적 표로 강등한다",
          stale[0] === "anthropic:claude-opus-5",
          `high=${stale[0]}`,
        ),
      );

      // 캐시가 아예 없으면 정적 표 — 네트워크가 죽어도 동작이 안 바뀐다(회귀 0).
      setCatalog(null);
      out.push(
        assert(
          "카탈로그가 없으면 정적 표로 동작(네트워크 무관)",
          builtinTierPool("high", empty)[0] === "anthropic:claude-opus-5",
          "정적 표",
        ),
      );

      // ── client_version 낡음 감지 (사용자 제안 2026-08-13: "릴리즈 때 한 번씩 갱신") ──
      // ★손으로 올리는 건 맞다. 문제는 **잊었을 때 신호가 없다**는 것 — 목록이 짧게 올 뿐
      //  에러도 힌트도 없다(응답 최상위 키는 `models` 하나뿐, 실측). 그래서 낡음을
      //  기계가 말하게 했고, 그 말이 실제로 나오는지를 여기서 실행으로 본다.
      setCatalog({ fetchedAt: Date.now(), models: { codex: ["gpt-9.9-sol"] } });
      setHidden([]);
      const noteFresh = catalogNote() ?? "";
      setHidden(["gpt-9.9-nova", "gpt-9.9-nova-wm"]);
      const noteStale = catalogNote() ?? "";
      out.push(
        assert(
          "★client_version 이 낡으면 그 사실을 말한다(조용히 안 늙는다)",
          !noteFresh.includes("낡") &&
            noteStale.includes("낡") &&
            noteStale.includes("gpt-9.9-nova"),
          `최신=${noteFresh.slice(0, 40)} / 낡음=${noteStale.slice(0, 90)}`,
        ),
      );
      setHidden([]);
      setCatalog(null);

      // 표의 키가 실존 provider 인지 — 오타·삭제된 provider 가 조용히 남지 않게.
      const bogus = builtinTierProviders().filter((p) => !isRegisteredProvider(p));
      out.push(
        assert(
          "빌트인 표의 provider 가 전부 실존한다",
          bogus.length === 0,
          bogus.length === 0 ? builtinTierProviders().join(",") : `미지 ${bogus.join(",")}`,
        ),
      );
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(empty, { recursive: true, force: true }).catch(() => undefined);
      await rm(configured, { recursive: true, force: true }).catch(() => undefined);
    }

    // ★어댑터의 실행 가드가 **같은 판정 함수**를 부르는가. 여기가 갈리면 위 초록은
    //  거짓이 된다 — 빌트인은 claude 를 넣는데 어댑터는 인증 없다며 던지는(또는 그 반대)
    //  상태가 되고, 그 차이는 특정 사용자 설치에서만 드러난다.
    const adapter = await readFile(
      new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url),
      "utf8",
    );
    const shared =
      /import \{ claudeAuthAvailable \} from "\.\.\/provider-availability\.js";/.test(
        adapter,
      ) && /if \(!claudeAuthAvailable\(\)\) \{/.test(adapter);
    // ★탐침 결과를 **쓰지는 않는다** — 주장하지 않은 버전에서 받은 모델을 쓰면
    //  "client_version 을 우리가 정한다" 는 계약이 무의미해지고, 낡음 경고도 영영 안 뜬다.
    const cat = await readFile(
      new URL("../../core/llm-runtime/model-catalog.ts", import.meta.url),
      "utf8",
    );
    const probeNotUsed =
      /const ours = await codexModelsAt\(CODEX_CLIENT_VERSION\(\)\);/.test(cat) &&
      /return ours;/.test(cat) &&
      !/return probe/.test(cat);
    out.push(
      assert(
        "★탐침 목록은 감지용일 뿐 실제로 쓰지 않는다",
        probeNotUsed,
        probeNotUsed ? "ours 반환" : "★탐침 결과를 그대로 쓴다 — 낡음 경고가 영영 안 뜬다",
      ),
    );

    // ★갱신을 부르는 자리가 있는가 — 카탈로그가 아무리 잘 돌아도 **아무도 안 부르면**
    //  영원히 비어 정적 표만 쓰인다(조용한 무효화). 새 타이머를 만들지 않고 이미 도는
    //  시계에 얹었으므로, 그 시계가 부르는지를 본다.
    //
    // ★등급: **배선 린트**다 — 실행으로 못 잰다. `runSelfMaintenanceTick` 을 회귀 프로세스
    //  에서 부르면 백업 단계가 딸려 오고, TIGUCLAW_HOME 미설정이면 그게 **다른 인스턴스의
    //  홈**(~/.tiguclaw)을 건드린다(assertIsolated 가 있는 이유). 그래서 소스를 본다.
    // ★첫 판은 `[\s\S]*?` 로 느슨해 `if (false) void refreshModelCatalog()` 를 통과시켰다
    //  (변이로 확인). 문장 자체의 모양을 못 박아 흔한 무력화(가드·주석)를 걸리게 한다.
    const clock = await readFile(
      new URL("../../core/self-maintenance.ts", import.meta.url),
      "utf8",
    );
    const body = clock.slice(clock.indexOf("export const runSelfMaintenanceTick"));
    const wired = /\n  void refreshModelCatalog\(\)\.catch\(/.test(body);
    out.push(
      assert(
        "★자기 보전 틱이 카탈로그 갱신을 부른다(안 부르면 영원히 정적 표)",
        wired,
        wired ? "틱에 배선됨" : "★아무도 갱신을 안 부른다",
      ),
    );
    out.push(
      assert(
        "★claude 어댑터 가드가 같은 인증 판정을 쓴다(두 벌 금지)",
        shared,
        shared ? "claudeAuthAvailable 공유" : "★어댑터가 env 를 직접 다시 읽는다",
      ),
    );

    // ── ★보여주는 곳이 **실행되는 것과 같은 답**을 준다 (2026-08-19 사용자 신고) ──────
    //  "설치하면 기본 모델 프로파일들이 생기지가 않아 — 대시보드에 비어 있는 상태."
    //  런타임은 원래 빌트인으로 잘 돈다(위 검사들이 그걸 지킨다). 문제는 **화면과 프롬프트**
    //  였다: 폴백을 2026-08-13 에 `/models` 에**만** 적어서, 대시보드 엔드포인트와 비서
    //  프롬프트 인벤토리는 `settings.json` 만 보고 빈 목록을 냈다. 사용자에겐 "설치가 덜
    //  된 것" 으로 보이고, 비서는 자기가 쓸 등급을 모르는 채 서브에이전트를 구성한다.
    //  ★그래서 폴백을 소비처마다 적지 않고 `resolveModelProfiles` 하나로 모았다 —
    //   이 검사는 **셋이 그 하나를 쓰는지**만 본다(규칙을 감시하는 대신 부를 것을 하나로).
    {
      const consumers: Array<[string, string]> = [
        ["대시보드(/model-profiles)", await readSource("../../../plugins/http-bridge")],
        ["프롬프트 인벤토리", await readFile(new URL("../../core/prompt-assembly.ts", import.meta.url), "utf8")],
      ];
      const missing = consumers.filter(([, src]) => !/resolveModelProfiles\(/.test(src)).map(([n]) => n);
      out.push(
        assert(
          "★보여주는 소비처가 빌트인 폴백을 쓴다(설정 0인 새 설치에서 빈 목록 금지)",
          missing.length === 0,
          missing.length === 0 ? "대시보드 · 프롬프트" : `★settings 만 보는 곳: ${missing.join(", ")}`,
        ),
      );
      // 판정 자체도 실행으로 — 설정이 없으면 빌트인, 있으면 설정.
      const { resolveModelProfiles } = await import("../../core/llm-runtime/builtin-profiles.js");
      const r = resolveModelProfiles();
      out.push(
        assert(
          "resolveModelProfiles 가 어느 쪽을 쓰는지 말해준다(화면이 구분해 표시할 수 있게)",
          typeof r.builtin === "boolean" && typeof r.profiles === "object",
          `builtin=${r.builtin} · ${Object.keys(r.profiles).length}개`,
        ),
      );
    }
    return out;
  },
};
