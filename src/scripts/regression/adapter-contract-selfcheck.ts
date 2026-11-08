/** 검사 자체의 실패 판정/진단 계약. 실제 child 경계 + 합성 종결 상태를 대조한다. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck, type SpawnResult } from "./_framework.js";
import { contractDiagnostic, contractError, decodeContractChild } from "./_adapter-contract-result.js";

export const check: RegressionCheck = {
  name: "adapter-contract-selfcheck",
  guards: "정상 JSON이 비정상 child 종료를 가리거나 MCP 오류/stderr가 증발하는 검사 자체의 거짓 초록",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const json = JSON.stringify({ outcome: "returned", text: "끝", remoteCalls: [] });
    const run = (script: string) => spawnWithin(10_000, "contract 판정 selfcheck", ["-e", script], { env: process.env });
    const normal = await run(`console.log(${JSON.stringify(json)})`);
    const clean = decodeContractChild(normal);
    out.push(assert("정상 JSON + exit0는 기존 기능 결과를 보존", normal.code === 0 && normal.signal === null && clean.outcome === "returned" && clean.text === "끝", clean.diagnostic));
    const exited = await run(`console.log(${JSON.stringify(json)}); console.error('synthetic-fatal-uv-handle'); process.exitCode=23;`);
    const abnormal = decodeContractChild(exited);
    out.push(assert("정상 JSON + 비정상 exit는 실패이며 원 JSON/exit/stderr 보존", abnormal.outcome === "abnormal-exit" && abnormal.text === "끝" && abnormal.diagnostic.includes('"code":23') && abnormal.diagnostic.includes("synthetic-fatal-uv-handle") && abnormal.diagnostic.includes('\\"outcome\\":\\"returned\\"'), abnormal.diagnostic));
    const base: SpawnResult = { out: json, err: "", code: 0, signal: null, timedOut: false };
    for (const [label, patch, outcome] of [
      ["Windows abort code", { code: 3221226505 }, "abnormal-exit"],
      ["signal", { code: null, signal: "SIGABRT" }, "abnormal-exit"],
      ["exit null", { code: null }, "abnormal-exit"],
      ["spawn error + JSON", { error: "synthetic spawn error" }, "spawn-error"],
      ["timeout + JSON", { timedOut: true }, "timeout"],
      ["JSON 없음", { out: "synthetic log only", err: "synthetic stderr" }, "no-output"],
      ["잘린 JSON", { out: '{"outcome":"returned"', err: "synthetic parse error" }, "bad-json"],
    ] as Array<[string, Partial<SpawnResult>, string]>) {
      const result = decodeContractChild({ ...base, ...patch });
      out.push(assert(`${label} 누락 없이 실패 판정과 진단 보존`, result.outcome === outcome && result.diagnostic.includes('"stderr"'), result.diagnostic));
    }
    const missing = await spawnWithin(10_000, "존재하지 않는 합성 cwd", ["-e", ""], { cwd: path.join(process.env.TIGUCLAW_HOME!, "absent-contract-selfcheck") });
    out.push(assert("실제 spawn ENOENT 수집", missing.error?.includes("ENOENT") === true && decodeContractChild(missing).outcome === "spawn-error", decodeContractChild(missing).diagnostic));
    const fail = decodeContractChild(await run(`console.error('synthetic-MCP-call-error Bearer synthetic-private-header'); process.exitCode=1;`));
    out.push(assert("JSON 없는 실패 stderr 보존 및 헤더 마스킹", fail.outcome === "abnormal-exit" && fail.diagnostic.includes("synthetic-MCP-call-error") && !fail.diagnostic.includes("synthetic-private-header") && fail.diagnostic.includes("REDACTED"), fail.diagnostic));
    const noisy = decodeContractChild({ ...base, out: "start:" + "x".repeat(5000) + "\n" + json, err: "head:" + "z".repeat(5000) + ":tail" });
    out.push(assert("긴 원출력은 앞/뒤·길이·잘림 표시 보존", noisy.outcome === "returned" && noisy.diagnostic.includes("truncated") && noisy.diagnostic.includes("start:") && noisy.diagnostic.includes(":tail") && noisy.diagnostic.length < 3000, noisy.diagnostic));
    const error = Object.assign(new Error("synthetic MCP failure Bearer synthetic-mcp-secret", { cause: Object.assign(new Error("synthetic-cause"), { code: "SYNTH_CAUSE" }) }), { code: "SYNTH_MCP" });
    const detail = contractError(error);
    out.push(assert("MCP 예외는 name/message/code/cause 보존·마스킹", detail.includes("synthetic MCP failure") && detail.includes("SYNTH_MCP") && detail.includes("synthetic-cause") && detail.includes("SYNTH_CAUSE") && !detail.includes("synthetic-mcp-secret"), detail));
    out.push(assert("마스킹이 길이 제한보다 먼저", !contractDiagnostic("Bearer " + "a".repeat(4000), 80).includes("a".repeat(10)), contractDiagnostic("Bearer " + "a".repeat(4000), 80)));
    const utf8 = await run(`const b=Buffer.from('진단'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),20);`);
    out.push(assert("실제 분할 UTF8 원출력 손실 없음", utf8.out === "진단", utf8.out));
    // 실제 fixture의 설정/호출 실패 → child JSON → 부모 진단까지 연결을 지킨다.
    for (const fault of ["mcp-missing", "mcp-error"]) {
      const r = await spawnWithin(60_000, `MCP 진단 ${fault}`, ["--import", "tsx", fileURLToPath(new URL("./_adapter-contract-child.ts", import.meta.url)), "claude", "remote-tool", "adapter", fault], { env: process.env });
      const decoded = decodeContractChild(r);
      const diagnostics = decoded.mcpDiagnostics as Array<{ stage: string; error: string }> | undefined;
      const d = diagnostics?.[0];
      const ok = fault === "mcp-missing"
        ? d?.stage === "config" && d.error.includes("설정 없음") && d.error.includes('"present":false')
        : d?.stage === "callTool" && d.error.includes("synthetic MCP call failure") && d.error.includes("SYNTH_MCP") && d.error.includes("synthetic MCP cause");
      out.push(assert(`실제 fixture ${fault} 진단·client 정리가 child/부모에 보존`, r.code === 0 && decoded.outcome === "returned" && ok && decoded.closedCliClients === (fault === "mcp-error" ? 1 : 0) && decoded.diagnostic.includes("mcpDiagnostics") && JSON.stringify(decoded.remoteCalls) === "[]", decoded.diagnostic));
    }
    const cleanupFailure = await spawnWithin(60_000, "실제 fixture 정리 실패", ["--import", "tsx", fileURLToPath(new URL("./_adapter-contract-child.ts", import.meta.url)), "claude", "remote-tool", "adapter", "cleanup-error"], { env: process.env });
    const cleanupResult = decodeContractChild(cleanupFailure);
    out.push(assert("앞 정리 예외 뒤에도 서버·DB 정리 완료 및 실패 exit/진단 보존", cleanupFailure.code === 1 && cleanupFailure.signal === null && !cleanupFailure.timedOut && cleanupResult.outcome === "abnormal-exit" && cleanupResult.storeClosed === true && JSON.stringify(cleanupResult.cleanupCompleted) === JSON.stringify(["external", "remote", "store"]) && cleanupResult.diagnostic.includes("synthetic cleanup failure") && cleanupResult.diagnostic.includes("echo:ping-1:hdr-ok"), cleanupResult.diagnostic));
    return out;
  },
};
