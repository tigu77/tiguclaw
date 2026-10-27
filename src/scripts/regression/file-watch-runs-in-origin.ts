/**
 * 회귀: **파일 감시는 만든 대화에서 처리된다** (2026-10-20 정태님 — 설계 docs/decisions/2026-10-20-watch-origin-session-design.md).
 *
 * 사고(회사돌쇠 10-19·10-20): 감시는 전용 세션(`file-watch:<id>`)에서 돌아 RPG 대화의 정정을 몰랐고, 감시가 띄운 매니저는 감시 세션
 *  소유라 RPG 대화에서 이름으로 멈추지 못했다. 이제 새 감시는 **만든 대화의 줄**에 턴을 넣는다.
 * 지키는 것:
 *  ① 파사드: 만든 대화가 있으면 그 대화 키로 턴을 넣는다(세션 지정·합성·표식 inOrigin) — 전용 세션 실행·추가 줄 서기 0
 *  ② 차례가 왔을 때 다시 본다: 감시 삭제·끄기·처리 자리 변경·대화 사라짐이면 돌지 않는다 · 대화가 없으면 **폴백 없이** 실패
 *  ③ 답은 그 턴이 목적지로 직접(물리 발송만 — 관측은 핸들러가 그 대화에) · 못 보내면 던진다
 *  ④ 도구: 등록 대화는 **서버가** 적는다(호스트 turnSession) · 대화 감시엔 keep_runs 거절 · move_here 로 옮기기
 *  ⑤ 호스트 turnSession: 대시보드·기본 세션은 그 키 · 매니저 안이면 맨 위 소유 · 스케줄·감시·턴 밖은 null
 *  ⑥ 맥락 줄: «이 대화에서 등록» 이고 «이력은 여기 없다» 가 아니다 ⑦ 세션 줄이 차례에서 `beforeTurn` 을 묻는다(배선)
 */
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { triggerRunLine } from "../../core/prompt-assembly.js";
import { resolveEgressTargets } from "../../core/egress-targets.js";
import { createPluginHost } from "../../core/plugins/host.js";
import { __resetJobsForTest, registerJob } from "../../core/worker-jobs.js";
import { deleteSession, initStore, isConversationLive, saveSession, setThreadArchived } from "../../store/sessions.js";
import { recordChatMessage } from "../../store/chat-log.js";
import { getWatch, deleteWatch } from "../../store/watches.js";
import { readSourceSync, stripComments } from "./_wiring.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Msg = Record<string, unknown> & { beforeTurn?: () => string | null; reply: (t: string, o?: { turnFailed?: boolean }) => Promise<void> };

/** 진짜 파사드(`plugins/file-watch/src/index.ts`)를 OS·코어 경계만 바꿔 싣는다. */
const loadFacade = (state: {
  row: Record<string, unknown> | undefined;
  sessions: Set<string>;
  delivered: boolean;
  /** 그 대화가 마지막으로 받은 채널·주소(세션 채널 메타). 없으면 대시보드 기본. */
  meta?: { lastChannel: string; lastChannelTarget: string | null };
  onTurn: (m: Msg) => Promise<void>;
}) => {
  const seen = { msgs: [] as Msg[], core: 0, queued: 0, sends: [] as Record<string, unknown>[] };
  let deps: { runClaude: (i: unknown) => Promise<Record<string, unknown>> } | undefined;
  let core: Record<string, unknown> | undefined;
  const req = (name: string): unknown => {
    if (name.endsWith("/eventbus.js")) return { safeUnsubscribe: (fn: (() => void) | null) => { fn?.(); return null; } };
    if (name.endsWith("/claude.js")) return { runClaude: async () => { seen.core += 1; return { text: "전용 세션 답" }; } };
    if (name.endsWith("/external-turn.js")) return { runExternalTurn: (_tk: string, _t: unknown, fn: () => Promise<unknown>) => { seen.queued += 1; return fn(); } };
    if (name.endsWith("/watches.js")) return { getWatch: () => state.row, listWatches: () => [{ id: 77, label: "답안", enabled: true }], recordFiring: () => {}, updateWatch: () => {}, recordWatchRun: () => {}, watchRunTimes: () => [] };
    if (name.endsWith("/thread-reset.js")) return { applyRunHistory: () => null };
    if (name.endsWith("/sessions.js")) return { canonicalSessionChannel: (_tk: string, ch: string) => ch, getSessionChannelMeta: () => state.meta ?? null, isConversationLive: (k: string) => state.sessions.has(k), SESSION_STORAGE_CHANNEL: "http-bridge" };
    if (name.endsWith("/threadkey.js")) return { DEFAULT_SESSION_ID: "dashboard:default" };
    if (name.endsWith("/worker-jobs.js")) return { jobSessionLabel: (tk: string) => ({ labelSession: tk }), mainMessageHandler: () => async (m: Msg) => { seen.msgs.push(m); await state.onTurn(m); } };
    if (name.endsWith("/outbound.js")) return {
      attachmentSenderFor: () => undefined,
      optionsPresenterFor: () => undefined,
      deliverOutbound: async (i: Record<string, unknown>) => { seen.sends.push(i); return state.delivered ? { delivered: true } : { delivered: false, reason: "fixture: not registered" }; },
    };
    // ★코어의 «만든 대화에서 처리» 는 **진짜 코드**를 같은 가짜 경계 위에 싣는다(2026-10-20 — 파사드에서 코어로 옮겼다). 모의로 갈면 이 검사가
    //  코어 판정을 못 본다.
    if (name.endsWith("/trigger-in-session.js")) {
      if (core === undefined) {
        const cf = path.join(repo, "src/core/trigger-in-session.ts");
        const cc = ts.transpileModule(fs.readFileSync(cf, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        core = {};
        vm.runInNewContext(cc, { exports: core, require: req, Date, console: { log() {}, warn() {}, error() {} } }, { filename: cf });
      }
      return core;
    }
    if (name === "./watcher.js") return { substitutePrompt: (p: string, c: { path: string; event: string }) => p.split("{path}").join(c.path).split("{event}").join(c.event), registerWatcher: (_r: unknown, _b: unknown, d: typeof deps) => { deps = d; }, unregisterWatcher: () => {} };
    if (name === "./mcp.js") return { setFileWatchLifecycleHooks: () => {}, createFileWatchMcpServer: () => ({}) };
    throw new Error(`모의하지 않은 import: ${name}`);
  };
  const filename = path.join(repo, "plugins/file-watch/src/index.ts");
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(code, { exports, require: req, AbortController, Date, process: { cwd: () => "/fixture" }, console: { log() {}, warn() {}, error() {} } }, { filename });
  const Plugin = exports.default as new () => { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> };
  return {
    state,
    seen,
    /** 파사드가 감시기에 «발화 때 최신 행» 을 넘기나(레드팀 P-1 배선). */
    hasLatestRow: (): boolean => typeof (deps as { latestRow?: unknown } | undefined)?.latestRow === "function",
    fire: async (origin: string | null, notifyDest: { channel: string; target: string | null } = { channel: "telegram", target: "chat-1" }): Promise<Record<string, unknown>> => {
      const plugin = new Plugin();
      await plugin.startTrigger({ subscribe: () => () => {}, publish: () => {} }, { cwd: "/fixture" });
      const out = await deps!.runClaude({
        text: "바뀐 답안을 검수해: /w/answers.json", threadKey: "file-watch:77", channel: "file-watch", cwd: "/fixture",
        notifyDest,
        triggerRun: { kind: "watch", id: 77, event: "change", path: "/w/answers.json" },
        originThreadKey: origin,
      });
      await plugin.stop();
      return out;
    },
  };
};

export const check: RegressionCheck = {
  name: "file-watch-runs-in-origin",
  guards:
    "파일 감시가 전용 세션에서 돌아 만든 대화의 맥락(정정)을 모르고, 감시가 띄운 작업을 그 대화에서 멈추지 못하던 것(회사돌쇠 10-19·10-20) — 새 감시는 만든 대화의 줄에서 처리",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];
    const ORIGIN = "dashboard:rpg";
    // 차례가 왔을 때 지시·목적지를 이 행에서 다시 만든다(아스트라 10-20 P1) — 발화 때와 같은 값.
    const liveRow = { id: 77, label: "답안", enabled: true, originThreadKey: ORIGIN, prompt: "바뀐 답안을 검수해: {path}", destChannel: "telegram", destTarget: "chat-1" };

    // ── ①③ 파사드 ────────────────────────────────────────────────────────
    const ok = loadFacade({ row: liveRow, sessions: new Set([ORIGIN]), delivered: true, onTurn: async (m) => { if (m.beforeTurn?.() === null) await m.reply("검수 결과입니다"); } });
    const r1 = await ok.fire(ORIGIN);
    out.push(assert("파사드가 감시기에 «발화 때 최신 행» 을 넘긴다 — 옮기기·프롬프트·목적지 변경이 재시작 없이 먹게", ok.hasLatestRow(), String(ok.hasLatestRow())));
    const m = ok.seen.msgs[0] as Msg | undefined;
    out.push(
      assert(
        "★★만든 대화가 있으면 **그 대화 키**로 턴을 넣는다 — 세션 지정·합성·턴 출처·감시 표식(inOrigin) · 전용 세션 실행 0 · 파사드가 줄을 또 서지 않는다",
        m !== undefined && m.threadKey === ORIGIN && (m.session as { explicitSessionId?: string })?.explicitSessionId === ORIGIN &&
          m.synthetic === true && m.turnOrigin === "file-watch" && (m.triggerRun as { inOrigin?: boolean })?.inOrigin === true &&
          String(m.text).includes("answers.json") && ok.seen.core === 0 && ok.seen.queued === 0,
        JSON.stringify({ threadKey: m?.threadKey, session: m?.session, synthetic: m?.synthetic, origin: m?.turnOrigin, run: m?.triggerRun, core: ok.seen.core, queued: ok.seen.queued }),
      ),
    );
    // ★실행 좌표 = 그 대화 자신의 좌표 · 결과 좌표는 notifyDest 로 따로(레드팀 P-2) · 이력에 남는 글엔 출처 표식(P-4).
    const tg = loadFacade({ row: { ...liveRow, originThreadKey: "dashboard:default", destTarget: null }, sessions: new Set(["dashboard:default"]), delivered: true,
      meta: { lastChannel: "telegram", lastChannelTarget: "7777" }, onTurn: async () => {} });
    await tg.fire("dashboard:default", { channel: "telegram", target: null });
    const mt = tg.seen.msgs[0] as Msg | undefined;
    out.push(
      assert(
        "★★실행 좌표는 **그 대화 자신의**(마지막 채널·주소) — 목적지의 빈 target 을 대화 키로 채우지 않는다 · 결과 좌표는 notifyDest 로 따로 · 글에 «사용자가 쓴 말이 아니다» 표식",
        m?.channel === "http-bridge" && m?.channelAddress === ORIGIN && JSON.stringify(m?.notifyDest) === JSON.stringify({ channel: "telegram", target: "chat-1" }) &&
          mt?.channel === "telegram" && mt?.channelAddress === "7777" && (mt?.session as { channelAddress?: string })?.channelAddress === "7777" &&
          JSON.stringify(mt?.notifyDest) === JSON.stringify({ channel: "telegram", target: null }) &&
          String(m?.text).startsWith("〔파일 감시 #77 실행 · change /w/answers.json — 사용자가 쓴 말이 아니다〕\n"),
        JSON.stringify({ dash: { ch: m?.channel, addr: m?.channelAddress, nd: m?.notifyDest }, tg: { ch: mt?.channel, addr: mt?.channelAddress, nd: mt?.notifyDest }, text: String(m?.text).slice(0, 40) }),
      ),
    );
    // ★이음매 — 파사드가 **실제로 만든 메시지**를 진짜 egress 해석에 넣는다(2026-10-26 라이브). 대화 안 트리거의 `channel` 은 실행 좌표(위 단언)라
    //  마지막 인입이 텔레그램인 대시보드 대화의 감시 답이 텔레그램 사본을 못 탔다. 두 모듈은 각자 멀쩡했고 이음매에서 났다.
    const egressOf = async (destChannel: string, destTarget: string | null) => {
      const f = loadFacade({ row: { ...liveRow, destChannel, destTarget }, sessions: new Set([ORIGIN]), delivered: true,
        meta: { lastChannel: "telegram", lastChannelTarget: "7777" }, onTurn: async (mm) => { if (mm.beforeTurn?.() === null) await mm.reply("답"); } });
      await f.fire(ORIGIN, { channel: destChannel, target: destTarget });
      const sent = f.seen.msgs[0] as unknown as Parameters<typeof resolveEgressTargets>[0] | undefined;
      if (sent === undefined) return "★턴 없음";
      const r = await resolveEgressTargets({ ...sent, egressChannels: ["telegram"] }, {
        getOutbound: (n) => (n === "telegram" ? { deliver: async () => {}, defaultOutboundTarget: () => "owner" } : undefined),
        getSessionMeta: () => ({ lastChannel: "telegram", lastChannelTarget: "7777" }),
      });
      return `${f.seen.sends.map((s) => `${String(s.channel)}:${String(s.target)}`).join(",")} + 사본[${r.map((t) => `${t.channel}:${t.target}`).join(",")}]`;
    };
    const toDash = await egressOf("http-bridge", ORIGIN);
    const toSameTg = await egressOf("telegram", "7777");
    out.push(
      assert(
        "★★마지막 인입이 텔레그램인 대화의 감시 답: 목적지가 대시보드면 대시보드 + 텔레그램 사본 1건 · 목적지가 그 텔레그램 좌표면 사본 0(중복 0)",
        toDash === `http-bridge:${ORIGIN} + 사본[telegram:7777]` && toSameTg === "telegram:7777 + 사본[]",
        JSON.stringify({ toDash, toSameTg }),
      ),
    );
    // 턴이 실패 안내로 끝나면 실패로 돌려준다(그물 G-2).
    const failing = loadFacade({ row: liveRow, sessions: new Set([ORIGIN]), delivered: true, onTurn: async (mm) => { if (mm.beforeTurn?.() === null) await mm.reply("한도 초과", { turnFailed: true }); } });
    const rf = await failing.fire(ORIGIN);
    out.push(assert("턴이 실패 안내로 끝나면 `inOrigin.failed` 로 돌려준다(성공으로 세지 않는다)", (rf.inOrigin as { failed?: string })?.failed === "한도 초과", JSON.stringify(rf)));
    const send = ok.seen.sends[0];
    out.push(
      assert(
        "★답은 그 턴이 **감시의 목적지로 직접**(물리 발송만 — 관측은 핸들러가 그 대화에 한 번) · 실행기는 다시 보내지 않게 `inOrigin` 을 돌려준다",
        send?.channel === "telegram" && send?.target === "chat-1" && send?.observe === false && send?.originThreadKey === ORIGIN &&
          JSON.stringify(r1.inOrigin) === JSON.stringify({ replied: "검수 결과입니다".length, dest: { channel: "telegram", target: "chat-1" } }) && r1.text === "",
        JSON.stringify({ send, r1 }),
      ),
    );
    const noSend = loadFacade({ row: liveRow, sessions: new Set([ORIGIN]), delivered: false, onTurn: async (mm) => { await mm.reply("x"); } });
    let threw = "";
    try { await noSend.fire(ORIGIN); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    out.push(assert("목적지로 못 보내면(미등록 채널) 그 답 보내기가 **던진다** — «보냄» 으로 넘기지 않는다", threw.includes("배달 실패"), threw || "★안 던짐"));

    // ★아스트라 10-20 P1 — 줄에서 기다리는 사이 바뀐 지시·목적지를 **그 턴이** 쓴다(넣을 때의 값으로 옛 지시를 실행하고 옛 목적지로 답했다).
    const chg = loadFacade({ row: liveRow, sessions: new Set([ORIGIN]), delivered: true, onTurn: async (mm) => {
      chg.state.row = { ...liveRow, prompt: "새 지시: {path}", destTarget: "chat-NEW" };
      if (mm.beforeTurn?.() === null) await mm.reply("새 답");
    } });
    await chg.fire(ORIGIN);
    const mc = chg.seen.msgs[0] as Msg | undefined;
    out.push(
      assert(
        "★★아스트라 P1 기다리는 사이 바뀐 **지시·목적지를 그 턴이 쓴다** — 글(같은 치환)·통지 좌표·답의 실제 좌표·실제 배달처가 새 값",
        String(mc?.text).endsWith("\n새 지시: /w/answers.json") && (mc?.notifyDest as { target?: string })?.target === "chat-NEW" &&
          (mc?.replyTarget as { target?: string })?.target === "chat-NEW" && chg.seen.sends[0]?.target === "chat-NEW",
        JSON.stringify({ text: String(mc?.text).split("\n")[1], nd: mc?.notifyDest, rt: mc?.replyTarget, sent: chg.seen.sends.map((x) => x.target) }),
      ),
    );

    // ── ② 차례가 왔을 때 다시 본다 ─────────────────────────────────────────
    const gate = async (row: Record<string, unknown> | undefined, sessions: string[]) => {
      let said: string | null = "";
      const f = loadFacade({ row, sessions: new Set(sessions), delivered: true, onTurn: async (mm) => { said = mm.beforeTurn?.() ?? null; } });
      const r = await f.fire(ORIGIN);
      return { said, skipped: r.skipped, turns: f.seen.msgs.length, core: f.seen.core };
    };
    const del = await gate(undefined, [ORIGIN]);
    const off = await gate({ ...liveRow, enabled: false }, [ORIGIN]);
    const moved = await gate({ ...liveRow, originThreadKey: null }, [ORIGIN]);
    // 넣을 땐 유효했는데 **기다리는 사이** 꺼졌다 — 차례에서 다시 봐야 잡힌다.
    let offRow: Record<string, unknown> | undefined = liveRow;
    let saidOff: string | null = "";
    const fo = loadFacade({ row: liveRow, sessions: new Set([ORIGIN]), delivered: true, onTurn: async (mm) => { offRow = { ...liveRow, enabled: false }; fo.state.row = offRow; saidOff = mm.beforeTurn?.() ?? null; } });
    const ro = await fo.fire(ORIGIN);
    const goneLater = await gate(liveRow, []); // 넣기 전 확인에서 이미 없음
    // 넣을 땐 있었는데 **기다리는 사이** 탭을 지웠다 — 차례에서 다시 봐야 잡힌다.
    const vanishing = new Set([ORIGIN]);
    let saidVanish: string | null = "";
    const fv = loadFacade({ row: liveRow, sessions: vanishing, delivered: true, onTurn: async (mm) => { vanishing.delete(ORIGIN); saidVanish = mm.beforeTurn?.() ?? null; } });
    const rv = await fv.fire(ORIGIN);
    out.push(
      assert(
        "★★지워짐·꺼짐·처리 자리 바뀜이면 돌지 않는다(사유를 돌려준다 — 넣을 때 이미 그렇면 줄에 서지도 않고, **기다리는 사이** 그렇게 되면 차례에서 잡는다) · 대화가 없으면 «origin-gone» — **전용 세션 폴백 0**",
        del.skipped === "deleted" && del.turns === 0 &&
          off.skipped === "disabled" && off.turns === 0 && moved.skipped === "moved" && moved.turns === 0 &&
          ro.skipped === "disabled" && String(saidOff).includes("disabled") &&
          goneLater.skipped === "origin-gone" && goneLater.turns === 0 &&
          rv.skipped === "origin-gone" && String(saidVanish).includes("origin-gone") && fv.seen.core === 0 &&
          [del, off, moved, goneLater].every((g) => g.core === 0),
        JSON.stringify({ del, off, moved, goneLater, offLater: { skipped: ro.skipped, said: saidOff }, vanish: { skipped: rv.skipped, said: saidVanish } }),
      ),
    );
    const own = loadFacade({ row: { ...liveRow, originThreadKey: null }, sessions: new Set(), delivered: true, onTurn: async () => {} });
    const rOwn = await own.fire(null);
    out.push(
      assert(
        "만든 대화가 없는 감시(null)는 종전대로 **전용 세션**에서 돈다(줄 한 번 · 결과는 실행기가 배달)",
        own.seen.msgs.length === 0 && own.seen.core === 1 && own.seen.queued === 1 && rOwn.text === "전용 세션 답",
        JSON.stringify({ msgs: own.seen.msgs.length, core: own.seen.core, queued: own.seen.queued, text: rOwn.text }),
      ),
    );

    // ── ⑤ 호스트 turnSession ─────────────────────────────────────────────
    __resetJobsForTest();
    const parent = registerJob({ label: "매니저", task: "t", threadKey: ORIGIN, channel: "http-bridge" as never, channelUserId: "u", detached: true });
    const hostAt = (threadKey: string | undefined) =>
      createPluginHost("file-watch", {}, threadKey === undefined ? undefined : { threadKey, channel: "http-bridge", target: null }).turnSession();
    const sessionsSeen = {
      dash: hostAt(ORIGIN), def: hostAt("dashboard:default"), inManager: hostAt(`worker:${parent}`),
      sched: hostAt("scheduler:3"), watch: hostAt("file-watch:3"), none: hostAt(undefined),
    };
    __resetJobsForTest();
    out.push(
      assert(
        "★호스트가 «이 턴의 사람 대화» 를 준다 — 대시보드·기본 세션은 그 키 · 매니저 안이면 **맨 위 소유** · 스케줄·감시·턴 밖은 null(전용 세션)",
        sessionsSeen.dash === ORIGIN && sessionsSeen.def === "dashboard:default" && sessionsSeen.inManager === ORIGIN &&
          sessionsSeen.sched === null && sessionsSeen.watch === null && sessionsSeen.none === null,
        JSON.stringify(sessionsSeen),
      ),
    );

    // ── ④ 도구(진짜 저장소) ──────────────────────────────────────────────
    const mcp = await loadPluginModule<{ createFileWatchMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/file-watch/src/mcp.js");
    type T = Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }>;
    const toolsAt = (session: string | null): T =>
      (mcp.createFileWatchMcpServer({ turnSession: () => session }).instance as { _registeredTools: T })._registeredTools;
    const call = async (t: T, name: string, args: unknown) => JSON.parse((await t[name]!.handler(args, {})).content[0]!.text) as Record<string, unknown>;
    const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-origin-"));
    const made: number[] = [];
    try {
      const inChat = await call(toolsAt(ORIGIN), "add_watch", { label: "r1", path: dir, prompt: "p", dest_channel: "http-bridge", dest_target: ORIGIN });
      const fromSched = await call(toolsAt(null), "add_watch", { label: "r2", path: dir, prompt: "p", dest_channel: "telegram", dest_target: "c" });
      const keepRefused = await call(toolsAt(ORIGIN), "add_watch", { label: "r3", path: dir, prompt: "p", dest_channel: "http-bridge", keep_runs: 0 });
      for (const r of [inChat, fromSched]) if (typeof r.id === "number") made.push(r.id);
      const moveTo = await call(toolsAt("dashboard:other"), "update_watch", { id: fromSched.id, move_here: true });
      const moveNowhere = await call(toolsAt(null), "update_watch", { id: inChat.id, move_here: true });
      out.push(
        assert(
          "★★등록 대화는 **서버가** 적는다(호스트 턴 좌표) — 대화에서 만들면 그 대화, 사람 없는 자리면 전용 세션 · 대화 감시엔 keep_runs 거절",
          getWatch(inChat.id as number)?.originThreadKey === ORIGIN && inChat.runs_in === "this_conversation" &&
            fromSched.runs_in === "own_session" && keepRefused.ok === false && keepRefused.error === "keep_runs_with_origin",
          JSON.stringify({ inChat, fromSched, keepRefused }),
        ),
      );
      out.push(
        assert(
          "★move_here 는 **이 수정을 부른 대화**로만 옮긴다 · 사람 없는 자리에선 거절",
          moveTo.ok === true && getWatch(fromSched.id as number)?.originThreadKey === "dashboard:other" && moveNowhere.ok === false && moveNowhere.error === "no_conversation",
          JSON.stringify({ moveTo, moveNowhere }),
        ),
      );
    } finally {
      for (const id of made) deleteWatch(id);
      rmSync(dir, { recursive: true, force: true });
    }

    // ── ③' 진짜 감시기 — 만든 대화에서 돈 결과는 다시 안 보내고, 대화가 없으면 실패로 남긴다 ───────────────
    const wmod = (await import(new URL("../../../plugins/file-watch/src/watcher.ts", import.meta.url).href)) as {
      registerWatcher: (row: unknown, bus: unknown, deps: unknown) => void; unregisterWatcher: (id: number) => void;
    };
    const fireReal = async (id: number, result: Record<string, unknown>, latest?: (rowId: number) => Record<string, unknown> | undefined) => {
      const wdir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-origin-real-"));
      const got = { inputs: [] as Record<string, unknown>[], dispatched: 0, fired: [] as Record<string, unknown>[] };
      try {
        wmod.registerWatcher(
          { id, label: `regr-${id}`, path: wdir, pattern: null, recursive: false, debounceMs: 50, eventFilter: "add", prompt: "확인: {path}",
            destChannel: "telegram", destTarget: "chat-1", enabled: true, createdAt: 0, updatedAt: 0, lastFiredAt: null, lastPath: null, lastEvent: null,
            lastStatus: null, lastError: null, keepRuns: null, originThreadKey: ORIGIN },
          { publish: () => {}, subscribe: () => () => {}, history: () => [] },
          { cwd: wdir, recordFiring: (_i: number, r: Record<string, unknown>) => { got.fired.push(r); },
            runClaude: async (i: Record<string, unknown>) => { got.inputs.push(i); return result; },
            dispatch: async () => { got.dispatched += 1; },
            ...(latest !== undefined ? { latestRow: latest } : {}) },
        );
        await new Promise((r) => setTimeout(r, 400));
        fs.writeFileSync(path.join(wdir, "a.json"), "{}");
        for (let i = 0; i < 80 && got.fired.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      } finally {
        wmod.unregisterWatcher(id);
        rmSync(wdir, { recursive: true, force: true });
      }
      return got;
    };
    const ran = await fireReal(990177, { text: "", inOrigin: { replied: 12 } });
    const gone = await fireReal(990178, { text: "", skipped: "origin-gone" });
    const failedRun = await fireReal(990179, { text: "", inOrigin: { replied: 0, failed: "한도 초과" } });
    // 차례가 오기 전에 끝났다(데몬 종료 중) — 실행도 실패도 아니다: 기록 0·배달 0(재검토 10-20 G5).
    const notRun = await fireReal(990181, { text: "", skipped: "not-run" });
    // 성공 로그의 목적지 = 그 실행이 실제로 쓴 곳(아스트라 재검토 10-20) — 감시기가 붙잡은 행(chat-1)이 아니라 결과가 알려 준 값.
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try { await fireReal(990182, { text: "", inOrigin: { replied: 2, dest: { channel: "telegram", target: "chat-NEW" } } }); } finally { console.log = origLog; }
    const usedLog = logs.find((l) => l.includes("[file-watch:990182]") && l.includes("에서 처리")) ?? "";
    // ★옮긴 감시 — 감시기는 등록 때 행을 붙잡고 있다. 발화 때 최신 행을 읽어야 옮긴 대화로 간다(레드팀 P-1).
    const movedRun = await fireReal(990180, { text: "", inOrigin: { replied: 3 } }, (rowId) => ({
      id: rowId, label: `regr-${rowId}`, path: "/x", pattern: null, recursive: false, debounceMs: 50, eventFilter: "add", prompt: "옮긴 뒤 지시: {path}",
      destChannel: "http-bridge", destTarget: "dashboard:b", enabled: true, createdAt: 0, updatedAt: 0, lastFiredAt: null, lastPath: null, lastEvent: null,
      lastStatus: null, lastError: null, keepRuns: null, originThreadKey: "dashboard:b" }));
    out.push(
      assert(
        "★★진짜 감시기: 만든 대화를 실행기에 넘기고(originThreadKey) · 그 대화에서 돈 결과는 **다시 보내지 않으며**(두 번 배달 0) 성공으로 적는다 · 대화가 없으면 **실패로** 적는다 · 차례 전에 끝났으면(not-run) 아무것도 적지 않는다",
        ran.inputs[0]?.originThreadKey === ORIGIN && ran.dispatched === 0 && ran.fired[0]?.ok === true &&
          gone.dispatched === 0 && gone.fired[0]?.ok === false && String(gone.fired[0]?.error ?? "").includes(ORIGIN) &&
          failedRun.fired[0]?.ok === false && String(failedRun.fired[0]?.error ?? "").includes("한도 초과") &&
          notRun.inputs.length === 1 && notRun.fired.length === 0 && notRun.dispatched === 0 &&
          usedLog.includes("→ telegram:chat-NEW") && !usedLog.includes("chat-1 ") &&
          movedRun.inputs[0]?.originThreadKey === "dashboard:b" && String(movedRun.inputs[0]?.text ?? "").startsWith("옮긴 뒤 지시") &&
          JSON.stringify(movedRun.inputs[0]?.notifyDest) === JSON.stringify({ channel: "http-bridge", target: "dashboard:b" }),
        JSON.stringify({ origin: ran.inputs[0]?.originThreadKey, ran: { d: ran.dispatched, f: ran.fired }, gone: { d: gone.dispatched, f: gone.fired }, failed: failedRun.fired, moved: movedRun.inputs[0]?.originThreadKey }),
      ),
    );

    // ── 보관한 탭은 «살아 있지 않다»(레드팀 P-3 — 탭 «제거» 는 보관이라 행이 남는다) ──────────────────
    const LIVE_KEY = "dashboard:regr-origin-live";
    saveSession({ channel: "http-bridge" as never, threadKey: LIVE_KEY, claudeSessionId: "s", model: null, systemPromptHash: null });
    const beforeArchive = isConversationLive(LIVE_KEY);
    setThreadArchived(LIVE_KEY, Date.now());
    const afterArchive = isConversationLive(LIVE_KEY);
    out.push(
      assert(
        "★대화가 «살아 있나» 는 보관까지 본다 — 탭을 제거(보관)하면 감시는 그 대화로 안 간다 · 기본 세션은 늘 산다 · 없는 키는 아니다",
        beforeArchive && !afterArchive && isConversationLive("dashboard:default") && !isConversationLive("dashboard:regr-never"),
        JSON.stringify({ beforeArchive, afterArchive }),
      ),
    );

    // ── ★새 탭의 **첫 턴 안** — 세션 행이 아직 없어도 대화는 산다 (2026-10-22 회사돌쇠 검증) ──────────
    //  행은 모델 호출이 끝난 뒤 `saveSession` 이 만든다. 그 전에 울린 감시가 «만든 대화가 없다» 로 실패했다(같은 턴에서 만든 파일).
    //  (행이 지워진 경우는 deleteSession 으로 흉내낸다 — 제품의 `/reset` 은 08-20 에 없어졌다.)
    const FRESH_KEY = "dashboard:regr-origin-first-turn";
    recordChatMessage({ ts: Date.now(), threadKey: FRESH_KEY, channel: "http-bridge", role: "user", text: "이 폴더 감시해줘" });
    const freshLive = isConversationLive(FRESH_KEY);
    const RESET_KEY = "dashboard:regr-origin-reset";
    recordChatMessage({ ts: Date.now(), threadKey: RESET_KEY, channel: "http-bridge", role: "user", text: "안녕" });
    saveSession({ channel: "http-bridge" as never, threadKey: RESET_KEY, claudeSessionId: "s", model: null, systemPromptHash: null });
    deleteSession("http-bridge" as never, RESET_KEY);
    const afterReset = isConversationLive(RESET_KEY);
    // 보관이 이긴다 — 대화 기록이 있어도 보관한 탭은 죽은 대화다.
    recordChatMessage({ ts: Date.now(), threadKey: LIVE_KEY, channel: "http-bridge", role: "user", text: "기록 있음" });
    const archivedWithLog = isConversationLive(LIVE_KEY);
    // ★행이 없는 탭을 보관(제거)해도 보관이 남는다 — 그 뒤 트리거 턴의 saveSession 이 행을 만들어도 보관 유지(레드팀 10-22 P-1).
    const ROWLESS_KEY = "dashboard:regr-origin-rowless-archived";
    recordChatMessage({ ts: Date.now(), threadKey: ROWLESS_KEY, channel: "http-bridge", role: "user", text: "첫 턴이 실패한 탭" });
    setThreadArchived(ROWLESS_KEY, Date.now());
    const rowlessArchived = isConversationLive(ROWLESS_KEY);
    saveSession({ channel: "http-bridge" as never, threadKey: ROWLESS_KEY, claudeSessionId: "s2", model: null, systemPromptHash: null });
    const afterSave = isConversationLive(ROWLESS_KEY);
    // 흔적 없는 키(오타)는 보관해도 0행 — 명령·세션 도구가 «그런 세션이 없다» 로 답하는 근거다.
    const typoArchived = setThreadArchived("dashboard:regr-origin-typo", Date.now());
    out.push(
      assert(
        "★★세션 행이 아직 없는 새 탭(첫 턴 안)·행이 지워진 탭도 산다(대화 기록이 증거) — 보관한 탭은 기록이 있어도 죽은 대화 · **행 없는 탭의 보관도 남고 뒤 saveSession 이 되살리지 않는다** · 흔적 없는 키는 아니다",
        freshLive && afterReset && !archivedWithLog && !rowlessArchived && !afterSave && typoArchived === 0 && !isConversationLive("dashboard:regr-never"),
        JSON.stringify({ freshLive, afterReset, archivedWithLog, rowlessArchived, afterSave, typoArchived }),
      ),
    );

    // ── ⑥ 맥락 줄 · ⑦ 세션 줄 배선 ─────────────────────────────────────────
    const lineOrigin = triggerRunLine({ kind: "watch", id: 3, event: "change", path: "/w/a.json", inOrigin: true });
    const lineOwn = triggerRunLine({ kind: "watch", id: 3, event: "change", path: "/w/a.json" });
    out.push(
      assert(
        "맥락 줄: 만든 대화 실행이면 «이 대화에서 등록»·«앞선 대화를 보고» 이고 «이력은 여기 없다» 가 아니다 · 전용 세션은 종전 문장",
        lineOrigin.includes("이 대화에서 등록") && !lineOrigin.includes("이력은 여기 없다") && lineOwn.includes("이력은 여기 없다") && lineOrigin.includes("알 수 없다"),
        lineOrigin,
      ),
    );
    const idx = stripComments(readSourceSync("src/index.ts"));
    const wired = /enqueueThreadTurn\(\s*msg\.threadKey,\s*\(\) => \{\s*const skip = msg\.beforeTurn\?\.\(\) \?\? null;\s*if \(skip !== null\) \{[\s\S]{0,300}?return Promise\.resolve\(\);\s*\}\s*(?:if \(msg\.triggerRun\?\.kind === "schedule"\) \{[\s\S]{0,400}?claimLimitResume\([\s\S]{0,200}?return handler\(msg\)\.finally\([\s\S]{0,120}?\}\s*)?return handler\(msg\);/.test(idx);
    const router = stripComments(readSourceSync("src/core/router.ts"));
    out.push(
      assert(
        "세션 줄은 **차례가 온 그 자리에서** `beforeTurn` 을 묻고, 라우터는 `triggerRun` 을 모델 입력까지 나른다",
        wired && /msg\.triggerRun !== undefined \? \{ triggerRun: msg\.triggerRun \}/.test(router) && /msg\.notifyDest !== undefined \? \{ notifyDest: msg\.notifyDest \}/.test(router),
        JSON.stringify({ wired, router: /msg\.triggerRun/.test(router) }),
      ),
    );
    return out;
  },
};
