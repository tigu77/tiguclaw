/**
 * 회귀: **텔레그램으로 나가는 모든 통이 1~4096자이고, 긴 한 줄·코드 블록 빈 조각·평문 폴백 URL 펼침에서 내용이 빠지거나 겹치지 않는다**
 * (2026-11-23 C2, 결정 `docs/decisions/2026-11-18-stability-c1-c3-review.md` §2·§8).
 *
 * 사고(격리 재현 11-18): 분할기(`splitHtmlForTelegram`)는 줄 단위로만 자른다 — 줄바꿈 없는 4096 초과 줄은 한 조각 그대로,
 *  코드 블록의 긴 줄 앞뒤엔 빈 `<pre><code></code></pre>` 조각. 평문 폴백은 링크 URL 을 펼쳐 4096 을 넘겼다. 서버가 모두
 *  거절해 일반 답은 그 조각부터 끝까지 유실(로그만), 능동 발신은 앞 조각만 가고 실패, 카드는 빈 조각에서 실패했다.
 *
 * 재는 것(실제 `replyAndRecord`→`sendFormatted`·`resendInBackground` · `renderOptions` · `sendOutgoing`, 가짜 서버 = «HTML 모드는
 *  태그 제거·이스케이프 복원한 표시 / 평문은 그대로, 공백뿐 또는 4096 초과면 400»(Bot API 규칙을 가정 — 실서버 미검증)):
 *  ① 대화형 — 긴 한 줄·앞+긴 줄+뒤·코드 블록 첫 줄 4,080·코드 한 줄 5,000·빈 라벨 링크·이모지(홀수 경계)·`&` 가득·`<b>x</b>` 글
 *     → 서버 거절 0 · 모든 통 표시 1~4096 · 깨진 서로게이트 0 · 비공백 내용이 원문과 같다(빠짐·겹침 0) · 모든 통 답글 매핑 ·
 *     첫 통에만 답글 표시 · 세션 라벨 1회 · 정상 범위 답은 분할기 출력과 바이트 동일
 *  ② 평문 폴백 초과(링크 든 긴 한 줄 + HTML 실패) → 여러 평문 통 · URL 보존
 *  ③ 부분 실패 — 평문 둘째 토막 실패 → 재전송은 둘째 토막부터 · 뒤 조각·다음 답 순서 · 늦은 id 매핑 / 재개 토막 자체 실패 ·
 *     재개 뒤 셋째 토막 실패 → 로그·`plugin.error` 의 토막 위치
 *  ④ 능동 발신 — 앞+긴 줄+뒤 도착 / 평문 둘째 토막 실패 → 원래 `GrammyError` · 유실 로그 위치
 *  ⑤ 카드 — 빈 조각 제거 · 설명 평문 초과 · 버튼 조각 자체가 나뉠 때 버튼은 마지막 한 통 · 간 그때 매핑 · 부분 실패 N ·
 *     표시 4096 초과 줄은 기존대로 보내기 전 실패
 *
 * 등급: **동작**(네트워크 0).
 */
import { GrammyError } from "grammy";
import { telegramFormat, splitHtmlForTelegram } from "telegram-markdown-formatter";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { fakeChannel, loadTelegram, settle } from "./_fake-telegram.js";

const MAX = 4096;
type Extra = { parse_mode?: string; reply_markup?: unknown; reply_parameters?: { message_id: number } };
type Sent = { text: string; extra: Extra; shown: string; id: number | null };
type Send = (text: string, extra: Extra) => Promise<unknown>;

const bad = (d: string): GrammyError =>
  new GrammyError(`Call to 'sendMessage' failed! (400: ${d})`, { ok: false, error_code: 400, description: d }, "sendMessage", {});
const shownOf = (text: string, extra: Extra): string =>
  extra.parse_mode === "HTML"
    ? text.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&")
    : text;
const nows = (s: string): string => s.replace(/\s/g, "");
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface ServerOpts {
  /** HTML 모드 실패(파싱 400 흉내) — 이 글이면. */
  htmlFails?: (text: string) => boolean;
  /** 평문 모드 k번째 호출(0부터) 강제 실패. */
  failPlain?: (k: number, text: string) => boolean;
  /** 보내기 직전 붙잡기(성공 통의 순번 n). */
  gate?: (n: number) => Promise<void>;
  /** 응답에 message_id 를 빼는 통(성공 통의 순번 n). */
  noId?: (n: number) => boolean;
}

/** 가짜 서버 — 길이·공백 규칙 거절은 `rejects` 에(강제 실패와 따로 센다). */
const server = (o: ServerOpts = {}) => {
  const sent: Sent[] = [];
  const rejects: string[] = [];
  /** HTML 모드로 시도된 글 전부(성공·실패 무관). */
  const htmlAttempts: string[] = [];
  let plainCalls = 0;
  let mid = 500;
  const send: Send = async (text, extra) => {
    const html = extra.parse_mode === "HTML";
    if (html) htmlAttempts.push(text);
    if (html && o.htmlFails?.(text) === true) throw bad("can't parse entities (forced)");
    if (!html) {
      const k = plainCalls++;
      if (o.failPlain?.(k, text) === true) throw bad("forced plain failure");
    }
    const shown = shownOf(text, extra);
    if (shown.trim() === "") {
      rejects.push(`empty(${html ? "html" : "plain"})`);
      throw bad("message text is empty");
    }
    if (shown.length > MAX) {
      rejects.push(`too long ${shown.length}(${html ? "html" : "plain"})`);
      throw bad("message is too long");
    }
    const n = sent.length;
    if (o.gate !== undefined) await o.gate(n);
    const id = o.noId?.(n) === true ? null : ++mid;
    sent.push({ text, extra, shown, id });
    return id === null ? { chat: { id: 77 } } : { message_id: id, chat: { id: 77 } };
  };
  return { send, sent, rejects, htmlAttempts };
};

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  for (let t = 0; t < ms && !cond(); t += 20) await settle(20);
};

/** 링크 든 긴 한 줄 — 표시는 상한 안(≈2.8천), URL 을 펼친 평문은 넘는다(≈5.4천). */
const bandLine = Array.from({ length: 40 }, (_, i) => `문장${i} ${"가".repeat(60)} [링크${i}](https://example.com/${"p".repeat(40)}/${i})`).join(" ");
const bandPlain = Array.from({ length: 40 }, (_, i) => `문장${i} ${"가".repeat(60)} 링크${i} (https://example.com/${"p".repeat(40)}/${i})`).join(" ");
/** 평문이 세 토막으로 나뉘는 링크 줄(표시 ≈ 0.3천, 평문 ≈ 1.1만). */
const band3Line = Array.from({ length: 50 }, (_, i) => `[l${i}](https://example.org/${"q".repeat(200)}/${i})`).join(" ");
const band3Urls = Array.from({ length: 50 }, (_, i) => `https://example.org/${"q".repeat(200)}/${i}`);
const isBand = (t: string): boolean => t.includes("example.com/") || t.includes("example.org/");

interface TgMod {
  replyAndRecord: (send: Send, sessionId: string, chatId: string, out: string, opts?: { repliedSession?: string | null; replyToMessageId?: number }) => Promise<{ messageIds: number[] }>;
  renderOptions: (send: Send, q: string, o: { label: string; value: string }[], opts?: { note?: string; chatId?: string; originThreadKey?: string }) => Promise<{ ok: boolean; error?: string; channelRefs?: { messageIds: number[] }[] }>;
  sendOutgoing: (chatId: string | number, text: string) => Promise<number[]>;
}

export const check: RegressionCheck = {
  name: "telegram-chunks-fit-limits",
  guards:
    "텔레그램 일반 답·능동 발신·카드가 줄바꿈 없는 4096 초과 줄·코드 블록 빈 조각·링크 URL 을 펼친 평문 폴백 초과를 서버에 보내 그 조각부터 답이 유실되던 것(C2)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { findSessionForOutboundMessage } = await import("../../store/outbound-messages.js");
    const { outboundSessionLabel } = await import("../../core/outbound.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const mod = (await loadTelegram()) as unknown as TgMod & Parameters<typeof fakeChannel>[0];
    const mapped = (chat: string, ids: readonly (number | null)[], sid: string): boolean =>
      ids.length > 0 && ids.every((id) => id !== null && findSessionForOutboundMessage("telegram", chat, id) === sid);

    const logs: string[] = [];
    const errors: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    const origLog = console.log;
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    const unsub = getEventBus().subscribe((ev) => {
      if (ev.type !== "plugin.error") return;
      const p = ev.payload as { pluginName?: string; error?: string };
      if (p.pluginName === "telegram-channel") errors.push(String(p.error));
    });
    let stopChannel: (() => Promise<void>) | null = null;
    try {
      // ── ① 대화형 — 길이·공백 규칙 ─────────────────────────────────────────
      const cases: Array<{ name: string; md: string; expect: string }> = [
        { name: "한 줄 9,000", md: "a".repeat(9000), expect: "a".repeat(9000) },
        { name: "앞+한 줄 5,000+뒤", md: `${"intro ".repeat(10)}\n\n${"b".repeat(5000)}\n\n${"tail ".repeat(10)}`, expect: `${"intro".repeat(10)}${"b".repeat(5000)}${"tail".repeat(10)}` },
        { name: "코드 블록 첫 줄 4,080", md: "```\n" + "d".repeat(4080) + "\n" + "e".repeat(100) + "\n```", expect: "d".repeat(4080) + "e".repeat(100) },
        { name: "코드 한 줄 5,000", md: "```\n" + "d".repeat(5000) + "\n```", expect: "d".repeat(5000) },
        { name: "빈 라벨 링크 단독", md: "[](https://example.net/empty-label)", expect: "(https://example.net/empty-label)" },
        { name: "이모지 2,500", md: "😀".repeat(2500), expect: "😀".repeat(2500) },
        { name: "이모지 홀수 경계", md: "a" + "😀".repeat(2500), expect: "a" + "😀".repeat(2500) },
        { name: "& 가득 한 줄", md: "&".repeat(5000), expect: "&".repeat(5000) },
        { name: "<b>x</b> 를 글로 담은 긴 줄", md: "<b>x</b> ".repeat(560), expect: "<b>x</b>".repeat(560) },
      ];
      const caseResults: Record<string, unknown> = {};
      let allOk = true;
      for (const [ci, c] of cases.entries()) {
        const s = server();
        const chat = `c2-case-${ci}`;
        const sid = `dashboard:regr-c2-${ci}`;
        const r = await mod.replyAndRecord(s.send, sid, chat, c.md, { replyToMessageId: 9 });
        await waitFor(() => s.sent.length > 0 && logs.length >= 0, 200);
        const joined = s.sent.map((x) => x.shown).join("");
        const ok =
          s.rejects.length === 0 && s.sent.length > 0 &&
          s.sent.every((x) => x.shown.trim() !== "" && x.shown.length <= MAX && !lone.test(x.shown)) &&
          nows(joined) === nows(c.expect) &&
          r.messageIds.length === s.sent.length && mapped(chat, s.sent.map((x) => x.id), sid) &&
          s.sent[0]!.extra.reply_parameters?.message_id === 9 && s.sent.slice(1).every((x) => x.extra.reply_parameters === undefined);
        if (!ok) allOk = false;
        caseResults[c.name] = { ok, rejects: s.rejects, sends: s.sent.map((x) => x.shown.length), returned: r.messageIds.length, contentEq: nows(joined) === nows(c.expect) };
      }
      out.push(assert(
        "★① 대화형 — 긴 한 줄·앞+긴 줄+뒤·코드 블록 빈 조각·코드 한 줄·빈 라벨 링크·이모지(홀수 경계)·& 가득·<b> 글: 서버 거절 0 · 모든 통 1~4096 · 깨진 서로게이트 0 · 비공백 내용 원문과 같음(빠짐·겹침 0) · 모든 통 즉시 반환·답글 매핑 · 첫 통에만 답글 표시",
        allOk,
        caseResults,
      ));

      // <b>x</b> 글 — 보낸 HTML 이 이스케이프 토막 그대로(태그로 해석될 글이 서버에 안 간다).
      {
        const s = server();
        await mod.replyAndRecord(s.send, "dashboard:regr-c2-esc", "c2-esc", "<b>x</b> ".repeat(560));
        out.push(assert(
          "★①' 표시 상한을 넘어 평문으로 나눈 조각은 이스케이프해 보낸다 — 보낸 HTML 에 진짜 태그 0 · 표시 = 원래 글",
          s.sent.length >= 2 && s.sent.every((x) => x.extra.parse_mode === "HTML" && !/<b>/.test(x.text) && x.text.includes("&lt;b&gt;x&lt;/b&gt;")) &&
            nows(s.sent.map((x) => x.shown).join("")) === "<b>x</b>".repeat(560),
          s.sent.map((x) => ({ len: x.text.length, head: x.text.slice(0, 30) })),
        ));
      }

      // 세션 라벨 1회 · 정상 범위 답은 분할기 출력과 바이트 동일.
      {
        const label = outboundSessionLabel("dashboard:regr-c2-labelled");
        const s = server();
        await mod.replyAndRecord(s.send, "dashboard:regr-c2-labelled", "c2-label", "a".repeat(9000), { repliedSession: "dashboard:regr-c2-labelled" });
        const joined = s.sent.map((x) => x.shown).join("");
        const normal = Array.from({ length: 300 }, (_, i) => `- 항목 ${i} **굵게** [l](https://e.com/${i})`).join("\n");
        const s2 = server();
        await mod.replyAndRecord(s2.send, "dashboard:regr-c2-normal", "c2-normal", normal);
        const expected = splitHtmlForTelegram(telegramFormat(normal));
        out.push(assert(
          "★①'' 세션 라벨은 첫 통 앞에 한 번 · 정상 범위 긴 답(여러 줄·링크)은 분할기 출력과 바이트 동일(서식 회귀 0)",
          label !== "" && joined.startsWith(label.trim()) && joined.split(label.trim()).length - 1 === 1 &&
            s2.rejects.length === 0 && JSON.stringify(s2.sent.map((x) => x.text)) === JSON.stringify(expected) &&
            s2.sent.every((x) => x.extra.parse_mode === "HTML"),
          { label, first: joined.slice(0, 40), normalSends: s2.sent.length, expected: expected.length },
        ));
      }

      // ── ② 평문 폴백 초과 ──────────────────────────────────────────────────
      {
        const s = server({ htmlFails: isBand });
        const md = `앞 문단\n\n${bandLine}\n\n뒤 문단`;
        const r = await mod.replyAndRecord(s.send, "dashboard:regr-c2-band", "c2-band", md);
        const plains = s.sent.filter((x) => x.extra.parse_mode === undefined);
        const joinedPlain = plains.map((x) => x.text).join(" ");
        out.push(assert(
          "★② HTML 이 실패한 링크 든 긴 한 줄 — 평문 폴백을 여러 통(각 ≤4096)으로 · URL 전부 보존 · 앞·뒤 문단 순서 · 모든 통 매핑",
          s.rejects.length === 0 && plains.length >= 2 && plains.every((x) => x.text.length <= MAX) &&
            nows(joinedPlain) === nows(bandPlain) &&
            s.sent[0]!.shown.includes("앞 문단") && s.sent[s.sent.length - 1]!.shown.includes("뒤 문단") &&
            r.messageIds.length === s.sent.length && mapped("c2-band", s.sent.map((x) => x.id), "dashboard:regr-c2-band"),
          { rejects: s.rejects, sends: s.sent.map((x) => [x.extra.parse_mode ?? "plain", x.shown.length]) },
        ));
      }

      // ── ③ 부분 실패 — 재개 위치·순서·매핑·기록 ─────────────────────────────
      {
        // 평문 둘째 토막(평문 호출 #1) 실패 → 뒤 재전송이 둘째 토막부터. 같은 대화 다음 답은 그 뒤.
        //  그 조각의 HTML 은 **첫 시도만** 실패 — 재개 때 HTML 을 다시 시도하면 성공해 첫 토막 내용이 겹치므로 그 변이가 드러난다.
        let bandHtml = 0;
        const s = server({ htmlFails: (t) => isBand(t) && bandHtml++ === 0, failPlain: (k) => k === 1 });
        const sid = "dashboard:regr-c2-partial";
        const md = `앞 문단\n\n${bandLine}\n\n뒤 문단`;
        const r1 = await mod.replyAndRecord(s.send, sid, "c2-partial", md);
        const r2 = await mod.replyAndRecord(s.send, sid, "c2-partial", "다음 답");
        await waitFor(() => s.sent.some((x) => x.shown === "다음 답"));
        const shown = s.sent.map((x) => x.shown);
        const plains = s.sent.filter((x) => x.extra.parse_mode === undefined);
        out.push(assert(
          "★③ 평문 둘째 토막 실패 — 첫 토막 id 는 즉시 반환 · 재전송은 둘째 토막부터 평문으로(첫 토막 재전송 0 · 그 조각 HTML 재시도 0) · 뒤 문단까지 순서대로 · 다음 답은 그 뒤 · 늦은 통도 매핑",
          s.rejects.length === 0 && shown.length === 5 && s.htmlAttempts.filter(isBand).length === 1 &&
            shown[0]!.includes("앞 문단") && plains.length === 2 && s.sent[1] === plains[0] && s.sent[2] === plains[1] &&
            nows(plains.map((x) => x.text).join("")) === nows(bandPlain) &&
            shown[3]!.includes("뒤 문단") && shown[4] === "다음 답" &&
            JSON.stringify(r1.messageIds) === JSON.stringify([s.sent[0]!.id, s.sent[1]!.id]) && r2.messageIds.length === 0 &&
            mapped("c2-partial", s.sent.map((x) => x.id), sid),
          { shown: shown.map((x) => x.slice(0, 12)), r1: r1.messageIds, r2: r2.messageIds, ids: s.sent.map((x) => x.id), rejects: s.rejects },
        ));
      }
      {
        // 재개한 첫 토막 자체가 다시 실패 → 위치(토막 2/3 · 앞 1통) · 뒤 조각 미전송.
        logs.length = 0;
        errors.length = 0;
        const s = server({ htmlFails: isBand, failPlain: (k) => k === 1 || k === 2 });
        await mod.replyAndRecord(s.send, "dashboard:regr-c2-p2", "c2-p2", `앞 문단\n\n${band3Line}\n\n뒤 문단`);
        await waitFor(() => errors.length > 0);
        const lost = logs.find((l) => l.includes("★telegram 발송 유실")) ?? "";
        out.push(assert(
          "★③' 재개한 첫 토막이 끝내 실패 — 로그·plugin.error 에 «청크 2/3 · 평문 토막 2/3 부터 · 앞 1통» · 같은 답의 뒤 조각 미전송",
          /청크 2\/3\(\d+자\) · 평문 토막 2\/3 부터 미도달 · 앞 1통 도달/.test(lost) &&
            errors.length === 1 && /chunk 2\/3 \(\d+ chars\) from plain part 2\/3 \(1 sent\)/.test(errors[0]!) &&
            s.sent.length === 2 && !s.sent.some((x) => x.shown.includes("뒤 문단")),
          { lost, errors, sent: s.sent.map((x) => x.shown.slice(0, 12)) },
        ));
      }
      {
        // 재개 뒤 한 토막 더 가고 셋째 토막 실패 → 위치 갱신(토막 3/3 · 앞 2통) · 간 토막만 늦은 매핑.
        logs.length = 0;
        errors.length = 0;
        const s = server({ htmlFails: isBand, failPlain: (k) => k === 1 || k === 3 });
        const sid = "dashboard:regr-c2-p3";
        await mod.replyAndRecord(s.send, sid, "c2-p3", `앞 문단\n\n${band3Line}\n\n뒤 문단`);
        await waitFor(() => errors.length > 0);
        const lost = logs.find((l) => l.includes("★telegram 발송 유실")) ?? "";
        const plains = s.sent.filter((x) => x.extra.parse_mode === undefined);
        out.push(assert(
          "★③'' 재개 뒤 셋째 토막 실패 — 로그·plugin.error 둘 다 «토막 3/3 부터 · 앞 2통» · 간 토막(1·2)만 매핑 · 뒤 조각 미전송",
          /청크 2\/3\(\d+자\) · 평문 토막 3\/3 부터 미도달 · 앞 2통 도달/.test(lost) &&
            errors.length === 1 && /from plain part 3\/3 \(2 sent\)/.test(errors[0]!) &&
            plains.length === 2 && band3Urls.slice(0, 5).every((u) => plains[0]!.text.includes(u)) &&
            mapped("c2-p3", s.sent.map((x) => x.id), sid) && !s.sent.some((x) => x.shown.includes("뒤 문단")),
          { lost, errors, sent: s.sent.map((x) => [x.extra.parse_mode ?? "plain", x.shown.length]) },
        ));
      }

      {
        // 뒤 재전송도 간 그때 매핑 — 재개한 둘째 토막이 간 뒤 셋째 토막 응답을 붙잡은 동안 둘째 토막이 이미 매핑돼 있다.
        let release: () => void = () => {};
        const held = new Promise<void>((r) => (release = r));
        let checked = false;
        let mappedWhileHeld = false;
        const sid = "dashboard:regr-c2-p4";
        const s = server({
          htmlFails: isBand,
          failPlain: (k) => k === 1,
          gate: async (n) => {
            if (n !== 3) return; // 앞(0) · 첫 토막(1) · 재개한 둘째 토막(2) → 셋째 토막(3)
            const id = s.sent[2]?.id ?? null;
            mappedWhileHeld = id !== null && findSessionForOutboundMessage("telegram", "c2-p4", id) === sid;
            checked = true;
            await held;
          },
        });
        await mod.replyAndRecord(s.send, sid, "c2-p4", `앞 문단\n\n${band3Line}\n\n뒤 문단`);
        await waitFor(() => checked);
        release();
        await waitFor(() => s.sent.some((x) => x.shown.includes("뒤 문단")));
        out.push(assert(
          "★③‴ 뒤 재전송도 통이 간 그때 매핑 — 셋째 토막 응답을 붙잡은 동안 재개한 둘째 토막이 이미 발원 세션에 묶여 있다",
          checked && mappedWhileHeld && s.rejects.length === 0 && mapped("c2-p4", s.sent.map((x) => x.id), sid),
          { checked, mappedWhileHeld, n: s.sent.length },
        ));
      }
      {
        // 4096 이하 평문 폴백은 지금과 같은 한 통 — 바이트 그대로(앞뒤 공백·들여쓰기 포함, 나누기 함수의 trim 을 타지 않는다).
        const s = server({ htmlFails: () => true });
        await mod.replyAndRecord(s.send, "dashboard:regr-c2-short", "c2-short", "앞 문단\n\n```\n  들여쓴\n```");
        out.push(assert(
          "★③⁗ 상한 안 평문 폴백은 한 통·바이트 그대로(들여쓰기·끝 줄바꿈 유지)",
          s.sent.length === 1 && s.sent[0]!.extra.parse_mode === undefined && s.sent[0]!.text === "앞 문단\n\n  들여쓴\n",
          s.sent.map((x) => JSON.stringify(x.text)),
        ));
      }

      // ── ④ 능동 발신 ───────────────────────────────────────────────────────
      {
        let mode: ServerOpts = {};
        let s = server(mode);
        const { channel } = fakeChannel(mod, async (method, payload) => {
          if (method !== "sendMessage") return undefined;
          try {
            const r = (await s.send(String(payload.text), payload as Extra)) as { message_id?: number };
            return { ok: true, result: { message_id: r.message_id ?? 0, date: 0, chat: { id: 77, type: "private" } } };
          } catch (e) {
            return { ok: false, error_code: 400, description: (e as GrammyError).description };
          }
        });
        stopChannel = () => channel.stop();
        let ids: number[] = [];
        let firstThrew = "";
        try {
          ids = await mod.sendOutgoing("77", `${"intro ".repeat(10)}\n\n${"b".repeat(5000)}\n\n${"tail ".repeat(10)}`);
        } catch (e) {
          firstThrew = e instanceof Error ? e.message : String(e);
        }
        const okLong = firstThrew === "" && s.rejects.length === 0 && ids.length === s.sent.length && s.sent.length >= 3 &&
          nows(s.sent.map((x) => x.shown).join("")) === `${"intro".repeat(10)}${"b".repeat(5000)}${"tail".repeat(10)}`;
        mode = { htmlFails: isBand, failPlain: (k) => k === 1 };
        s = server(mode);
        logs.length = 0;
        const errorsBefore = errors.length;
        let thrown: unknown = null;
        try {
          await mod.sendOutgoing("77", bandLine);
        } catch (e) {
          thrown = e;
        }
        await settle(50);
        const lost = logs.find((l) => l.includes("★telegram 발송 유실")) ?? "";
        out.push(assert(
          "★④ 능동 발신 — 앞+긴 줄+뒤가 throw 없이 전부 도착 / 평문 둘째 토막 실패면 원래 GrammyError 를 던지고 유실 로그에 «평문 토막 2/2 부터 · 앞 1통» · plugin.error 는 내지 않는다(호출자가 실패를 기록 — 기존 계약)",
          okLong && thrown instanceof GrammyError && /forced plain failure/.test(thrown.description) &&
            /청크 1\/1\(\d+자\) · 평문 토막 2\/2 부터 미도달 · 앞 1통 도달/.test(lost) && s.sent.length === 1 && errors.length === errorsBefore,
          { okLong, firstThrew, thrown: thrown instanceof Error ? thrown.message : String(thrown), lost },
        ));
      }

      // ── ⑤ 카드 ────────────────────────────────────────────────────────────
      const O = [{ label: "예", value: "y" }, { label: "아니오", value: "n" }];
      const buttons = (s: { sent: Sent[] }) => s.sent.filter((x) => x.extra.reply_markup !== undefined);
      {
        // 코드 블록 빈 조각 → 빼고 성공.
        const s = server();
        const r = await mod.renderOptions(s.send, "코드 확인?", O, { note: "```\n" + "d".repeat(4080) + "\n" + "e".repeat(100) + "\n```" });
        // 설명 평문 초과 + HTML 실패 → 설명은 평문 여러 통, 버튼은 마지막(질문) 한 통.
        const s2 = server({ htmlFails: isBand });
        const r2 = await mod.renderOptions(s2.send, "링크 설명 승인?", O, { note: bandLine, chatId: "c2-card2", originThreadKey: "dashboard:regr-c2-card2" });
        const ids2 = r2.channelRefs?.[0]?.messageIds ?? [];
        out.push(assert(
          "★⑤ 카드 — 코드 블록 빈 조각은 빼고 성공 / 설명 평문 초과 + HTML 실패 → 설명 평문 여러 통 · 버튼은 마지막(질문) 한 통 · 모든 통 ≤4096 · 매핑",
          r.ok && s.rejects.length === 0 && buttons(s).length === 1 && buttons(s)[0] === s.sent[s.sent.length - 1] && s.sent[s.sent.length - 1]!.shown === "코드 확인?" &&
            r2.ok && s2.rejects.length === 0 && s2.sent.filter((x) => x.extra.parse_mode === undefined).length >= 2 &&
            buttons(s2).length === 1 && buttons(s2)[0] === s2.sent[s2.sent.length - 1] && s2.sent[s2.sent.length - 1]!.shown === "링크 설명 승인?" &&
            ids2.length === s2.sent.length && mapped("c2-card2", ids2, "dashboard:regr-c2-card2"),
          { r: { ok: r.ok, error: r.error, rejects: s.rejects, n: s.sent.length }, r2: { ok: r2.ok, error: r2.error, rejects: s2.rejects, sends: s2.sent.map((x) => [x.extra.parse_mode ?? "plain", x.shown.length, x.extra.reply_markup !== undefined]) } },
        ));
      }
      {
        // 버튼 조각 자체가 평문 여러 통으로 — 공백 질문(기존 동작: 마지막 설명 조각이 버튼 조각) + 링크 든 긴 마지막 설명.
        const s = server({ htmlFails: isBand });
        const r = await mod.renderOptions(s.send, " ", O, { note: `앞 설명\n\n${bandLine}` });
        const s2 = server({ htmlFails: isBand, failPlain: (k) => k === 1 });
        const r2 = await mod.renderOptions(s2.send, " ", O, { note: `앞 설명\n\n${bandLine}`, chatId: "c2-card3", originThreadKey: "dashboard:regr-c2-card3" });
        out.push(assert(
          "★⑤' 버튼이 달린 조각 자체가 평문 여러 통이 되면 버튼은 마지막 평문 통에만 · 그 마지막 토막이 실패하면 도착한 버튼 0 · ok:false · «앞 2개는 보냄» · 간 통 매핑",
          r.ok && s.rejects.length === 0 && buttons(s).length === 1 && buttons(s)[0] === s.sent[s.sent.length - 1] &&
            s.sent.filter((x) => x.extra.parse_mode === undefined).length >= 2 &&
            !r2.ok && buttons(s2).length === 0 && /failed after 2 sent/.test(r2.error ?? "") && s2.sent.length === 2 &&
            mapped("c2-card3", s2.sent.map((x) => x.id), "dashboard:regr-c2-card3"),
          { r: { ok: r.ok, sends: s.sent.map((x) => [x.extra.parse_mode ?? "plain", x.shown.length, x.extra.reply_markup !== undefined]) }, r2: { ok: r2.ok, error: r2.error, n: s2.sent.length } },
        ));
      }
      {
        // 간 그때 매핑 — 둘째 평문 통을 붙잡은 동안 첫 평문 통이 이미 물어본 세션에 묶여 있다.
        let release: () => void = () => {};
        const held = new Promise<void>((r) => (release = r));
        let firstPlainId: number | null = null;
        let mappedWhileHeld = false;
        const s = server({
          htmlFails: isBand,
          gate: async (n) => {
            if (n !== 1) return; // 성공 통 #1 = 첫 평문 토막 다음(둘째 평문 토막)
            firstPlainId = s.sent[0]?.id ?? null;
            mappedWhileHeld = firstPlainId !== null && findSessionForOutboundMessage("telegram", "c2-card4", firstPlainId) === "dashboard:regr-c2-card4";
            await held;
          },
        });
        const p = mod.renderOptions(s.send, "붙잡힌 카드?", O, { note: bandLine, chatId: "c2-card4", originThreadKey: "dashboard:regr-c2-card4" });
        await waitFor(() => firstPlainId !== null, 1000);
        release();
        const r = await p;
        // id 를 못 읽은 통도 «보냄» 에 센다 — 첫 평문 통 응답에 id 없음 · 버튼(질문) 통은 HTML·평문 둘 다 실패.
        const s2 = server({ htmlFails: (t) => isBand(t) || t === "N 세기?", noId: (n) => n === 0, failPlain: (_k, t) => t === "N 세기?" });
        const r2 = await mod.renderOptions(s2.send, "N 세기?", O, { note: bandLine });
        out.push(assert(
          "★⑤'' 카드는 통이 간 그때 답글 매핑(둘째 통을 붙잡은 동안 첫 통이 이미 매핑) · «앞 N개» 는 id 를 못 읽은 통까지 센 실제 간 통 수",
          mappedWhileHeld && r.ok && !r2.ok && /failed after 2 sent/.test(r2.error ?? "") && s2.sent.length === 2 && buttons(s2).length === 0,
          { mappedWhileHeld, firstPlainId, r: r.ok, r2: { ok: r2.ok, error: r2.error, n: s2.sent.length } },
        ));
      }
      {
        // 표시 4096 초과 줄은 카드 정책대로 보내기 전 실패(일반 답과 다르다 — 의도된 차이).
        const s = server();
        const r = await mod.renderOptions(s.send, "긴 줄?", O, { note: "x".repeat(5000) });
        out.push(assert(
          "★⑤‴ 카드 설명의 표시 4096 초과 줄 — 기존대로 아무것도 안 보내고 ok:false(상한 안내)",
          !r.ok && s.sent.length === 0 && s.rejects.length === 0 && /4096/.test(r.error ?? ""),
          { ok: r.ok, error: r.error, n: s.sent.length },
        ));
      }

      // ── ⑥ 같은 자르기 함수를 쓰는 문서 전송 — 캡션 경계에서 서로게이트 쌍을 가르지 않는다 ──────────────
      {
        const doc = await loadPluginModule<{
          deliverDocument: (
            api: { sendDocument: (...a: unknown[]) => Promise<unknown>; sendMessage: (...a: unknown[]) => Promise<unknown> },
            target: string, filePath: string, opts?: { caption?: string },
          ) => Promise<{ ok: boolean }>;
          CAPTION_MAX: number;
        }>("../../../plugins/telegram-channel/send-document.js");
        const caps: string[] = [];
        const texts: string[] = [];
        let id = 900;
        const api = {
          sendDocument: async (_c: unknown, _f: unknown, extra: unknown) => { caps.push(String((extra as { caption?: string } | undefined)?.caption ?? "")); return { message_id: ++id }; },
          sendMessage: async (_c: unknown, text: unknown) => { texts.push(String(text)); return { message_id: ++id }; },
        };
        const caption = "가".repeat(doc.CAPTION_MAX - 1) + "😀" + "끝";
        const r = await doc.deliverDocument(api, "c2-doc", "/tmp/regr-c2-doc.png", { caption });
        out.push(assert(
          "★⑥ 문서 캡션이 한도에서 잘릴 때 이모지(서로게이트 쌍)를 가르지 않는다 — 캡션·뒤 글 모두 깨진 글자 0 · 이으면 원문",
          r.ok && caps.length === 1 && texts.length === 1 && !lone.test(caps[0]!) && !lone.test(texts[0]!) &&
            caps[0]!.length <= doc.CAPTION_MAX && caps[0]! + texts[0]! === caption,
          { capLen: caps[0]?.length, capTail: JSON.stringify(caps[0]?.slice(-2)), text: JSON.stringify(texts[0]) },
        ));
      }
    } finally {
      unsub();
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
      if (stopChannel !== null) await stopChannel().catch(() => {});
    }
    return out;
  },
};
