/**
 * 회귀: **재시작이 진행 중 메인 턴을 조용히 죽이지 않는다** (2026-08-01 A5, 실사고).
 *
 * 사고: 배포하며 `daemon:restart` 를 눌렀는데 그 순간 사용자 턴이 돌고 있었다.
 *   00:10:42 사용자 질문 → 00:10:48 codex 실패(쿨다운) → 00:11:27~00:12:23 claude 폴백 작동
 *   → **00:13:22 재시작** → `turn_done` 없음·답장 없음 → 7분 뒤 "응답이 없다" 신고.
 *
 * 뿌리는 두 가지였다.
 *  ①`inflightTurns` 주석이 "재시작 정직" 이라고 **적어만** 놓고 알리는 코드가 없었다.
 *   워커 잡은 부팅 복구가 "데몬 재시작으로 중단" 을 통지하는데(recoverInterruptedJobs)
 *   **메인 턴만** 없었다 — 사용자에겐 그냥 답이 안 오는 것으로 보인다.
 *  ②레지스트리 값이 `AbortController` 하나라 **누구에게 알릴지**를 몰랐다.
 *   (통지 좌표를 담은 자매 Map 을 하나 더 두면 둘이 어긋난다 → 값에 같이 담았다.)
 *
 * ★검사 방식: 소스에 통지 코드가 있는지 보는 정규식은 이 사고를 못 막는다 —
 *  사고 당시에도 "정직" 이라는 **주석**은 있었다. 그래서 실제 shutdown 경로를 밟혀
 *  **발송된 텍스트를 관측**한다.
 */
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceOrder } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "restart-interrupt-honesty",
  guards:
    "데몬 재시작이 진행 중이던 메인 턴을 통지 없이 죽여 사용자가 무응답으로 겪던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 관측 심 — 미등록이면 **null**(0 아님). 0 으로 답하면 "재시작해도 안전" 이라는
    //  뜻이 되는데 미등록은 그걸 보장하지 않는다. 모르는 것을 안전으로 읽은 게 사고의 형상.
    const { getInflightTurns, setInflightTurnReporter } = await import(
      "../../core/inflight-turns.js"
    );
    out.push(
      assert(
        "★미등록 상태의 진행중턴 조회는 null 이다(0 과 구분 — 모름≠안전)",
        getInflightTurns() === null,
        String(JSON.stringify(getInflightTurns())),
      ),
    );

    // 등록하면 **사본이 아니라 실제 레지스트리**를 본다 — getter 주입이라 어긋날 수 없다.
    const live = new Map<string, number>();
    setInflightTurnReporter({ count: () => live.size, keys: () => [...live.keys()] });
    live.set("dashboard:a", 1);
    live.set("telegram:b", 1);
    const seen = getInflightTurns();
    out.push(
      assert(
        "★관측값이 실제 레지스트리를 따라간다(사본 0)",
        seen?.count === 2 && seen.keys.includes("dashboard:a"),
        `count=${String(seen?.count)} keys=${(seen?.keys ?? []).join(",")}`,
      ),
    );
    live.delete("dashboard:a");
    out.push(
      assert(
        "레지스트리가 줄면 관측값도 준다",
        getInflightTurns()?.count === 1,
        `count=${String(getInflightTurns()?.count)}`,
      ),
    );

    // ★② shutdown 이 **채널을 닫기 전에** 통지한다 — 순서가 뒤집히면 발송 경로가 이미 없다.
    //  (이건 순서 계약이라 소스 순서로 본다. 아래 ③ 이 실제 발송을 동작으로 확인한다.)
    const order = await sourceOrder("../../index.ts", [
      /const shutdown = async \(signal: string\): Promise<void> => \{/,
      /if \(inflightTurns\.size > 0\) \{/,
      /await notifyInterruptedTurns\(/,
      /for \(const ch of channels\) \{/,
    ]);
    out.push(
      assert(
        "★중단 통지가 채널 stop() 보다 **먼저** 있다(닫힌 채널로는 못 보낸다)",
        order.ok,
        order.detail,
      ),
    );

    // ★③ 통지가 실제로 나간다 — **프로덕션 함수**를 돌리고 발송된 것을 본다.
    //  (ESM 모듈은 읽기 전용이라 deliverOutbound 를 목으로 못 바꾼다. 그래서 통지 로직이
    //   send 를 인자로 받는다 — 경계를 열어야 검사가 진짜가 된다.)
    const { notifyInterruptedTurns, RESTART_INTERRUPT_TEXT } = await import(
      "../../core/inflight-turns.js"
    );
    const sent: Array<{ channel: string; text: string; label: string }> = [];
    const entries = [
      { ac: new AbortController(), channel: "telegram", target: "12345" },
      { ac: new AbortController(), channel: "http-bridge", target: "dashboard:x" },
    ];
    const r = await within(
      10_000,
      "중단 통지 발송",
      notifyInterruptedTurns(entries, async (a) => {
        sent.push({ channel: a.channel, text: a.text, label: a.label });
        return { delivered: true };
      }),
    );
    out.push(
      assert(
        "★진행 중이던 턴 전부에 통지가 나간다(채널 무관 — 텔레그램·대시보드)",
        !("timedOut" in r) && r.value === 2 && sent.length === 2,
        `발송 ${sent.length}건: ${sent.map((s) => s.channel).join(",")}`,
      ),
    );
    out.push(
      assert(
        "★통지가 '중단됐다 + 내용이 남지 않았다 + 다시 보내라' 를 말한다(조용한 손실 0)",
        RESTART_INTERRUPT_TEXT.includes("중단") &&
          RESTART_INTERRUPT_TEXT.includes("남지 않") &&
          RESTART_INTERRUPT_TEXT.includes("다시"),
        RESTART_INTERRUPT_TEXT.slice(0, 60),
      ),
    );
    out.push(
      assert(
        "통지에 라벨이 붙어 관측에서 구분된다",
        sent.every((s) => s.label === "restart-interrupt"),
        sent.map((s) => s.label).join(","),
      ),
    );
    // 대조군 — 통지만 하고 턴을 안 끊으면 살아남은 턴이 답장을 한 통 더 낸다.
    out.push(
      assert(
        "대조군 — 통지 대상 턴은 abort 된다(이중 답장 0)",
        entries.every((e) => e.ac.signal.aborted),
        entries.map((e) => String(e.ac.signal.aborted)).join(","),
      ),
    );
    // ★미배달을 **성공으로 세지 않는다** — deliverOutbound 는 실패를 throw 가 아니라
    //  `delivered:false` 로 알린다. 반환값을 안 보면 "알렸다" 고 거짓 기록된다(A4e 와 같은 병).
    const failLog: string[] = [];
    const failed = await notifyInterruptedTurns(
      [{ ac: new AbortController(), channel: "telegram", target: null }],
      async () => ({ delivered: false, reason: "채널 미등록" }),
      (ch, reason) => failLog.push(`${ch}:${reason}`),
    );
    out.push(
      assert(
        "★미배달은 성공으로 세지 않고 사유를 남긴다",
        failed === 0 && failLog.length === 1 && failLog[0].includes("채널 미등록"),
        `성공 ${failed}건 · 로그 ${failLog.join(" ")}`,
      ),
    );
    return out;
  },
};
