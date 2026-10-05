/**
 * 회귀: **이력 상한은 모델 창(토큰)에 맞춘다 — 그 대화의 실측 글자당 토큰으로, 성분을 맞춰서** (2026-09-30, 압축 후 업무 연속성).
 *
 * 사고: 상한이 글자 20만 고정이라 모델 창(27.2만 토큰)의 약 3분의 1만 썼다. 도구를 많이 쓰는 턴(약 10만 자)마다 여유(3.5~5만 자)를 넘어
 *  매 턴 접고 캐시가 깨졌다(합성 20턴 19회). 글자 상한만 올리면 한국어가 빽빽한 대화(글자당 1.4)는 창을 넘는다.
 * 적대 검토가 찾은 것: 비율(요청 전체 JSON 기준)과 그걸 쓰는 곳(이력만)의 성분이 달랐다 — 그림 base64 가 비율을 부풀려 창 초과,
 *  요청 전체 상한(594,960)을 이력 몫에 그대로 써 밀도 높은 대화가 안전선을 넘음, 다른 어댑터 턴 뒤 옛 비율, 턴 안 상한이 토큰을 모름.
 * ★기대값은 **숫자로** 적는다 — 내보낸 상수로 계산하면 상수를 바꿔도 초록이다(적대 검토 G3).
 */
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "history-cap-follows-token-window",
  guards: "이력 상한이 글자 20만 고정이라 도구 많은 턴마다 접고 캐시가 매 턴 깨지던 것 · 글자만 올리면 한국어 대화가 창을 넘는 것 · 그림 base64·도구 정의가 비율·상한을 부풀려 창을 넘는 것 · 요약 기준과 창 안전망이 갈려 매 턴 오래된 턴이 밀리는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(`${tmpdir()}/tiguclaw-regression-token-density-`);
    const child = await spawnWithin(90_000, "글자당 토큰 기록 실경로", ["--import", "tsx", fileURLToPath(new URL("./_token-density-child.ts", import.meta.url))],
      { env: { ...process.env, TIGUCLAW_HOME: home, CODEX_COMPACT_TRIGGER_CHARS: "50000" } })
      .finally(() => rmSync(home, { recursive: true, force: true }));
    const line = child.out.split(/\r?\n/).find((l) => l.startsWith("DENSITY_RESULT "));
    const D = (line === undefined ? {} : JSON.parse(line.slice("DENSITY_RESULT ".length))) as {
      density?: number | null; afterImage?: number | null; sawImage?: boolean; capInLog?: string | null; turnEnd?: string; trigExplicit?: number; limitCap?: number | null; error?: string;
    };

    const { initStore } = await import("../../store/sessions.js");
    const { appendApiTurn, loadThreadHistoryWithIds } = await import("../../store/memory.js");
    const { recordTokenDensity, tokenDensityOf } = await import("../../store/token-density.js");
    const { lookupContextWindow } = await import("../../core/llm-runtime/context-windows.js");
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    initStore();
    const M = "gpt-6-sol";

    // ① 계산 — 요청 전체 글자(창×95%×60%×비율, 설정·실측 상한과 작은 쪽) × 95%(이스케이프) − 도구 몫 4만, 하한 20만
    const unknownModel = H.historyCapChars("some-local-model", "regr:cap-u");
    const noDensity = H.historyCapChars(M, "regr:cap-none");
    recordTokenDensity("regr:cap-23", 230_000, 100_000);
    const d23 = H.historyCapChars(M, "regr:cap-23");
    recordTokenDensity("regr:cap-10", 100_000, 100_000);
    const d10 = H.historyCapChars(M, "regr:cap-10");
    recordTokenDensity("regr:cap-50", 500_000, 100_000);
    const d50 = H.historyCapChars(M, "regr:cap-50");
    const d50limited = H.historyCapChars(M, "regr:cap-50", 400_000);
    const ceil23 = H.requestCeilingChars(M, "regr:cap-23");
    const ceilNone = H.requestCeilingChars(M, "regr:cap-none");
    const ceilUnknown = H.requestCeilingChars("some-local-model", "regr:cap-none");
    const ceilLimited = H.requestCeilingChars(M, "regr:cap-23", 300_000);
    // ② 기록 — 믿을 수 없는 비율(8 초과·0)은 남기지 않고 직전 값 유지, 8 이하는 남긴다 · 지우기
    recordTokenDensity("regr:cap-23", 50_000, 10);
    recordTokenDensity("regr:cap-23", 90_000, 10_000); // 9.0 — 범위 밖
    recordTokenDensity("regr:cap-23", 0, 100);
    const kept = tokenDensityOf("regr:cap-23");
    recordTokenDensity("regr:cap-7", 70_000, 10_000);
    const seven = tokenDensityOf("regr:cap-7");
    // 섞기 — 재지 않은 어댑터가 늘린 글자만 보수값(1.4)으로 더한다. 짧은 폴백 한 턴은 거의 그대로, 긴 대화는 1.4 쪽으로.
    const { blendTokenDensity } = await import("../../store/token-density.js");
    recordTokenDensity("regr:blend-short", 220_000, 100_000);
    blendTokenDensity("regr:blend-short", 2_000);
    const blendShort = tokenDensityOf("regr:blend-short");
    recordTokenDensity("regr:blend-long", 220_000, 100_000);
    blendTokenDensity("regr:blend-long", 2_000_000);
    const blendLong = tokenDensityOf("regr:blend-long");
    blendTokenDensity("regr:blend-none", 5_000); // 실측이 없으면 할 일이 없다
    const blendNone = tokenDensityOf("regr:blend-none");
    // 그림·PDF base64 글자 — 비율 기록 생략과 턴 안 비교가 같은 함수를 쓴다
    const media = H.mediaCharsOf([
      { type: "message", role: "user", content: [{ type: "input_text", text: "글".repeat(100) }, { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(1_000) }] },
      { type: "message", role: "user", content: [{ type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64," + "B".repeat(2_000) }] },
      { type: "function_call_output", call_id: "c", output: '"type":"input_image"' },
    ]);
    // 퍼사드(동작) — 재지 않는 어댑터(Claude 폴백 등)가 턴을 끝내면 비율을 **섞는다**(지우지 않는다). 시험용 어댑터 주입.
    const RT = await import("../../core/llm-runtime/index.js");
    recordTokenDensity("regr:facade-fb", 220_000, 100_000);
    const undo = RT.__setAdapterForTest(async () => ({ text: "답".repeat(1_000), sessionId: "s-fb" }));
    try {
      await RT.runRegionA({ channel: "http-bridge", threadKey: "regr:facade-fb", text: "질문".repeat(500) } as never, { specs: [{ adapter: "claude", model: "claude-sonnet-5" } as never] });
    } finally { undo(); }
    const facadeFb = tokenDensityOf("regr:facade-fb");
    // ★OpenAI 턴의 도구 항목도 섞는다 — 이력에 붙는 건 발화만이 아니다. 종전엔 발화 글자만 섞어, 도구 결과가 큰 턴을 붙여도
    //  비율이 안 움직였다(적대 재검토 P2 — 이력은 커지는데 상한은 옛 비율 그대로).
    recordTokenDensity("regr:facade-oa", 220_000, 100_000);
    const oaItems = [
      { type: "function_call", call_id: "c1", name: "Read", arguments: '{"path":"big.log"}' },
      { type: "function_call_output", call_id: "c1", output: "X".repeat(200_000) },
    ];
    const undoOa = RT.__setAdapterForTest(async () => ({ text: "답".repeat(1_000), sessionId: "s-oa", turnItems: oaItems as never }));
    let oaErr = "";
    try {
      await RT.runRegionA({ channel: "http-bridge", threadKey: "regr:facade-oa", text: "질문".repeat(500) } as never, { specs: [{ adapter: "openai", model: "gpt-6-sol" } as never] });
    } catch (e) { oaErr = String(e).slice(0, 200); } finally { undoOa(); }
    const oaReplayed = H.turnItemsReplayedChars(oaItems as never);
    const oaAdded = 1_000 + 1_000 + oaReplayed;
    const oaExpect = (220_000 + oaAdded) / (100_000 + Math.round(oaAdded / 1.4));
    const facadeOa = tokenDensityOf("regr:facade-oa");
    const smallItems = [{ type: "function_call", call_id: "c", name: "Ls", arguments: "{}" }];
    // 모델 창 — 실사용 모델 전부(순수 Codex CLI 메타데이터 27.2만 · gpt-5 계열 입력 한도 27.2만)
    const windows = Object.fromEntries(["gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.1", "gpt-5"].map((m) => [m, lookupContextWindow(m)]));

    // ③ 실제 드라이버 — 같은 약 20만 자 이력(20턴 × 1만 자)
    const seed = (tk: string, n = 20) => { for (let i = 0; i < n; i++) appendApiTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: `s-${tk}`, userContent: `질문${i} ` + "가".repeat(5_000), assistantContent: `답${i} FIRST-${i} ` + "나".repeat(5_000) }); };
    const calls: Record<string, number> = {};
    const withPort = async <T>(tk: string, fn: () => Promise<T>): Promise<T> => {
      calls[tk] = 0;
      H.setSummarizerPort(async () => { calls[tk] = (calls[tk] ?? 0) + 1; return "요약: " + "요".repeat(80); });
      try { return await fn(); } finally { H.setSummarizerPort(null); }
    };
    const req = (tk: string) => H.buildTurnHistory({ threadKey: tk, channel: "http-bridge", provider: "codex-oauth" } as never, "지금 질문", [], "t", undefined, M, 47_000);
    seed("regr:cap-drv-none");
    const noneIn = await withPort("regr:cap-drv-none", () => req("regr:cap-drv-none"));
    seed("regr:cap-drv-23");
    recordTokenDensity("regr:cap-drv-23", 230_000, 100_000);
    const in23 = await withPort("regr:cap-drv-23", () => req("regr:cap-drv-23"));
    const in23Text = JSON.stringify(in23);
    const usedCap = H.historyCapUsedFor("regr:cap-drv-23");
    // 같은 이력, 기본 상한이면 창 안전망(20만)이 오래된 턴을 민다 — 상한을 창 안전망에 넘기지 않으면 이렇게 된다(대조).
    const H0 = H.recentTurnsAfter(loadThreadHistoryWithIds("http-bridge", "regr:cap-drv-23"), 0, { budgetUsedChars: 50_000 });
    // 턴 뒤 요약 — 기준(약 23만)을 넘기면 뒤에서 접되 저수위도 같은 상한에서(약 14만 남김). 기본 상한의 저수위(약 8만)까지 접으면 원문을 과하게 잃는다.
    seed("regr:cap-post");
    recordTokenDensity("regr:cap-post", 230_000, 100_000);
    await withPort("regr:cap-post:req", () => req("regr:cap-post"));
    appendApiTurn({ channel: "http-bridge", threadKey: "regr:cap-post", claudeSessionId: "s-regr:cap-post", userContent: "큰 질문 " + "다".repeat(25_000), assistantContent: "큰 답 " + "라".repeat(25_000) });
    await withPort("regr:cap-post:post", async () => { await H.compactHistoryAfterTurn("regr:cap-post"); await H.settleThreadCompaction("regr:cap-post"); });
    const { getThreadSummary } = await import("../../store/thread-summaries.js");
    const postWm = getThreadSummary("regr:cap-post")?.compactedThrough ?? 0;
    const postLeft = loadThreadHistoryWithIds("http-bridge", "regr:cap-post").filter((t) => t.id > postWm).reduce((n, t) => n + t.content.length, 0);
    // 턴 뒤 요약은 **그 시점에** 상한을 다시 계산한다 — 요청 때는 실측 없음(20만), 턴 중 2.3 을 쟀으면 뒤에서 그 기준으로 판단(헛접기 없음).
    //  요청 때는 기준(약 12.9만 — 접힌 도구 결과 목록 몫 4천 자를 뺀 값, 2026-10-05) 바로 아래(약 12만)라 안 접고, 턴이 끝나며 기준을 넘는다
    //  (약 13.2만) — 옛 상한이면 뒤에서 접고, 다시 계산하면 안 접는다.
    seed("regr:cap-late", 12);
    await withPort("regr:cap-late:req", () => req("regr:cap-late"));
    recordTokenDensity("regr:cap-late", 230_000, 100_000); // 이 턴 안에서 잰 값
    appendApiTurn({ channel: "http-bridge", threadKey: "regr:cap-late", claudeSessionId: "s-regr:cap-late", userContent: "하나 더 " + "마".repeat(6_000), assistantContent: "답 " + "바".repeat(6_000) });
    await withPort("regr:cap-late:post", async () => { await H.compactHistoryAfterTurn("regr:cap-late"); await H.settleThreadCompaction("regr:cap-late"); });

    // 배선(소스) — OpenAI 는 실모델 가드로 실경로가 못 돈다 · 퍼사드가 재지 않는 어댑터의 턴 뒤 비율을 지운다
    const { readFile } = await import("node:fs/promises");
    const { stripComments } = await import("./_wiring.js");
    const src = async (rel: string) => stripComments(await readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
    const oa = await src("../../core/llm-runtime/adapters/openai-agents-sdk.ts");
    const oaCap = /const capFor = \(\): number => historyCapChars\(model, input\.threadKey, limitChars\);\s*const capChars = capFor\(\);/.test(oa) &&
      /budget: \{ instructionsChars: instructions\.length, promptChars: promptWithMemory\.length, capChars \},\s*capFor,/.test(oa) &&
      /budgetUsedChars: instructions\.length \+ promptWithMemory\.length \+ summary\.length,\s*charCap: capChars,/.test(oa);
    const facade = await src("../../core/llm-runtime/index.ts");
    const blendBeforePersist = /blendTokenDensity\(input\.threadKey, input\.text\.length \+ output\.text\.length \+ turnItemsReplayedChars\(output\.turnItems\)\);[^]*?\}\s*persistOutput\(input, output\);/.test(facade);
    const cx = await src("../../core/llm-runtime/adapters/openai-codex-oauth.ts");
    const cxCeiling = /ceilingChars: requestCeilingChars\(model, input\.threadKey, loadModelInputLimits\(\)\.get\(`codex:\$\{model\}`\)\),/.test(cx) &&
      /requestChars: lastReqBytes\.total - lastReqBytes\.mediaChars,/.test(cx) && /mediaChars: mediaCharsOf\(body\.input\),/.test(cx) &&
      /if \(lastReqBytes\.mediaChars === 0\) recordTokenDensity\(/.test(cx);


    return [
      assert("재현 조건: 실경로 자식이 두 턴(글·그림)을 돌았다", D.error === "" && D.sawImage === true && typeof D.turnEnd === "string" && D.turnEnd !== "", { error: D.error, sawImage: D.sawImage, err: child.err.slice(-300) }),
      assert("★실경로: Codex 가 그 대화의 글자당 토큰을 남긴다(보낸 요청 / 그 호출의 **전체** 입력 토큰 — 캐시분 포함)", typeof D.density === "number" && Math.abs(D.density - 2.2) < 0.05, D.density),
      assert("★실경로: 그림이 실린 요청은 재지 않는다(base64 가 비율을 부풀려 창을 넘는다) — 직전 값 유지", D.afterImage === D.density, { before: D.density, after: D.afterImage }),
      assert("실경로: 턴 끝 로그는 **이번 요청이 쓴** 상한을 싣는다(실측 전 첫 턴 = 20만)", D.capInLog === "200000", D.turnEnd),
      assert("환경변수로 요약 임계를 명시하면 상한이 커져도 그 값을 넘지 않는다", D.trigExplicit === 50_000, D.trigExplicit),
      assert("창을 모르는 모델은 오늘 그대로(20만)", unknownModel === 200_000, unknownModel),
      assert("★실측이 없으면 오늘 값(20만) — 보수값 1.4 에 도구·이스케이프 몫을 빼면 하한에 걸린다", noDensity === 200_000, noDensity),
      assert("★실측 2.3: (27.2만×0.95×0.6×2.3=356,592) × 0.95 − 4만 = 298,762", d23 === 298_762, d23),
      assert("오늘 값(20만) 아래로는 안 내려간다", d10 === 200_000, d10),
      assert("★밀도가 높아도 요청 전체가 백엔드 실측 상한(594,960) 안 — 이력 몫은 거기서 도구·이스케이프를 뺀 525,212", d50 === 525_212, d50),
      assert("설정된 모델 입력 상한(maxInputChars)을 따른다 — 40만이면 이력 몫 34만", d50limited === 340_000, d50limited),
      assert("★턴 안 상한도 토큰을 안다 — 창×95%×비율(2.3: 594,320 · 실측 없음 1.4: 361,760), 모르는 창은 실측 상한, 설정이 있으면 그것",
        ceil23 === 594_320 && ceilNone === 361_760 && ceilUnknown === 594_960 && ceilLimited === 300_000, { ceil23, ceilNone, ceilUnknown, ceilLimited }),
      assert("★믿을 수 없는 비율(5,000·9.0·0)은 기록하지 않고 직전 값을 유지 · 7.0 은 남긴다",
        kept !== undefined && Math.abs(kept - 2.3) < 1e-9 && seven !== undefined && Math.abs(seven - 7) < 1e-9, { kept, seven }),
      assert("★섞기: 짧은 폴백 한 턴(2천 자)은 거의 그대로(2.19), 긴 다른 어댑터 대화(200만 자)는 보수값 쪽(1.44), 실측 없으면 그대로 없음",
        blendShort !== undefined && blendShort > 2.18 && blendShort < 2.2 && blendLong !== undefined && blendLong > 1.4 && blendLong < 1.5 && blendNone === undefined,
        { blendShort, blendLong, blendNone }),
      assert("★퍼사드(동작): Claude 가 턴을 끝내도 비율을 지우지 않고 그 턴 글자만큼 섞는다(폴백 한 턴이 이력을 접게 만들지 않는다)",
        facadeFb !== undefined && facadeFb > 2.15 && facadeFb < 2.2, facadeFb),
      assert("★퍼사드(동작): OpenAI 턴은 도구 항목이 다음 요청에 실려 갈 크기까지 섞는다(되살리기 상한으로 깎인 크기) · 작은 항목은 그대로 · 없으면 0",
        oaErr === "" && facadeOa !== undefined && Math.abs(facadeOa - oaExpect) < 1e-9 && oaReplayed <= H.turnItemsReplayChars() && oaReplayed >= H.turnItemsReplayChars() * 0.95 &&
          H.turnItemsReplayedChars(smallItems as never) === JSON.stringify(smallItems[0]).length && H.turnItemsReplayedChars(undefined) === 0,
        { oaErr, facadeOa, oaExpect, oaReplayed }),
      assert("★그림·PDF base64 글자를 센다(글·도구 결과 안의 같은 문자열은 아님)", media === 1_000 + 22 + 2_000 + 28, media),
      assert("★설정된 모델 입력 상한이 실제 요청 조립까지 간다(비율 5 · 설정 40만 → 이력 34만)", D.limitCap === 340_000, D.limitCap),
      assert("★모델 창: 실사용 모델 전부 27.2만(과대 추정은 곧 창 초과)", Object.values(windows).every((w) => w === 272_000), windows),
      assert("★실제 드라이버: 같은 20만 자 이력 — 실측이 없으면(오늘 값) 접는다", (calls["regr:cap-drv-none"] ?? 0) > 0 && noneIn.length > 0, calls),
      assert("★실제 드라이버: 실측 2.3 이면 접지 않고 **맨 앞 턴까지** 원문으로 보낸다(창 안전망이 같은 상한 — 오래된 턴을 안 민다)",
        (calls["regr:cap-drv-23"] ?? 0) === 0 && in23Text.includes("FIRST-0") && in23Text.includes("FIRST-19") && usedCap === 298_762, { calls: calls["regr:cap-drv-23"], first: in23Text.includes("FIRST-0"), usedCap }),
      assert("대조: 기본 상한(20만)이면 같은 이력의 앞 턴이 밀린다 — 상한을 창 안전망에 넘기지 않으면 이렇게 된다", !JSON.stringify(H0).includes("FIRST-0"), H0.length),
      assert("★턴 뒤 요약: 기준을 넘으면 뒤에서 접되, 저수위도 같은 상한에서 — 원문을 과하게 잃지 않는다(약 14만 남김, 기본 상한이면 약 8만)",
        (calls["regr:cap-post:req"] ?? 0) === 0 && (calls["regr:cap-post:post"] ?? 0) > 0 && postWm > 0 && postLeft > 120_000 && postLeft < 250_000,
        { req: calls["regr:cap-post:req"], post: calls["regr:cap-post:post"], postWm, postLeft }),
      assert("★턴 뒤 요약은 그 시점에 상한을 다시 계산한다 — 턴 중 잰 비율로 판단해 헛접지 않는다",
        (calls["regr:cap-late:req"] ?? 0) === 0 && (calls["regr:cap-late:post"] ?? 0) === 0, { req: calls["regr:cap-late:req"], post: calls["regr:cap-late:post"] }),
      assert("Codex: 턴 안 상한은 토큰 기준 함수 · 그림 base64 는 빼고 비교 · 그림 요청은 비율 안 잼(소스)", cxCeiling, cxCeiling),
      assert("OpenAI 도 같은 상한을 요약 기준·창 안전망·턴 뒤 요약에 넘긴다(소스)", oaCap, oaCap),
      assert("섞기는 저장·턴 뒤 요약보다 **먼저**(소스)", blendBeforePersist, blendBeforePersist),
    ];
  },
};
