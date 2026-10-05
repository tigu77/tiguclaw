/**
 * 회귀: **Claude 구독 토큰은 잘리지 않고, 거부되면 저장되지 않으며, 재인증은 쿨다운을 푼다** (2026-09-29).
 *
 * 사고(지인 설치본): 붙여넣은 토큰이 줄바꿈으로 잘려 **앞 조각만** 저장됐고, 확인 없이 «다음 턴부터 구독으로 돕니다»
 *  라고 답했다. 모든 턴이 401 이었고 화면은 «사용량 한도 — 12시간 뒤» 라고 했다. 재시작해도 그대로였다.
 * 확인 호출만 가짜(주입)이고 뽑기·고르기·저장·쿨다운 해제는 제품 코드다(임시 홈).
 */
import { readFileSync } from "node:fs";
import { assert, fakeNetwork, type Assertion, type RegressionCheck } from "./_framework.js";

const TOKEN = "sk-ant-oat01-" + "Ab3_x-9".repeat(14) + "AA"; // 모양만 흉내 낸 가짜 값

export const check: RegressionCheck = {
  name: "claude-token-accept",
  guards: "줄바꿈으로 잘린 Claude 토큰 앞 조각이 확인 없이 저장돼 모든 턴이 401 이던 것 — 이어 붙이기 · 거부면 저장 안 함 · 재인증이 쿨다운을 푼다",
  run: async (): Promise<Assertion[]> => {
    const { claudeTokenCandidates, acceptClaudeToken } = await import("../../core/llm-runtime/claude-token.js");
    const { homeEnvPath } = await import("../../core/load-env.js");
    const { initStore } = await import("../../store/sessions.js");
    const { saveCooldown, loadLiveCooldowns, deleteCooldown } = await import("../../store/cooldowns.js");
    initStore();
    const out: Assertion[] = [];

    // ── 뽑기 ─────────────────────────────────────────────────────────────────
    const a = TOKEN.slice(0, 40), b = TOKEN.slice(40, 80), c = TOKEN.slice(80);
    const wrapped = `토큰:\n${a}\n${b}\n${c}\n\n이 토큰을 안전하게 보관하세요.`;
    const boxed = `\x1b[32m│ ${a} │\x1b[0m\n│ ${b}${c} │\n└──────┘`;
    const trailing = `${TOKEN.slice(0, 60)} 을 복사하세요\n${TOKEN.slice(60)}`;
    // ★대시보드 붙여넣기 칸은 한 줄 입력이라 브라우저가 줄바꿈을 **공백으로** 넘긴다(헤드리스 Chrome 실측).
    const browser = `${a} ${b} ${c}`;
    const sentence = `토큰은 ${TOKEN}.`;
    const wordAfter = `${TOKEN}\nDone`;
    // 실제 `claude setup-token` 출력 모양 — 토큰 뒤에 영어 문장. 줄 모드라 문장은 안 붙는다(후보 하나).
    const setupOut = `Your OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely. You won't be able to see it again.\n`;
    out.push(
      assert(
        "★줄바꿈으로 잘린 토큰을 이어 붙인다(평문·색·상자 테두리) — 이은 것이 첫 후보",
        claudeTokenCandidates(wrapped)[0] === TOKEN && claudeTokenCandidates(boxed)[0] === TOKEN && claudeTokenCandidates(TOKEN)[0] === TOKEN &&
          claudeTokenCandidates(browser)[0] === TOKEN && claudeTokenCandidates(sentence)[0] === TOKEN,
        { wrapped: claudeTokenCandidates(wrapped).map((t) => t.length), boxed: claudeTokenCandidates(boxed).map((t) => t.length), browser: claudeTokenCandidates(browser).map((t) => t.length), sentence: claudeTokenCandidates(sentence).map((t) => t.length) },
      ),
    );
    out.push(
      assert(
        "같은 줄에 글이 이어지면 다음 줄을 안 붙인다 · 다음 줄이 낱말이면 붙인 것과 안 붙인 것을 둘 다 낸다(검증이 고른다)",
        claudeTokenCandidates(trailing).length === 1 && claudeTokenCandidates(trailing)[0] === TOKEN.slice(0, 60) &&
          JSON.stringify(claudeTokenCandidates(wordAfter)) === JSON.stringify([TOKEN + "Done", TOKEN]) &&
          claudeTokenCandidates("토큰 없음 sk-ant-짧음").length === 0 &&
          JSON.stringify(claudeTokenCandidates(setupOut)) === JSON.stringify([TOKEN]),
        { trailing: claudeTokenCandidates(trailing).map((t) => t.length), wordAfter: claudeTokenCandidates(wordAfter).map((t) => t.length), setupOut: claudeTokenCandidates(setupOut).length },
      ),
    );

    // ── 고르기·저장 ───────────────────────────────────────────────────────────
    const saved = (): string | undefined => {
      try {
        return /^CLAUDE_CODE_OAUTH_TOKEN=(.*)$/m.exec(readFileSync(homeEnvPath(), "utf8"))?.[1]?.replace(/^"|"$/g, "");
      } catch {
        return undefined;
      }
    };
    const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const onlyFull = async (t: string) => (t === TOKEN ? ("ok" as const) : ("rejected" as const));
      saveCooldown("anthropic", Date.now() + 3_600_000);
      saveCooldown("claude", Date.now() + 3_600_000);
      saveCooldown("codex", Date.now() + 3_600_000);
      const r1 = await acceptClaudeToken(wordAfter, onlyFull);
      const keys = loadLiveCooldowns(Date.now()).map((x) => x.key).sort();
      out.push(
        assert(
          "★확인을 통과한 후보만 저장한다(낱말이 붙은 후보는 거부 → 원래 토큰) · 메모리·파일 둘 다 · Claude 쿨다운만 풀린다",
          r1.ok && process.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN && saved() === TOKEN && JSON.stringify(keys) === '["codex"]' &&
            r1.message.includes("cooldown"),
          { ok: r1.ok, message: r1.message, keys, fileMatches: saved() === TOKEN },
        ),
      );
      deleteCooldown("codex");

      const bad = "sk-ant-oat01-" + "Zz".repeat(20);
      const r2 = await acceptClaudeToken(bad, async () => "rejected");
      out.push(
        assert(
          "★거부된 토큰은 저장하지 않는다 — 메모리·파일 모두 이전 값 그대로, 답은 실패",
          !r2.ok && process.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN && saved() === TOKEN && r2.message.includes("401"),
          { ok: r2.ok, message: r2.message },
        ),
      );

      const other = "sk-ant-oat01-" + "Yy".repeat(20);
      const r3 = await acceptClaudeToken(other, async () => "unknown");
      out.push(
        assert(
          "확인을 못 하면(네트워크) 저장은 하되 «확인하지 못했다» 고 말한다 — 검증 실패로 인증을 막지 않는다",
          r3.ok && process.env.CLAUDE_CODE_OAUTH_TOKEN === other && r3.message.includes("could not be confirmed"),
          { ok: r3.ok, message: r3.message },
        ),
      );
      const r4 = await acceptClaudeToken("아무것도 없음", async () => "ok");
      out.push(assert("토큰이 없으면 실패로 답한다", !r4.ok && r4.message.includes("sk-ant-"), r4));
      // ★확인을 못 하는데 후보가 둘 이상이면 저장하지 않는다 — 첫 것(군더더기가 붙은 쪽)을 저장했다(적대 검토 재현).
      const r5 = await acceptClaudeToken(wordAfter, async () => "unknown");
      out.push(
        assert(
          "★확인 불가 + 후보 여럿이면 저장하지 않는다(어느 쪽이 맞는지 모른다) — 이전 값 그대로",
          !r5.ok && process.env.CLAUDE_CODE_OAUTH_TOKEN === other,
          { ok: r5.ok, message: r5.message },
        ),
      );

      // ── 제품 경로의 확인 호출(기본 check) — 가짜 네트워크, 머리·시한·판정 ─────────────
      const originalFetch = globalThis.fetch;
      const calls: Array<{ url: string; headers: Record<string, string>; signal: boolean }> = [];
      let status = 401;
      globalThis.fetch = fakeNetwork(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal instanceof AbortSignal });
        return new Response("{}", { status });
      }) as typeof fetch;
      try {
        const denied = await acceptClaudeToken(TOKEN);
        status = 500;
        const unknownOne = await acceptClaudeToken(TOKEN);
        status = 200;
        const good = await acceptClaudeToken(TOKEN);
        const h = calls[0]?.headers ?? {};
        out.push(
          assert(
            "★기본 확인이 실제로 돈다 — 401=거부(저장 안 함) · 500=모름(후보 하나면 저장) · 200=통함, 구독 머리(bearer·beta)와 시한을 싣는다",
            !denied.ok && unknownOne.ok && unknownOne.message.includes("could not be confirmed") && good.ok && good.message.includes("Checked and saved") &&
              calls[0]?.url.includes("/v1/models") === true && h.authorization === `Bearer ${TOKEN}` && h["anthropic-beta"] === "oauth-2025-04-20" &&
              calls.every((c) => c.signal),
            { denied: denied.ok, unknownOne: unknownOne.ok, good: good.ok, calls: calls.length, beta: h["anthropic-beta"], signal: calls.every((c) => c.signal) },
          ),
        );

        // ★통지 표시까지 푼다 — DB 행만 지우면 새 토큰도 거부될 때 재등록이 조용히 끝났다(적대 검토 P2).
        //  정확한 키만 — 자기 키를 쓰는 사용자 정의 provider(`anthropic-work`)는 그대로.
        const rt = await import("../../core/llm-runtime/index.js");
        const { getPaths } = await import("../../core/paths.js");
        const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
        // claude 어댑터를 타는 사용자 정의 provider(`work`) — 같은 구독 자격이라 같이 풀려야 한다(전체 검토).
        wf(getPaths().settings, JSON.stringify({ models: { providers: { work: { adapter: "claude", apiKeyEnv: "REGR_WORK_KEY" } } } }));
        try {
          saveCooldown("anthropic", Date.now() + 3_600_000);
          saveCooldown("work", Date.now() + 3_600_000);
          saveCooldown("openai", Date.now() + 3_600_000);
          rt.markCooldownAnnounced("anthropic", Date.now() + 3_600_000);
          await acceptClaudeToken(TOKEN);
          const reannounce = rt.registerCooldownIfRateLimited({ adapter: "claude", model: "regr", provider: "anthropic" } as never, new Error("API Error: 401 OAuth access token is invalid."));
          const left = loadLiveCooldowns(Date.now()).map((x) => x.key).sort();
          out.push(
            assert(
              "★재인증은 그 자격을 쓰는 쉼 전부(사용자 정의 claude provider 포함)를 통지 표시까지 푼다 · 다른 자격(openai)은 그대로",
              reannounce !== null && !left.includes("work") && left.includes("openai"),
              { reannounce: reannounce?.reason ?? null, left },
            ),
          );
          // ★다른 프로세스(터미널 CLI)가 DB 에서만 풀어도 데몬의 통지 표시가 풀린다 — 조회가 DB 를 보는 자리에서.
          rt.markCooldownAnnounced("anthropic", Date.now() + 3_600_000);
          deleteCooldown("anthropic");
          rt.cooldownRemainingMs({ adapter: "claude", model: "regr", provider: "anthropic" } as never);
          const again = rt.registerCooldownIfRateLimited({ adapter: "claude", model: "regr", provider: "anthropic" } as never, new Error("API Error: 401 OAuth access token is invalid."));
          out.push(
            assert(
              "★다른 프로세스가 DB 에서 푼 쉼은 데몬의 통지 표시도 풀린다 — 새로 거부되면 다시 알린다",
              again !== null,
              { again: again?.reason ?? null },
            ),
          );
        } finally {
          rm(getPaths().settings, { force: true });
          deleteCooldown("work");
          deleteCooldown("openai");
        }

        // host 게이트 — needs.auth 에 claude-subscription 이 없으면 저장하지 않는다.
        const { createPluginHost } = await import("../../core/plugins/host.js");
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "before-gate";
        const denyHost = await createPluginHost("regr-noauth", {}).saveClaudeToken(TOKEN);
        const gated = process.env.CLAUDE_CODE_OAUTH_TOKEN === "before-gate";
        const allowHost = await createPluginHost("regr-auth", { auth: ["claude-subscription"] } as never).saveClaudeToken(TOKEN);
        out.push(
          assert(
            "플러그인 host 는 needs.auth 에 claude-subscription 이 있을 때만 토큰을 받는다",
            !denyHost.ok && gated && allowHost.ok && process.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN,
            { deny: denyHost.ok, gated, allow: allowHost.ok },
          ),
        );
        status = 401;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "before-generic";
        const generic = await createPluginHost("regr-old-plugin", { auth: ["claude-subscription"] } as never).saveAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN.slice(0, 50) });
        out.push(
          assert(
            "★범용 saveAuthEnv 로 넘긴 Claude 토큰도 확인을 지난다 — 잘린 토큰(401)은 저장하지 않는다(옛 플러그인 경로)",
            !generic.ok && process.env.CLAUDE_CODE_OAUTH_TOKEN === "before-generic",
            generic,
          ),
        );
        status = 200;
      } finally {
        globalThis.fetch = originalFetch;
        deleteCooldown("anthropic-work");
      }
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
      deleteCooldown("anthropic");
      deleteCooldown("claude");
      deleteCooldown("codex");
    }

    // ── 배선 ─────────────────────────────────────────────────────────────────
    const { readSourceSync } = await import("./_wiring.js");
    const plugin = readSourceSync("plugins/claude-subscription-auth/index.mjs");
    const cli = readSourceSync("src/scripts/claude-auth.ts");
    const catalog = readSourceSync("src/core/llm-runtime/model-catalog.ts");
    const wired = {
      plugin: /finish: async \(pasted\) => host\.saveClaudeToken\(String\(pasted \?\? ""\)\),/.test(plugin) && !/sk-ant-\[/.test(plugin),
      cli: /acceptClaudeToken\(captured\.out\)/.test(cli) && /acceptClaudeToken\(pasted\)/.test(cli) && !/TOKEN_RE/.test(cli) && !/rl\.question/.test(cli),
      catalog: /const headers = anthropicModelsHeaders\(key, oauth\);/.test(catalog),
    };
    out.push(
      assert(
        "★화면 붙여넣기·터미널 발급·모델 목록 조회가 같은 판단을 쓴다(한 줄만 집는 옛 정규식·첫 줄에서 끝나는 입력 없음)",
        wired.plugin && wired.cli && wired.catalog,
        wired,
      ),
    );
    return out;
  },
};
