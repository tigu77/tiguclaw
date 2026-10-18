/**
 * 회귀: **설치된 Claude CLI 가 MCP 설정의 `${VAR}` 를 채운다** (2026-10-18, 아스트라 회신 Q1).
 *
 * 왜: Claude 경로는 설정을 `--mcp-config <JSON>` 명령줄로 넘기므로, 비밀이 명령줄에 안 실리게 파일에 적힌 모양(`${VAR}`)을 **그대로** 넘기고
 *  CLI 가 자기 환경에서 채우게 했다(`external-mcp.ts` `moveRemoteHeadersToEnv`). 그 동작은 **CLI 의 것**이라 SDK/CLI 를 올릴 때 바뀌면
 *  Claude 경로만 조용히 깨진다 — 가짜 CLI(`adapter-contract`)는 그 동작을 흉내 낼 뿐이라 상류 변경을 못 본다.
 * 본다(실제 CLI · 모델·네트워크 0 · 합성 값): stdio 인자 `${VAR}` · env `${VAR}` · env `${VAR:-기본}` · 원격 URL `${VAR}` · 헤더 `${VAR}`.
 * 등급: **실행**(자식 프로세스 — 실제 CLI 를 띄운다).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_cli-env-expansion-child.ts");

export const check: RegressionCheck = {
  name: "claude-cli-mcp-env-expansion",
  guards: "Claude 경로가 기대는 CLI 의 `${VAR}` 채우기 — 바뀌면 Claude 만 원격 MCP·stdio 비밀을 못 받는데 가짜 CLI 검사는 그걸 못 본다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const r = await spawnWithin(60_000, "cli-env-expansion", ["--import", "tsx", CHILD], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    const j = (line === undefined ? {} : JSON.parse(line)) as { ms?: number; probe?: Record<string, string | null> | null; auth?: string; path?: string; error?: string };
    const p = j.probe ?? null;
    return [
      assert("★stdio — 인자·env 의 `${VAR}` 와 `${VAR:-기본}` 를 CLI 가 채운다",
        p !== null && p.arg === "arg-filled" && p.env === "env-filled" && p.envDefault === "dflt", JSON.stringify({ probe: p, ms: j.ms, timedOut: r.timedOut, err: r.err.slice(-160) })),
      assert("★원격 — URL·헤더의 `${VAR}` 를 CLI 가 채워 서버에 보낸다",
        j.auth === "Bearer token-filled" && (j.path ?? "").includes("k=token-filled"), JSON.stringify({ auth: j.auth, path: j.path })),
    ];
  },
};
