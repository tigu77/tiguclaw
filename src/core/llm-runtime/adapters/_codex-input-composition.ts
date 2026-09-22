import type { ResponseInputItem } from "./openai-codex-oauth-history.js";

/** Request structure only. UTF-16 JSON lengths are not tokens or UTF-8 bytes.
 * Media counts/lengths overlap their containing message bucket; never add twice.
 * Keys are fixed: no content, IDs, names, URLs, or encrypted strings leave here.
 */
export const summarizeInputComposition = (input: readonly ResponseInputItem[]) => {
  const empty = () => ({ count: 0, chars: 0 });
  const buckets = {
    user: empty(), assistant: empty(), messageOther: empty(),
    functionCall: empty(), toolOutput: empty(), reasoning: empty(), other: empty(),
  };
  const media = { images: 0, files: 0, chars: 0 };
  let itemChars = 0;
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
    chars: itemChars + 2 + Math.max(0, input.length - 1), buckets, media };
};
