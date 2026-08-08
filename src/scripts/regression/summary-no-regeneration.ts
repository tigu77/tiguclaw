/**
 * 회귀: **요약을 다시 요약하지 않는다 — 옛 구간은 원문 그대로 남는다** (2026-08-09).
 *
 * 사용자 질문에서 나왔다: "3패스라는 게 요약한 걸 또 요약하는 거야?" 그렇다. 그리고 데이터를
 * 보니 그게 압축이 아니라 **망각**이었다.
 *
 * ★실측(dashboard 스레드 하루치):
 *  - 접은 총량 **623,045자**(20회) → 남은 요약 **589자**  = **1,000:1**
 *  - 62턴 40,542자를 **90자**로 만든 회차가 성공으로 지나감
 *  - 전 스레드 5개의 요약이 **273~695자**로 똑같이 몰림 — 분량이 *내용*이 아니라 *지침*을
 *    따랐다는 증거다.
 *
 * 원인 둘:
 *  ① 지침이 `"한국어 3~6문장으로"` 로 **입력 크기와 무관하게 고정**이었다.
 *  ② 매 압축이 `[기존 요약] + [새 원문]` 을 통째로 다시 요약해 옛 요약을 **덮어썼다**.
 *     그래서 옛 내용은 압축이 돌 때마다 한 세대씩 더 뭉개졌다(지수적 증발).
 *
 * 고침: ①분량을 접은 양에 비례시키고 ②새 조각 요약을 **덧붙인다**(재요약 세대 = 0).
 * ③누적본이 상한을 넘을 때만 앞 구간을 한 번 접는다 — 재요약이 *매번*에서 *드물게*로.
 *
 * ★등급: **행동 게이트**. 판정 셋(`summaryTargetFor`·`appendSummarySection`·
 *  `planSummaryRecompaction`)을 실제로 호출하고, 압축 20회를 시뮬레이션해 **첫 구간이
 *  글자 하나까지 그대로인지** 본다. 배선(두 호출부가 덮어쓰기 대신 덧붙이는가)은 소스로
 *  본다고 표시한다 — 요약 LLM 호출을 품은 함수라 주입 이음매가 없다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
const SRC_PATH = "../../../src/core/llm-runtime/adapters/openai-codex-oauth-history.ts";

export const check: RegressionCheck = {
  name: "summary-no-regeneration",
  guards:
    "히스토리 요약이 재요약으로 증발하지 않는다 — 623,045자가 589자로 남던 것",
  run: async (): Promise<Assertion[]> => {
    const {
      summaryTargetFor,
      appendSummarySection,
      planSummaryRecompaction,
      recompactTargetFor,
      summarizeInstructions,
      applyRecompaction,
      MIN_USABLE_SUMMARY_CHARS,
      CODEX_SUMMARY_MAX_CHARS,
    } = await import(SRC);

    // ── ④ 지침이 **좌표**를 요구하는가 ────────────────────────────────────
    // ★라이브 실측에서 나온 축이다. 사실·수치·파일명은 지어낸 것 없이 정확했는데
    //  프로젝트 태그(`#핫딜숏폼커머스엔진`, 원문 6회)가 요약엔 0회였다 — 나머지가 다 맞아도
    //  **어느 프로젝트 일인지 모르는 요약**은 이어서 할 수 없다. 지침을 고치자 첫 문장에 들어왔다.
    const instr = summarizeInstructions(1_600) as string;
    const asksAnchor = /첫 문장/.test(instr) && /태그/.test(instr);
    const statesTarget = instr.includes("1600") || instr.includes("1,600");
    const asksSpecifics = /수치/.test(instr) && /미해결/.test(instr) && /사용자 의도/.test(instr);
    // 종전 사고의 형상 — 입력과 무관한 고정 문장 수 지시가 남아 있으면 안 된다.
    // ★"몇 문장" 형태를 **전부** 막는다. 종전엔 틸드형(`3~6문장`)만 봐서 `최대 3문장으로
    //  간결하게` 로 바꾸면 통과했다 — 사고의 근본(입력과 무관한 고정 분량)이 그대로 복원되는데
    //  초록이었다(적대 검토 A9).
    const noFixedCount =
      !/[\d일이삼사오육칠팔구십]\s*(~\s*[\d일이삼사오육칠팔구십]+\s*)?문장/.test(instr) &&
      !/간결하게\s*(줄|요약)/.test(instr) &&
      !/이내로/.test(instr);

    // ── ① 분량이 입력에 비례하는가 ────────────────────────────────────────
    const t20k = summaryTargetFor(20_000);
    // 사고 회차: 40,542자를 90자로. 그 크기면 목표가 세 자릿수 후반 이상이어야 한다.
    // ★경계에 붙이지 않는다. 종전 `>= 1_000` 은 상한을 정확히 1,000 으로 낮춰도 등호로
    //  통과했다(A1). 지켜야 할 성질은 "**비율대로** 커진다" 이므로 비율로 잰다.
    const t40k = summaryTargetFor(40_000);
    const proportional =
      t40k >= t20k * 1.8 && t40k >= 40_000 * 0.03 && t20k >= 20_000 * 0.03;
    // 하한이 "쓸 수 있는 요약" 하한과 붙으면, 90자짜리가 정상 목표가 된다(A18).
    const floorSane = summaryTargetFor(1) >= (MIN_USABLE_SUMMARY_CHARS as number) * 4;
    // 상한이 너무 낮으면 큰 폴드가 전부 클램프돼 손실이 커진다(A1).
    const ceilSane = summaryTargetFor(10_000_000) >= 3_000;
    // 재압축은 **절대 기준**으로 완만해야 한다 — 상대 비교면 둘 다 낮춰서 뚫린다(A10).
    const gentleAbs = recompactTargetFor(20_000) >= 20_000 * 0.25;

    // ── ② 덧붙이면 옛 구간이 **그대로** 남는가 (핵심 성질) ────────────────
    const first = "1회차 요약: 사용자가 A를 결정했고 파일 x.ts 를 고쳤다.";
    let acc = "";
    acc = appendSummarySection(acc, first);
    for (let i = 2; i <= 20; i++) acc = appendSummarySection(acc, `${i}회차 요약: 내용 ${i}`);
    // ★사고 재현 규모(20회 압축) 뒤에도 1회차 문장이 **글자 하나까지** 살아 있어야 한다.
    const firstSurvives = acc.startsWith(first);
    const allSurvive = Array.from({ length: 19 }, (_, i) => i + 2).every((i) =>
      acc.includes(`${i}회차 요약: 내용 ${i}`),
    );
    // 종전 동작(덮어쓰기)이면 1회차는 사라진다.
    const overwriteWouldLose = !"20회차 요약: 내용 20".includes(first);

    // ── ③ 재압축은 **상한을 넘을 때만** ───────────────────────────────────
    const small = planSummaryRecompaction(acc, CODEX_SUMMARY_MAX_CHARS) as {
      needed: boolean;
    };
    // 상한을 넘는 누적본 만들기
    let big = "";
    for (let i = 0; i < 40; i++) big = appendSummarySection(big, "가".repeat(1_000));
    const rec = planSummaryRecompaction(big, CODEX_SUMMARY_MAX_CHARS) as {
      needed: boolean;
      oldPart: string;
      keepPart: string;
    };
    // 잘린 두 조각을 합치면 원본이다(경계에서 내용이 새지 않는다).
    const lossless =
      rec.needed && appendSummarySection(rec.oldPart, rec.keepPart) === big;
    // 최근 구간은 남긴다(원문에 가까운 쪽을 보존).
    const keepsRecent = rec.needed && rec.keepPart.length > 0 && big.endsWith(rec.keepPart);
    // 요약의 요약은 완만하게 — 원문 비율(4%)을 그대로 쓰면 두 번째 세대에서 또 증발한다.
    const gentle = recompactTargetFor(20_000) > summaryTargetFor(20_000);
    // ★재압축이 **상한 아래로 내려가는가** — 이 단언이 없어서 "앞 구간 하나만 접기"(A5)와
    //  "거의 전부 접기"(A5b) 가 둘 다 통과했다. 제품과 같은 바운드로 반복 구동한다.
    let conv = big;
    for (let i = 0; i < 2; i++) {
      const r = planSummaryRecompaction(conv, CODEX_SUMMARY_MAX_CHARS) as {
        needed: boolean; oldPart: string; keepPart: string;
      };
      if (!r.needed) break;
      // 요약기가 목표대로 돌려줬다고 가정한 모사(제품은 실제 LLM).
      conv = appendSummarySection("요".repeat(recompactTargetFor(r.oldPart.length)), r.keepPart);
    }
    const converges = conv.length <= (CODEX_SUMMARY_MAX_CHARS as number);
    // ★안 줄어드는 재압축은 **거부**한다 — 목표는 부탁이지 절단이 아니다(모델이 넘겨서
    //  돌려주면 누적본이 커지고, 그게 매 턴 프롬프트에서 최근 원문 턴을 밀어낸다).
    const recStub = { oldPart: "가".repeat(5_000), keepPart: "나".repeat(100) };
    const grew = applyRecompaction("가".repeat(5_100), "다".repeat(9_000), recStub);
    const shrank = applyRecompaction("가".repeat(5_100), "다".repeat(500), recStub);
    const rejectsGrowth = grew === null && typeof shrank === "string" && shrank.length < 5_100;

    // ── 배선 ──────────────────────────────────────────────────────────────
    const src = (await readFile(new URL(SRC_PATH, import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // 옛 요약을 프롬프트에 앞세워 다시 요약하던 자리가 **사라졌는가**.
    const noRefeed = !src.includes("[기존 요약]");
    // 두 쓰기 경로(자동 루프 + 수동 /compact)가 모두 덧붙이는가.
    const appends = (src.match(/appendSummarySection\(/g) ?? []).length >= 3;
    // 분량 목표가 실제로 요약기에 전달되는가.
    // ★인자까지 본다. 종전엔 호출 **수**만 세서 `summaryTargetFor(plan.toFold.length)`
    //  (글자수→턴수)로 바꿔도 통과했고, 그러면 목표가 항상 하한 400자로 클램프돼
    //  이 커밋의 핵심 수정이 통째로 무력화된다(A2).
    // ★분량 목표가 요약기까지 닿는지는 이제 `compaction-driver` 가 **드라이버를 돌려**
    //  확인한다(목표가 접은 글자 수에 비례하는가). 여기서 소스 문자열을 보던 두 단언은
    //  요약기 호출이 포트 경유로 바뀌자 곧바로 깨졌다 — 이름에 매달린 검사의 수명이다.
    // 재압축이 최근 구간을 **실제로 이어붙이는가** — 인자를 `""` 로 죽이면 뒤 절반 영구 폐기(A12).
    const keepsRecentWired = /appendSummarySection\(folded\.trim\(\), rec\.keepPart\)/.test(src);
    // 수동 경로의 인자 순서 — 뒤집으면 시간순이 역전된다(A13).
    const manualOrder = /appendSummarySection\(prior, fresh\)/.test(src);

    return [
      assert(
        "★요약 분량이 **접은 양에 비례**한다(고정 문장 수가 623,045자를 589자로 만들었다)",
        proportional,
        `4만자→${t40k}자 · 2만자→${t20k}자`,
      ),
      assert(
        "★20회 압축 뒤에도 **1회차 요약이 글자 그대로** 남아 있다(재요약 세대 0)",
        firstSurvives && overwriteWouldLose,
        firstSurvives ? `누적 ${acc.length}자, 선두 보존` : "★1회차가 사라졌다",
      ),
      assert(
        "중간 회차도 전부 남는다(부분 유실 없음)",
        allSurvive,
        allSurvive ? "2~20회차 전부" : "★유실 있음",
      ),
      assert(
        "상한 아래 누적본은 **건드리지 않는다**(불필요한 재요약 0)",
        small.needed === false,
        `${acc.length}자 ≤ 상한 ${CODEX_SUMMARY_MAX_CHARS} → needed=false`,
      ),
      assert(
        "★상한을 넘으면 앞 구간만 접고 **합치면 원본**이다(경계에서 안 샌다)",
        lossless,
        rec.needed ? `${big.length}자 → 앞 ${rec.oldPart.length} + 뒤 ${rec.keepPart.length}` : "★재압축 판정 안 남",
      ),
      assert(
        "최근 구간은 보존한다(원문에 가까운 쪽을 남긴다)",
        keepsRecent,
        rec.needed ? `뒤 ${rec.keepPart.length}자 유지` : "-",
      ),
      assert(
        "요약을 요약할 땐 **완만하게** 줄인다(2세대에서 또 증발하지 않게)",
        gentle,
        `재압축 ${recompactTargetFor(20_000)}자 > 원문요약 ${summaryTargetFor(20_000)}자`,
      ),
      assert(
        "★요약 지침이 **좌표**를 요구한다(첫 문장에 프로젝트·#태그 — 없으면 이어서 못 한다)",
        asksAnchor,
        asksAnchor ? "첫 문장 + 태그 요구" : "★좌표 축 없음",
      ),
      assert(
        "★지침에 **고정 문장 수**가 없다(`3~6문장`이 623,045자를 589자로 만들었다)",
        noFixedCount && statesTarget,
        `고정문장=${String(!noFixedCount)} · 목표분량 명시=${String(statesTarget)}`,
      ),
      assert(
        "지침이 수치·미해결·사용자 의도를 명시적으로 요구한다",
        asksSpecifics,
        asksSpecifics ? "세 축 모두" : "★빠진 축 있음",
      ),
      assert(
        "★재압축이 **상한 아래로 수렴**한다(한 구간만 접거나 전부 접는 것 둘 다 잡는다)",
        converges,
        `${big.length}자 → ${conv.length}자 (상한 ${CODEX_SUMMARY_MAX_CHARS})`,
      ),
      assert(
        "★안 줄어드는 재압축은 **거부**한다(목표는 부탁이지 절단이 아니다)",
        rejectsGrowth,
        `커진 결과=${grew === null ? "거부" : "★수락"} · 줄어든 결과=${typeof shrank === "string" ? "수락" : "★거부"}`,
      ),
      assert(
        "요약 목표의 하한·상한이 제 구실을 한다(하한이 '쓸 수 있음' 하한과 안 붙는다)",
        floorSane && ceilSane && gentleAbs,
        `하한 ${summaryTargetFor(1)} · 상한 ${summaryTargetFor(10_000_000)} · 재압축 ${recompactTargetFor(20_000)}`,
      ),
      assert(
        "★[배선] 재압축이 **최근 구간을 이어붙인다**(인자를 죽이면 뒤 절반 영구 폐기)",
        keepsRecentWired && manualOrder,
        `keepPart=${String(keepsRecentWired)} · 수동 순서=${String(manualOrder)}`,
      ),
      assert(
        "★[배선 린트] 옛 요약을 프롬프트에 **다시 넣지 않는다**(`[기존 요약]` 자리 소멸)",
        noRefeed,
        noRefeed ? "재투입 없음" : "★옛 요약을 아직 다시 요약한다",
      ),
      assert(
        "[배선 린트] 자동·수동 **두 쓰기 경로 모두** 덧붙인다(한쪽만 고치면 반쪽)",
        appends,
        `appendSummarySection 호출 ${(src.match(/appendSummarySection\(/g) ?? []).length}곳`,
      ),
    ];
  },
};
