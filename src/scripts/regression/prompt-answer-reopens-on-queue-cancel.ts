/**
 * 회귀: **큐에서 기다리다 ✕ 로 취소된 선택지 답은 질문을 닫지 않는다** (2026-10-28, 설계 `docs/decisions/2026-10-28-prompt-choice-release-followup.md` §1 A1).
 *
 * 사고(코드 추적 · 독립 검토 성립): 선택지 답은 핸들러·큐 **전에** 소비 판정을 받는다(같은 질문 두 번 처리 차단, 10-26). 그런데 바쁜 세션에서
 *  큐에 선 답을 ✕ 로 취소해 처리되지 않았는데도 질문은 영구히 «답함» 이었다 — 다시 고르면 409, 텔레그램은 거절된 클릭에도 보기 id 를 먼저 지워
 *  나중에 같은 버튼이 «만료» 였다.
 *
 * 지키는 것(전부 동작 — 진짜 대장·진짜 직렬 큐·진짜 `handleMessages`·가짜 Bot API):
 *  ① 시작 전 취소가 확정되는 **그 순간** 질문이 다시 열린다(앞 턴이 끝나기 전) · 취소된 답은 끝내 실행되지 않는다
 *  ② 이미 시작한 답의 취소는 already-started · 질문은 닫힌 채
 *  ③ 두 번 취소해도 되돌림은 한 번 — 재개방 뒤 다른 답이 닫은 질문을 두 번째 취소가 열지 않는다
 *  ④ 대장에서 빠진(상한 퇴출) 질문은 되살리지 않는다 — «만료» 그대로
 *  ⑤ HTTP: 판정 ok 인 답만 `promptAnswerId` 를 싣고 · 409 경로 불변 · 큐 취소 뒤 같은 질문 id 재전송 수락
 *  ⑥ 텔레그램: 거절된 클릭은 보기 id 를 남긴다 → 재개방 뒤 **같은 버튼**이 그 값으로 처리된다
 *  ⑦ (CLI 는 `prompt-options-cli-once` 에서) · ⑧ 배선: 메인 큐가 `promptAnswerId` 를 `onCancel` 재개방으로 넘긴다
 *  ⑨ 답 큐 ≠ 표시 탭(대화 밖 작업의 질문): 표시 탭 키로는 취소 대상이 없고(질문 닫힘 유지) 답 큐 키로 취소해야 다시 열린다
 *  ⑩ 504 시한으로 POST 가 끝난 뒤에도 큐 항목이 살아 있으면 그 뒤 취소가 질문을 다시 연다(되살림 수명 = 큐 항목)
 *
 * 등급: **동작**.
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";

type Msg = { threadKey: string; text: string; correlationId?: string; promptAnswerId?: string; presentOptions?: unknown };
type Claims = typeof import("../../core/prompt-answer-claims.js");
type Queue = typeof import("../../core/worker-jobs.js");
type ChatRoutes = { handleMessages: (ctx: unknown) => Promise<void> };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open = (): void => {};
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
};
/** 진짜 큐 위에 메인 큐와 **같은 모양**의 핸들러(`index.ts` queueHandler 의 id·onCancel 넘김 — 그 배선 자체는 ⑧ 이 본다). */
const queueShaped =(claims: Claims, q: Queue, ran: Msg[]) => (m: Msg): Promise<unknown> =>
  q.enqueueThreadTurn(m.threadKey, async () => { ran.push(m); }, {
    id: m.correlationId,
    ...(m.promptAnswerId !== undefined ? { onCancel: () => { claims.reopenPromptAnswer?.(m.promptAnswerId!); } } : {}),
  } as never);

export const check: RegressionCheck = {
  name: "prompt-answer-reopens-on-queue-cancel",
  guards: "바쁜 세션에서 큐에 선 선택지 답을 ✕ 로 취소해도 그 질문이 영구히 «답함» 으로 닫히던 것(텔레그램은 거절된 클릭에도 보기 id 를 지움)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const claims = (await import("../../core/prompt-answer-claims.js")) as Claims;
    const q = (await import("../../core/worker-jobs.js")) as Queue;
    const reopen = (id: string): boolean => (typeof claims.reopenPromptAnswer === "function" ? claims.reopenPromptAnswer(id) : false);
    claims.__resetPromptClaimsForTest();

    // ── ① 시작 전 취소 = 즉시 재개방 ─────────────────────────────────────────
    {
      const T = "dashboard:regr-reopen-1";
      const id = claims.issuePromptId(T);
      const first = claims.claimPromptAnswer(id);
      const front = gate();
      const ran: string[] = [];
      let cbs = 0;
      void q.enqueueThreadTurn(T, async () => { await front.wait; });
      const answer = q.enqueueThreadTurn(T, async () => { ran.push("answer"); return "ran"; }, { id: "cid-1", onCancel: () => { cbs += 1; reopen(id); } } as never);
      const cancel = q.cancelQueuedTurn(T, "cid-1");
      const reclaimBeforeFrontEnds = claims.claimPromptAnswer(id);
      front.open();
      const result = await answer;
      out.push(assert(
        "★① 시작 전 취소가 확정되는 순간 질문이 다시 열린다(앞 턴이 끝나기 전에 다시 답할 수 있다) · 취소된 답은 실행되지 않는다",
        first === "ok" && cancel === "cancelled" && cbs === 1 && reclaimBeforeFrontEnds === "ok" && ran.length === 0 && q.isCancelledTurnResult(result),
        { 첫판정: first, 취소: cancel, 콜백: cbs, 앞턴종료전재판정: reclaimBeforeFrontEnds, 실행: ran, 결과sentinel: q.isCancelledTurnResult(result) },
      ));
    }
    // ── ② 이미 시작 ──────────────────────────────────────────────────────────
    {
      const T = "dashboard:regr-reopen-2";
      const id = claims.issuePromptId(T);
      claims.claimPromptAnswer(id);
      const hold = gate();
      let cbs = 0;
      const p = q.enqueueThreadTurn(T, async () => { await hold.wait; }, { id: "cid-2", onCancel: () => { cbs += 1; reopen(id); } } as never);
      await tick();
      const cancel = q.cancelQueuedTurn(T, "cid-2");
      const after = claims.claimPromptAnswer(id);
      hold.open();
      await p;
      out.push(assert("② 이미 시작한 답의 취소는 already-started · 되돌림 없음 · 질문 닫힘", cancel === "already-started" && cbs === 0 && after === "answered", { 취소: cancel, 콜백: cbs, 재판정: after }));
    }
    // ── ③ 두 번 취소 ─────────────────────────────────────────────────────────
    {
      const T = "dashboard:regr-reopen-3";
      const id = claims.issuePromptId(T);
      claims.claimPromptAnswer(id);
      const front = gate();
      let cbs = 0;
      void q.enqueueThreadTurn(T, async () => { await front.wait; });
      const p = q.enqueueThreadTurn(T, async () => undefined, { id: "cid-3", onCancel: () => { cbs += 1; reopen(id); } } as never);
      const c1 = q.cancelQueuedTurn(T, "cid-3");
      const other = claims.claimPromptAnswer(id); // 다른 채널의 답이 다시 닫는다
      const c2 = q.cancelQueuedTurn(T, "cid-3");
      const still = claims.claimPromptAnswer(id);
      front.open();
      await p;
      out.push(assert(
        "★③ 두 번 취소해도 되돌림은 한 번 — 재개방 뒤 다른 답이 닫은 질문을 두 번째 취소가 열지 않는다",
        c1 === "cancelled" && c2 === "cancelled" && cbs === 1 && other === "ok" && still === "answered",
        { 취소: [c1, c2], 콜백: cbs, 다른답: other, 두번째취소뒤: still },
      ));
    }
    // ── ④ 상한 퇴출 ──────────────────────────────────────────────────────────
    {
      claims.__resetPromptClaimsForTest();
      const oldest = claims.issuePromptId("dashboard:regr-reopen-4");
      claims.claimPromptAnswer(oldest);
      for (let i = 0; i < claims.PROMPT_ID_CAP; i += 1) claims.issuePromptId("dashboard:regr-fill");
      const reopened = reopen(oldest);
      const after = claims.claimPromptAnswer(oldest);
      out.push(assert("④ 대장에서 빠진 질문은 되살리지 않는다(«만료» 그대로)", reopened === false && after === "expired", { 재개방: reopened, 재판정: after }));
      claims.__resetPromptClaimsForTest();
    }
    // ── ⑤ HTTP · ⑨ 답 큐 ≠ 표시 탭 ───────────────────────────────────────────
    {
      const { handleMessages } = await loadPluginModule<ChatRoutes>("../../../plugins/http-bridge/routes-chat.ts");
      const ran: Msg[] = [];
      const seen: Msg[] = [];
      const handler = queueShaped(claims, q, ran);
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        void handleMessages({ req, res, url, pathname: url.pathname, channelName: "http-bridge", bus: null, sseClients: new Set(), channelHandler: (m: Msg) => { seen.push(m); return handler(m); } } as never);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      const post = (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> =>
        fetch(`http://127.0.0.1:${port}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }));
      const waitSeen = async (n: number): Promise<void> => { for (let i = 0; i < 200 && seen.length < n; i += 1) await new Promise((r) => setTimeout(r, 5)); };
      try {
        // ⑤ 표시 = 답 큐인 평소 질문
        const T = "dashboard:regr-reopen-http";
        const pid = claims.issuePromptId(T);
        const front = gate();
        void q.enqueueThreadTurn(T, async () => { await front.wait; });
        const a = post({ text: "A", threadKey: T, correlationId: "cid-http-a", promptId: pid });
        await waitSeen(1);
        const dup = await post({ text: "B", threadKey: T, correlationId: "cid-http-b", promptId: pid });
        const cancel = q.cancelQueuedTurn(T, "cid-http-a");
        const again = post({ text: "B", threadKey: T, correlationId: "cid-http-c", promptId: pid });
        await waitSeen(2);
        front.open();
        const [ra, rc] = await Promise.all([a, again]);
        out.push(assert(
          "★⑤ HTTP — 판정 ok 인 답만 promptAnswerId 를 싣는다 · 두 번째 답 409(prompt-closed) 불변 · 큐 취소 뒤 같은 질문 id 재전송 수락 · 처리된 답은 재전송분 하나",
          seen[0]?.promptAnswerId === pid && dup.status === 409 && dup.body.code === "prompt-closed" && cancel === "cancelled" &&
            ra.status === 200 && ra.body.cancelled === true && rc.status === 200 && rc.body.cancelled !== true &&
            ran.length === 1 && ran[0]?.text === "B" && ran[0]?.correlationId === "cid-http-c",
          { 첫답필드: seen[0]?.promptAnswerId === pid, 중복: dup, 취소: cancel, 첫응답: ra, 재전송응답: rc, 처리: ran.map((m) => [m.text, m.correlationId]) },
        ));
        // ⑤b 질문 id 없는 글은 필드 없음
        const plain = await post({ text: "그냥 글", threadKey: "dashboard:regr-reopen-plain", correlationId: "cid-plain" });
        const plainSeen = seen.find((m) => m.correlationId === "cid-plain");
        out.push(assert("⑤ 질문 id 없는 글엔 promptAnswerId 가 없다(종전 그대로)", plain.status === 200 && plainSeen !== undefined && plainSeen.promptAnswerId === undefined, { 응답: plain.status, 필드: plainSeen?.promptAnswerId ?? null }));
        // ⑨ 답 큐(scheduler:regr) ≠ 표시 탭(dashboard:regr-x)
        const AQ = "scheduler:regr";
        const SHOWN = "dashboard:regr-x";
        const pid9 = claims.issuePromptId(AQ);
        const f9 = gate();
        void q.enqueueThreadTurn(AQ, async () => { await f9.wait; });
        const n9 = seen.length;
        const p9 = post({ text: "A", threadKey: SHOWN, correlationId: "cid-9", promptId: pid9 });
        await waitSeen(n9 + 1);
        const queuedOn = seen.at(-1)?.threadKey;
        const wrongKey = q.cancelQueuedTurn(SHOWN, "cid-9");
        const stillClosed = claims.claimPromptAnswer(pid9); // 닫혀 있으면 부작용 없음
        const rightKey = q.cancelQueuedTurn(AQ, "cid-9");
        const p9b = post({ text: "B", threadKey: SHOWN, correlationId: "cid-9b", promptId: pid9 });
        await waitSeen(n9 + 2);
        f9.open();
        const [r9, r9b] = await Promise.all([p9, p9b]);
        out.push(assert(
          "★⑨ 답 큐 ≠ 표시 탭 — 항목은 답 큐에 서고 · 표시 탭 키 취소는 not-found(질문 닫힘 유지) · 답 큐 키 취소가 다시 열어 같은 질문 재전송 수락",
          queuedOn === AQ && wrongKey === "not-found" && stillClosed === "answered" && rightKey === "cancelled" && r9.body.cancelled === true && r9b.status === 200 && r9b.body.cancelled !== true,
          { 줄선곳: queuedOn, 표시탭취소: wrongKey, 그사이판정: stillClosed, 답큐취소: rightKey, 첫응답: r9.body, 재전송: r9b },
        ));
      } finally {
        server.close();
      }
    }
    // ── ⑥ 텔레그램 같은 버튼 ─────────────────────────────────────────────────
    {
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const { withPromptOptionsObservation } = await import("../../core/prompt-options-observe.js");
      const { translate } = await import("../../core/i18n.js");
      const OWNER = 333;
      const mod = await loadTelegram("reopen-same-button");
      const { channel, bot, calls } = fakeChannel(mod);
      const seen: Msg[] = [];
      await startWithOwners(channel, String(OWNER), async (m) => { seen.push(m as unknown as Msg); });
      try {
        await bot.handleUpdate(textUpdate(OWNER, "질문 턴") as never);
        await settle();
        const turn = seen[0];
        let pid = "";
        const present = withPromptOptionsObservation(turn?.presentOptions as never, { channel: "telegram", threadKey: turn?.threadKey ?? "", bus: { publish: (e: { payload: { promptId: string } }) => { pid = e.payload.promptId; } } as never });
        await present?.("어느 쪽?", [{ label: "A", value: "회귀-재개방A" }]);
        const kb = ([...calls].reverse().find((c) => c.method === "sendMessage" && c.payload.reply_markup !== undefined)?.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
        const button = kb[0]?.[0]?.callback_data ?? "";
        const dashFirst = claims.claimPromptAnswer(pid); // 대시보드 답이 먼저 예약
        const n0 = seen.length;
        const c0 = calls.length;
        await bot.handleUpdate(callbackUpdate(OWNER, button) as never);
        await settle();
        const told = calls.slice(c0).some((c) => c.method === "sendMessage" && c.payload.text === translate("srv.options.alreadyAnswered"));
        const handledWhileClosed = seen.length - n0;
        const reopened = reopen(pid); // 대시보드 답이 시작 전에 취소됨
        await bot.handleUpdate(callbackUpdate(OWNER, button) as never);
        await settle();
        const answered = seen.slice(n0).find((m) => m.text === "회귀-재개방A");
        const third = claims.claimPromptAnswer(pid);
        out.push(assert(
          "★⑥ 텔레그램 — 예약된 질문의 클릭은 «이미 답함» 만(핸들러 0) · 보기 id 는 남아 재개방 뒤 **같은 버튼**이 그 값으로 처리 · 그 뒤 질문은 다시 닫힘",
          button !== "" && dashFirst === "ok" && told && handledWhileClosed === 0 && reopened === true && answered !== undefined && third === "answered",
          { 버튼: button !== "", 대시보드선점: dashFirst, 안내: told, 닫힘중처리: handledWhileClosed, 재개방: reopened, 재클릭처리: answered?.text ?? null, 이후판정: third },
        ));
      } finally {
        await (channel as unknown as { stop?: () => Promise<void> }).stop?.();
      }
    }
    // ── ⑧ 배선 ───────────────────────────────────────────────────────────────
    {
      const idx = await readFile(path.join(HERE, "../../index.ts"), "utf8");
      const qh = /const queueHandler: MessageHandler = \(msg\) => \{[\s\S]*?\n\};\n/.exec(idx)?.[0] ?? "";
      const enq = qh.slice(qh.lastIndexOf("return enqueueThreadTurn("));
      const wired = /id: msg\.correlationId,/.test(enq) &&
        /msg\.promptAnswerId !== undefined \? \{ onCancel: \(\) => \{ reopenPromptAnswer\(msg\.promptAnswerId!?\); \} \}/.test(enq);
      out.push(assert("⑧ 배선 — 메인 큐가 그 메시지의 상관 id 와 함께 promptAnswerId 재개방을 onCancel 로 넘긴다", wired, enq === "" ? "queueHandler 를 못 찾음" : "배선"));
    }
    // ── ⑩ 504 시한 뒤에도 취소가 다시 연다 ─────────────────────────────────────
    {
      const r = spawnSync(process.execPath, ["--import", "tsx", path.join(HERE, "_prompt-reopen-timeout-child.ts")], {
        encoding: "utf8", timeout: 60_000, env: { ...process.env, HTTP_BRIDGE_HANDLER_TIMEOUT_MS: "300" },
      });
      let got: Record<string, unknown> = {};
      try { got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Record<string, unknown>; } catch { got = { raw: (r.stdout ?? "").slice(-200), err: (r.stderr ?? "").slice(-200) }; }
      out.push(assert(
        "★⑩ 504(accepted·running)로 POST 가 끝난 뒤의 큐 취소도 질문을 다시 연다(되살림 수명 = 큐 항목) · 그 답은 실행되지 않는다",
        got.status === 504 && got.accepted === true && got.running === true && got.cancel === "cancelled" && got.reclaim === "ok" && got.ran === 0,
        got,
      ));
    }
    claims.__resetPromptClaimsForTest();
    return out;
  },
};

export default check;
