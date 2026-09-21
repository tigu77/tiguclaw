import type { RegionASdkOutput, RequestUsageEntry } from "../types.js";

type Pending = { id: string; model?: string; input?: unknown; read?: unknown; write?: unknown; output?: unknown };
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Claude 스트림의 시작값과 누적 델타를 조립한다. 완료되지 않은 요청은 확정 기록으로 만들지 않는다. */
export const createClaudeRequestUsage = () => {
  let pending: Pending | undefined;
  const seen = new Set<string>();
  const entries: RequestUsageEntry[] = [];
  const observe = (raw: unknown): void => {
    if (raw === null || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    if (msg.type !== "stream_event" || typeof msg.parent_tool_use_id === "string") return;
    const e = msg.event as Record<string, unknown> | undefined;
    if (!e || typeof e !== "object") return;
    if (e.type === "message_start") {
      const m = e.message as Record<string, unknown> | undefined;
      pending = undefined; // 이전 요청이 끊겼더라도 다음 요청과 합치지 않는다.
      if (!m || typeof m.id !== "string" || seen.has(m.id)) return;
      const u = m.usage as Record<string, unknown> | undefined;
      pending = { id: m.id, ...(typeof m.model === "string" ? { model: m.model } : {}),
        input: u?.input_tokens, read: u?.cache_read_input_tokens, write: u?.cache_creation_input_tokens };
      // message_start.output_tokens는 시작 스냅샷이므로 최종 출력으로 사용하지 않는다.
    } else if (e.type === "message_delta" && pending) {
      const u = e.usage as Record<string, unknown> | undefined;
      if (!u) return;
      if (u.input_tokens !== undefined) pending.input = u.input_tokens;
      if (u.cache_read_input_tokens !== undefined) pending.read = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens !== undefined) pending.write = u.cache_creation_input_tokens;
      if (u.output_tokens !== undefined) pending.output = u.output_tokens; // 누적값: 더하지 않는다.
    } else if (e.type === "message_stop" && pending) {
      const p = pending;
      pending = undefined;
      if (!count(p.input) || !count(p.read) || !count(p.write) || !count(p.output)) return;
      const inputTokens = p.input + p.read + p.write;
      if (!count(inputTokens)) return;
      seen.add(p.id);
      entries.push({ inputTokens, outputTokens: p.output, cachedTokens: p.read,
        cacheCreationTokens: p.write, ...(p.model !== undefined ? { model: p.model } : {}) });
    }
  };
  return {
    observe,
    resetPending: (): void => { pending = undefined; },
    /** 세션 누적을 턴 합계로 재사용하지 않는다. 현재 실행에서 완료된 요청만 합산한다. */
    withUsage: (usage: RegionASdkOutput["usage"]): RegionASdkOutput["usage"] => {
      if (usage === undefined) return undefined;
      const { inputTokensTotal: _input, outputTokensTotal: _output,
        cachedTokensTotal: _cache, iterations: _iterations, ...perCall } = usage;
      if (entries.length === 0) return { ...perCall, iterations: 1,
        inputTokensTotal: perCall.inputTokens, outputTokensTotal: perCall.outputTokens,
        ...(perCall.cachedTokens !== undefined ? { cachedTokensTotal: perCall.cachedTokens } : {}),
      };
      return { ...perCall,
        iterations: entries.length,
        inputTokensTotal: entries.reduce((sum, e) => sum + e.inputTokens, 0),
        outputTokensTotal: entries.reduce((sum, e) => sum + e.outputTokens, 0),
        cachedTokensTotal: entries.reduce((sum, e) => sum + (e.cachedTokens ?? 0), 0),
        requestUsageEntries: entries.map(e => ({ ...e })),
      };
    },
  };
};
