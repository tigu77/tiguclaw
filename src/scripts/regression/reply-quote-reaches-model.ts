/**
 * 회귀: **답글 원문이 비서에게 닿는다** — 새 턴뿐 아니라 응답 중 끼워넣기·재주입에서도, 긴 원문은 앞과 끝이 (2026-10-06).
 *
 * 사용자 질문(«대시보드에서 답글로 보내면 비서가 참고해?»)을 확인하다 찾았다:
 *  ①비서가 **답하는 중에** 답글을 보내면(응답 중 «이거 말고 저거» 가 흔한 사용법) 끼워넣기 경로가 본문만 실어 원문이 빠졌다.
 *  ②미소비 끼워넣기를 새 턴으로 재주입할 때 그 턴을 연 **다른 메시지의** 답글 원문이 붙을 수 있었다(`...msg`).
 *  ③채널(텔레그램·대시보드)이 각자 앞 1,500자만 남겨 긴 답의 **끝**(결론·질문)이 잘렸다.
 * 셋 다 `withReplyQuote` 한 곳으로 모으고, 여기서 그 함수와 두 경로(toSteeringInput · reinjectTextFor)를 실행으로 잰다.
 *
 * 등급: **동작** — 순수 함수 실행. 새 턴 주입부(index.ts)는 배선만 본다.
 */
import { readFileSync } from "node:fs";
import { clipReplyQuote, REPLY_QUOTE_MAX_CHARS, withReplyQuote } from "../../core/reply-quote.js";
import { buildReinjectMessage, reinjectTextFor, toSteeringInput } from "../../core/steering.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "reply-quote-reaches-model",
  guards:
    "응답 중에 보낸 답글의 원문이 비서에게 안 가고 · 재주입이 다른 메시지의 원문을 붙이고 · 긴 원문의 끝(결론·질문)이 잘리던 것",
  run: async (): Promise<Assertion[]> => {
    const QUOTE = "이전 답: A 와 B 중 무엇으로 할까요?";
    const steer = toSteeringInput({ channel: "http-bridge", threadKey: "dashboard:x", text: "B로 해", replyToText: QUOTE } as never);
    const plain = toSteeringInput({ channel: "http-bridge", threadKey: "dashboard:x", text: "그냥 메시지" } as never);

    const lead = "HEAD-MARK-1111 " + "앞부분 ".repeat(200);
    const end = " 결론: 둘 중 하나를 골라 주세요? TAIL-MARK-2222";
    const long = lead + "가운데 ".repeat(600) + end;
    const clipped = clipReplyQuote(long);

    // 재주입 — 메시지마다 자기 원문
    const left = [
      toSteeringInput({ channel: "telegram", threadKey: "dashboard:x", text: "첫째", replyToText: "원문-ONE" } as never),
      toSteeringInput({ channel: "telegram", threadKey: "dashboard:x", text: "둘째" } as never),
      toSteeringInput({ channel: "telegram", threadKey: "dashboard:x", text: "셋째", replyToText: "원문-THREE" } as never),
    ];
    const re = reinjectTextFor(left);
    const pos = (s: string) => re.indexOf(s);

    // 재주입 메시지 조립 — 그 턴을 연 메시지의 원문은 비우고, 첨부만 담은 답글도 인용을 지킨다(실행으로 잰다)
    const turnOpener = { channel: "telegram", threadKey: "dashboard:x", text: "턴을 연 메시지", replyToText: "TURN-OPENER-QUOTE" } as never;
    const reMsg = buildReinjectMessage(turnOpener, left, 1);
    const attOnly = buildReinjectMessage(turnOpener, [
      toSteeringInput({ channel: "http-bridge", threadKey: "dashboard:x", text: "", replyToText: "ATT-ONLY-QUOTE", attachments: [{ path: "/tmp/a.png", mime: "image/png" }] } as never),
    ], 1);
    const empty = buildReinjectMessage(turnOpener, [], 1);

    const idx = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const life = readFileSync(new URL("../../core/entry/turn-lifecycle.ts", import.meta.url), "utf8"); // 턴 출구 판정(2026-10-09 index.ts 에서 옮김)
    const tg = readFileSync(new URL("../../../plugins/telegram-channel/index.ts", import.meta.url), "utf8");
    const bridge = readFileSync(new URL("../../../plugins/http-bridge/routes-chat.ts", import.meta.url), "utf8");
    // 채널은 자르지 않거나(텔레그램) 요청 크기 방어만 한다(대시보드) — 정확히 1500 만 금지하면 숫자를 바꾼 변이가 통과했다(재검토 G3).
    const tgStmt = /const replyToText = [^;]*;/.exec(tg.slice(tg.indexOf("const repliedRaw")))?.[0] ?? "";
    const brStmt = /const replyToText =[\s\S]*?;/.exec(bridge)?.[0] ?? "";
    const brCaps = [...brStmt.matchAll(/slice\(0,\s*([\d_]+)\)/g)].map((m) => Number(m[1]!.replace(/_/g, "")));
    return [
      assert(
        "★응답 중에 보낸 답글도 원문이 비서에게 간다(끼워넣기 본문에 인용) · 표시용 원문(raw)은 사용자 글 그대로",
        steer.text.includes(QUOTE) && steer.text.includes("B로 해") && steer.raw === "B로 해" && steer.replyToText === QUOTE,
        steer.text.slice(-80),
      ),
      assert("답글이 아니면 인용을 안 붙인다", !plain.text.includes("답글") && plain.replyToText === undefined, plain.text.slice(-30)),
      assert(
        "★긴 원문은 앞과 끝을 남기고 가운데를 버린다(종전엔 앞 1,500자만 — 끝의 결론·질문이 잘렸다)",
        clipped.includes("HEAD-MARK-1111") && clipped.includes("TAIL-MARK-2222") && /가운데 \d+자 생략/.test(clipped) &&
          clipped.length <= REPLY_QUOTE_MAX_CHARS + 40,
        `${clipped.length}자`,
      ),
      assert(
        "★재주입은 메시지마다 자기 원문을 붙인다(그 턴을 연 다른 메시지의 원문이 아니라)",
        pos("원문-ONE") >= 0 && pos("원문-ONE") < pos("첫째") && pos("첫째") < pos("둘째") && pos("둘째") < pos("원문-THREE") &&
          pos("원문-THREE") < pos("셋째") && (re.match(/〔\/답글 대상 메시지〕/g) ?? []).length === 2,
        re.replace(/\n/g, " ").slice(0, 160),
      ),
      assert(
        "★재주입 메시지는 그 턴을 연 메시지의 답글 원문을 갖지 않는다(본문에 메시지마다 자기 원문) · 화면 재표시 없음",
        reMsg !== null && !("replyToText" in reMsg) && !reMsg.text.includes("TURN-OPENER-QUOTE") && reMsg.text.includes("원문-ONE") &&
          reMsg.synthetic === true,
        reMsg === null ? "★null" : reMsg.text.replace(/\n/g, " ").slice(0, 100),
      ),
      assert(
        "첨부만 담은 답글도 재주입에서 인용이 남는다(새 턴 경로와 같게) · 남은 게 없으면 재주입하지 않는다",
        attOnly !== null && attOnly.text.includes("ATT-ONLY-QUOTE") && (attOnly.attachments?.length ?? 0) === 1 && empty === null,
        attOnly === null ? "★null" : attOnly.text.slice(0, 60),
      ),
      assert(
        "새 턴은 같은 인용 함수를, 재주입은 조립 함수를 쓴다 · 채널은 인용 원문을 상한 아래로 자르지 않는다(배선)",
        /effectiveText = withReplyQuote\(effectiveText, msg\.replyToText\)/.test(idx) &&
          (/const again = reinjectUnlessStopped\(t\.signal, t\.msg, leftover\)/.test(life) && /signal: turnAc\.signal,/.test(idx) && /reinject: \(m\) => serializedHandler\(m\)/.test(idx)) &&
          tgStmt !== "" && !/slice/.test(tgStmt) && brStmt !== "" && brCaps.every((n) => n >= 4096),
        `텔레그램=${tgStmt.slice(0, 60)} · 대시보드 상한=${JSON.stringify(brCaps)}`,
      ),
    ];
  },
};
