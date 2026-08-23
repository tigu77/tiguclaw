/**
 * 회귀: 한도 리셋 안내가 **읽을 수 있는 시각**이고, 문구가 한 곳에서 나온다 (2026-08-14).
 *
 * 사고(사용자 신고): 윈도우 인스턴스가 이렇게 보냈다 —
 *   `⚠️ codex 백엔드 사용 한도(rate limit)에 도달했습니다. 약 8118분 후 리셋됩니다.`
 * **8,118분이 5.6일**이라는 걸 사용자가 암산해야 한다. 이 문장의 유일한 목적이 "언제 다시
 * 시도하나" 인데 그게 무너진다. 분은 한 시간 안쪽에서만 쓸모 있다.
 *
 * ★그리고 같은 판단이 **두 곳**에 각자 적혀 있었다(`index.ts` 채널 응답 · `worker-jobs`
 *  워커 통지). 한쪽만 고치면 다른 쪽이 늙는다 — 오늘만 같은 부류로 두 번 겪었다
 *  (도구 느림 문구도 로그만 고치고 채널 푸시를 빠뜨렸었다).
 *
 * ★로케일 API 를 쓰지 않는다. 같은 코드가 맥·윈도우·리눅스에서 도는데
 *  `toLocaleTimeString("ko-KR")` 은 ICU 에 따라 `오전 3:14`·`AM 3:14`·`3:14 AM` 로 갈린다
 *  (실측: 맥에서 `AM 3:14`). 사용자에게 나가는 문장이 플랫폼마다 다르면 그 자체가 결함이다.
 */
import { readFile } from "node:fs/promises";
import { formatResetAt } from "../../core/llm-runtime/rate-limit.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

// 기준 시각 고정 — 실행 시각에 따라 결과가 흔들리면 검사가 아니다.
const NOW = new Date("2026-08-14T23:14:00+09:00").getTime();

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 사고 재현 — 5.6일을 분으로 말하지 않는다 ──────────────────────────────
  const long = formatResetAt(8118 * 60_000, NOW);
  out.push(
    assert(
      "★긴 한도는 **날짜·시각**으로 말한다(8118분 같은 숫자 금지)",
      !/\d{3,}분/.test(long) && /월 \d+일/.test(long) && /일 후/.test(long),
      long,
    ),
  );

  // ── ② 짧은 건 분이 맞다 — 과잉 교정 금지 ────────────────────────────────────
  out.push(assert("한 시간 안쪽은 분으로", formatResetAt(3 * 60_000, NOW) === "약 3분 후", formatResetAt(3 * 60_000, NOW)));
  out.push(
    assert(
      "하루 안쪽이면 시각 + 상대시간",
      /\d+시 \d{2}분쯤 \(약 \d+시간 후\)/.test(formatResetAt(4 * 3600_000, NOW)),
      formatResetAt(4 * 3600_000, NOW),
    ),
  );

  // ── ③ 플랫폼 독립 — 로케일 API 를 안 쓴다 ───────────────────────────────────
  //  ICU 차이로 문장이 갈리면 윈도우 사용자만 다른 걸 본다(원격이라 확인도 어렵다).
  {
    const raw = await readFile(
      new URL("../../core/llm-runtime/rate-limit.ts", import.meta.url),
      "utf8",
    );
    // ★주석은 빼고 본다 — "왜 안 쓰는지" 설명하는 글에 그 이름이 나오는 건 당연하고,
    //  그걸 위반으로 세면 **설명을 지워야 초록이 되는** 검사가 된다(오늘 아침 게이트에서
    //  겪은 것과 같은 오탐: 판정 대상은 코드지 그걸 설명하는 글이 아니다).
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const uses = /toLocale(Time|Date)String/.test(src);
    out.push(
      assert(
        "★로케일 API 를 쓰지 않는다(플랫폼마다 다른 문장 금지)",
        !uses,
        uses ? "toLocale* 사용 — ICU 에 따라 갈린다" : "직접 조립 확인(주석 제외 판정)",
      ),
    );
    out.push(
      assert(
        "오전/오후 표기가 한국어로 박혀 있다",
        raw.includes('"오전"') && raw.includes('"오후"'),
        "한국어 표기 확인",
      ),
    );
  }

  // ── ④ ★소비처 둘이 **같은 함수**를 쓴다 — 이번 사고의 뿌리 ──────────────────
  //  각자 만들면 한쪽만 늙는다. 자체 계산(`/ 60000` 후 "분")이 남아 있으면 그게 신호다.
  {
    const idx = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const wj = await readFile(new URL("../../core/worker-jobs.ts", import.meta.url), "utf8");
    const bothUse = idx.includes("formatResetAt(") && wj.includes("formatResetAt(");
    // ★**주석은 빼고** 본다 (2026-08-22). 이 규칙을 *설명하는 글* 안에 든 코드 예시를
    //  코드로 세서 상시 FAIL 했다 — `verify-dashboard-split` 이 주석 속 `<style>` 을 태그로
    //  세던 것과 같은 부류다([[feedback_gate_must_actually_run]]: 검사 대상은 코드이지 그걸
    //  설명하는 글이 아니다). 오탐이 나면 사람이 검사를 끄거나 무시하게 되고, 그 순간 이
    //  게이트에만 있던 판정이 죽는다.
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const ownMathRe = /Math\.round\([^)]*\/\s*60_?000\)[^;]*분/;
    const ownMath =
      ownMathRe.test(stripComments(idx)) || ownMathRe.test(stripComments(wj));
    out.push(
      assert(
        "★채널 응답·워커 통지가 같은 문구 함수를 쓴다(자체 계산 금지)",
        bothUse && !ownMath,
        `index=${idx.includes("formatResetAt(")} worker=${wj.includes("formatResetAt(")} 자체계산=${ownMath}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "reset-time-is-readable",
  guards:
    "한도 리셋 안내가 `약 8118분 후`(5.6일)처럼 읽을 수 없는 숫자로 나가던 것 + 같은 문구를 채널 응답과 워커 통지가 각자 만들어 한쪽만 늙던 것",
  run,
};
