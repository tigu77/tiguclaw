/**
 * 회귀: **`UserPromptSubmit` 훅을 기다리는 «시작 중» 턴도 `/stop` 으로 멈춘다** (2026-10-23 — 설계
 * docs/decisions/2026-10-22-limit-auto-resume-design.md §3.10 · §7 «보존′»).
 *
 * 틈: 핸들러는 훅을 기다린 **뒤에야** 턴을 «진행 중» 으로 등록했다. 그 사이 `/stop` 은 «진행 중 없음» 으로 답하고 턴은 그대로 모델을 불렀다 —
 *  사람 메시지·완료 재주입·트리거(한도 재개 포함) 턴 모두. 지키는 것:
 *  ⓐ 훅 대기 중 `/stop` → 훅이 **통과**해도 모델 호출 0 · `/stop` 답 «멈춤» 1통 ⓑ 훅이 **차단**해도 같은 판정 + 차단 안내 0
 *  · 끝난 뒤 «시작 중» 표시가 남지 않는다(다음 `/stop` 은 «진행 중 없음») · 양성 대조: 안 멈춘 턴은 모델을 부르고, 안 멈춘 차단 훅은 안내가 나간다
 *  · ⓓ 표시는 슬래시 처리 **뒤**(실행형 `run:` 준비 중 `/stop` 은 지금 동작 그대로 — 범위 밖)
 *
 * 등급: **동작** — 진짜 데몬(`_stop-starting-child.ts`)·진짜 훅 셸. ⓓ 자리만 배선 대조.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceSync } from "./_wiring.js";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_stop-starting-child.ts");
type Probe = { booted?: boolean; why?: string; held?: Record<string, boolean>; steps?: Record<string, string>; tail?: string };
const MODEL_CALLED = "REGRESSION_LIVE_MODEL_BLOCKED";
const STOPPED = "Stopped the current turn";
const BLOCKED = "A hook blocked this request";

export const check: RegressionCheck = {
  name: "stop-reaches-starting-turn",
  guards:
    "훅을 기다리는 동안 보낸 `/stop` 이 «진행 중 없음» 으로 답하고, 그 턴이 훅이 끝나자 그대로 모델을 부르던 것 — 한도 재개 턴을 멈출 수 없는 틈이기도 했다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const home = mkdtempSync(path.join(tmpdir(), "stop-starting-"));
    let got: Probe = {};
    try {
      const r = await spawnWithin(90_000, "stop-starting-probe", ["--import", "tsx", CHILD], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PROBE_HOME: home } });
      const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      try { got = line === undefined ? { why: r.err.slice(-300) } : (JSON.parse(line) as Probe); } catch { got = { why: "bad-json" }; }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const out: Assertion[] = [assert("프로브 데몬이 떴다(안 뜨면 아래 판정은 무의미)", got.booted === true, got.why ?? got.tail ?? "")];
    if (got.booted !== true) return out;
    const s = got.steps ?? {};
    const h = got.held ?? {};
    const show = (k: string): string => (s[k] ?? "").replace(/\s+/g, " ").slice(-260);
    out.push(
      assert("장벽 훅이 네 단계 모두 실제로 턴을 붙잡았다(아래 판정의 전제)", h.a === true && h.b === true && h.c === true && h.d === true, JSON.stringify(h)),
      assert("ⓐ★훅 대기 중 `/stop` → «멈춤» 답 · 훅이 통과해도 **모델 호출 0**", (s.a ?? "").includes(STOPPED) && !(s.a ?? "").includes(MODEL_CALLED), show("a")),
      assert("끝난 뒤 «시작 중» 표시가 남지 않는다 — 다음 `/stop` 은 «진행 중 없음»(엉뚱한 턴을 안 멈춘다)", (s.idleAfter ?? "").includes("Nothing is in progress"), show("idleAfter")),
      assert("ⓑ★훅이 **차단**으로 끝나도 같은 판정 — 모델 호출 0 · 차단 안내 0(사용자가 먼저 멈췄다)", (s.b ?? "").includes(STOPPED) && !(s.b ?? "").includes(BLOCKED) && !(s.b ?? "").includes(MODEL_CALLED), show("b")),
      assert("양성 대조 ① 멈추지 않은 턴은 훅 뒤 모델을 부른다(«모델 호출 0» 판정이 공허하지 않다)", (s.c ?? "").includes(MODEL_CALLED), show("c")),
      assert("양성 대조 ② 멈추지 않은 차단 훅은 차단 안내가 나간다", (s.d ?? "").includes(BLOCKED), show("d")),
    );
    // ⓓ 표시 자리 — 슬래시 처리(`dispatchCommandSlash`) **뒤**, 훅 직전. 앞으로 옮기면 실행형 `run:` 의 셸 시작이 «멈춤» 을 알린 뒤 시작된다.
    const src = readSourceSync("src/index.ts");
    const slash = src.indexOf("await dispatchCommandSlash(slashCtx, cmd)");
    const mark = src.indexOf("await awaitWhileStarting(msg.threadKey");
    const stopCheck = src.indexOf("if (stoppedWhileStarting) {");
    const blockCheck = src.indexOf("if (hookOut.block) {");
    out.push(
      assert("ⓓ [배선] «시작 중» 표시는 슬래시 처리 뒤 · 멈춤 판정은 훅 차단 판정보다 앞", slash > 0 && mark > slash && stopCheck > mark && blockCheck > stopCheck, JSON.stringify({ slash, mark, stopCheck, blockCheck })),
    );
    return out;
  },
};
