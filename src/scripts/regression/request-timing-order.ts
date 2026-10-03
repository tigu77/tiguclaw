/**
 * 회귀: **어댑터가 시각을 찍는 순서**가 맞는가 — 가짜 codex 백엔드로 실제 턴을 돌려 잰다 (2026-10-03).
 *
 * `request-timing` 은 구간 계산(순수 함수)을 잰다. 그런데 적대 검토(2026-10-02 G1)가 보였듯 «어댑터가 언제 찍나» 는
 * 거기서 안 보인다 — 시도마다 하던 초기화를 빼거나, 첫 전송을 매 시도로 덮거나, 요청을 목록에 안 넣어도 초록이었다.
 * 여기선 백엔드가 헤더 H · 첫 진전 T · 끝 O 만큼 쉬게 만들고, 요청 두 번의 칸이 그 값과 맞는지 본다(아래 한도는 sleep 이
 * 보장하는 최소치와 느린 CI 여유). 실패 턴이 «어디서 멈췄나» 를 남기는지, `llm.turn_done` 에 같은 값이 실리는지도.
 */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";

type Timing = { requests: number; setupMs?: number; betweenMs: number; firstOutputMs: number; outputMs: number; residualMs?: number };

export const check: RegressionCheck = {
  name: "request-timing-order",
  guards: "어댑터가 요청 시각을 엉뚱한 자리에서 찍거나 빠뜨려 «도구 밖 시간» 분해가 틀리던 것 + 실패 턴·DB 에 분해가 안 남던 것",
  run: async () => {
    const r = await spawnWithin(60_000, "요청 시간 분해", ["--import", "tsx", fileURLToPath(new URL("./_request-timing-child.ts", import.meta.url))], {
      env: { ...process.env, CODEX_NO_PROGRESS_MS: "400", CODEX_STALL_BACKOFF_MS: "50", CODEX_CACHE_CURVE: "1" },
    });
    const line = r.out.split(/\r?\n/).find((l) => l.startsWith("TIMING_RESULT "));
    const v = (line === undefined ? {} : JSON.parse(line.slice("TIMING_RESULT ".length))) as {
      H?: number; T?: number; O?: number; endLine?: string | null; failLine?: string | null;
      outputTiming?: Timing | null; turnDoneTiming?: Timing | null; failed?: boolean;
      stallTiming?: (Timing & { stalledMs?: number }) | null; stallCalls?: number; headerSecs?: number[];
    };
    const st = v.stallTiming ?? undefined;
    const t = v.outputTiming ?? undefined;
    const H = v.H ?? 0, T = v.T ?? 0, O = v.O ?? 0;
    const firstMin = 2 * (H + T) * 0.95, outMin = 2 * O * 0.95;
    return [
      assert("하네스가 결과를 냈다", line !== undefined, r.out.slice(-600)),
      assert(
        "★요청 두 번: «첫출력까지» ≈ 2·(헤더+첫 진전) · «출력» ≈ 2·(끝까지) · 도구·후처리는 짧다",
        t !== undefined && t.requests === 2 && t.firstOutputMs >= firstMin && t.firstOutputMs <= firstMin + 600 &&
          // 도구·후처리는 «직전 응답 끝 → 다음 준비» 다. 직전 요청 하나(≥ 헤더+진전+끝)보다 짧아야 한다 — 시작 시각을 끝 대신 쓰면 여기가 부푼다.
          t.outputMs >= outMin && t.outputMs <= outMin + 500 && t.betweenMs < (H + T + O) * 0.8,
        { t, firstMin, outMin },
      ),
      assert(
        "요청별 상세 줄의 «헤더» 칸이 백엔드가 쉰 시간만큼 나온다(턴 줄에선 «첫출력까지» 에 묶여 안 보인다)",
        (v.headerSecs ?? []).length === 2 && (v.headerSecs ?? []).every((x) => x >= (H / 1000) * 0.9 && x < 1),
        v.headerSecs,
      ),
      assert("턴 줄 앞에 «턴 준비», 뒤에 «그 밖» 이 있고 요약도 그 둘을 갖는다", /시간=턴 준비 [\d.]+s·.*·그 밖 [\d.]+s 요청=2회/.test(v.endLine ?? "") && t?.setupMs !== undefined && t?.residualMs !== undefined, v.endLine),
      assert(
        "★무진전 재개: 버린 시도는 «무진전» 칸(≥ 판정 400ms) · «첫출력까지» 는 마지막 시도만(헤더+첫 진전) · 요청은 하나",
        st !== undefined && v.stallCalls === 2 && st.requests === 1 && (st.stalledMs ?? 0) >= 400 &&
          st.firstOutputMs >= (H + T) * 0.95 && st.firstOutputMs <= (H + T) * 0.95 + 400,
        { st, stallCalls: v.stallCalls },
      ),
      assert("★`llm.turn_done` 에 어댑터와 같은 분해가 실린다(DB 로 남는다)", JSON.stringify(v.turnDoneTiming) === JSON.stringify(v.outputTiming) && v.turnDoneTiming !== null, { turnDone: v.turnDoneTiming }),
      assert("★실패 턴도 분해를 남기고, 끝나지 않은 요청이 «출력 중» 에 멈췄다고 적는다", v.failed === true && /\[codex-turn-fail\][^\n]*시간=[^\n]*미완=[\d.]+s\(출력 중\)/.test(v.failLine ?? ""), v.failLine),
    ];
  },
};
