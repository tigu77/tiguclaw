import type { ResponseInputItem } from "./openai-codex-oauth-history.js";

/** Request structure only. UTF-16 JSON lengths are not tokens or UTF-8 bytes.
 * Media counts/lengths overlap their containing message bucket; never add twice.
 * Keys are fixed: no content, IDs, names, URLs, or encrypted strings leave here.
 */
export const summarizeInputComposition = (
  input: readonly ResponseInputItem[],
  /**
   * ★조립 출처 경계(2026-09-23) — `buildCodexInputArray` 가 낸 [summary?][history…][current…]
   * 순서를 **인덱스**로만 되짚는다(내용 재해석 없음). `current` 는 초기 현재 턴 + 이후 루프가
   * 덧붙인 steering/function_call/function_call_output 전부(끝까지 append-only 라 경계가 안 깨짐).
   * 미지정이면 전부 `current` — 경계를 모르는 기존 호출부는 회귀 0.
   */
  boundaries?: { summaryCount: number; historyCount: number },
) => {
  const empty = () => ({ count: 0, chars: 0 });
  const buckets = {
    user: empty(), assistant: empty(), messageOther: empty(),
    functionCall: empty(), toolOutput: empty(), reasoning: empty(), other: empty(),
  };
  const origins = { summary: empty(), history: empty(), current: empty() };
  const summaryEnd = Math.max(0, Math.min(boundaries?.summaryCount ?? 0, input.length));
  const historyEnd = Math.max(summaryEnd, Math.min(summaryEnd + Math.max(0, boundaries?.historyCount ?? 0), input.length));
  const media = { images: 0, files: 0, chars: 0 };
  let itemChars = 0;
  let index = 0;
  for (const item of input) {
    const chars = JSON.stringify(item).length;
    itemChars += chars;
    const key = item.type === "message"
      ? item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "messageOther"
      : item.type === "function_call" ? "functionCall"
      : item.type === "function_call_output" ? "toolOutput"
      : item.type === "reasoning" ? "reasoning" : "other";
    buckets[key].count += 1;
    buckets[key].chars += chars;
    const originKey = index < summaryEnd ? "summary" : index < historyEnd ? "history" : "current";
    origins[originKey].count += 1;
    origins[originKey].chars += chars;
    index += 1;
    if (item.type === "message") {
      for (const content of item.content) {
        if (content.type === "input_image" || content.type === "input_file") {
          if (content.type === "input_image") media.images += 1;
          else media.files += 1;
          media.chars += JSON.stringify(content).length;
        }
      }
    }
  }
  return { unit: "utf16-json-chars" as const, items: input.length,
    chars: itemChars + 2 + Math.max(0, input.length - 1), buckets, media, origins };
};
