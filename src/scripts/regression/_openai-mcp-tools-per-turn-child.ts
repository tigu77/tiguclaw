/**
 * `openai-mcp-tools-per-turn` 의 자식 — OpenAI 어댑터(`runOpenAi`) 턴을 **한 프로세스에서** 돌리고, 턴의 **모든 모델 요청**에 실린 도구
 * 정의(이름 → 정의 JSON 의 sha256 앞 16자)를 낸다. 모델 호출 0(회귀 모델 주입) · 네트워크 차단.
 * - 턴마다 같은 이름의 플러그인 둘을 **새 인스턴스로** 넣는다 — 도구가 턴 종류마다 다르다(`regr_<종류>_only`·`regr2_<종류>_only`).
 *   `regr-plug` 는 코어와 겹치는 이름(`read_memory`)도 있어 이름 선점 래퍼(`hideTakenTools`)를, `regr-plug2` 는 겹침이 없어 공유 브리지
 *   (`adaptSharedClaudeMcpServer`) 그대로의 분기를 지난다(독립 변이 사냥 10-26: 겹치는 플러그인만 있어 겹침 없는 분기가 비었다).
 * - 첫 요청은 플러그인 도구 `regr_ping` 을 부르고 두 번째 요청에서 답한다 — 한 턴 안 두 번째 도구 조립까지 본다.
 * 인자: ① 쉼표로 이은 턴 순서(`main`|`worker`|`sub`) ② `seq`(차례로) | `par`(동시에 — 모든 턴의 첫 요청이 모일 때까지 서로 기다린다).
 * 출력: 마지막 줄 JSON 배열 `[{ which, calls, err?, pong, reqs: [{이름: 해시}, …] }]`.
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { assertIsolated } from "./_framework.js";

type Kind = "main" | "worker" | "sub";
const seq = (process.argv[2] ?? "").split(",") as Kind[];
const mode = process.argv[3] === "par" ? "par" : "seq";
assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "openai-tools-turn-"));
const { initStore } = await import("../../store/sessions.js");
initStore();
const wj = await import("../../core/worker-jobs.js");
const W = wj.registerJob({ label: "작업자", task: "t", threadKey: "dashboard:regr-tools-turn", channel: "cli", channelUserId: "u", kind: "worker" } as never);
const cwd = process.env.TIGUCLAW_HOME;
const plugin = (kind: Kind) => ({
  "regr-plug": createSdkMcpServer({
    name: "regr-plug",
    version: "1",
    tools: [
      tool(`regr_${kind}_only`, `이 턴 종류(${kind})에만 있는 도구`, {}, async () => ({ content: [{ type: "text" as const, text: kind }] })),
      tool("regr_ping", "응답 확인", {}, async () => ({ content: [{ type: "text" as const, text: "pong-regr" }] })),
      tool("read_memory", "코어와 겹치는 이름 — 선점 규칙이 가린다", {}, async () => ({ content: [{ type: "text" as const, text: "x" }] })),
    ],
  }),
  "regr-plug2": createSdkMcpServer({
    name: "regr-plug2",
    version: "1",
    tools: [tool(`regr2_${kind}_only`, `이 턴 종류(${kind})에만 있는 도구 — 겹침 없음`, {}, async () => ({ content: [{ type: "text" as const, text: kind }] }))],
  }),
});
const inputOf = (kind: Kind): Record<string, unknown> => {
  const base = { text: `해줘 [turn:${kind}]`, channel: "cli", cwd, extraMcpServers: plugin(kind) };
  if (kind === "worker") return { ...base, threadKey: `worker:${W}`, workerDepth: 1, turnOrigin: "worker" };
  if (kind === "sub") return { ...base, threadKey: `agent:${W}-sub`, subagentDepth: 1 };
  return { ...base, threadKey: "dashboard:regr-tools-turn" };
};

(globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error("REGRESSION_NETWORK_BLOCKED"); };
type Rec = { calls: number; pong: boolean; reqs: Array<Record<string, string>> };
const rec = new Map<Kind, Rec>();
// `par` — 모든 턴의 첫 요청이 도착할 때까지 붙잡는다(목록 조립이 서로 겹치게). 시한 10초(못 모이면 그대로 진행 — 판정은 결과 대조가 한다).
let arrived = 0;
let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
const barrier = async (): Promise<void> => {
  arrived += 1;
  if (arrived >= seq.length) release();
  await Promise.race([gate, new Promise((r) => setTimeout(r, 10_000))]);
};
const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
injectRegressionModel({
  getResponse: async () => { throw new Error("스트림만 쓴다"); },
  async *getStreamedResponse(req: { tools?: Array<{ name?: string }>; input?: unknown }) {
    const raw = JSON.stringify(req.input ?? "");
    const kind = (["main", "worker", "sub"] as Kind[]).find((k) => raw.includes(`[turn:${k}]`))!;
    const r = rec.get(kind)!;
    r.calls += 1;
    r.reqs.push(Object.fromEntries((req.tools ?? []).map((t) => [t.name ?? "", createHash("sha256").update(JSON.stringify(t)).digest("hex").slice(0, 16)])));
    yield { type: "response_started" };
    if (r.calls === 1) {
      if (mode === "par") await barrier();
      yield { type: "response_done", response: { id: "r1", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output: [{ type: "function_call", id: "fc1", callId: `c-${kind}`, name: "regr_ping", arguments: "{}", status: "completed" }] } };
      return;
    }
    r.pong = raw.includes("pong-regr");
    yield { type: "output_text_delta", delta: "끝" };
    yield { type: "response_done", response: { id: "r2", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "끝" }] }] } };
  },
});
const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");

const turn = async (which: Kind) => {
  rec.set(which, { calls: 0, pong: false, reqs: [] });
  let err: string | undefined;
  try {
    await runOpenAi({ ...inputOf(which), model: "gpt-regression", provider: "openai" } as never);
  } catch (e) {
    err = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  const r = rec.get(which)!;
  return { which, calls: r.calls, pong: r.pong, ...(err !== undefined ? { err } : {}), reqs: r.reqs };
};
const out: unknown[] = [];
if (mode === "par") {
  if (new Set(seq).size !== seq.length) throw new Error("par 는 종류마다 한 턴");
  out.push(...(await Promise.all(seq.map(turn))));
} else {
  for (const which of seq) out.push(await turn(which));
}
console.log(JSON.stringify(out));
process.exit(0);
