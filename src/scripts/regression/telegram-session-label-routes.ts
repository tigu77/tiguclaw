/**
 * 회귀: **텔레그램 세션 라벨은 확정 기준표대로 붙는다** (2026-10-26 정태님 확정 — `docs/decisions/2026-10-26-telegram-session-label-policy.md`).
 *
 * 기준: 현재 텔레그램 세션의 직접 응답·선택지는 생략 · 다른 세션으로 연결된 후속 응답·선택지는 표시 · 대시보드 사본·자동 알림·
 *  그 밖의 선택지는 **기본 세션도** 표시 · 이름이 없으면 짧은 ID · 한 메시지에 중복 금지 · 출처 없는 시스템 알림엔 지어내지 않는다.
 * 이름 규칙(`sessionLabelPrefix`)·인입 갈림 판정(`routedReplySession`)은 `egress-source-label` 이 잰다. 여기는 **경로**를 잰다.
 *
 * 재는 것(LLM·네트워크 0):
 *  ① 코어 발송 `deliverOutbound` — `labelSession` 이면 물리 발송 글에만 라벨(관측 본문은 그대로) · 기본 세션도 · 중복 없음 ·
 *     `labelSession` 없이 귀속·표시 세션만 있으면 라벨 없음(업데이트·자가 점검처럼 출처 없는 알림)
 *  ② 잡 보고·알림의 라벨 세션 `jobSessionLabel` — 사람 대화(기본 세션 포함)면 그 세션 · 스케줄 등 내부 스레드·미상 부모면 없음
 *  ③ 텔레그램 선택지 렌더 `renderOptions` — 라벨 세션이면 질문 앞에 한 번 · 없으면(현재 세션 직접) 질문 그대로
 *  ④ 배선 — 텔레그램 콜백 턴은 «갈렸나» 신호로 라벨 · 인입 턴 선택지도 같은 신호 · `labelSession` 을 넘기는 자리는 출처가 있는 경로뿐
 *
 * 등급: **동작**(④만 배선 확인 — grammy 컨텍스트가 필요한 자리).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Ev = { type: string; ts: number; payload: Record<string, unknown> };

/** `labelSession` 을 **넘기는** 파일 전수(정의·검사 제외) — 새 자리가 생기면 «출처가 있는 경로인가» 를 다시 봐야 한다. */
const listLabelSessionPassers = (): string[] => {
  const hits: string[] = [];
  const skip = new Set(["node_modules", "dist", ".git"]);
  const walk = (dir: string): void => {
    for (const e of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".ts") && !rel.includes("scripts/regression/")) {
        // 객체 리터럴로 «값을 넘기는» 자리만 센다 — 타입 선언(`labelSession?:`)·전달(`opts.labelSession`)은 뺀다.
        if (/labelSession: (?!opts|string)[A-Za-z_$]/.test(readFileSync(path.join(REPO, rel), "utf8"))) hits.push(rel);
      }
    }
  };
  for (const r of ["src", "plugins"]) walk(r);
  return hits.sort();
};

export const check: RegressionCheck = {
  name: "telegram-session-label-routes",
  guards:
    "텔레그램으로 나가는 사본·자동 알림·선택지에 세션 라벨이 기준표와 달리 붙거나(현재 세션 직접 대화·출처 없는 알림) 안 붙는 것(기본 세션 사본·완료 보고·좌표 선택지)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, setThreadName } = await import("../../store/sessions.js");
    initStore();
    setThreadName("dashboard:default", "회귀공통");
    setThreadName("dashboard:regr-lbl", "회귀작업");

    // ── ① 코어 발송 ─────────────────────────────────────────────────────────
    {
      const { deliverOutbound } = await import("../../core/outbound.js");
      const { registerChannelOutbound, unregisterChannelOutbound } = await import("../../core/channel-outbound.js");
      const CH = "regr-lbl-chan";
      const sent: string[] = [];
      // 실제 TelegramChannel.outbound.deliver 경계를 탄다. API만 가짜(토큰/네트워크 0).
      const tgModule = await loadPluginModule<{ default: new () => { outbound: unknown; stop(): Promise<void> } }>("../../../plugins/telegram-channel/index.js");
      const savedToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "12345:regression-label-only";
      const tg = new tgModule.default();
      if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedToken;
      const bot = (tg as unknown as { bot: { api: { sendMessage: unknown }; stop: unknown } }).bot;
      bot.api.sendMessage = async (_t: unknown, text: string) => { sent.push(text); return { message_id: 881000 + sent.length }; };
      bot.stop = async () => {};
      registerChannelOutbound(CH, tg.outbound as never);
      const events: Ev[] = [];
      const bus = { publish: (e: Ev) => { events.push(e); } } as never;
      try {
        await deliverOutbound({ channel: CH, target: null, text: "사본 본문", bus, originThreadKey: "dashboard:default", labelSession: "dashboard:default" });
        await deliverOutbound({ channel: CH, target: null, text: "[회귀작업] 이미 붙은 글", bus, originThreadKey: "dashboard:regr-lbl", labelSession: "dashboard:regr-lbl" });
        await deliverOutbound({ channel: CH, target: null, text: "업데이트 알림", bus, observeThreadKey: "dashboard:default", originThreadKey: "dashboard:default" });
        await deliverOutbound({ channel: CH, target: null, text: "무명 세션 사본", bus, labelSession: "dashboard:5f0e1d2c-aaaa-bbbb-cccc-0123456789ab" });
        const observed = events.filter((e) => e.type === "channel.message.out").map((e) => String(e.payload.text));
        out.push(assert(
          "★① 대시보드 사본·자동 알림은 **기본 세션도** 물리 발송 글 앞에 `[세션 이름]` — 관측 본문엔 안 붙는다(대시보드는 탭이 구분한다)",
          sent[0] === "[회귀공통] 사본 본문" && observed[0] === "사본 본문",
          JSON.stringify({ sent: sent[0], observed: observed[0] }),
        ));
        out.push(assert(
          "① 이미 그 라벨로 시작하는 글엔 다시 안 붙는다(한 메시지에 중복 표시 금지)",
          sent[1] === "[회귀작업] 이미 붙은 글",
          JSON.stringify(sent[1]),
        ));
        out.push(assert(
          "★① 라벨 세션을 안 넘긴 발송은 귀속·표시 세션(기본 세션)이 있어도 라벨 없음 — 출처 없는 시스템 알림에 세션을 지어내지 않는다",
          sent[2] === "업데이트 알림",
          JSON.stringify(sent[2]),
        ));
        out.push(assert(
          "① 이름이 없는 세션은 짧은 ID(UUID 앞 8자)",
          sent[3] === "[dashboard:5f0e1d2c] 무명 세션 사본",
          JSON.stringify(sent[3]),
        ));
      } finally {
        unregisterChannelOutbound(CH);
        await tg.stop();
      }
    }

    {
      const { deliverOutbound } = await import("../../core/outbound.js");
      const { registerChannelOutbound, unregisterChannelOutbound } = await import("../../core/channel-outbound.js");
      const sent: string[] = [];
      registerChannelOutbound("regr-non-telegram-label", { deliver: async (_t, text) => { sent.push(text); } });
      try {
        await deliverOutbound({ channel: "regr-non-telegram-label", target: "x", text: "CLI 자동알림", labelSession: "dashboard:default" });
        out.push(assert("★타 채널의 자동알림 글은 새 Telegram 라벨 정책으로 바뀌지 않는다", sent[0] === "CLI 자동알림", JSON.stringify(sent)));
      } finally { unregisterChannelOutbound("regr-non-telegram-label"); }
    }

    // ── ② 잡 보고·알림의 라벨 세션 ─────────────────────────────────────────────
    {
      const { jobSessionLabel } = await import("../../core/worker-jobs.js");
      const table: Array<[string, string, string | undefined]> = [
        ["기본 세션에서 띄운 잡", "dashboard:default", "dashboard:default"],
        ["대시보드 세션에서 띄운 잡", "dashboard:regr-lbl", "dashboard:regr-lbl"],
        ["스케줄이 띄운 잡(내부 스레드 — 출처 세션 없음)", "scheduler:7", undefined],
        ["부모를 모르는 매니저 자식(미상)", "worker:never-registered", undefined],
      ];
      const bad = table.filter(([, tk, want]) => jobSessionLabel(tk).labelSession !== want);
      out.push(assert(
        "★② 잡 보고·진행·지연 알림은 띄운 **사람 대화**의 라벨(기본 세션 포함) · 내부 스레드·미상이면 라벨 없음(표시 세션 «기본» 을 출처로 지어내지 않는다)",
        bad.length === 0,
        bad.length === 0
          ? table.map(([n, tk]) => `${n}→${jobSessionLabel(tk).labelSession ?? "없음"}`).join(" · ")
          : `★틀린 것: ${bad.map(([n, tk, w]) => `${n} 기대=${w ?? "없음"} 실제=${jobSessionLabel(tk).labelSession ?? "없음"}`).join(" · ")}`,
      ));
    }

    // ── ③ 텔레그램 선택지 렌더 ─────────────────────────────────────────────────
    {
      const tg = await loadPluginModule<{
        renderOptions: (
          send: (text: string, extra: unknown) => Promise<unknown>,
          q: string,
          o: { label: string; value: string }[],
          opts?: { note?: string; replyToSession?: string; labelSession?: string; promptId?: string },
        ) => Promise<{ ok: boolean }>;
      }>("../../../plugins/telegram-channel/index.ts");
      const texts: string[] = [];
      const send = async (text: string): Promise<unknown> => { texts.push(text); return { message_id: 1 }; };
      const O = [{ label: "A", value: "a" }];
      await tg.renderOptions(send, "고를까요?", O, { note: "설명", labelSession: "dashboard:default" });
      await tg.renderOptions(send, "고를까요?", O, { note: "설명" });
      await tg.renderOptions(send, "[회귀작업] 고를까요?", O, { labelSession: "dashboard:regr-lbl" });
      out.push(assert(
        "★③ 라벨 세션이 있는 선택지(사본·자동 알림·갈린 세션)는 질문 앞에 한 번 — 기본 세션 포함",
        texts[0] === "[회귀공통] 고를까요?\n\n설명",
        JSON.stringify(texts[0]),
      ));
      out.push(assert(
        "★③ 라벨 세션이 없는 선택지(현재 텔레그램 세션 직접)는 글자 하나 안 바뀐다 · 중복 없음",
        texts[1] === "고를까요?\n\n설명" && texts[2] === "[회귀작업] 고를까요?",
        JSON.stringify(texts.slice(1)),
      ));
    }

    // ── ④ 배선 ───────────────────────────────────────────────────────────────
    {
      const tgSrc = readFileSync(path.join(REPO, "plugins/telegram-channel/index.ts"), "utf8");
      const cb = /bot\.on\("callback_query:data"[\s\S]{0,12000}?\n    \}\);/.exec(tgSrc)?.[0] ?? "";
      out.push(assert(
        "★④ 다른 세션 선택지를 눌러 이어진 콜백 턴은 **답장과 같은 «갈렸나» 판정**으로 답·파일·선택지에 라벨(현재 세션 선택지면 생략)",
        /const routedSession = routedReplySession\(callbackSession, resolveSessionId\("telegram", chatId\)\)/.test(cb) &&
          /repliedSession: routedSession/.test(cb) &&
          /labelSession: routedSession/.test(cb) &&
          /buildPresentOptions\(ctx, callbackSession \?\? null, routedSession, sessionId\)/.test(cb),
        cb === "" ? "콜백 핸들러를 못 찾음" : "배선",
      ));
      out.push(assert(
        "④ 인입 턴의 선택지도 답과 같은 신호(갈린 세션)로만 라벨",
        (tgSrc.match(/buildPresentOptions\(ctx, routedSession, routedSession, sessionId\)/g) ?? []).length === 2,
        String((tgSrc.match(/buildPresentOptions\(ctx, routedSession, routedSession, sessionId\)/g) ?? []).length),
      ));
      const passers = listLabelSessionPassers();
      const allowed = [
        "plugins/telegram-channel/index.ts", // 인입·콜백 턴의 갈린 세션
        "src/core/prompt-options-egress.ts", // egress 선택지 = 물어본 세션
        "src/core/outbound.ts", // 채널에 명시 라벨 메타 전달(글은 채널이 결정)
        "src/core/worker-jobs.ts", // 잡 보고 = jobSessionLabel
        "src/index.ts", // 대시보드 사본·선택지 텍스트 사본 = 물어본 세션
      ];
      out.push(assert(
        "★④ 라벨 세션을 넘기는 자리는 **출처가 있는 경로**뿐 — 새 자리가 생기면 «현재 세션 직접 대화인가 · 출처를 지어내나» 를 다시 본다",
        passers.length === allowed.length && passers.every((p) => allowed.includes(p)),
        passers.join(", "),
      ));
    }
    return out;
  },
};

export default check;
