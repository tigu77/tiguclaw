/** 선택 확인용 트리거만 보고 생략: 기존 deliver·최종 게이트·원래 대화·전용 실행·영속 metadata를 격리 자식에서 검증한다. */
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "trigger-report-omission",
  guards: "선택된 정상 확인의 새 소식 없음 보고만 생략하고 기본 전달·실행 기록·worker 상태 줄을 보존한다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const r = await spawnWithin(45_000, "trigger-report-omission", ["--import", fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(new URL("./_trigger-report-omission-child.ts", import.meta.url))]);
    const last = r.out.trim().split("\n").at(-1) ?? "";
    if (r.code !== 0 || r.timedOut) return [assert("격리 트리거 보고 검사 완료", false, { ...r, out: r.out.slice(-5000) })];
    try { return JSON.parse(last) as Assertion[]; }
    catch { return [assert("트리거 보고 검사 JSON", false, { last, err: r.err })]; }
  },
};
