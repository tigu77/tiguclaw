/**
 * 진행 중 메인 턴 관측 심 (2026-08-01, A5 실사고).
 *
 * ★왜 있나: 배포하며 데몬을 재시작했는데 그 순간 사용자 턴이 돌고 있었다. 재시작 전에 확인한
 *  것은 `/health` 의 `ok:true` 였고, 그건 **데몬이 살아있는지**만 말해준다 —
 *  **지금 누구를 위해 일하고 있는지**는 어디에도 없었다. 답변 하나가 통째로 유실됐다.
 *
 * ★왜 심(injection)인가: 진짜 레지스트리는 `src/index.ts` 의 `inflightTurns` 하나뿐이다.
 *  http-bridge 플러그인이 그걸 직접 못 읽는다고 카운터를 하나 더 두면 **둘이 어긋난다**
 *  (손으로 관리하는 목록과 같은 병 — 어긋난 사실이 안 보인다). 그래서 사본을 만들지 않고
 *  index.ts 가 자기 Map 을 보는 getter 를 여기 꽂는다. 단일 진실은 계속 Map 이다.
 *  `setSelfUpdateRestart` 와 같은 컨벤션.
 */

interface InflightReporter {
  count: () => number;
  keys: () => string[];
}

let reporter: InflightReporter | null = null;

/** index.ts 부팅 시 1회 등록. 미등록이면 관측은 "모름"(0 이 아니라)으로 답한다. */
export const setInflightTurnReporter = (r: InflightReporter): void => {
  reporter = r;
};

/**
 * 진행 중 메인 턴 수. **미등록이면 `null`** — 0 과 구분해야 한다. 0 으로 답하면
 * "지금 재시작해도 안전" 이라는 뜻이 되는데, 미등록은 그걸 보장하지 않는다
 * (모르는 것을 안전으로 읽으면 그게 이번 사고의 형상이다).
 */
export const getInflightTurns = (): { count: number; keys: string[] } | null =>
  reporter === null ? null : { count: reporter.count(), keys: reporter.keys() };

/** 통지 문구 — 무엇이 일어났고 무엇이 남지 않았고 무엇을 하면 되는지. */
export const RESTART_INTERRUPT_TEXT =
  "⚠️ 진행 중이던 작업이 데몬 재시작으로 중단됐습니다. 답변을 만들던 중이었고 그 내용은 남지 않았습니다 — 같은 요청을 다시 보내주세요.";

export interface InterruptedTurn {
  readonly ac: AbortController;
  readonly channel: string;
  readonly target: string | null;
}

/**
 * 진행 중이던 메인 턴에 **중단을 정직 통지**하고 턴을 끊는다. shutdown 이 채널을 닫기
 * **전에** 부른다(닫힌 뒤엔 발송 경로가 없다).
 *
 * ★`send` 를 주입받는 이유: ESM 모듈은 읽기 전용이라 `deliverOutbound` 를 목으로 못 바꾼다.
 *  경계를 인자로 열어두면 회귀가 **프로덕션 로직 그대로** 돌리면서 발송된 것을 볼 수 있다
 *  (소스에 통지 코드가 있는지 보는 정규식은 이 사고를 못 막는다 — 사고 당시에도 "정직"
 *  이라는 주석은 있었다).
 *
 * 발송 실패는 삼킨다 — 통지 실패가 종료를 막으면 안 된다(force-exit 백스톱이 있다).
 * @returns 실제로 통지에 성공한 건수.
 */
export const notifyInterruptedTurns = async (
  turns: readonly InterruptedTurn[],
  send: (a: {
    channel: string;
    target: string | null;
    text: string;
    label: string;
  }) => Promise<{ delivered: boolean; reason?: string }>,
  onError?: (channel: string, reason: string) => void,
): Promise<number> => {
  let notified = 0;
  await Promise.all(
    turns.map(async (t) => {
      // 통지만 하고 턴을 안 끊으면 살아남은 턴이 답장을 한 통 더 낸다(이중 답장).
      t.ac.abort(new Error("데몬 재시작으로 중단"));
      try {
        const r = await send({
          channel: t.channel,
          target: t.target,
          text: RESTART_INTERRUPT_TEXT,
          label: "restart-interrupt",
        });
        // ★`delivered:false` 는 **throw 하지 않는다** — 반환값을 안 보면 통지 자체가 조용히
        //  유실되고 "알렸다" 고 기록된다(A4e 와 같은 병). 성공만 센다.
        if (r.delivered) notified += 1;
        else onError?.(t.channel, r.reason ?? "미배달(사유 없음)");
      } catch (e) {
        onError?.(t.channel, e instanceof Error ? e.message : String(e));
      }
    }),
  );
  return notified;
};
