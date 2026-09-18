/**
 * 회귀: **매니저 목록이 «도구가 아직 돌고 있다» 를 말하는가** (2026-09-18, 아스트라 제보).
 *
 * ★배경 — 매니저 셋이 21분·2시간·53분 멈췄고, 세 번 다 같은 foreground Bash 였다. 그때
 *  `list_workers` 는 «마지막: Bash 52분 전» 이라고 답했다. 그 문장은 **두 가지로 읽힌다**:
 *  «52분 전에 쓰고 조용» / «52분째 실행 중». 전자로 읽혀 «모델이 멈췄다» 는 오진과 엉뚱한
 *  어댑터 가설이 나왔고, 약 3시간이 갔다.
 *
 * ★★정답은 **로그에 있었다**(`[warn] [tool-slow]`). 감지도 했고 원인 후보까지 만들어
 *  뒀는데 **판단하는 자에게 도착하지 않았다.** 이 세션에서 우리가 남에게 한 말이
 *  (「로그에만 있는 진단은 모델에게 없는 것이다」) 우리 쪽에도 그대로 있었다.
 *
 * ★그래서 이 검사는 «문구가 예쁜가» 가 아니라 **«두 상태가 서로 다른 문장으로 나오는가»**
 *  를 잰다. 같은 문장으로 나오면 그게 결함이다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { workerActivityLine } from "../../core/worker-activity-line.js";

const elapsed = (a: number, b: number): string => `${Math.floor((b - a) / 60_000)}분`;
const NOW = 10_000_000;

export const check: RegressionCheck = {
  name: "worker-list-says-if-a-tool-is-stuck",
  guards:
    "매니저 목록이 «도구가 52분째 안 끝났다» 와 «52분째 조용하다» 를 같은 문장으로 말해, 멈춘 도구를 «모델이 멈췄다» 로 오진하게 만들던 것 — 실제로 매니저 셋·약 3시간이 그렇게 갔다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const lastBash = { label: "Bash", ts: NOW - 52 * 60_000, kind: "tool" };

    // ── ① 감시자가 «아직 돈다» 를 봤다 → **그렇게 말해야 한다** ────────────────
    const stuck = workerActivityLine({
      last: lastBash,
      // 도구 시작 52분 전 · 감시자는 10분 뒤에 울렸다(그때까지 600초 경과).
      slow: { tool: "Bash", ms: 600_000, ts: NOW - 42 * 60_000 },
      now: NOW,
      elapsed,
    });
    out.push(
      assert(
        "★**«실행 중» 이라고 말한다** — «마지막 활동» 이 아니라(그게 세 번 오진을 만들었다)",
        stuck.includes("실행 중") && stuck.includes("아직 반환하지 않았습니다"),
        stuck,
      ),
    );
    out.push(
      assert(
        "★경과는 **도구가 시작한 때부터** 센다 — 감시자가 울린 때부터가 아니다",
        stuck.includes("52분째"),
        `${stuck} · 42분이면 감시자 시각에서 센 것이다`,
      ),
    );

    // ── ② 증거가 없으면 **단정하지 않는다** ─────────────────────────────────
    const quiet = workerActivityLine({ last: lastBash, slow: null, now: NOW, elapsed });
    out.push(
      assert(
        "감시자 신호가 없으면 «실행 중» 이라고 **단정하지 않는다** — 다만 «도구 시작» 임은 밝힌다",
        !quiet.includes("실행 중") && quiet.includes("시작"),
        quiet,
      ),
    );
    out.push(
      assert(
        "★★두 상태가 **서로 다른 문장**이다 — 같으면 읽는 쪽이 가를 수가 없다",
        stuck !== quiet,
        `막힘=${stuck} / 조용=${quiet}`,
      ),
    );

    // ── ③ 순서 — 낡은 감시자 신호를 «지금 막혔다» 로 읽지 않는다 ──────────────
    const oldSignal = workerActivityLine({
      last: { label: "Read", ts: NOW - 60_000, kind: "tool" },
      slow: { tool: "Bash", ms: 600_000, ts: NOW - 30 * 60_000 }, // 그 뒤 Read 가 돌았다
      now: NOW,
      elapsed,
    });
    out.push(
      assert(
        "★감시자 신호 **뒤에** 다른 활동이 있었으면 그 도구는 끝난 것이다 — 낡은 신호를 안 쓴다",
        !oldSignal.includes("실행 중") && oldSignal.includes("Read"),
        oldSignal,
      ),
    );

    // ── ④ 도구가 아닌 활동·활동 없음 ────────────────────────────────────────
    out.push(
      assert(
        "도구가 아닌 활동은 «시작» 을 안 붙인다 · 활동이 아예 없으면 **아무 말도 안 한다**",
        !workerActivityLine({
          last: { label: "생각 중", ts: NOW - 60_000, kind: "turn" },
          slow: null,
          now: NOW,
          elapsed,
        }).includes("시작") &&
          workerActivityLine({ last: null, slow: null, now: NOW, elapsed }) === "",
        `turn=${workerActivityLine({ last: { label: "생각 중", ts: NOW - 60_000, kind: "turn" }, slow: null, now: NOW, elapsed })}`,
      ),
    );
    out.push(
      assert(
        "활동 기록이 없어도 감시자 신호만 있으면 **그것만으로 말한다**",
        workerActivityLine({
          last: null,
          slow: { tool: "Bash", ms: 600_000, ts: NOW - 60_000 },
          now: NOW,
          elapsed,
        }).includes("실행 중"),
        workerActivityLine({ last: null, slow: { tool: "Bash", ms: 600_000, ts: NOW - 60_000 }, now: NOW, elapsed }),
      ),
    );
    return await Promise.resolve(out);
  },
};
