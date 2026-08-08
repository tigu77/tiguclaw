/**
 * 회귀: **압축은 한 번 돌면 임계 아래로 내려간다** (2026-08-09).
 *
 * 사용자 신고: "코덱스가 2만 자 정도만 넘어도 요약을 진행한다" — 실제 임계는 15만이지만
 * **매 턴 압축이 돌아** 그렇게 보였다. 라이브 로그가 그대로다: 18:48·19:08·21:46·22:13·23:59.
 *
 * 원인은 **고수위만 있고 저수위가 없던 것**이다. "넘었나?" 는 15만으로 묻는데 "얼마나 접나?"
 * 는 4만으로 답한다 — 23.8만짜리 스레드는 한 번 접어도 19.8만이라 **다음 턴에 또** 걸린다.
 * 두 숫자가 서로를 모르니 임계에 딱 붙어 진동했다. ★같은 부류를 이 레포에서 여러 번 겪었다
 * (경계·상수가 계층마다 흩어져 서로를 모르는 것 — [[feedback_fix_root_not_bandaid]]).
 *
 * 고침은 **저수위**다. 한 번 걸리면 임계 아래로 내려갈 때까지 여러 번 접는다. 접는 **한 번의
 * 크기는 그대로** 두는 게 핵심이다 — 요약 호출은 큰 입력에서 깨진다(실측: 87,387자 실패 /
 * 60,650자 성공). "크게 한 번" 이 아니라 "안전한 크기로 여러 번".
 *
 * ★등급: **행동 게이트**(수렴·저수위·워터마크·상수 대소) + 잔여 **배선 린트**(루프 존재·
 *  발행 위치). 2026-08-09 적대 검토가 변이 32개 중 19개를 통과시켰고, 뿌리는 하나였다 —
 *  **검사가 제품 루프를 한 번도 실행하지 않았다**(테스트가 루프를 자기 안에서 재구현하고
 *  제품은 정규식으로 이름만 봤다). 그래서 판정을 순수 함수로 뽑아(`lowWaterMark`·
 *  `nextPassOpts`·`applyFoldResult`) **실행해서** 본다. 남은 린트는 그 등급을 적어 둔다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
const SRC_PATH = "../../../src/core/llm-runtime/adapters/openai-codex-oauth-history.ts";

export const check: RegressionCheck = {
  name: "codex-compaction-hysteresis",
  guards:
    "codex 히스토리 압축이 임계 아래로 내려간다 — 임계에 붙어 매 턴 압축이 돌던 진동",
  run: async (): Promise<Assertion[]> => {
    // ★**실제 상수**를 참조한다. 값을 직접 적으면 제품 상수를 되돌려도 검사가 통과한다
    //  (event-payload-cap 에서 변이로 확인한 가짜 초록 — 같은 함정을 두 번 밟지 않는다).
    const {
      planHistoryCompaction,
      CODEX_HISTORY_COMPACT_TRIGGER_CHARS: TRIGGER,
      CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS: BUDGET,
      CODEX_COMPACT_LOW_WATER_RATIO: RATIO,
      CODEX_COMPACT_MAX_PASSES: MAX_PASSES,
      lowWaterMark,
      nextPassOpts,
      applyFoldResult,
      CODEX_SUMMARY_MAX_CHARS,
    } = await import(SRC);
    const { CODEX_TURN_HISTORY_CHAR_CAP } = await import("../../store/memory.js");
    // ★저수위는 **제품 함수**로 얻는다. 종전엔 검사가 자체 계산해서, 제품이 곱하기를
    //  나누기로 바꿔도(250,000) 통과했다(적대 검토 A3).
    const LOW = lowWaterMark() as number;

    // 사고 스레드 재현 — 임계의 **1.59배**(라이브 실측 23.8만 / 임계 15만). 임계를 올리면
    // 사고 크기도 같이 오른다 — "임계를 훌쩍 넘긴 스레드" 가 재현하려는 상태다.
    const turnCount = 472;
    const per = Math.ceil((TRIGGER * 1.586) / turnCount);
    const turns = Array.from({ length: turnCount }, (_, i) => ({
      id: i + 1,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "가".repeat(per),
    }));

    let wm = 0;
    const remaining = (): number =>
      turns.filter((t) => t.id > wm).reduce((a, t) => a + t.content.length, 0);
    const start = remaining();
    const foldSizes: number[] = [];

    // ★제품과 같은 순서로 구동한다: 1회차는 고수위, 2회차부터는 저수위로 재판정.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const plan = planHistoryCompaction(
        turns.filter((t) => t.id > wm),
        wm,
        {
          maxFoldChars: BUDGET,
          ...(pass === 0 ? {} : { triggerChars: LOW }),
        },
      ) as { needed: boolean; toFold: { content: string }[]; nextWatermark: number };
      if (!plan.needed) break;
      foldSizes.push(plan.toFold.reduce((a, t) => a + t.content.length, 0));
      wm = plan.nextWatermark;
    }
    const end = remaining();

    // 종전 동작(1회만 접음)은 여기서 걸린다 — 23.8만 - 4만 = 19.8만 > 15만.
    const singlePassEnd = start - (foldSizes[0] ?? 0);

    // ★저수위가 **실제로 값을 내는 자리**: 임계 바로 위에서 맴도는 스레드. 한 번 접어
    //  임계 아래로만 내려가면 다음 압축까지 남은 여유가 예산 한 번치뿐이라 **곧 또 걸린다**.
    //  저수위까지 내려가야 여유가 배로 는다. (이게 없으면 "임계 아래" 만으로 통과해버린다.)
    const nearCount = 200;
    const nearPer = Math.ceil((TRIGGER + BUDGET * 0.15) / nearCount);
    const near = Array.from({ length: nearCount }, (_, i) => ({
      id: i + 1,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "가".repeat(nearPer),
    }));
    let nwm = 0;
    const nearLeft = (): number =>
      near.filter((t) => t.id > nwm).reduce((a, t) => a + t.content.length, 0);
    const nearStart = nearLeft();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const plan = planHistoryCompaction(near.filter((t) => t.id > nwm), nwm, {
        maxFoldChars: BUDGET,
        ...(pass === 0 ? {} : { triggerChars: LOW }),
      }) as { needed: boolean; nextWatermark: number };
      if (!plan.needed) break;
      nwm = plan.nextWatermark;
    }
    const nearEnd = nearLeft();

    // 배선 — 루프가 실제로 소스에 있는가. (주석은 걷어낸다: 2026-08-08 에 자기 설명문을
    //  세 번 매칭했다.)
    const src = (await readFile(new URL(SRC_PATH, import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const hasLoop = /while\s*\(\s*plan\.needed\s*&&\s*compactPass\s*<\s*CODEX_COMPACT_MAX_PASSES/.test(src);
    // ★재판정이 실제로 **저수위**를 쓰는가 — 값을 실행해서 본다(이름 매칭 아님).
    const p0 = nextPassOpts(0, 40_000, LOW) as { triggerChars?: number };
    const p1 = nextPassOpts(1, 40_000, LOW) as { triggerChars?: number };
    const replans = p0.triggerChars === undefined && p1.triggerChars === LOW;
    // 실패·쿨다운에서 루프를 끊는가 — ★**루프 본문 안**의 break 만 센다. 종전엔 파일 전역
    //  카운트라 무관한 break 하나가 자리를 채워, 둘 중 하나를 지워도 초록이었다(적대 검토 A7).
    //  ★범위는 **while 루프 본문만**이다. 뒤에 재압축 for 루프가 생기자 그 break 들이
    //   자리를 채워 또 뚫렸다(같은 실수 두 번) — 끝을 재압축 루프 시작으로 잘라 고정한다.
    const loopBody = src.slice(
      src.indexOf("while (plan.needed"),
      src.indexOf("for (let rp = 0"),
    );
    const breaks = (loopBody.match(/\n\s*break;/g) ?? []).length >= 2;
    // ★재압축은 쿨다운이 **아닐 때** 돈다. 반전하면 이중 결함이다 — 정상일 땐 영영 안 돌고
    //  (상한 무력화), 막힌 백엔드일 때만 때린다(A15).
    const recompactBlock = src.slice(src.indexOf("for (let rp = 0"), src.indexOf("if (foldedTurnsTotal"));
    const cooldownPolarity = /remainingMs\([^)]*\)\s*\?\?\s*0\)\s*!==\s*0\)\s*break;/.test(recompactBlock);
    // ★알림 발행 조건 — 접은 게 있을 때만. `>= 0` 이면 압축 안 해도 매 턴 스팸(A4).
    const publishGuard = /if\s*\(foldedTurnsTotal\s*>\s*0\)/.test(src);
    // ★watermark 는 **성공했을 때만** 전진한다 — 실행해서 본다(A11: 원문 영구 유실).
    const base = { summary: "옛 요약", watermark: 10, foldedTurns: 1, foldedChars: 100 };
    const planStub = { toFold: [1, 2, 3], nextWatermark: 99 };
    const bad = applyFoldResult(base, "5자", planStub, 5_000) as {
      next: typeof base; accepted: boolean;
    };
    const good = applyFoldResult(base, "가".repeat(600), planStub, 5_000) as {
      next: typeof base; accepted: boolean;
    };
    const watermarkSafe =
      bad.accepted === false && bad.next.watermark === 10 && bad.next.foldedTurns === 1;
    const accumulates =
      good.accepted === true &&
      good.next.watermark === 99 &&
      good.next.foldedTurns === 4 &&
      good.next.foldedChars === 5_100 &&
      good.next.summary.startsWith("옛 요약");
    // ★상수 대소 — 커밋이 "표로 확인" 이라 적었는데 **검사로는 없었다**(A1·A6·A10·A18 의 뿌리).
    const constantsOrdered =
      (CODEX_TURN_HISTORY_CHAR_CAP as number) > TRIGGER + (CODEX_SUMMARY_MAX_CHARS as number) &&
      TRIGGER > LOW &&
      LOW > BUDGET &&
      BUDGET > (CODEX_SUMMARY_MAX_CHARS as number) / 2;
    // 알림이 **턴에 한 번**인가. 사용자 신고: 저수위 도입 직후 "🗜 압축했습니다" 가 한 턴에
    // 3번 떴다 — 사용자에겐 한 번의 정리인데 **내부 패스 수가 새어 나왔다**. 발행이 하나뿐이고
    // 패스별 값(`plan.toFold.length`)이 아니라 **누적값**을 싣는지 본다.
    const publishes = (src.match(/type:\s*"llm\.compacted"/g) ?? []).length;
    const usesTotals =
      /type:\s*"llm\.compacted"[\s\S]{0,320}foldedTurns:\s*foldedTurnsTotal/.test(src) &&
      /type:\s*"llm\.compacted"[\s\S]{0,360}foldedChars:\s*foldedCharsTotal/.test(src);
    // 발행이 루프 **밖**인가 — 안이면 패스마다 나간다.
    const loopStart = src.indexOf("while (plan.needed");
    const loopEnd = src.indexOf("if (foldedTurnsTotal"); // 발행 가드 = 루프 뒤
    const publishAt = src.indexOf('type: "llm.compacted"');
    const publishOutsideLoop =
      loopStart !== -1 && loopEnd > loopStart && publishAt > loopEnd;

    return [
      assert(
        "★사고 크기(23.8만자) 스레드가 압축 뒤 **임계 아래**로 내려간다",
        end <= TRIGGER,
        `${start}자 → ${end}자 (임계 ${TRIGGER})`,
      ),
      assert(
        "★종전 동작(1패스)이었다면 **여전히 임계 위**였다 — 이 검사가 진짜 차이를 본다",
        singlePassEnd > TRIGGER,
        `1패스만: ${singlePassEnd}자 > ${TRIGGER}`,
      ),
      assert(
        "★임계 **바로 위** 스레드가 임계의 80% 아래까지 내려간다 — 진동의 본체",
        // ★기대값을 `LOW` 로 쓰면 **비율을 0.99 로 바꿔도 통과한다**(검사가 상수를 따라
        //  움직인다 — 변이로 확인). 지켜야 할 **성질**을 고정 분수로 적는다.
        nearEnd <= TRIGGER * 0.8,
        `${nearStart}자 → ${nearEnd}자 (기준 ${Math.floor(TRIGGER * 0.8)} · 저수위 ${LOW})`,
      ),
      assert(
        "저수위가 임계에 **붙어 있지 않다**(붙으면 히스테리시스가 아니라 그냥 임계다)",
        RATIO <= 0.8 && RATIO >= 0.3,
        `비율 ${RATIO} → 저수위 ${LOW} / 임계 ${TRIGGER}`,
      ),
      assert(
        "접는 **한 번의 크기**는 예산 안이다(요약 호출은 큰 입력에서 깨진다)",
        foldSizes.length > 0 && foldSizes.every((f) => f <= BUDGET),
        foldSizes.length === 0 ? "★접은 게 없다" : `${foldSizes.join("·")}자`,
      ),
      assert(
        "패스 수가 바운드다(요약 호출이 그만큼 늘어난다)",
        foldSizes.length <= MAX_PASSES && MAX_PASSES <= 4,
        `${foldSizes.length}/${MAX_PASSES}패스`,
      ),
      assert(
        "임계 아래 스레드는 **건드리지 않는다**(불필요한 요약 호출 0)",
        (
          planHistoryCompaction(turns.slice(0, Math.floor(turnCount / 4)), 0, {
            maxFoldChars: BUDGET,
          }) as { needed: boolean }
        ).needed === false,
        `${Math.floor(turnCount / 4) * per}자(임계 ${TRIGGER}) → needed=false`,
      ),
      assert(
        "★제품이 저수위까지 **반복** 접는다(루프 존재 + 재판정이 실제로 저수위 값을 쓴다)",
        hasLoop && replans,
        `loop=${String(hasLoop)} replan=${String(replans)}`,
      ),
      assert(
        "★실패·쿨다운이면 루프를 끊는다 — **while 루프 본문 안**의 break 만 센다",
        breaks,
        breaks ? "break 2곳 이상" : "★break 부족",
      ),
      assert(
        "★[배선 린트] 재압축은 쿨다운이 **아닐 때** 돈다(반전하면 막힌 백엔드만 때린다)",
        cooldownPolarity,
        cooldownPolarity ? "!== 0 → break" : "★극성이 뒤집혔거나 게이트가 없다",
      ),
      assert(
        "★압축 알림은 **턴에 한 번**이다 — 여러 번 접어도 사용자에겐 한 번의 정리",
        publishes === 1 && publishOutsideLoop && publishGuard,
        `발행 ${publishes}곳 · 루프 밖=${String(publishOutsideLoop)} · 조건=${String(publishGuard)}`,
      ),
      assert(
        "★요약이 쓸모없으면 **watermark 가 안 움직인다**(원문 영구 유실 차단)",
        watermarkSafe,
        `수락=${String(bad.accepted)} · watermark ${bad.next.watermark}(10 유지여야)`,
      ),
      assert(
        "★성공하면 요약을 덧붙이고 watermark·합계가 함께 전진한다",
        accumulates,
        `wm=${good.next.watermark} 턴=${good.next.foldedTurns} 자=${good.next.foldedChars}`,
      ),
      assert(
        "★상수 대소가 성립한다(프롬프트 캡 > 임계+요약상한 > 저수위 > 폴드예산)",
        constantsOrdered,
        `캡 ${CODEX_TURN_HISTORY_CHAR_CAP} / 임계 ${TRIGGER} / 저수위 ${LOW} / 폴드 ${BUDGET} / 요약상한 ${CODEX_SUMMARY_MAX_CHARS}`,
      ),
      assert(
        "[배선 린트] 알림 수치가 **합계**다(패스 하나치가 아니라 그 턴에 접은 전부)",
        usesTotals,
        usesTotals ? "foldedTurnsTotal·foldedCharsTotal" : "★패스별 값을 싣고 있다",
      ),
    ];
  },
};
