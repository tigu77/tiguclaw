/**
 * 합성 턴의 도구 목록을 **router → 어댑터가 실제로 조립한 정의**로 사용자 턴과 비교한다. 네트워크 0(가짜 응답).
 * 두 모양을 본다 — 파일 전송·선택지 둘 다 받는 스레드 / 선택지만 받는 스레드(CLI 형태).
 */
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
assertIsolated();
process.env.REGION_A_MODELS = "codex:gpt-5.6-sol";
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

const toolsByTurn: string[] = [];
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { tools?: unknown[] };
  toolsByTurn.push(JSON.stringify(body.tools ?? []));
  const events = [
    { type: "response.output_text.delta", delta: "끝" },
    { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
});
const realLog = console.log.bind(console);
console.log = () => {};
console.warn = () => {};

const { route } = await import("../../core/router.js");
const base = { channel: "dashboard" as const, channelUserId: "u", receivedAt: Date.now(), reply: async () => {} };
const sendAttachment: IncomingMessage["sendAttachment"] = async () => ({ ok: true });
const presentOptions: IncomingMessage["presentOptions"] = async () => ({ ok: true });
const turn = async (m: Partial<IncomingMessage>, opts?: Parameters<typeof route>[1]): Promise<string> => {
  const before = toolsByTurn.length;
  await route({ ...base, text: "질문", ...m } as IncomingMessage, opts);
  return toolsByTurn[before] ?? "";
};
let error = "";
const out: Record<string, unknown> = {};
try {
  const bothUser = await turn({ threadKey: "regr:tools-both", sendAttachment, presentOptions });
  const bothSynth = await turn({ threadKey: "regr:tools-both", synthetic: true, turnOrigin: "worker-completion" } as Partial<IncomingMessage>);
  const cliUser = await turn({ threadKey: "regr:tools-cli", presentOptions });
  const cliSynth = await turn({ threadKey: "regr:tools-cli", synthetic: true, turnOrigin: "worker-completion" } as Partial<IncomingMessage>);
  const unknownSynth = await turn({ threadKey: "regr:tools-unknown", synthetic: true, turnOrigin: "worker-completion" } as Partial<IncomingMessage>);
  // 세션 정규화 — 텔레그램 사용자 턴은 `tg:` 스레드 + 채널 주소로 들어와 세션 id 로 바뀌고, 재주입은 그 세션 id 를
  //  명시해 온다. 모양은 **정규화된 세션 id** 로 맞아야 한다(정규화 전 키로 기록하면 둘이 어긋난다).
  const normUser = await turn({ channel: "telegram", threadKey: "tg:regr-norm", sendAttachment, presentOptions } as Partial<IncomingMessage>, { session: { channelAddress: "regr-norm-addr" } });
  const normSynth = await turn({ channel: "telegram", threadKey: "dashboard:default", synthetic: true, turnOrigin: "worker-completion" } as Partial<IncomingMessage>, { session: { explicitSessionId: "dashboard:default" } });
  Object.assign(out, {
    bothEqual: bothUser !== "" && bothUser === bothSynth,
    bothHasSend: bothUser.includes("send_file"),
    cliEqual: cliUser !== "" && cliUser === cliSynth,
    cliSynthHasSend: cliSynth.includes("send_file"),
    cliHasOptions: cliUser.includes("prompt_options"),
    unknownHasSend: unknownSynth.includes("send_file"),
    normEqual: normUser !== "" && normUser === normSynth,
    sizes: [bothUser.length, bothSynth.length, cliUser.length, cliSynth.length, unknownSynth.length, normUser.length, normSynth.length],
  });
} catch (e) { error = e instanceof Error ? e.message : String(e); }
realLog("TOOLS_RESULT " + JSON.stringify({ ...out, error }));
process.exit(0);
