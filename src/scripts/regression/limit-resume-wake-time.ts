/**
 * 회귀: **한도로 멈춘 턴에 «그 풀을 언제 다시 쓸 수 있나» 가 실린다** (2026-10-23 — 설계 docs/decisions/2026-10-22-limit-auto-resume-design.md §3.2·§7 R4).
 *
 * 한도 자동 이어가기의 재료다. 판정은 런타임 한 곳(`runPool`)이 오류를 꾸미기 **전에** 하고, 두 출구는 그 칸만 읽는다.
 * 지키는 것:
 *  ① `[A, B]` 에서 A 가 도구 실행 뒤 한도 → B 가 쉬지 않으면 «지금» · 부분 실행 사유도 같이 실린다
 *  ② 단일 풀 → 그 provider 의 해제 시각 · ⑦ 장부(`until_ts`)는 백엔드가 말한 값 그대로(여유는 재개 타이머에만)
 *  ③ 풀 전부 쉬는 중 → 가장 이른 해제 · ④ 용량 상한을 넘는 후보는 «지금 가능» 에 안 센다
 *  ⑤ 401 → 재개 없음 · ⑥ 재개 판정이 탐침 시각을 안 바꾼다 · ⑧ 이번 실행에서 한도 아닌 이유로 실패한 후보는 뺀다
 *  ⑨ 앞 풀이 구조적으로 거부되면 다음 풀 기준 · ⑩⑪⑫ 도구 이름에 `quota`·`rate_limit` 이 들어도 한도가 아니면 재개 없음
 *
 * 등급: **동작** — 실제 `runRegionA` 를 가짜 어댑터로 자식 프로세스에서 돌린다(용량 상한을 하위 홈 설정에 써야 해서). 모델 호출 0.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_limit-resume-runtime-child.ts");
type J = Record<string, Record<string, unknown>>;

export const check: RegressionCheck = {
  name: "limit-resume-wake-time",
  guards:
    "구독 한도로 멈춘 일을 풀린 뒤 이어 가려면 «언제 풀리나» 를 알아야 하는데, 쓸 수 있는 후보·이번에 실패한 후보·용량 상한·도구 이름에 섞인 «quota» 를 가리지 않으면 엉뚱한 시각에 깨운다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const r = await spawnWithin(90_000, "limit-resume-runtime", ["--import", "tsx", CHILD], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (r.timedOut || line === undefined) return [assert("자식이 결과를 낸다", false, r.timedOut ? "timeout" : r.err.slice(-300))];
    const d = JSON.parse(line) as J;
    const show = (k: string): string => JSON.stringify(d[k]).slice(0, 240);
    const near = (v: unknown, want: number, tol = 3): boolean => typeof v === "number" && Math.abs(v - want) <= tol;
    return [
      assert("①★`[A,B]` 에서 A 가 도구 실행 뒤 한도 → B 가 쉬지 않으니 «지금»(재실행은 안 한다 — 시도 1회)", near(d.sideEffectThenLimit!.rel, 0) && (d.sideEffectThenLimit!.attempts as string[]).length === 1, show("sideEffectThenLimit")),
      assert("① 부분 실행 사유가 구조화 칸으로 실린다(도구 이름 포함)", String(d.sideEffectThenLimit!.partial ?? "").includes("send_file"), show("sideEffectThenLimit")),
      assert("②★단일 풀 → 그 provider 의 해제 시각(장부와 같은 값)", near(d.single!.rel, 3600) && d.single!.equal === true, show("single")),
      assert("⑦ 장부 해제 시각은 백엔드가 말한 값 그대로(여유를 장부에 더하지 않는다)", near(d.single!.ledgerRel, 3600), show("single")),
      assert("③ 풀 전부 쉬는 중 → 가장 이른 해제(min)", near(d.allCooling!.rel, 900), show("allCooling")),
      assert("④★용량 상한을 넘는 후보는 «지금 가능» 에 안 센다", near(d.capacity!.rel, 600) && (d.capacity!.attempts as string[]).join() === "regr-a", show("capacity")),
      assert("⑤ 인증 거부(401)는 한도가 아니다 → 재개 없음", d.auth!.rel === null, show("auth")),
      assert("⑥ 재개 판정이 탐침 시각(last_probe_ts)을 안 바꾼다", d.probe!.probeUnchanged === true && near(d.probe!.rel, 600), show("probe")),
      assert("⑧★이번 실행에서 한도 아닌 이유로 실패한 후보는 «지금 가능» 에서 뺀다", near(d.otherExcluded!.rel, 1200), show("otherExcluded")),
      assert("⑨ 앞 풀 구조적 거부 → 다음 풀에서 한도 → 다음 풀 기준", near(d.nextPool!.rel, 1500) && (d.nextPool!.attempts as string[]).join() === "regr-a,regr-b", show("nextPool")),
      assert("⑩★한도가 아닌 오류 + 이름에 quota/rate_limit 이 든 도구 실행 뒤 → 재개 없음(사유 문장을 분류하지 않는다)", d.toolNameNotLimit!.rel === null && d.toolNameNotLimit!.msgHasTool === true, show("toolNameNotLimit")),
      assert("⑪ 401 + 그 도구 이름 → 재개 없음", d.authWithToolName!.rel === null, show("authWithToolName")),
      assert("⑫ 도구 멈춤(이름 rate_limit_status) → 재개 없음", d.toolHang!.rel === null, show("toolHang")),
      assert("한도 뒤 폴백이 성공하면 실패가 아니다(칸이 새지 않는다)", d.fallbackSuccess!.msg === "(성공)", show("fallbackSuccess")),
      assert("★작업 결과로 운반 — `failureOutcome` 이 런타임이 실은 시각을 `resumeAtMs` 로 옮긴다 · 보통 오류·문자열 오류엔 칸이 없다", d.outcome!.carried === true && near(d.outcome!.relSec, 900, 5) && d.outcome!.plain === false && d.outcome!.str === false, show("outcome")),
    ];
  },
};
