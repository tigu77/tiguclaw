/**
 * 회귀: **stdio MCP 연결 실패 로그에 그 서버의 stderr 끝부분이 남는다** (2026-10-18, 회사돌쇠 운영점검 1번).
 *
 * 사고: 프로젝트 MCP `voxelbuilder-s5` 가 하루 40번 `연결 실패 … (MCP error -32000: Connection closed)` 만 남겼다 — 서버는 준비 실패를 stderr 로
 *  말했는데 SDK 기본(`inherit`)이 그걸 데몬에 그냥 흘려 날짜 로그(`console.*` 미러)엔 없었다. 원격 인스턴스는 로그가 유일한 창이다.
 * 본다(실제 자식 프로세스): 말하고 죽는 서버 → 실패 줄에 그 서버의 stderr 끝(비밀은 가려짐) · 조용히 죽는 서버 → 원인을 지어내지 않음 ·
 *  병렬 두 서버의 꼬리가 섞이지 않음 · 긴 stderr 는 상한 안으로.
 * 등급: **실행**(격리 홈 · 실제 stdio 자식).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const SECRET = "sk-ant-api03-regressionsecretvalue0123456789abcdefABCDEF";

export const check: RegressionCheck = {
  name: "mcp-stderr-diagnostic",
  guards: "stdio MCP 가 연결 전에 stderr 로 원인을 말하고 죽어도 로그엔 «Connection closed» 만 남던 것 — SDK 기본이 stderr 를 데몬에 흘렸다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { getPaths } = await import("../../core/paths.js");
    const ext = await import("../../core/external-mcp.js");
    const home = getPaths().home;
    const script = (file: string, body: string): string => {
      const p = path.join(home, file);
      writeFileSync(p, body);
      return p;
    };
    const loud = script("mcp-loud.mjs", `process.stderr.write("준비 실패: Godot 경로를 찾을 수 없음\\nkey=${SECRET}\\n"); process.exit(1);`);
    const other = script("mcp-other.mjs", `process.stderr.write("다른 서버 B 의 오류\\n"); process.exit(1);`);
    const quiet = script("mcp-quiet.mjs", `process.exit(1);`);
    const big = script("mcp-big.mjs", `process.stderr.write("앞부분-버려져야 함 " + "가".repeat(20000) + " 끝부분-남아야 함\\n"); process.exit(1);`);
    const file = path.join(home, "mcp.json");
    const prev = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const lines: string[] = [];
    const orig = { error: console.error, warn: console.warn, stderrWrite: process.stderr.write.bind(process.stderr) };
    let rawStderr = "";
    // 서버 stderr 는 종전(`inherit`)처럼 데몬 stderr 로도 흐른다 — 꼬리만 남기면 붙어 있는 서버의 출력이 사라진다(리뷰 10-18).
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      rawStderr += String(chunk);
      void rest;
      return true;
    }) as typeof process.stderr.write;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const node = process.execPath;
      writeFileSync(file, JSON.stringify({ mcpServers: {
        "regr-loud": { command: node, args: [loud] },
        "regr-other": { command: node, args: [other] },
        "regr-quiet": { command: node, args: [quiet] },
        "regr-big": { command: node, args: [big] },
      } }));
      for (const b of await ext.getConnectedExternalMcpBridges()) await b.close();
    } finally {
      console.error = orig.error;
      console.warn = orig.warn;
      process.stderr.write = orig.stderrWrite;
      await ext.closeAllExternalMcp();
      if (prev === undefined) rmSync(file, { force: true });
      else writeFileSync(file, prev);
    }
    const lineOf = (name: string): string => lines.find((l) => l.includes(`'${name}'`) && l.includes("연결 실패")) ?? "";
    const L = lineOf("regr-loud");
    const O = lineOf("regr-other");
    const Q = lineOf("regr-quiet");
    const B = lineOf("regr-big");
    return [
      assert("★말하고 죽는 서버 — 실패 줄에 그 서버의 stderr 끝이 붙는다(같은 줄에 서버 이름)",
        L.includes("stderr 끝:") && L.includes("Godot 경로를 찾을 수 없음"), L.slice(0, 240)),
      assert("★stderr 안의 비밀은 가려진다", L !== "" && !L.includes(SECRET), L.includes(SECRET) ? "비밀 노출" : "가려짐"),
      assert("병렬 두 서버의 꼬리가 섞이지 않는다", O.includes("다른 서버 B") && !L.includes("다른 서버 B") && !O.includes("Godot"), JSON.stringify({ L: L.slice(0, 80), O: O.slice(0, 80) })),
      assert("조용히 죽는 서버는 원인을 지어내지 않는다(꼬리 없음)", Q !== "" && !Q.includes("stderr 끝:"), Q.slice(0, 200)),
      assert("서버 stderr 는 데몬 stderr 로도 흐른다(종전 inherit 과 같다 — 붙어 있는 서버의 출력이 버려지지 않는다)",
        rawStderr.includes("Godot 경로를 찾을 수 없음") && rawStderr.includes("다른 서버 B"), `${rawStderr.length}자`),
      assert("긴 stderr 는 끝부분만 상한 안으로", B.includes("끝부분-남아야 함") && !B.includes("앞부분-버려져야 함") && B.length < 2_500, `길이 ${B.length}`),
    ];
  },
};
