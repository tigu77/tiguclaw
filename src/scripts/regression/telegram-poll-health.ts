/**
 * 회귀: **텔레그램 수신이 늦거나 폴링이 실패하면 로그로 가를 수 있다** (2026-11-17 개발돌쇠 무응답 신고).
 *
 * 사고: 사용자가 한참 답이 없다고 겪었는데, 채널 표시는 `up` 이고 데몬 로그엔 아무것도 없었다. grammY 는 일시적 폴링 오류를
 *  내부에서 재시도하며 debug 출력으로만 남기고(`handlePollingError`), 기록에는 처리 시각만 있어 «발신→도착→전달» 을 가를 수 없었다.
 *  ★이 검사는 원인을 정하지 않는다 — 다음에 같은 일이 나면 기록으로 가를 수 있는지만 잰다.
 *
 * 재는 것:
 *  ① 상태기(가짜 시계) — 정상 폴링은 침묵(첫 응답 한 줄뿐) · 실패는 시작 한 줄 + 복구 한 줄(횟수) · 정상 대기를 넘긴 응답·매달림만 «느림»
 *  ② 진짜 `TelegramChannel` + 진짜 grammY 폴링 루프(가짜 전송, 네트워크 0) — 502 한 번 → 실패·복구 한 줄씩,
 *     오래전 발신 메시지 → «늦은 전달» 한 줄(발신→도착·도착→전달 분리 — 같은 응답의 앞 첨부 다운로드 대기는 도착 뒤로), 새 메시지는 침묵,
 *     종료 중 끊긴 요청·마지막 오프셋 호출 실패는 폴링 실패로 안 적음, 로그에 내용·id 없음, 메시지는 그대로 전달
 *
 * 등급: **동작**.
 */
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { fakeChannel, loadTelegram, settle, startWithOwners } from "./_fake-telegram.js";

type PollHealthMod = {
  createPollHealth: (log: (l: string) => void, now: () => number) => {
    begin(t: number | undefined): number;
    ok(s: number, t: number | undefined): void;
    fail(s: number, k: string): void;
    stalled(): string | null;
    lastReceivedAt(): number | null;
  };
};

export const check: RegressionCheck = {
  name: "telegram-poll-health",
  guards:
    "텔레그램 폴링이 실패·지연하거나 메시지가 늦게 닿아도 데몬 로그엔 아무것도 없어(채널은 up), 무응답 신고의 원인을 기록으로 가를 수 없던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ── ① 상태기 ─────────────────────────────────────────────────────
    const { createPollHealth } = await loadPluginModule<PollHealthMod>("../../../plugins/telegram-channel/poll-health.ts");
    let clock = 1_000_000;
    const lines: string[] = [];
    const h = createPollHealth((l) => lines.push(l), () => clock);
    const poll = (ms: number, timeout: number | undefined = 30): void => {
      const s = h.begin(timeout);
      clock += ms;
      h.ok(s, timeout);
    };
    const fresh = createPollHealth(() => {}, () => clock);
    const neverOk = fresh.lastReceivedAt();
    // 정상 대기(30초)에 여유(30초) 안쪽 지연이 붙은 응답(59초)도 섞는다 — «느림» 기준이 요청의 대기 시간을 빼먹으면 여기서 드러난다.
    for (let i = 0; i < 20; i++) poll(i % 2 === 0 ? 30_000 : 59_000);
    out.push(assert(
      "업데이트 도착 시각 = 마지막 성공 응답 시각(성공 전엔 null)",
      neverOk === null && h.lastReceivedAt() === clock,
      { neverOk, last: h.lastReceivedAt(), clock },
    ));
    out.push(assert(
      "★정상 long polling(30초 대기 · 여유 안쪽 59초 포함) 20회는 첫 응답 한 줄 말고 침묵",
      lines.length === 1 && lines[0]!.includes("첫 응답"),
      lines,
    ));
    lines.length = 0;
    poll(30_000 + 31_000);
    out.push(assert(
      "정상 대기(30초)+여유를 넘겨 끝난 응답은 «느림» 한 줄",
      lines.length === 1 && lines[0]!.includes("61초") && lines[0]!.includes("느림"),
      lines,
    ));
    lines.length = 0;
    for (let i = 0; i < 3; i++) {
      const s = h.begin(30);
      clock += i === 0 ? 500_000 : 1_000; // 첫 실패는 500초 매달렸다 끝난 것(기본 요청 시한)
      h.fail(s, "HttpError(transport)");
      clock += 3_000;
    }
    const failLines = [...lines];
    poll(1_000);
    out.push(assert(
      "★연속 실패는 시작 한 줄(원인·요청 소요·마지막 성공) — 반복마다 쓰지 않는다",
      failLines.length === 1 && failLines[0]!.includes("polling 실패 — HttpError(transport)") && failLines[0]!.includes("요청 500초 만에") && failLines[0]!.includes("마지막 성공") &&
        !failLines[0]!.includes("재시도"), // 401·409 는 라이브러리가 재시도하지 않는다 — 재시도를 단언하지 않는다
      failLines,
    ));
    out.push(assert(
      "★복구는 한 줄 — 실패 횟수·기간·첫 원인",
      lines.length === 2 && lines[1]!.includes("polling 복구 — 실패 3회") && lines[1]!.includes("HttpError(transport)"),
      lines.slice(1),
    ));
    lines.length = 0;
    const s2 = h.begin(30);
    clock += 30_000;
    const normalWait = h.stalled();
    clock += 31_000;
    const hung = h.stalled();
    h.ok(s2, 30);
    out.push(assert(
      "매달린 요청 — 정상 대기 안이면 null, 넘기면 설명(종료 때 쓰는 값)",
      normalWait === null && hung !== null && hung.includes("61초째"),
      { normalWait, hung },
    ));
    // 라이브러리가 재시도하지 않는 401·409 도 실패 줄은 «재시도한다» 를 말하지 않는다(원인 요약을 그대로 싣는다).
    const noRetryLines: string[] = [];
    for (const kind of ["API 401 Unauthorized", "API 409 Conflict: terminated by other getUpdates request"]) {
      const hk = createPollHealth((l) => noRetryLines.push(l), () => clock);
      const sk = hk.begin(30);
      clock += 1_000;
      hk.fail(sk, kind);
    }
    out.push(assert(
      "401·409 실패 줄 — 원인은 싣고 «재시도» 는 단언하지 않는다",
      noRetryLines.length === 2 && noRetryLines[0]!.includes("API 401") && noRetryLines[1]!.includes("API 409") && noRetryLines.every((l) => !l.includes("재시도")),
      noRetryLines,
    ));

    // ── ①-b 묶음 안의 짝 — 가장 먼저 보낸 메시지 한 건의 발신·도착을 함께 쓴다 ──────────
    {
      type Batcher = { add: (c: string, k: string, p: { msg: Promise<unknown>; replyTo: undefined; stopTyping: () => void; arrivedAt?: number }) => void; flushAll: (ms: number) => Promise<void> };
      const { createInboundBatcher } = await loadPluginModule<{ createInboundBatcher: (fire: (m: unknown) => Promise<void>) => Batcher }>(
        "../../../plugins/telegram-channel/inbound-batch.ts",
      );
      const saved = process.env.TELEGRAM_BATCH_QUIET_MS;
      process.env.TELEGRAM_BATCH_QUIET_MS = "50";
      const batchLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        if (line.includes("늦은 전달")) batchLines.push(line);
        else origLog(...args);
      };
      try {
        const b = createInboundBatcher(async () => {});
        const T = Date.now();
        const msg = (sentAgoMs: number) => Promise.resolve({ text: "x", receivedAt: T - sentAgoMs });
        // 늦게 보냈지만 먼저 도착한 Y(발신 10초 전·도착 9초 전)와, 먼저 보냈지만 나중에 도착한 X(발신 120초 전·도착 5초 전).
        b.add("c", "k", { msg: msg(10_000), replyTo: undefined, stopTyping: () => {}, arrivedAt: T - 9_000 });
        b.add("c", "k", { msg: msg(120_000), replyTo: undefined, stopTyping: () => {}, arrivedAt: T - 5_000 });
        await settle(150);
        await b.flushAll(500);
      } finally {
        console.log = origLog;
        process.env.TELEGRAM_BATCH_QUIET_MS = saved;
      }
      out.push(assert(
        "★묶음의 지연은 가장 먼저 보낸 메시지(X) 한 건의 짝으로 — 발신→도착 115초·도착→전달 5초(다른 메시지 값과 섞지 않는다)",
        batchLines.length === 1 && batchLines[0]!.includes("메시지 2건, 발신→도착 115초 · 도착→전달 5초"),
        batchLines,
      ));
    }

    // ── ② 진짜 채널 + 진짜 폴링 루프 ──────────────────────────────────
    const mod = await loadTelegram();
    let n = 0;
    const OLD_SEC = 120;
    const fromId = 111;
    // 발신 시각은 **응답하는 순간** 정한다(텔레그램이 «지금 막 건네는» 업데이트) — 미리 정하면 재시도 대기가 지연에 섞인다.
    const base = (id: number, ageSec: number) => ({
      message_id: id,
      date: Math.floor(Date.now() / 1000) - ageSec,
      chat: { id: fromId, type: "private", first_name: "u" },
      from: { id: fromId, is_bot: false, first_name: "u" },
    });
    const textUpd = (id: number, ageSec: number, text: string) => ({ update_id: id, message: { ...base(id, ageSec), text } });
    // 작은 문서 — getFile 이 1.6초 걸리고 경로 없이 답한다(내려받기 네트워크 0, «경로 없음» 안내로 끝난다).
    const docUpd = (id: number, ageSec: number) => ({
      update_id: id,
      message: { ...base(id, ageSec), caption: `DOC-SECRET-${id}`, document: { file_id: "f", file_unique_id: "fu", file_name: "a.txt", mime_type: "text/plain", file_size: 1000 } },
    });
    const hold: { reject: ((e: Error) => void) | null; want: boolean; stopCalls: number } = { reject: null, want: false, stopCalls: 0 };
    const { channel, calls } = fakeChannel(mod, (method, payload) => {
      if (method === "getFile") return new Promise((r) => setTimeout(() => r({ ok: true, result: { file_id: "f", file_unique_id: "fu" } }), 1_600));
      if (method !== "getUpdates") return undefined;
      // bot.stop() 의 마지막 오프셋 확정 호출(limit 1·대기 없음) — 매달린 요청을 그제야 끊고, 이 호출도 실패시킨다(종료 중 두 실패 경로).
      if (payload.limit === 1 && payload.timeout === undefined) {
        hold.stopCalls += 1;
        hold.reject?.(new Error("aborted by stop"));
        hold.reject = null;
        return { ok: false, error_code: 500, description: "Internal Server Error" };
      }
      if (hold.want) {
        hold.want = false;
        return new Promise((_, rej) => {
          hold.reject = rej;
        });
      }
      n += 1;
      if (n === 2) return { ok: false, error_code: 502, description: "Bad Gateway" };
      // 같은 응답에 첨부 A 와 글 B — grammY 는 A 를 처리(다운로드)한 뒤에야 B 를 넘긴다. B 의 도착은 이 응답 시각이어야 한다.
      if (n === 3) return { ok: true, result: [docUpd(900_001, OLD_SEC), textUpd(900_002, OLD_SEC, "OLD-SECRET-TEXT")] };
      if (n === 45) return { ok: true, result: [textUpd(900_003, 0, "FRESH-TEXT")] }; // 앞 묶음들이 다 나간 뒤 — 따로 전달
      // 첨부 뒤 첨부 — D 는 C 의 다운로드를 기다린 뒤 넘겨진다(첨부 경로의 도착 시각).
      if (n === 80) return { ok: true, result: [docUpd(900_004, OLD_SEC), docUpd(900_005, OLD_SEC)] }; // 새 글과 묶음 창(0.6초)이 겹치지 않게
      return undefined; // 기본 — 30ms 뒤 빈 응답
    });
    // 묶음 창을 켠다(fakeChannel 이 0 으로 끈다) — 묶인 경로를 탄다. 0.6초(검사 시간을 아끼되 다운로드 1.6초보다 짧게 — 앞뒤 메시지가 따로 묶인다).
    process.env.TELEGRAM_BATCH_QUIET_MS = "600";
    const got: string[] = [];
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("telegram:")) logged.push(line);
      origLog(...args);
    };
    let hungBeforeStop = false;
    let afterStop: string[] = [];
    // grammY 는 폴링 실패 뒤 3초 쉬고 다시 부른다(`handlePollingError` → 모듈 내부 `sleep`). 그 3초는 재는 값이 아니라(단언 0) 검사 시간만
    //  먹으므로, 이 구간에서 **grammY 가 건 그 대기 하나만** 0으로 접는다 — 실패→재시도→복구 분기는 그대로 탄다(가짜 시계).
    //  다운로드 1.6초·묶음 창·폴링 간격은 접지 않는다: 로그가 초 단위라 «도착→전달» 을 가르려면 실제 경과가 필요하다.
    // 종료 직전에만 시계를 10분 당긴다 — 매달린 요청이 정상 대기를 넘긴 상태에서 «종료 시» 한 줄을 잰다(그 전 측정은 오프셋 0).
    //  채널 시작 전에 바꿔야 관측기가 이 시계를 쓴다(`createPollHealth` 의 기본 시계는 생성 때 `Date.now` 를 잡는다).
    const realNow = Date.now;
    let nowOffset = 0;
    Date.now = () => realNow.call(Date) + nowOffset;
    const realSetTimeout = globalThis.setTimeout;
    let foldedRetryWaits = 0;
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 3_000 && /[\\/]grammy[\\/]/.test(new Error().stack ?? "")) {
        foldedRetryWaits += 1;
        return realSetTimeout(fn, 0, ...rest);
      }
      return realSetTimeout(fn, ms, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      await startWithOwners(channel, String(fromId), async (m) => {
        got.push(m.text);
      });
      for (let i = 0; i < 300 && (got.length < 5 || calls.filter((c) => c.method === "getUpdates").length < 20); i++) await settle(50);
      // 종료 중: 진행 중이던 getUpdates 가 끊겨 거절되고, 마지막 오프셋 호출도 실패한다 — 둘 다 «폴링 실패» 가 아니다.
      hold.want = true;
      for (let i = 0; i < 40 && hold.reject === null; i++) await settle(50);
      hungBeforeStop = hold.reject !== null;
      const mark = logged.length;
      nowOffset = 600_000;
      await channel.stop().catch(() => {}); // 마지막 오프셋 호출 실패는 기존대로 stop 거절로 올라온다
      await settle(100);
      afterStop = logged.slice(mark);
    } finally {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      console.log = origLog;
      process.env.TELEGRAM_BATCH_QUIET_MS = "0";
      await channel.stop().catch(() => {});
    }
    const polls = calls.filter((c) => c.method === "getUpdates").length;
    const pick = (re: RegExp) => logged.filter((l) => re.test(l));
    const late = pick(/늦은 전달/);
    out.push(assert(
      "검사 전제 — 폴링이 계속 돌았고 다섯 메시지(첨부·글·새 글·첨부 둘)가 따로 핸들러에 닿았다",
      polls >= 20 && got.length === 5 && got.filter((t) => t.includes("DOC-SECRET")).length === 3 && got.includes("OLD-SECRET-TEXT") && got.includes("FRESH-TEXT"),
      { polls, got: got.map((t) => t.slice(0, 30)), foldedRetryWaits },
    ));
    out.push(assert(
      "★진짜 폴링 루프 — 502 한 번에 실패 한 줄·복구 한 줄, 정상 폴링 수십 번에도 다른 폴링 줄은 첫 응답 하나뿐",
      pick(/polling 실패 — API 502/).length === 1 &&
        pick(/polling 복구 — 실패 1회/).length === 1 &&
        pick(/polling 첫 응답/).length === 1 &&
        pick(/polling|getUpdates/).filter((l) => !l.startsWith("telegram: 종료 시")).length === 3, // 종료 줄은 아래에서 따로 잰다
      { polls, 폴링줄: pick(/polling|getUpdates/) },
    ));
    out.push(assert(
      "★오래전 발신 메시지는 묶음마다 «늦은 전달» 한 줄 — 발신→도착은 폴링 응답 시각까지(약 120초, 글·첨부 경로 모두), 새 메시지는 침묵",
      late.length === 4 && late.every((l) => /메시지 1건, 발신→도착 1(19|2[01])초/.test(l)),
      late,
    ));
    out.push(assert(
      "★같은 응답의 앞 첨부 다운로드(1.6초)를 기다린 글·첨부는 그 시간이 «도착→전달» 에 들어간다(발신→도착에 섞이지 않는다)",
      late.length === 4 && /도착→전달 [23]초/.test(late[1]!) && /도착→전달 [34]초/.test(late[3]!),
      late,
    ));
    out.push(assert(
      "★종료 중 끊긴 요청·마지막 오프셋 호출 실패는 «폴링 실패/복구» 로 적지 않는다",
      hungBeforeStop && hold.stopCalls === 1 && afterStop.every((l) => !/polling (실패|복구)/.test(l)),
      { hungBeforeStop, stopCalls: hold.stopCalls, afterStop },
    ));
    out.push(assert(
      "★종료 때 정상 대기를 넘겨 매달린 요청은 «종료 시 getUpdates 응답 대기 N초째» 한 줄",
      afterStop.filter((l) => /^telegram: 종료 시 getUpdates 응답 대기 \d+초째/.test(l)).length === 1,
      afterStop,
    ));
    out.push(assert(
      "로그에 메시지 내용·사용자/채팅 id 가 없다",
      logged.every((l) => !l.includes("SECRET") && !l.includes("FRESH-TEXT") && !l.includes(String(fromId))),
      logged.filter((l) => l.includes("SECRET") || l.includes(String(fromId))),
    ));
    return out;
  },
};
