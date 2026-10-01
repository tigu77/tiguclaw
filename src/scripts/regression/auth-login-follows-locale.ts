/**
 * 회귀: **구독 인증 버튼·안내가 설정 언어를 따른다** (2026-10-01 — 백로그 «구독 토큰 발급 버튼 문구 현지화 없음»).
 *
 * 종전엔 두 구독 플러그인(claude·codex)이 한국어 문구를 박아 두어 영어 설정에서도 «구독 토큰 발급»·«ChatGPT 로 로그인» 이었고,
 * `host.locale` 은 플러그인 시작 때 한 번만 읽혀 언어를 바꿔도 재시작 전까지 옛 언어였다.
 * 지키는 것: 실제 플러그인을 가짜 호스트로 띄워 ① 버튼 이름이 **읽을 때의** 설정 언어 ② 안내(begin 결과)도 같은 언어
 *  ③ 실제 호스트의 `locale` 이 매번 새로 읽힌다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Login = { label: string; begin: () => Promise<{ summary?: string; pasteHint?: string }> };

export const check: RegressionCheck = {
  name: "auth-login-follows-locale",
  guards: "구독 인증 버튼·안내가 한국어 고정이라 영어 설정에서도 한국어였고, 언어를 바꿔도 재시작 전까지 옛 언어이던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-authlocale-"));
    let locale = "ko";
    const regs: Record<string, { login?: Login }> = {};
    const host = {
      get locale() { return locale; },
      log: () => {},
      dataDir: dir,
      registerAuthProvider: (p: { provider: string; login?: Login }) => { regs[p.provider] = p; return { ok: true }; },
      beginClaudeTokenIssue: async () => ({ ok: true, url: "https://example.invalid/oauth" }),
      saveClaudeToken: async () => ({ ok: true, message: "" }),
    };
    try {
      const Claude = (await loadPluginModule<{ default: new () => { startService: (b: unknown, h: unknown) => Promise<void> } }>("../../../plugins/claude-subscription-auth/index.mjs")).default;
      await new Claude().startService(null, host);
      const Codex = (await loadPluginModule<{ default: new () => { startService: (b: unknown, h: unknown) => Promise<void> } }>("../../../plugins/codex-subscription-auth/index.js")).default;
      await new Codex().startService(null, host);
      const cl = regs["claude-subscription"]?.login, cx = regs["codex"]?.login;
      const koLabels = [cl?.label, cx?.label];
      const koHint = (await cl?.begin())?.pasteHint ?? "";
      locale = "en";
      const enLabels = [cl?.label, cx?.label];
      const enPlan = await cl?.begin();
      const { createPluginHost } = await import("../../core/plugins/host.js");
      const { readLocale } = await import("../../core/i18n.js");
      const real = createPluginHost("regr-locale", {} as never);
      const live = real.locale === readLocale();
      return [
        assert("★버튼 이름이 읽을 때의 설정 언어 — 한국어 → 영어로 바꾸면 재시작 없이 바뀐다(claude·codex)",
          koLabels[0] === "구독 토큰 발급" && koLabels[1] === "ChatGPT 로 로그인" && enLabels[0] === "Get subscription token" && enLabels[1] === "Sign in with ChatGPT",
          { koLabels, enLabels }),
        assert("안내(begin 결과)도 같은 언어", koHint.includes("코드") && /code/i.test(enPlan?.pasteHint ?? "") && /Sign in/.test(enPlan?.summary ?? ""), { koHint, en: enPlan }),
        assert("실제 호스트의 locale 이 설정 언어를 읽는다(getter — 매번 새로)", live && Object.getOwnPropertyDescriptor(real, "locale")?.get !== undefined, { live }),
      ];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
