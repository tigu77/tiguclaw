/**
 * 회귀: **요약 호출도 이 턴과 같은 추론 강도로 간다** (2026-09-15 정태님 신고로 생겼다).
 *
 * ★사고: 요약 요청 본문에 `reasoning: { effort: "none" }` 이 **박혀** 있었다. 사용자가
 *  모델 프로파일을 `low` 로 해뒀는데도 요약만 `none` 으로 나갔고, `gpt-6-astra` 가 그 값을
 *  거부해(`400 unsupported_value`) **요약이 매 턴 죽었다.** 턴은 안 깨진다 — oldest-drop
 *  폴백으로 그대로 진행되므로, 화면엔 아무 말도 없이 **긴 대화의 앞부분만 조용히 사라졌다.**
 *  실측(회사돌쇠 2026-09-15): 10:48 에 35턴/38,845자, 10:50 에 15턴/18,671자가 요약 없이 잘렸다.
 *
 * ★**왜 그물이 못 잡았나가 이 검사의 설계를 정했다.** 압축 회귀가 일곱 개나 있었는데 전부
 *  초록이었다 — 테스트 이음매(`setSummarizerPort`)가 그 호출을 **통째로** 대체해서 실제로
 *  나가는 본문을 본 검사가 **하나도 없었다.** 부품은 검사되는데 이음매는 안 검사되던 그
 *  부류다. 그래서 여기서는 ①본문 조립을 **실행**하고 ②강도가 이음매까지 **실제로 흐르는지**
 *  드라이버로 확인한다.
 *
 * ★③은 «같은 값» 이 우연이 아니라 **구조**임을 지킨다. 두 곳이 같은 함수를 *부르게* 하면
 *  언젠가 한쪽만 바뀐다 — 실제로 그렇게 갈렸다(본 턴은 프로파일, 요약은 리터럴). 변수
 *  하나를 두 곳이 쓰면 갈릴 수가 없다([[feedback_hand_maintained_lists]]).
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
const readRel = (rel: string): Promise<string> =>
  readFile(new URL(rel, import.meta.url), "utf8");
/** 줄·블록 주석을 지운다 — 주석 안의 글자를 코드로 세지 않으려고. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export const check: RegressionCheck = {
  name: "summary-rides-the-turn-profile",
  guards:
    "요약 호출이 프로파일을 무시하고 `effort:\"none\"` 을 박아 보내, 그 값을 안 받는 모델에서 요약이 매 턴 400 으로 죽고 맥락이 조용히 잘리던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 실제로 나가는 본문을 **조립해서** 본다 ────────────────────────────────
    const mod = await import(SRC);
    const build = mod.buildSummarizeRequestBody as (
      model: string,
      text: string,
      targetChars: number,
      effort: string | undefined,
    ) => Record<string, unknown>;

    const withLow = build("gpt-6-astra", "대화", 500, "low");
    const withHigh = build("gpt-6-astra", "대화", 500, "xhigh");
    const unknown = build("gpt-6-astra", "대화", 500, undefined);

    out.push(
      assert(
        "★준 강도가 그대로 실린다 — 요약이 자기 값을 만들어 쓰지 않는다",
        JSON.stringify((withLow as { reasoning?: unknown }).reasoning) ===
          JSON.stringify({ effort: "low" }) &&
          JSON.stringify((withHigh as { reasoning?: unknown }).reasoning) ===
            JSON.stringify({ effort: "xhigh" }),
        `low → ${JSON.stringify((withLow as { reasoning?: unknown }).reasoning)} · xhigh → ${JSON.stringify((withHigh as { reasoning?: unknown }).reasoning)}`,
      ),
      assert(
        "★모르면 **필드를 안 보낸다** — 모르는 것에 추측값을 씌우면 그게 이번 사고다",
        !("reasoning" in unknown),
        `키 목록: ${Object.keys(unknown).join("·")}`,
      ),
      assert(
        "요약 본문은 여전히 격리된 최소 요청이다(도구 없음·대화로 안 남김)",
        unknown.store === false && !("tools" in unknown) && !("prompt_cache_key" in unknown),
        `store=${String(unknown.store)} tools=${String("tools" in unknown)} cacheKey=${String("prompt_cache_key" in unknown)}`,
      ),
    );

    // ── ② 강도가 이음매까지 **흐르는지** 실제 드라이버로 ─────────────────────────
    const { buildTurnHistory, setSummarizerPort, CODEX_HISTORY_COMPACT_TRIGGER_CHARS: TRIGGER } =
      (await import(SRC)) as {
        buildTurnHistory: (...a: unknown[]) => Promise<unknown[]>;
        setSummarizerPort: (p: unknown) => void;
        CODEX_HISTORY_COMPACT_TRIGGER_CHARS: number;
      };
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn, loadThreadHistoryWithIds } = await import(
      "../../store/memory.js"
    );
    const { clearThreadSummary } = await import("../../store/thread-summaries.js");

    initStore();
    const TK = "regr:summary-effort";
    clearThreadSummary("http-bridge", TK);
    indexCodexTurn({ channel: "http-bridge", threadKey: TK, claudeSessionId: "regr-eff-sid" });
    const turnCount = 200;
    const per = Math.ceil((TRIGGER * 1.4) / turnCount);
    const existing = loadThreadHistoryWithIds("http-bridge", TK);
    if (existing.length < turnCount) {
      let ts = 1_700_000_000_000;
      for (let i = existing.length; i < turnCount; i++) {
        appendTranscript({
          claudeSessionId: "regr-eff-sid",
          role: i % 2 === 0 ? "user" : "assistant",
          content: `턴${i}:` + "가".repeat(Math.max(1, per - 8)),
          ts: (ts += 60_000),
        });
      }
    }

    const seen: (string | undefined)[] = [];
    setSummarizerPort(async (_t: string, target: number, effort?: string) => {
      seen.push(effort);
      return "요약:" + "약".repeat(Math.max(0, target - 3));
    });
    try {
      await buildTurnHistory(
        { threadKey: TK, channel: "http-bridge", provider: "codex-oauth" },
        "현재 턴 프롬프트",
        [],
        "fake-token",
        undefined,
        "fake-model",
        0,
        "low", // ← 이 턴의 프로파일 값
      );
    } finally {
      setSummarizerPort(null);
    }

    out.push(
      assert(
        "★압축이 실제로 돌았다(0이면 아래 단정이 공허하다)",
        seen.length > 0,
        `요약 호출 ${seen.length}회`,
      ),
      assert(
        "★그 호출 **전부**가 이 턴의 강도를 받았다 — 하나라도 자기 값을 쓰면 빨개진다",
        seen.length > 0 && seen.every((e) => e === "low"),
        `받은 값: ${seen.map((e) => String(e)).join("·")}`,
      ),
    );

    // ── ③ «같은 값» 이 구조인가 — 본 턴과 요약이 **한 변수**를 쓴다 ──────────────
    const adapter = stripComments(
      await readRel("../../core/llm-runtime/adapters/openai-codex-oauth.ts"),
    );
    const decls = [...adapter.matchAll(/\bconst turnReasoning\b/g)].length;
    const usedInBody = /body\.reasoning = \{ effort: turnReasoning \}/.test(adapter);
    const passedToHistory = /buildTurnHistory\([\s\S]{0,400}?turnReasoning,/.test(adapter);
    out.push(
      assert(
        "★추론 강도를 **한 번만** 정하고 본 턴과 요약이 그 변수를 함께 쓴다(두 곳이 각자 구하면 언젠가 갈린다)",
        decls === 1 && usedInBody && passedToHistory,
        `선언 ${decls}회 · 본문사용 ${usedInBody} · 요약전달 ${passedToHistory}`,
      ),
      assert(
        "★요약 경로 어디에도 추론 강도 리터럴이 없다(주석은 세지 않는다)",
        !/effort:\s*"(none|low|medium|high|xhigh|max)"/.test(
          stripComments(await readRel("../../core/llm-runtime/adapters/openai-codex-oauth-history.ts")),
        ),
        `요약 모듈의 강도 리터럴: ${(stripComments(await readRel("../../core/llm-runtime/adapters/openai-codex-oauth-history.ts")).match(/effort:\s*"[a-z]+"/g) ?? ["(없음)"]).join("·")}`,
      ),
    );

    return out;
  },
};
