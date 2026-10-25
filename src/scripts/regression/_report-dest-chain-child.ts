/**
 * `completion-spawn-inherits-report-dest` 의 자식 — **완료 보고 턴에서 띄운 매니저의 보고 좌표**를 실경로로 잰다.
 *
 * 사슬: 매니저 A 완료(`onWorkerComplete`) → 합성 턴을 **실제 `route()`** 로 돌린다(index.ts 처럼 `msg.session` 만 넘긴다)
 *  → 가짜 codex 가 `run_in_background` 를 부른다 → 실제 발사 도구가 B 를 띄운다(`spawnNotifyDest`) → B 매니저 턴(가짜 응답)
 *  → B 완료 합성 턴에서 `sendAttachment` 를 부른다. 네트워크·실채널 0 — 채널은 스텁, 대시보드 첨부는 실제 `deliverSessionAttachment`.
 *
 * ★왜 자식인가: `globalThis.fetch`·auth provider·모델 고정이 프로세스 전역이다(`_reinjected-tools-child` 와 같은 이유).
 * 출력: 마지막 줄 `CHAIN_RESULT <json>`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork, loadPluginModule, pinModelForTest } from "./_framework.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { initStore, getSessionChannelMeta } from "../../store/sessions.js";
import { initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import type { IncomingMessage } from "../../channels/types.js";

assertIsolated();
pinModelForTest("codex:gpt-5.6-sol");
initStore();
initEventBus();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

const sse = (events: unknown[]): Response =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
const textReply = (t: string): Response =>
  sse([
    { type: "response.output_text.delta", delta: t },
    { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);

/** 케이스별 표식 — 가짜 모델이 어느 턴인지 가른다. */
const A_MARK = "A결과표식";
const B_TASK = "B작업표식";
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { input?: unknown; tools?: { name?: string }[] };
  const input = JSON.stringify(body.input ?? []);
  // ① A 완료 턴의 도구 결과 뒤 — 마무리 글
  if (input.includes("function_call_output")) return textReply("B 를 띄웠습니다");
  // ② B 매니저 자신의 턴
  if (input.includes(B_TASK)) return textReply("B 결과");
  // ③ A 완료 턴 — B 를 띄운다(케이스 이름은 A 결과 문구에 실려 온다)
  const m = input.match(new RegExp(`${A_MARK}:([a-z]+)`));
  const tool = (body.tools ?? []).map((t) => t.name ?? "").find((n) => n.endsWith("run_in_background"));
  if (m !== null && tool !== undefined) {
    const args = JSON.stringify({ task: `${B_TASK}:${m[1]}`, label: `B-${m[1]}` });
    return sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "c1", name: tool } },
      { type: "response.function_call_arguments.delta", delta: args },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "c1", name: tool, arguments: args } },
      { type: "response.completed", response: { id: "r1", output: [] } },
    ]);
  }
  return textReply(m !== null ? "도구 없음" : "기타");
});
const realLog = console.log.bind(console);
const routeLines: string[] = [];
console.log = (...a: unknown[]) => {
  const s = a.map(String).join(" ");
  if (s.startsWith("route ")) routeLines.push(s);
};
console.warn = () => {};

const wj = await import("../../core/worker-jobs.js");
const { route } = await import("../../core/router.js");
// 플러그인은 지정자를 리터럴로 안 쓴다(`src-stays-inside-src` — rootDir=src 빌드가 죽는다).
const { deliverSessionAttachment } = await loadPluginModule<{
  deliverSessionAttachment: (i: { bus: null; channel: string; target: string | null; filePath: string; caption?: string }) =>
    Promise<{ ok: true } | { ok: false; error: string; unavailable?: true }>;
}>("../../../plugins/http-bridge/attachments.js");
await import("../../core/llm-runtime/capabilities/worker-registry.js"); // 매니저 러너 자기 등록

const file = path.join(mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "chain-")), "out.png");
writeFileSync(file, "png");

/** 첨부가 실제로 닿은 곳 — 채널·좌표. */
const attached: { channel: string; target: string | null; ok: boolean; error?: string }[] = [];
const published: string[] = [];
/** 글 발송 — 채널·좌표·본문. */
const sent: { channel: string; target: string | null; text: string }[] = [];
const bus = { publish: (e: { type: string; payload: Record<string, unknown> }) => { published.push(String(e.payload.threadKey)); } };
registerChannelOutbound("http-bridge", {
  defaultOutboundTarget: () => null, // 실제 대시보드와 같다 — 기본 좌표 없음
  deliver: async (target, text) => { sent.push({ channel: "http-bridge", target, text }); return { messageIds: [1] }; },
  deliverAttachment: async (target, filePath, opts) => {
    const r = await deliverSessionAttachment({ bus: bus as never, channel: "http-bridge", target, filePath, ...(opts?.caption !== undefined ? { caption: opts.caption } : {}) });
    attached.push({ channel: "http-bridge", target, ok: r.ok, ...(!r.ok ? { error: r.error } : {}) });
    return r;
  },
});
registerChannelOutbound("telegram", {
  defaultOutboundTarget: async () => "owner-default",
  deliver: async (target, text) => { sent.push({ channel: "telegram", target, text }); return { messageIds: [1] }; },
  deliverAttachment: async (target) => { attached.push({ channel: "telegram", target, ok: true }); return { ok: true }; },
});

let bDone: (() => void) | undefined;
const bSends: unknown[] = [];
wj.registerWorkerHandler(async (msg: IncomingMessage) => {
  if (msg.text.includes(B_TASK) || /B-[a-z]+/.test(msg.text)) {
    // B 완료 턴 — 결과물을 보낸다
    bSends.push(msg.sendAttachment === undefined ? "sendAttachment 없음" : await msg.sendAttachment(file, { caption: "결과" }));
    await msg.reply("B 보고");
    bDone?.();
    return;
  }
  // A 완료 턴 — index.ts 의 핸들러처럼 메시지 그대로 + `session` 만 opts 로
  const out = await route({ ...msg }, { ...(msg.session !== undefined ? { session: msg.session } : {}) });
  await msg.reply(out.text);
});

const runCase = async (
  name: string,
  job: { threadKey: string; channel: string; notifyDest?: { channel: string; target: string | null } },
): Promise<Record<string, unknown>> => {
  wj.__resetJobsForTest();
  attached.length = 0;
  published.length = 0;
  bSends.length = 0;
  routeLines.length = 0;
  const done = new Promise<void>((r) => { bDone = r; });
  const aId = wj.registerJob({
    label: `A-${name}`, task: "A 작업", threadKey: job.threadKey, channel: job.channel as never, channelUserId: job.threadKey,
    ...(job.notifyDest !== undefined ? { notifyDest: job.notifyDest as never } : {}),
  });
  await wj.onWorkerComplete(aId, { result: `${A_MARK}:${name}` });
  await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
  const b = wj.listJobs().find((j) => j.label === `B-${name}`);
  const meta = getSessionChannelMeta("http-bridge", job.threadKey);
  return {
    bSpawned: b !== undefined,
    bThread: b?.threadKey ?? null,
    bNotifyDest: b?.notifyDest ?? null,
    bSend: bSends[0] ?? null,
    attached: [...attached],
    published: [...published],
    metaTarget: meta?.lastChannelTarget ?? null,
    metaChannel: meta?.lastChannel ?? null,
    routes: [...routeLines],
  };
};

/** 점검 합성 턴 — 돌고 있는 A 의 점검(무활동 주기 경과)에서 B 를 띄운다. */
const runCheckin = async (): Promise<Record<string, unknown>> => {
  wj.__resetJobsForTest();
  attached.length = 0;
  bSends.length = 0;
  routeLines.length = 0;
  const done = new Promise<void>((r) => { bDone = r; });
  const THREAD = "dashboard:regr-chain-ck";
  wj.registerJob({
    label: "A-ck", task: `${A_MARK}:ck`, threadKey: THREAD, channel: "http-bridge" as never, channelUserId: THREAD,
    notifyDest: { channel: "http-bridge", target: THREAD } as never,
  });
  wj.__checkinTickForTest(Date.now() + wj.JOB_CHECKIN_INTERVAL_MS + 60_000);
  await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
  const b = wj.listJobs().find((j) => j.label === "B-ck");
  return { bSpawned: b !== undefined, bNotifyDest: b?.notifyDest ?? null, bSend: bSends[0] ?? null, attached: [...attached], published: [...published], routes: [...routeLines] };
};

/** 완료 합성 턴이 한도에 걸린다 — 쿨다운 알림이 어디로 가나(대화=대시보드 · 보고 좌표=텔레그램). */
const runCooldown = async (): Promise<Record<string, unknown>> => {
  const { __setAdapterForTest } = await import("../../core/llm-runtime/index.js");
  const { translate } = await import("../../core/i18n.js");
  wj.__resetJobsForTest();
  sent.length = 0;
  const restore = __setAdapterForTest(async () => { throw new Error("You've hit your limit · resets 2:20am (Asia/Seoul)"); });
  try {
    const THREAD = "dashboard:regr-chain-cd";
    const aId = wj.registerJob({
      label: "A-cd", task: "A 작업", threadKey: THREAD, channel: "http-bridge" as never, channelUserId: THREAD,
      notifyDest: { channel: "telegram", target: "chat-5" } as never,
    });
    await wj.onWorkerComplete(aId, { result: "A 결과" });
    await new Promise((r) => setTimeout(r, 100)); // 쿨다운 알림은 void 발송이다
  } finally {
    restore();
  }
  // 알림 첫 줄의 고정 조각(어댑터·시각 자리 사이 가장 긴 글)로 쿨다운 알림만 가른다.
  const frag = translate("srv.limit.reached", { adapter: "\u0001", when: "\u0001" }).split("\u0001").sort((a, b) => b.length - a.length)[0] ?? "";
  return { frag, cooldown: sent.filter((s) => frag !== "" && s.text.includes(frag)).map(({ channel, target }) => ({ channel, target })), all: sent.map(({ channel, target, text }) => ({ channel, target, text: text.slice(0, 40) })) };
};

const out: Record<string, unknown> = {};
let error = "";
try {
  // 대시보드에서 띄운 A(그 턴은 addr=세션 id 를 가졌다) — 사고 그대로
  out.dash = await runCase("dash", { threadKey: "dashboard:regr-chain-dash", channel: "http-bridge", notifyDest: { channel: "http-bridge", target: "dashboard:regr-chain-dash" } });
  // 대화는 대시보드, 결과는 텔레그램(감시처럼) — 채널·좌표 쌍이 섞이면 안 된다
  out.cross = await runCase("cross", { threadKey: "dashboard:regr-chain-cross", channel: "http-bridge", notifyDest: { channel: "telegram", target: "chat-7" } });
  // 텔레그램에서 띄운 A(세션 정규화 갈래)
  out.tg = await runCase("tg", { threadKey: "dashboard:regr-chain-tg", channel: "telegram", notifyDest: { channel: "telegram", target: "chat-9" } });
  // 보고 좌표가 없는 옛 잡 — 종전 폴백 그대로
  out.none = await runCase("none", { threadKey: "dashboard:regr-chain-none", channel: "http-bridge" });
  out.checkin = await runCheckin();
  out.cooldown = await runCooldown(); // ★마지막 — 어댑터를 바꾸고 codex 를 쉬게 한다
} catch (e) {
  error = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
}
realLog("CHAIN_RESULT " + JSON.stringify({ ...out, error }));
process.exit(0);
