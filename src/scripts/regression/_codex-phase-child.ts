/**
 * `codex-commentary-not-in-answer` 의 자식 — Codex 어댑터를 가짜 네트워크로 끝까지 돌려 **최종 답** 을 본다.
 * ★자식인 이유: `fetch` 스텁·인증 전역 등록(`_codex-cancel-child` 와 같은 이유). 시나리오 하나 = 프로세스 하나.
 * 출력: 마지막 줄 JSON `{ text }`.
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const scenario = process.argv[2] ?? "";
const enc = new TextEncoder();
type Ev = Record<string, unknown>;
const msg = (id: string, text: string, phase?: string): Ev[] => [
  { type: "response.output_item.added", item: { type: "message", id, role: "assistant", status: "in_progress", content: [], ...(phase !== undefined ? { phase } : {}) } },
  ...[...text].reduce<string[]>((a, ch, i) => (i % 8 === 0 ? [...a, ch] : [...a.slice(0, -1), a[a.length - 1] + ch]), []).map((d) => ({ type: "response.output_text.delta", item_id: id, delta: d })),
  { type: "response.output_item.done", item: { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text }], ...(phase !== undefined ? { phase } : {}) } },
];
const call = (): Ev[] => [
  { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "c1", name: "list_commands", arguments: "" } },
  { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "c1", name: "list_commands", arguments: "{}" } },
];
const done = (id: string): Ev => ({ type: "response.completed", response: { id, usage: { input_tokens: 10, output_tokens: 5 } } });
/** 메시지를 시작하고 글을 흘리다가 **서버가 끊는다**(완료 없음) — 아래 `CUT` 표지에서 스트림이 `terminated` 로 죽는다. */
const CUT: Ev = { type: "__cut__" };
const partialMsg = (id: string, text: string, phase: string): Ev[] => [
  { type: "response.output_item.added", item: { type: "message", id, role: "assistant", status: "in_progress", content: [], phase } },
  { type: "response.output_text.delta", item_id: id, delta: text },
  CUT,
];

/** 요청 n 번째(1부터)에 보낼 이벤트. */
const SCRIPTS: Record<string, (n: number) => Ev[]> = {
  // 한 응답에 최종 답 + 그 뒤 작성용 해설(사고 모양).
  "answer-then-commentary": () => [...msg("m1", "시안 좋네요. 이대로 진행할게요.", "final_answer"), ...msg("m2", "tool? need prompt commentary", "commentary"), done("r1")],
  // 해설 → 도구 → 최종 답(정상 흐름).
  "commentary-tool-answer": (n) => (n === 1 ? [...msg("m1", "명령 목록을 확인하겠습니다.", "commentary"), ...call(), done("r1")] : [...msg("m2", "등록된 명령은 없습니다.", "final_answer"), done("r2")]),
  // phase 없는 옛 응답 — 지금 동작 그대로.
  "no-phase": () => [...msg("m1", "옛 모델의 답입니다."), done("r1")],
  // 해설만 온 응답(도구도 최종 답도 없음) — 버리지 않는다(빈 답보다 낫다).
  "commentary-only": () => [...msg("m1", "확인해 보겠습니다.", "commentary"), done("r1")],
  // 해설이 흐르다 끊김 → 이어 쓴 요청에서 최종 답 — 이어받은 글의 해설도 답에 안 붙는다(리뷰 10-18).
  "commentary-cut-then-answer": (n) => (n === 1 ? partialMsg("m1", "작업 메모: 먼저 확인 ", "commentary") : [...msg("m2", "확인 결과 문제없습니다.", "final_answer"), done("r2")]),
  // 답이 흐르다 끊김 → 이어 쓰기 — 앞에 흘린 답은 그대로 잇는다(종전 동작).
  "answer-cut-continue": (n) => (n === 1 ? partialMsg("m1", "앞부분 ", "final_answer") : [...msg("m2", "뒷부분.", "final_answer"), done("r2")]),
};

const main = async (): Promise<void> => {
  assertIsolated();
  process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "codex-phase-"));
  const script = SCRIPTS[scenario];
  if (script === undefined) throw new Error(`unknown scenario ${scenario}`);
  let n = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: string): Promise<Response> => {
    if (!String(url).includes("/responses")) return new Response("not found", { status: 404 });
    n += 1;
    const evs = script(n);
    const cutAt = evs.indexOf(CUT);
    const body = (cutAt < 0 ? evs : evs.slice(0, cutAt)).map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(body));
        if (cutAt < 0) c.close();
        else setTimeout(() => c.error(new TypeError("terminated")), 20); // undici 가 서버 끊김에 내는 모양
      },
    }), { status: 200 });
  });
  const { initStore } = await import("../../store/sessions.js");
  initStore();
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
  const out = await runOpenAiCodex({ text: "해줘", threadKey: `cli:codex-phase-${scenario}`, channel: "cli", cwd: process.env.TIGUCLAW_HOME } as never);
  console.log(JSON.stringify({ text: out.text, calls: n }));
  process.exit(0);
};
main().catch((e) => {
  console.log(JSON.stringify({ text: null, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  process.exit(0);
});
