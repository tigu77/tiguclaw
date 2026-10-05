/**
 * 회귀: **빈 env(`KEY=`)는 «없음» 이다 · 키 없는 로컬 서버는 settings.json 에 주소를 적었을 때만 «쓸 수 있다»**
 * (2026-09-27 · 2026-09-28 내장 ollama 제거).
 *
 * ★사고(윈도우 돌쇠 로그, 9/13 부터): 설치 템플릿이 `.env` 에 `OLLAMA_BASE_URL=` 빈 줄을 쓰고, 주소 해석이 `??` 라 빈
 *  문자열이 통과해 `/v1/models` 상대 URL 로 모델 목록 조회가 **매시간 실패**했다. 내장 ollama 는 대체 키 덕에 늘 «인증됨»
 *  이라 ollama 가 없는 설치본도 조회했다. 첫 수정은 빈 값·주소 변수 규칙을 더했는데(특수 규칙 셋), 정태님 «내부적으로 정리가
 *  가능한 부분은 정리해서 관리 이슈를 줄이자» 로 **내장 자체를 뺐다** — 로컬 서버는 다른 OpenAI 호환 서버와 같은 한 경로
 *  (`models.providers`)이고, 키가 없으면 `apiKeyEnv` 를 안 적는다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "empty-env-is-unset",
  guards: "빈 env 줄이 값으로 읽히던 것 · 키 없는 로컬 서버가 설정 없이도 «인증됨» 으로 목록 조회·표시되던 것 · 내장 ollama 가 OLLAMA_BASE_URL 이라는 자기만의 규칙을 들고 있던 것",
  run: async (): Promise<Assertion[]> => {
    const { existsSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const { getPaths } = await import("../../core/paths.js");
    const { envValue, resolveProviderConn, KEYLESS_API_KEY } = await import("../../core/llm-runtime/provider-registry.js");
    const { providerAuthAvailable, missingAuthEnv } = await import("../../core/llm-runtime/provider-availability.js");
    const { loadModelProviders } = await import("../../core/settings.js");
    const { parseModelSpec, unresolvedModelSpecs, unresolvedOverrideNote } = await import("../../core/llm-runtime/index.js");
    const KEYS = ["OLLAMA_BASE_URL", "OPENAI_API_KEY", "REGR_EMPTY_ENV", "REGR_REMOTE_KEY", "MODEL_TIER_NANO", "REGION_A_MODELS", "LLM_GATEWAY_MODELS"] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    const set = (k: (typeof KEYS)[number], v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    const settingsFile = path.join(getPaths().home, "settings.json");
    const prevSettings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : undefined;
    try {
      // 내장 ollama 는 없다 — 옛 env 가 있어도 읽지 않는다.
      set("OLLAMA_BASE_URL", "http://gpu-box:11434");
      writeFileSync(settingsFile, "{}\n");
      const noBuiltin = { conn: resolveProviderConn("ollama"), spec: parseModelSpec("ollama:qwen3:8b") };
      // 부팅 진단 — 없는 provider 를 가리키는 프로파일 원소를 조용히 버리지 않고 말한다(내장을 뺀 날 옮기지 않은 설치본).
      writeFileSync(settingsFile, JSON.stringify({ models: { profiles: { local: { pool: ["ollama:qwen3:8b", "anthropic:claude-sonnet-5", "형식없음"] } } } }) + "\n");
      const diagMissing = unresolvedModelSpecs();
      writeFileSync(settingsFile, JSON.stringify({ models: { profiles: { local: { pool: ["ollama:qwen3:8b"] } }, providers: { ollama: { adapter: "openai", baseURL: "http://gpu-box:11434/v1", apiKeyEnv: null } } } }) + "\n");
      const diagDefined = unresolvedModelSpecs();
      // 프로파일 밖의 자리도 본다 — 옛 `.env` 등급(프로파일이 없을 때만 읽힘)·REGION_A_MODELS·게이트웨이 풀(적대 검토 P4-2).
      writeFileSync(settingsFile, "{}\n");
      set("MODEL_TIER_NANO", "ollama:qwen2.5:7b"); set("REGION_A_MODELS", "ollama:gemma3,anthropic:claude-opus-5"); set("LLM_GATEWAY_MODELS", "ollama:x");
      const diagEnv = unresolvedModelSpecs();
      writeFileSync(settingsFile, JSON.stringify({ models: { profiles: { low: { pool: ["anthropic:claude-haiku-4-5"] } } } }) + "\n");
      const diagEnvShadowed = unresolvedModelSpecs();
      const overrideDead = unresolvedOverrideNote("ollama:qwen3:8b");
      const overrideLive = unresolvedOverrideNote("anthropic:claude-opus-5");
      // 콤마 풀 중 하나라도 풀리면 라우터는 그걸 쓴다 — 경고하면 안 된다(재검토 P2: reset 하면 쓰던 풀을 잃는다).
      const overridePartly = unresolvedOverrideNote("ollama:qwen2.5:7b,anthropic:claude-haiku-4-5");
      set("MODEL_TIER_NANO", undefined); set("REGION_A_MODELS", undefined); set("LLM_GATEWAY_MODELS", undefined);
      set("OLLAMA_BASE_URL", undefined);

      writeFileSync(settingsFile, JSON.stringify({
        models: {
          providers: {
            ollama: { adapter: "openai", baseURL: "http://gpu-box:11434/v1", apiKeyEnv: null },
            remote: { adapter: "openai", baseURL: "https://llm.example/v1", apiKeyEnv: "REGR_REMOTE_KEY" },
            nowhere: { adapter: "openai" },
            badkey: { adapter: "openai", baseURL: "http://x/v1", apiKeyEnv: "   " },
            typo: { adapter: "openai", baseURL: "https://openrouter.ai/api/v1", apikeyEnv: "OPENROUTER_API_KEY" },
            noted: { adapter: "openai", baseURL: "https://llm.example/v1", apiKeyEnv: "REGR_REMOTE_KEY", note: "메모" },
            lmstudio: { adapter: "openai", baseURL: "http://localhost:1234/v1", apiKeyEnv: null, apiKey: "lm-studio" },
            implicit: { adapter: "openai", baseURL: "http://localhost:1234/v1" },
            remotekey: { adapter: "openai", baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or-v1-abc" },
            nullnourl: { adapter: "openai", apiKeyEnv: null },
          },
        },
      }) + "\n");
      const keyless = { conn: resolveProviderConn("ollama"), available: providerAuthAvailable("ollama"), missing: missingAuthEnv("ollama"), spec: parseModelSpec("ollama:qwen3:8b") };
      set("REGR_REMOTE_KEY", "");
      const remoteEmpty = { available: providerAuthAvailable("remote"), apiKey: resolveProviderConn("remote")?.apiKey, missing: missingAuthEnv("remote") };
      set("REGR_REMOTE_KEY", "sk-remote");
      const remoteSet = { available: providerAuthAvailable("remote"), apiKey: resolveProviderConn("remote")?.apiKey };
      const warns: string[] = [];
      const realWarn = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      let providers: ReturnType<typeof loadModelProviders>;
      try { providers = loadModelProviders(undefined, true); } finally { console.warn = realWarn; }
      // 적혀 있는데 버려진 provider 는 «없음» 이 아니라 «설정이 잘못됨» 으로 말한다(재검토 P2).


      set("OPENAI_API_KEY", "");
      const openaiEmpty = { available: providerAuthAvailable("openai"), apiKey: resolveProviderConn("openai")?.apiKey };
      set("OPENAI_API_KEY", "sk-real");
      const openaiSet = providerAuthAvailable("openai");
      set("OPENAI_API_KEY", undefined);

      // 카드 — 판정과 같은 규칙에서 «무엇을 설정하나» 를 말한다(실제 모듈 목록으로 본다).
      const { collectModules } = await import("../../core/plugins/providers.js");
      const mods = (await collectModules()) as unknown as { providers: Array<{ id: string; summary?: { key?: string; params?: Record<string, unknown> } }> };
      const card = (id: string) => mods.providers.find((m) => m.id === id)?.summary;
      const localCard = card("llm-adapter.ollama");
      const openaiCard = card("llm-adapter.openai");
      writeFileSync(settingsFile, JSON.stringify({ models: { profiles: { p: { pool: ["typo:gpt-x", "ghost:gpt-y"] } }, providers: { typo: { adapter: "openai", baseURL: "https://openrouter.ai/api/v1", apikeyEnv: "OPENROUTER_API_KEY" } } } }) + "\n");
      const diagTypo = unresolvedModelSpecs();
      writeFileSync(settingsFile, JSON.stringify({ models: { profiles: { p: { pool: ["myanthropic:claude-x"] } }, providers: { myanthropic: { adapter: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" } } } }) + "\n");
      const diagAdapter = unresolvedModelSpecs();
      const overrideAdapter = unresolvedOverrideNote("myanthropic:claude-x");

      set("REGR_EMPTY_ENV", " ");
      const ev = [envValue("REGR_EMPTY_ENV"), (set("REGR_EMPTY_ENV", " v "), envValue("REGR_EMPTY_ENV"))];
      return [
        assert("★내장 ollama 는 없다 — `OLLAMA_BASE_URL` 이 있어도 provider 로 해석되지 않는다(설정한 것만 쓴다)", noBuiltin.conn === null && noBuiltin.spec === null, noBuiltin),
        assert("★부팅 진단: 없는 provider 원소는 이름과 설정 자리를 말하고, 형식 오류도 말한다 · 정의하면 조용하다",
          diagMissing.length === 2 && diagMissing.some((m) => m.includes("'ollama'") && m.includes("models.providers.ollama")) && diagMissing.some((m) => m.includes("형식없음")) && diagDefined.length === 0,
          { diagMissing, diagDefined }),
        // ★옛 `.env` 모델 줄(REGION_A_MODELS·MODEL_TIER_*)은 더 읽지 않으므로 진단도 하지 않는다(2026-09-29 — 부팅이 옮긴다).
        assert("★진단은 프로파일 밖의 **읽히는** 자리(게이트웨이 풀)를 본다 · 안 읽는 옛 .env 모델 줄은 말하지 않는다",
          diagEnv.some((m) => m.includes("LLM_GATEWAY_MODELS")) && !diagEnv.some((m) => m.includes("claude-opus-5")) &&
            !diagEnv.some((m) => m.includes("MODEL_TIER_NANO") || m.includes("REGION_A_MODELS")) &&
            !diagEnvShadowed.some((m) => m.includes("MODEL_TIER_NANO") || m.includes("REGION_A_MODELS")),
          { diagEnv, diagEnvShadowed }),
        assert("★풀리지 않는 세션 override 는 그렇다고 말한다 · 풀리는 것·일부라도 풀리는 콤마 풀(라우터가 그걸 씀)은 조용하다",
          overrideDead.includes("ollama:qwen3:8b") && overrideDead.includes("/model reset") && overrideLive === "" && overridePartly === "", { overrideDead, overrideLive, overridePartly }),
        assert("★키 없는 사용자 정의 서버: 주소를 적으면 쓸 수 있고, 그 주소·자리표시 키로 간다 · 말할 설정 변수 없음",
          keyless.available && keyless.conn?.baseURL === "http://gpu-box:11434/v1" && keyless.conn?.apiKey === KEYLESS_API_KEY && keyless.missing === undefined && keyless.spec?.adapter === "openai",
          keyless),
        assert("키를 가리키는 서버는 빈 키 줄이면 «없음»(안내는 그 변수) · 값이 있으면 그 키", !remoteEmpty.available && remoteEmpty.apiKey === undefined && remoteEmpty.missing === "REGR_REMOTE_KEY" && remoteSet.available && remoteSet.apiKey === "sk-remote", { remoteEmpty, remoteSet }),
        assert("키도 주소도 없는 항목·공백 키 변수는 설정 오류로 버린다(정품 경로로 키 없이 가지 않는다)", providers.nowhere === undefined && providers.badkey === undefined && providers.ollama !== undefined, Object.keys(providers)),
        assert("★키 없는 서버는 `\"apiKeyEnv\": null` 로 **명시**한 것만 — 빠뜨림·오타(`apikeyEnv`)·다른 도구 철자(`apiKey`, 원격 키 포함)는 버린다 · 반대 방향: 명시하면 가짜 `apiKey` 필드가 있어도 받고, 키가 맞으면 모르는 필드가 있어도 받는다",
          providers.typo === undefined && providers.implicit === undefined && providers.remotekey === undefined && providers.nullnourl === undefined &&
            providers.noted?.apiKeyEnv === "REGR_REMOTE_KEY" && providers.lmstudio?.baseURL === "http://localhost:1234/v1" && providers.lmstudio.apiKeyEnv === undefined,
          { typo: providers.typo, implicit: providers.implicit, remotekey: providers.remotekey, noted: providers.noted, lmstudio: providers.lmstudio }),
        assert("부팅 경고가 고치는 법을 말한다 — 키가 없으면 `\"apiKeyEnv\": null` 안내 · 모르는 필드는 이름을 댄다",
          warns.some((w) => w.includes("models.providers.implicit") && w.includes('"apiKeyEnv": null')) && warns.some((w) => w.includes("models.providers.lmstudio") && w.includes("`apiKey`")),
          warns),
        assert("★모르는 adapter 로 적은 provider 는 그 사실(쓸 수 있는 adapter)을 말한다 — «위 경고를 보세요» 로 없는 경고를 가리키지 않는다 · override 경고도 같은 사유",
          diagAdapter.some((m) => m.includes("adapter 'anthropic'") && m.includes("openai")) && overrideAdapter.includes("adapter 'anthropic'"), { diagAdapter, overrideAdapter }),
        assert("★적혀 있는데 버려진 provider 는 «설정이 잘못됨» 으로, 아예 없는 provider 는 «정의하세요» 로 가른다",
          diagTypo.some((m) => m.includes("'typo'") && m.includes("misconfigured")) && diagTypo.some((m) => m.includes("'ghost'") && m.includes("define it under")), diagTypo),
        assert("반대 방향: 키가 필요한 provider(openai)는 빈 키면 «없음», 키가 있으면 «있음» — 판정을 넓히지 않았다", openaiEmpty.available === false && openaiEmpty.apiKey === undefined && openaiSet === true, { openaiEmpty, openaiSet }),
        assert("envValue: 공백뿐이면 없음 · 값은 다듬어 돌려준다", ev[0] === undefined && ev[1] === "v", ev),
        assert("카드: 키 없는 서버는 «인증됨» · openai 는 키 변수를 안내", localCard?.key === "modules.summary.adapterAuthed" && openaiCard?.params?.env === "OPENAI_API_KEY", { localCard, openaiCard }),
      ];
    } finally {
      for (const k of KEYS) set(k, saved[k]);
      if (prevSettings === undefined) rmSync(settingsFile, { force: true }); else writeFileSync(settingsFile, prevSettings);
    }
  },
};
