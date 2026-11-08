import { redactSecrets } from "../../core/outbound-sanitize.js";
import type { SpawnResult } from "./_framework.js";

/** 합성 fixture 전용. 비밀을 먼저 가린 뒤 앞/뒤를 제한하고 잘림을 명시한다. */
export const contractDiagnostic = (value: unknown, limit = 1200): string => {
  const text = redactSecrets(String(value));
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}…[truncated ${text.length - half * 2} chars]…${text.slice(-half)}`;
};

export const contractError = (e: unknown): string => {
  const error = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown } | null;
  const head = error !== null && typeof error === "object"
    ? `${error.name ?? "Error"}: ${error.message ?? String(e)}${error.code !== undefined ? ` code=${String(error.code)}` : ""}`
    : String(e);
  const cause = error?.cause as { name?: unknown; message?: unknown; code?: unknown } | undefined;
  return contractDiagnostic(head + (cause === undefined ? "" : `; cause=${String(cause?.name ?? "Error")}: ${String(cause?.message ?? cause)}${cause?.code === undefined ? "" : ` code=${String(cause.code)}`}`));
};

export type ContractResult = Record<string, unknown> & { outcome?: string; diagnostic: string };

/** JSON의 기능 결과와 프로세스 종료는 독립 계약이다. 둘 다 만족해야 성공 후보가 된다. */
export const decodeContractChild = (r: SpawnResult): ContractResult => {
  const diagnostic = JSON.stringify({
    code: r.code, signal: r.signal, timedOut: r.timedOut,
    ...(r.error === undefined ? {} : { error: contractDiagnostic(r.error) }),
    stdout: contractDiagnostic(r.out), stderr: contractDiagnostic(r.err),
    stdoutChars: r.out.length, stderrChars: r.err.length,
  });
  let raw: Record<string, unknown> = {};
  let parseOutcome: string | undefined;
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (line === undefined) parseOutcome = "no-output";
  else {
    try { raw = JSON.parse(line) as Record<string, unknown>; }
    catch { parseOutcome = "bad-json"; }
  }
  // raw JSON은 제한/마스킹한 stdout에도 보존된다. 비정상 종료가 raw outcome에 덮이면 안 된다.
  const outcome = r.timedOut ? "timeout" : r.error !== undefined ? "spawn-error" :
    r.code !== 0 || r.signal !== null ? "abnormal-exit" : parseOutcome ?? raw.outcome;
  return { ...raw, outcome: typeof outcome === "string" ? outcome : "bad-json", diagnostic };
};
