/**
 * 회귀: **현지 날짜와 UTC 날짜가 갈리는 동안엔 환경 블록이 둘을 같이 적는다** (2026-10-02).
 *
 * 새벽 위키 루틴(KST 02:20)의 매니저가 검증·커밋을 멈췄다 — Codex 호스트 웹 검색이 붙으면 서버가 UTC 날짜(10월 1일)를
 * 숨은 지침으로 넣는데, 환경 블록은 현지 날짜(10월 2일)만 적어 «상위 지침과 요청 날짜가 충돌» 로 읽었다.
 * 시간대에 기대지 않게 순수 함수를 오프셋으로 부른다(CI 는 UTC 라 기기 시간대로는 이 줄이 영영 안 나온다).
 */
import { formatEnvContext, utcDateNote } from "../../core/runtime-env.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "env-utc-date-note",
  guards: "KST 새벽처럼 현지 날짜와 UTC 날짜가 갈릴 때 서버가 넣은 UTC 날짜를 모델이 지침 충돌로 읽고 작업을 멈추던 것",
  run: async (): Promise<Assertion[]> => {
    const kstDawn = new Date("2026-10-01T17:20:00Z"); // KST 2026-10-02 02:20
    const kstNoon = new Date("2026-10-02T03:00:00Z"); // KST 2026-10-02 12:00
    const dawn = utcDateNote(kstDawn, 540);
    const noon = utcDateNote(kstNoon, 540);
    const west = utcDateNote(new Date("2026-10-02T05:00:00Z"), -480); // PDT 2026-10-01 22:00
    const half = utcDateNote(new Date("2026-10-01T20:00:00Z"), 330); // IST 2026-10-02 01:30
    // 배선 — 시간대를 **바꿔 가며** 블록을 만든다. 기계 시간대에 기대면 한쪽 변이만 잡힌다(KST 에선 «오프셋 상수»,
    //  UTC 에선 «줄 삭제» 가 통과했다 — 2026-10-02 적대 검토 G-1). Node 는 실행 중 TZ 변경을 따른다.
    const prevTz = process.env.TZ;
    const envIn = (tz: string, now: Date): boolean => { process.env.TZ = tz; return formatEnvContext({ cwd: "/tmp", now }).includes("UTC date: "); };
    let wired: Record<string, boolean>;
    try {
      wired = { seoulDawn: envIn("Asia/Seoul", kstDawn), seoulNoon: envIn("Asia/Seoul", kstNoon), utcDawn: envIn("UTC", kstDawn), laEvening: envIn("America/Los_Angeles", new Date("2026-10-02T05:00:00Z")) };
    } finally {
      // 던져도 원복한다 — 안 그러면 뒤의 검사들이 바뀐 시간대로 돈다
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    }
    return [
      assert("★갈리는 동안(KST 02:20)엔 UTC 날짜와 오프셋을 같이 적는다", dawn !== undefined && dawn.includes("2026-10-01") && dawn.includes("UTC+09:00") && dawn.includes("same moment") && dawn.includes("use 2026-10-02"), dawn),
      assert("갈리지 않으면 아무것도 붙이지 않는다(KST 정오)", noon === undefined, noon),
      assert("서쪽(음수 오프셋)·30분 단위 오프셋도 맞게 적는다", west?.includes("2026-10-02") === true && west.includes("UTC-08:00") && half?.includes("UTC+05:30") === true, { west, half }),
      assert("환경 블록이 이 판정을 거쳐 그 줄을 싣는다 — 서울 새벽·LA 저녁엔 붙고, 서울 정오·UTC 기계엔 안 붙는다", wired.seoulDawn === true && wired.laEvening === true && wired.seoulNoon === false && wired.utcDawn === false, wired),
    ];
  },
};
