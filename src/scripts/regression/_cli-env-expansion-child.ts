/**
 * `claude-cli-mcp-env-expansion` 의 자식 — **설치된 실제 Claude CLI** 를 모델 호출 없이 띄워, 우리가 Claude 경로에 넘기는 설정 모양
 * (`${VAR}` 를 적힌 그대로)을 CLI 가 채우는지 본다. 자식인 이유: CLI 프로세스·환경을 통째로 바꾼다.
 * ★모델·네트워크 0: API 주소를 닫힌 로컬 포트로, 부가 트래픽 끔. CLI 는 MCP 서버를 API 호출 **전에** 띄운다(2026-10-18 실측) — 둘 다 닿으면 끊는다.
 * ★사용자 `~/.claude` 를 안 건드린다 — HOME·설정 폴더를 임시 폴더로.
 * 출력: 마지막 줄 JSON.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { freePort } from "./_probe-helpers.js";

assertIsolated();
const dir = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "cli-env-"));
const fakeHome = path.join(dir, "home");
mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
const probeOut = path.join(dir, "probe.json");
const probe = path.join(dir, "probe.mjs");
writeFileSync(probe, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({ arg: process.argv[3] ?? null, env: process.env.PROBE_ENV ?? null, envDefault: process.env.PROBE_DEFAULT ?? null }));
process.stdin.on("data", () => {});`);
let seenAuth = "";
let seenPath = "";
const http = createServer((req, res) => {
  seenAuth ||= String(req.headers.authorization ?? "");
  seenPath ||= String(req.url ?? "");
  res.writeHead(401).end();
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
const mcpUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
const deadPort = await freePort(); // 잡았다 놓은 포트 — API 호출은 바로 거절된다

const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"),
  ANTHROPIC_API_KEY: "sk-ant-regression-not-a-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${deadPort}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  ...(process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}),
  REGR_ARG: "arg-filled",
  REGR_ENV: "env-filled",
  REGR_TOKEN: "token-filled",
  REGR_MCP_URL: mcpUrl,
};
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const ac = new AbortController();
const started = Date.now();
const done = (): boolean => existsSync(probeOut) && seenAuth !== "";
const watch = setInterval(() => { if (done() || Date.now() - started > 40_000) ac.abort(); }, 100);
let error = "";
try {
  for await (const m of query({
    prompt: "hi",
    options: {
      env, cwd: dir, settingSources: [], maxTurns: 1, abortController: ac,
      mcpServers: {
        probe: { type: "stdio", command: process.execPath, args: [probe, probeOut, "${REGR_ARG}"], env: { PROBE_ENV: "${REGR_ENV}", PROBE_DEFAULT: "${REGR_UNSET_X:-dflt}" } },
        remote: { type: "http", url: "${REGR_MCP_URL}/mcp?k=${REGR_TOKEN}", headers: { Authorization: "Bearer ${REGR_TOKEN}" } },
      },
    } as never,
  })) void m;
} catch (e) {
  error = String((e as Error)?.message ?? e).slice(0, 120);
}
clearInterval(watch);
const probeSeen = existsSync(probeOut) ? (JSON.parse(readFileSync(probeOut, "utf8")) as Record<string, string | null>) : null;
http.close();
console.log(JSON.stringify({ ms: Date.now() - started, probe: probeSeen, auth: seenAuth, path: seenPath, error }));
process.exit(0);
