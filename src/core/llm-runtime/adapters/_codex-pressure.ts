/** Invocation-local matched usage boundary. Full strings stay in memory, never in logs/store. */
import { lookupContextWindow } from "../context-windows.js";
import {
  CODEX_KNOWN_SAFE_INPUT_CHARS, compatibleReplayOutput,
  type CodexSseResult, type ResponseInputItem,
} from "./openai-codex-oauth-history.js";

export interface PressureSnapshot {
  readonly invocation: symbol;
  readonly attempt: number;
  readonly model: string | undefined;
  readonly nonInput: string;
  readonly input: readonly string[];
}
export interface PressureAnchor {
  readonly snapshot: PressureSnapshot;
  readonly responseId: string;
  readonly covered: readonly string[];
  readonly calls: ReadonlySet<string>;
  readonly totalTokens: number;
}

export const pressureSnapshot = (bodyJson: string, invocation: symbol, attempt: number): PressureSnapshot => {
  // Parse the exact immutable wire body, not the mutable inputArray or a length/hash proxy.
  const { input, ...nonInput } = JSON.parse(bodyJson) as { input: ResponseInputItem[]; model?: unknown };
  return { invocation, attempt, model: typeof nonInput.model === "string" ? nonInput.model : undefined, nonInput: JSON.stringify(nonInput), input: input.map((it) => JSON.stringify(it)) };
};
const safe = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export const committedPressureAnchor = (
  snapshot: PressureSnapshot | undefined,
  result: CodexSseResult,
  reasoningIncluded: string | null,
  committed: readonly ResponseInputItem[],
): PressureAnchor | undefined => {
  const usage = result.terminalUsage;
  // false cannot establish that *all* covered reasoning is measured. Missing/unknown is not true.
  if (snapshot === undefined || reasoningIncluded !== "true" || usage === undefined ||
      result.replayUnchanged !== true || result.failure !== undefined || result.lastEvent !== "response.completed" ||
      result.eventCounts?.["response.completed"] !== 1 ||
      !result.responseId || usage.responseId !== result.responseId ||
      snapshot.model === undefined || usage.model !== snapshot.model ||
      !safe(usage.inputTokens) || !safe(usage.outputTokens) || !safe(usage.totalTokens) ||
      !safe(usage.inputTokens + usage.outputTokens) || usage.totalTokens !== usage.inputTokens + usage.outputTokens) return;
  if (snapshot.input.some((encoded) => !["message", "function_call", "function_call_output", "reasoning"].includes((JSON.parse(encoded) as { type: string }).type))) return;
  const replay = compatibleReplayOutput(result);
  if (replay === undefined || replay.length === 0 || replay.some((it) =>
    it.type !== "message" && it.type !== "function_call" && it.type !== "reasoning")) return;
  const covered = [...snapshot.input, ...replay.map((it) => JSON.stringify(it))];
  if (committed.length !== covered.length || committed.some((it, i) => JSON.stringify(it) !== covered[i])) return;
  const calls = new Set(replay.filter((it) => it.type === "function_call").map((it) => it.call_id));
  return { snapshot, responseId: result.responseId, covered, calls, totalTokens: usage.totalTokens };
};

/** Undefined is a closed gate: use the unchanged legacy request-minus-media pressure. */
export const matchedPressureChars = (anchor: PressureAnchor | undefined, snapshot: PressureSnapshot): number | undefined => {
  if (anchor === undefined || anchor.snapshot.invocation !== snapshot.invocation ||
      anchor.snapshot.attempt >= snapshot.attempt || anchor.snapshot.nonInput !== snapshot.nonInput ||
      snapshot.input.length < anchor.covered.length ||
      anchor.covered.some((it, i) => it !== snapshot.input[i])) return;
  const tail = snapshot.input.slice(anchor.covered.length);
  const seen = new Set<string>();
  for (const encoded of tail) {
    const it = JSON.parse(encoded) as Record<string, unknown>;
    if (it.type !== "function_call_output" || typeof it.output !== "string" ||
        typeof it.call_id !== "string" || !anchor.calls.has(it.call_id) || seen.has(it.call_id) ||
        Object.keys(it).some((key) => !["type", "call_id", "output"].includes(key))) return;
    seen.add(it.call_id);
  }
  // The JSON array includes escaping, entry caps, ref notes and wrapper punctuation.
  return anchor.totalTokens * 1.4 + `[${tail.join(",")}]`.length;
};

export const currentPressureCeiling = (model: string | undefined, limitChars?: number): number | undefined => {
  const known = limitChars ?? CODEX_KNOWN_SAFE_INPUT_CHARS;
  const window = lookupContextWindow(model);
  return window === undefined ? undefined : Math.min(known, Math.floor(window * 0.95 * 1.4));
};

export class CodexContextLimitError extends Error {
  constructor() { super("Codex context_length_exceeded — local recovery unavailable or exhausted"); }
}
export const hasExplicitContextLimit = (text: string): boolean => {
  try { return (JSON.parse(text) as { error?: { code?: unknown } }).error?.code === "context_length_exceeded"; }
  catch { return false; }
};
