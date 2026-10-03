/**
 * 회귀: **모델 요청 한 번의 벽시계 분해 — 세 어댑터가 같은 정의로** (2026-10-02).
 *
 * 회사돌쇠 실측: 같은 범위의 시범 제작이 Claude 517초 · GPT 1,221초였는데 도구 시간은 비슷했고 차이의 93%가
 * «도구 밖» 이었다. 그 밖이 서버가 생각한 시간인지·조립·무진전 재개인지 가를 기록이 없었다. 판정은
 * `_request-timing.ts` 한 곳이고, 여기선 그 함수를 실행해 잰다(어댑터는 시각만 넘긴다).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeStreamMark,
  createRequestTimeline,
  formatTurnTiming,
  openAiStreamMark,
  requestSpans,
  summarizeTurnTiming,
} from "../../core/llm-runtime/adapters/_request-timing.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (f: string): string => fs.readFileSync(path.join(repo, "src/core/llm-runtime/adapters", f), "utf8");

export const check: RegressionCheck = {
  name: "request-timing",
  guards: "«도구 밖 시간» 이 서버 대기·생각·조립·무진전 중 어디인지 로그로 못 가르던 것 — 세 어댑터가 같은 정의로 남기는가",
  run: async (): Promise<Assertion[]> => {
    // 직접 전송(codex) — 직전 끝 -500, 루프 0, 첫 전송 100, 무진전 뒤 재전송 400, 헤더 450, 응답 시작 460, 첫 진전 1460, 끝 2000.
    const direct = requestSpans(3, { readyAt: 0, firstSendAt: 100, sendAt: 400, headersAt: 450, firstEventAt: 460, firstOutputAt: 1460, endAt: 2000 }, -500);
    // SDK(claude·openai) — 전송·헤더를 모른다: 응답 시작까지가 통째로 wait.
    const sdk = requestSpans(1, { readyAt: 1000, firstEventAt: 3000, firstOutputAt: 5000, endAt: 6000 }, undefined);
    // 빈 응답 — 진전이 없으면 생각이 끝까지, 출력 0.
    const empty = requestSpans(1, { readyAt: 0, firstEventAt: 10, endAt: 900 }, undefined);

    // 수집기 — 첫 요청, 도구, 둘째 요청. 열린 응답 안의 중복 시작·닫힌 뒤의 끝은 무시한다.
    const tl = createRequestTimeline(1000);
    tl.mark("start", 3000);
    tl.mark("start", 3500); // 중복 — 무시
    tl.mark("output", 5000);
    tl.mark("output", 5500); // 첫 진전만
    tl.mark("end", 6000);
    tl.mark("end", 6100); // 닫힌 뒤 — 무시
    tl.toolResult(9000);
    tl.mark("start", 9500);
    tl.mark("output", 9600);
    tl.mark("end", 9700);
    const s = tl.spans();

    // 긴순 — 82회 중 한 번의 5분이 평균에 묻히지 않고 «무엇이 길었나» 와 같이 나온다.
    const many = [
      ...Array.from({ length: 10 }, (_, i) => requestSpans(i + 1, { readyAt: i * 10_000, firstEventAt: i * 10_000 + 500, firstOutputAt: i * 10_000 + 2000, endAt: i * 10_000 + 3000 }, i === 0 ? undefined : i * 10_000 - 7000)),
      requestSpans(35, { readyAt: 0, firstSendAt: 10, sendAt: 300_010, headersAt: 300_500, firstEventAt: 300_600, firstOutputAt: 301_000, endAt: 302_000 }, undefined),
    ];
    const line = formatTurnTiming(many);

    // 턴 바깥 — 준비 끝(500) 뒤 첫 요청(응답 900·진전 1000·끝 1200), 1500 에 줄을 찍으면 턴 준비 0.5s · 그 밖 0.3s.
    const tb = createRequestTimeline(0);
    tb.setupDone(500);
    tb.mark("start", 900);
    tb.mark("output", 1000);
    tb.mark("end", 1200);
    const bounded = tb.summary(1500);
    const boundedLine = tb.format(1500);
    // 끝나지 않은 요청 — 응답이 열리고 첫 진전 전이면 «첫출력 대기», 진전 뒤면 «출력 중».
    const tp = createRequestTimeline(0);
    tp.mark("start", 100);
    const waiting = tp.format(400);
    tp.mark("output", 500);
    const streaming = tp.format(700);
    const noBounds = summarizeTurnTiming(tb.spans());

    const adapters = {
      codex: /firstOutputAt \?\?= Date\.now\(\)/.test(src("openai-codex-oauth.ts")) && /formatTurnTiming\(turnSpans, turnBounds\(\)\)/.test(src("openai-codex-oauth.ts")),
      claude: /requestTimeline\.mark\(claudeStreamMark\(event\)/.test(src("claude-agent-sdk.ts")) && /requestTimeline\.toolResult\(/.test(src("claude-agent-sdk.ts")) && /requestTimeline\.format\(\)/.test(src("claude-agent-sdk.ts")) &&
        // ★실패 줄은 정상 종료로 흡수하는 갈래(앱 도구 캡처 abort · 답 확정 뒤 실패) **다음** — 앞이면 성공 턴에도 찍힌다(적대 검토 P3).
        src("claude-agent-sdk.ts").indexOf("[claude-turn-fail]") > src("claude-agent-sdk.ts").indexOf("keepAnswerOnThrow({"),
      openai: /requestTimeline\.mark\(openAiStreamMark\(data\)/.test(src("openai-agents-sdk.ts")) && /requestTimeline\.toolResult\(/.test(src("openai-agents-sdk.ts")) && /\[openai-turn-end\][^\n]*requestTimeline\.format\(\)/.test(src("openai-agents-sdk.ts")),
    };

    return [
      assert(
        "★직접 전송: 도구·후처리 500 · 조립 100 · 무진전 300 · 헤더 50 · 응답열림 10 · 첫출력 1000 · 출력 540",
        direct.between === 500 && direct.prep === 100 && direct.stalled === 300 && direct.headers === 50 && direct.wait === 10 && direct.think === 1000 && direct.output === 540,
        direct,
      ),
      assert("SDK: 전송·헤더를 모르면 그 칸이 없고 응답 시작까지가 wait", sdk.prep === undefined && sdk.headers === undefined && sdk.wait === 2000 && sdk.think === 2000 && sdk.output === 1000 && sdk.between === 0, sdk),
      assert("빈 응답: 생각이 끝까지 · 출력 0", empty.think === 890 && empty.output === 0, empty),
      assert(
        "★수집기: 첫 요청(wait 2000·첫출력 2000·출력 1000) → 도구 결과 → 둘째 요청(도구·후처리 3000·wait 500) · 중복 신호 무시",
        s.length === 2 && s[0]!.wait === 2000 && s[0]!.think === 2000 && s[0]!.output === 1000 && s[1]!.between === 3000 && s[1]!.wait === 500 && s[1]!.think === 100 && s[1]!.output === 100,
        s,
      ),
      assert("★긴순 첫 칸이 5분 무진전 요청이고 그 이름이 «무진전» 이다", /긴순=#35 \d+s\(무진전 300s\)/.test(line), line),
      // ★턴 줄은 어댑터끼리 같은 것을 재는 칸만 — 헤더·응답열림·첫출력은 «첫출력까지» 하나로(Claude 는 생각이 응답열림에,
      //  codex 는 첫출력에 들어간다 — 실측). 직접 전송 요청(헤더 50·응답열림 10·첫출력 1000) = 1.1s, SDK 요청(2000+2000) = 4.0s.
      assert(
        "★턴 줄: 헤더·응답열림·첫출력을 «첫출력까지» 하나로 묶고, 따로 된 칸은 없다",
        /첫출력까지 1\.1s/.test(formatTurnTiming([direct])) && /첫출력까지 4\.0s/.test(formatTurnTiming([sdk])) && !/응답열림|헤더/.test(formatTurnTiming([direct, sdk])),
        [formatTurnTiming([direct]), formatTurnTiming([sdk])],
      ),
      assert(
        "★Claude: 글자·도구 인자 델타만 첫 출력 — thinking 델타는 아니다",
        claudeStreamMark({ type: "message_start" }) === "start" &&
          claudeStreamMark({ type: "message_stop" }) === "end" &&
          claudeStreamMark({ type: "content_block_delta", delta: { type: "text_delta" } }) === "output" &&
          claudeStreamMark({ type: "content_block_delta", delta: { type: "input_json_delta" } }) === "output" &&
          claudeStreamMark({ type: "content_block_delta", delta: { type: "thinking_delta" } }) === undefined &&
          claudeStreamMark({ type: "message_delta" }) === undefined,
        ["message_start", "message_stop", "text_delta", "input_json_delta", "thinking_delta", "message_delta"].map((t) =>
          claudeStreamMark(t.startsWith("message") ? { type: t } : { type: "content_block_delta", delta: { type: t } }) ?? "-"),
      ),
      assert(
        "OpenAI: 응답 시작·끝·글자·도구 인자(원시 이벤트) — 그 밖은 경계 아님",
        openAiStreamMark({ type: "response_started" }) === "start" &&
          openAiStreamMark({ type: "response_done" }) === "end" &&
          openAiStreamMark({ type: "output_text_delta", delta: "a" }) === "output" &&
          openAiStreamMark({ type: "model", event: { type: "response.function_call_arguments.delta" } }) === "output" &&
          openAiStreamMark({ type: "model", event: { type: "response.reasoning_summary_text.delta" } }) === undefined,
        [{ type: "response_started" }, { type: "response_done" }, { type: "output_text_delta" }, { type: "model", event: { type: "response.function_call_arguments.delta" } }, { type: "model", event: { type: "response.reasoning_summary_text.delta" } }].map((d) => openAiStreamMark(d) ?? "-"),
      ),
      assert(
        "★턴 준비 = 준비 끝 − 턴 시작 · 첫 요청의 대기는 준비 끝부터 · 그 밖 = 벽시계 − 준비 − 분해 합",
        bounded.setupMs === 500 && tb.spans()[0]!.wait === 400 && bounded.residualMs === 300 && bounded.wallMs === 1500 &&
          /시간=턴 준비 0\.5s·.*·그 밖 0\.3s 요청=1회/.test(boundedLine) && noBounds.setupMs === undefined && noBounds.residualMs === undefined,
        { bounded, boundedLine, noBounds },
      ),
      assert("★끝나지 않은 요청은 어디서 멈췄는지 — 첫 진전 전 «첫출력 대기» · 뒤 «출력 중»", /미완=0\.4s\(첫출력 대기\)/.test(waiting) && /미완=0\.7s\(출력 중\)/.test(streaming), { waiting, streaming }),
      assert("세 어댑터가 시각을 넘기고 턴 끝 줄에 같은 표기를 싣는다", adapters.codex && adapters.claude && adapters.openai, adapters),
    ];
  },
};
