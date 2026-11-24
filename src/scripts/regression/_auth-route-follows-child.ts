/**
 * 자식 프로브 — `auth-route-follows-credentials` 가 띄운다. 홈 `.env` 따라가기(모듈 전역)를 임시 파일에 걸기 때문에
 * 부모(회귀 러너) 프로세스를 오염시키지 않게 여기서만 돈다. 결과를 JSON 한 줄로 낸다.
 *
 * 하는 일: 임시 홈 `.env`(자격 없음)로 따라가기를 켜고 → 가짜 provider 두 개(표지 있음/없음)를 등록 → 목록 라우트를 부른다 →
 * **다른 프로세스가 쓴 것처럼** 그 파일에 토큰을 적고 다시 부른다 → 토큰을 바꿔 한 번 더. 실제 자격·네트워크 0.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "auth-route-follow-"));
process.env.TIGUCLAW_HOME = dir;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
const envPath = path.join(dir, ".env");
writeFileSync(envPath, "SOME_OTHER=1\n", { mode: 0o600 });

const main = async (): Promise<void> => {
  const { startHomeCredentialWatch } = await import("../../core/credential-env.js");
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  // plugins/ 를 문자 그대로 import 하지 않는다(build 경계 — `src-stays-inside-src`).
  const { handleAuthProviders, handleAuthUsage, handleAuthLoginFinish } = (await import(
    new URL("../../../plugins/http-bridge/routes-auth.ts", import.meta.url).href
  )) as Record<"handleAuthProviders" | "handleAuthUsage" | "handleAuthLoginFinish", (c: unknown) => Promise<void>>;
  startHomeCredentialWatch(envPath);
  const token = (): string => (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  const tagOf = (t: string): string => (t === "" ? "" : createHash("sha256").update(t).digest("hex").slice(0, 12));
  registerAuthProvider({
    provider: "probe-tagged",
    getAccessToken: async () => token(),
    isAuthenticated: () => token() !== "",
    credentialTag: () => tagOf(token()),
    // 한도 조회가 **어느 자격으로** 불렸나만 말한다(토큰 값은 안 싣는다).
    getUsage: async (_force?: boolean, opts?: { afterAuth?: boolean }) => ({
      windows: [],
      measuredAt: 1,
      reason: `${token() === "" ? "no-token" : `token-${token().slice(-5)}`}${opts?.afterAuth === true ? "|after-auth" : ""}`,
    }),
    login: { label: "probe", begin: async () => ({ summary: "probe" }), finish: async () => ({ ok: true, message: "ok" }) },
  });
  registerAuthProvider({
    provider: "probe-untagged",
    getAccessToken: async () => token(),
    isAuthenticated: () => token() !== "",
  });
  const list = async (): Promise<Array<{ provider: string; authenticated: boolean | null; credential: string | null }>> => {
    let body = "";
    const res = { writeHead: () => res, setHeader: () => {}, end: (b: string) => { body = b; } };
    await handleAuthProviders({ req: { method: "GET" }, res, url: new URL("http://x/auth-providers") } as never);
    return (JSON.parse(body) as { providers: Array<{ provider: string; authenticated: boolean | null; credential: string | null }> }).providers;
  };
  const pick = (items: Awaited<ReturnType<typeof list>>, id: string) => items.find((p) => p.provider === id);
  const usageReason = async (extra = ""): Promise<string | undefined> => {
    let body = "";
    const res = { writeHead: () => res, setHeader: () => {}, end: (b: string) => { body = b; } };
    await handleAuthUsage({ req: { method: "GET" }, res, url: new URL(`http://x/auth-usage?provider=probe-tagged${extra}`) } as never);
    return (JSON.parse(body) as { usage?: { reason?: string } }).usage?.reason;
  };
  const before = await list();
  writeFileSync(envPath, "SOME_OTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-probe-first\n"); // 다른 프로세스(터미널 발급)가 썼다
  const usageFirst = await usageReason(); // 목록보다 **한도 라우트가 먼저** 불렸다(🔄)
  const usageAfterAuth = await usageReason("&after=auth"); // 화면이 인증 변화로 다시 묻는 조회
  const afterFirst = await list();
  writeFileSync(envPath, "SOME_OTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-probe-second\n"); // 다시 발급(계정 교체)
  const afterSecond = await list();
  const again = await list();
  // 마무리 응답 — 목록과 **같은** 표지를 싣는가(화면이 그 응답을 그 provider 의 확정 상태로 쓴다)
  let finishBody = "";
  {
    const { Readable } = await import("node:stream");
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ provider: "probe-tagged", pasted: "x" }))]), { method: "POST", headers: { "content-type": "application/json" } });
    const res = { writeHead: () => res, setHeader: () => {}, end: (b: string) => { finishBody = b; } };
    await handleAuthLoginFinish({ req, res, url: new URL("http://x/auth-login-finish") } as never);
  }
  const finish = JSON.parse(finishBody) as { credential?: string | null; authenticated?: boolean };
  const raw = JSON.stringify([before, afterFirst, afterSecond, again, finishBody]);
  process.stdout.write(
    JSON.stringify({
      before: pick(before, "probe-tagged"),
      afterFirst: pick(afterFirst, "probe-tagged"),
      afterSecond: pick(afterSecond, "probe-tagged"),
      again: pick(again, "probe-tagged"),
      untagged: pick(afterSecond, "probe-untagged"),
      usageFirst,
      usageAfterAuth,
      finishCredential: finish.credential,
      finishAuthenticated: finish.authenticated,
      leaksToken: raw.includes("sk-ant-probe"),
      leaksTag: raw.includes(tagOf("sk-ant-probe-first")) || raw.includes(tagOf("sk-ant-probe-second")),
    }) + "\n",
  );
};

main()
  .catch((e) => {
    process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.stack ?? e.message : String(e) }) + "\n");
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
