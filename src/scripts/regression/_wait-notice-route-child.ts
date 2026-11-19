/**
 * `compaction-wait-progress` 의 자식 — 요약 대기 안내의 받는 곳을 **진짜 `route` → Codex 어댑터 → 요약 드라이버 → 안내** 로 본다. 네트워크 0.
 *
 * ★왜 라우터부터인가: «이 턴의 채널·주소가 사용자 것인가» 는 라우터가 정한다(`userWaiting` — 세션 메타 캡처와 같은 판정). 어댑터 입력을
 *  손으로 만들면 그 판정을 재는 게 아니라 우리가 넣은 표식을 재게 된다(2026-11-19 GPT delta R2 F2: 잔여 재주입이 `synthetic-other` 로 넘어가
 *  사람 요청의 안내가 빠졌다).
 * 구성: 요약 잠금을 2.2초 쥐어(안내 문턱 1.5초) 요청이 기다리게 한다 · 텔레그램 채널 스텁(실제 발송 0) · 세션 메타는 직전 사람 인입 그대로.
 * 출력: `WAIT_NOTICE_ROUTE <JSON>` 한 줄(턴 뒤 로그가 뒤에 섞일 수 있어 접두로 찾는다).
 */
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";

assertIsolated();
pinModelForTest("codex:gpt-5.6-sol");
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
globalThis.fetch = fakeNetwork(async () =>
  new Response(
    [
      { type: "response.output_text.delta", delta: "끝" },
      { type: "response.completed", response: { id: "synthetic", usage: { input_tokens: 10, output_tokens: 1 } } },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { status: 200 },
  ),
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const { route } = await import("../../core/router.js");
const { saveSession, setSessionChannelMeta, SESSION_STORAGE_CHANNEL } = await import("../../store/sessions.js");
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const { registerWorkerHandler } = await import("../../core/worker-jobs.js");
const { withThreadCompactionLock } = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");

const sent: Array<{ sid: string; target: string }> = [];
let current = "";
registerChannelOutbound("telegram", {
  deliver: async (target: string) => { sent.push({ sid: current, target }); },
  defaultOutboundTarget: async () => "owner-default",
} as never);
registerWorkerHandler((async () => undefined) as never);

const { toSteeringInput, buildReinjectMessage } = await import("../../core/steering.js");
type Msg = IncomingMessage;
const mkMsg = (sid: string, address: string, extra: Partial<Msg> = {}): Msg =>
  ({ channel: "telegram", channelUserId: "u", threadKey: sid, text: "안녕", receivedAt: Date.now(), reply: async () => {}, channelAddress: address,
     session: { explicitSessionId: sid, channelAddress: address }, ...extra }) as Msg;

/** 세션 메타를 심고 요약 잠금을 쥔 채 `msg(sid)` 를 진짜 `route` 로 태운다 — 그 세션의 텔레그램 안내 목적지를 돌려준다. */
const run = async (name: string, metaCh: string, metaTarget: string, msg: (sid: string) => Msg | null): Promise<string[] | string> => {
  const sid = `dashboard:regr-wn-route-${name}-${Date.now()}`;
  current = sid;
  saveSession({ channel: SESSION_STORAGE_CHANNEL, threadKey: sid, claudeSessionId: `seed-${sid}`, model: null, systemPromptHash: null });
  setSessionChannelMeta({ channel: SESSION_STORAGE_CHANNEL, threadKey: sid, lastChannel: metaCh as never, lastChannelTarget: metaTarget });
  const m = msg(sid);
  if (m === null) return "no-message";
  const held = withThreadCompactionLock(sid, () => sleep(2_200));
  await sleep(20);
  // 진입점과 같은 모양 — 메시지가 지정한 세션 그대로(`src/index.ts` 의 route 호출).
  await route(m, m.session !== undefined ? { session: m.session } : {});
  await held;
  await sleep(50);
  return sent.filter((s) => s.sid === sid).map((s) => s.target);
};

const out: Record<string, unknown> = {};
try {
  // ① 사람 인입(텔레그램, 메타는 대시보드) — 그 턴의 주소로 1
  out.inbound = await run("inbound", "http-bridge", "dashboard:regr-prev", (sid) => mkMsg(sid, "777"));
  // ② 잔여 재주입 — 사람 턴이 연 턴에 끼워넣은 사람 입력(실제 생성기) — 그 사용자 주소로 1
  out.reinject = await run("reinject", "http-bridge", "dashboard:regr-prev", (sid) =>
    buildReinjectMessage(mkMsg(sid, "777"), [toSteeringInput(mkMsg(sid, "777", { text: "추가 요청" }))]));
  // ③ 잔여 재주입 — **예약 턴이 연** 턴에 끼워넣은 사람 입력(재주입 메시지는 예약 턴의 출처·오염 주소를 물려받는다 — GPT delta R3) — 사용자 주소로 1
  out.reinjectFromSchedule = await run("reinject-sched", "telegram", "dashboard:regr-polluted", (sid) =>
    buildReinjectMessage(
      mkMsg(sid, "dashboard:regr-polluted", { synthetic: true, turnOrigin: "schedule" }),
      [toSteeringInput(mkMsg(sid, "777", { text: "추가 요청" }))],
    ));
  // ⑤ 다른 채널의 잔여 재주입 — 텔레그램이 연 턴에 대시보드에서 끼워넣음 → 기다리는 사람은 대시보드(화면에서 본다) · 텔레그램 안내 0
  out.reinjectDashIntoTg = await run("reinject-dash-into-tg", "telegram", "777", (sid) =>
    buildReinjectMessage(mkMsg(sid, "777"), [toSteeringInput(mkMsg(sid, sid, { channel: "http-bridge", text: "추가 요청" }))]));
  // ⑥ 반대 — 대시보드가 연 턴에 텔레그램에서 끼워넣음 → 그 텔레그램 주소로 1(재주입 메시지의 채널은 대시보드 그대로)
  out.reinjectTgIntoDash = await run("reinject-tg-into-dash", "http-bridge", "dashboard:regr-prev", (sid) =>
    buildReinjectMessage(mkMsg(sid, sid, { channel: "http-bridge" }), [toSteeringInput(mkMsg(sid, "888", { text: "추가 요청" }))]));
  // ④ 대화 안 예약 턴 — 채널·주소를 세션 메타에서 꺼낸다(trigger-in-session.ts) · 오염 주소여도 기다리는 사람이 없어 0
  out.schedule = await run("schedule", "telegram", "dashboard:regr-polluted", (sid) =>
    mkMsg(sid, "dashboard:regr-polluted", { synthetic: true, turnOrigin: "schedule" }));
} catch (e) {
  out.error = String((e as Error)?.stack ?? e).slice(0, 400);
}
process.stdout.write(`WAIT_NOTICE_ROUTE ${JSON.stringify(out)}\n`);
process.exit(0);
