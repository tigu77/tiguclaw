/**
 * 회귀: **OpenAI 어댑터에서 턴을 취소하면 진행 중인 플러그인 도구가 그 취소를 받는다** (2026-11-11).
 *
 * 사고(공개 dev 싱크 전 독립 검토, `docs/decisions/2026-11-11-devsync-release-prep/REPORT.md`): computer-use 취소 수정은 공유 MCP 브리지에
 * 요청 소유 신호를 추가하고 codex 어댑터만 그 신호를 넘겼다. OpenAI 어댑터는 신호 없이 브리지를 만들었고, SDK 가 4번째 인자로 주는 신호는
 * 훅 래퍼를 지나며 버려져 — /stop 뒤에도 handler 의 `extra.signal` 이 끝까지 abort 되지 않았다(남은 화면 입력이 계속될 수 있다).
 *
 * 판정: 실제 `runOpenAi` 턴(회귀 모델 주입 · 모델/네트워크 0)에서 플러그인 도구 handler 가 시작된 뒤 턴 신호를 abort 하면 handler 의
 * `extra.signal` 이 시한 안에 abort 된다 — 이름 선점 래퍼 분기와 공유 브리지 그대로의 분기 둘 다. 반대 방향: 취소하지 않은 턴의 도구는
 * 끝까지 정상 결과를 돌려주고 모델이 그 결과를 받는다(신호를 묶은 것이 정상 호출을 끊지 않는다).
 * 등급: 동작 검사(실제 어댑터 조립·실제 MCP SDK in-memory 경로, 실제 OS 입력 0).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Out = { mode: string; branch: string; started: boolean; handlerAborted?: boolean; handlerMs?: number; calls: number; sawDone: boolean; err?: string };

const runChild = async (mode: "abort" | "complete", branch: "wrapped" | "direct"): Promise<Out | string> => {
  const r = await spawnWithin(60_000, `openai-plugin-cancel-${mode}-${branch}`, ["--import", "tsx", path.join(HERE, "_openai-plugin-tool-cancel-child.ts"), mode, branch], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" },
  });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  return line === undefined ? (r.timedOut ? "timeout" : r.err.slice(-600)) : (JSON.parse(line) as Out);
};

export const check: RegressionCheck = {
  name: "openai-plugin-tool-cancel",
  guards:
    "OpenAI 어댑터가 플러그인 MCP 브리지에 턴 취소 신호를 넘기지 않아, /stop 뒤에도 진행 중인 플러그인 도구(computer-use 입력 등)가 취소를 못 받고 끝까지 돌던 것(이름 선점 래퍼·공유 브리지 두 분기)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const [aw, ad, cw, cd] = await Promise.all([
      runChild("abort", "wrapped"), runChild("abort", "direct"), runChild("complete", "wrapped"), runChild("complete", "direct"),
    ]);
    const all = { aw, ad, cw, cd };
    const bad = Object.entries(all).filter(([, v]) => typeof v === "string");
    if (bad.length > 0) return [assert("자식이 결과를 낸다", false, JSON.stringify(Object.fromEntries(bad)).slice(0, 800))];
    const [abW, abD, coW, coD] = [aw, ad, cw, cd] as Out[];
    return [
      assert(
        "★턴 취소 → 진행 중인 플러그인 도구 handler 의 extra.signal 이 abort 된다(이름 선점 래퍼 분기)",
        abW!.started && abW!.handlerAborted === true && (abW!.handlerMs ?? 99_999) < 4_000,
        JSON.stringify(abW),
      ),
      assert(
        "★턴 취소 → 진행 중인 플러그인 도구 handler 의 extra.signal 이 abort 된다(공유 브리지 그대로의 분기)",
        abD!.started && abD!.handlerAborted === true && (abD!.handlerMs ?? 99_999) < 4_000,
        JSON.stringify(abD),
      ),
      assert(
        "반대 방향 — 취소하지 않은 턴의 플러그인 도구는 abort 없이 끝나고 모델이 그 결과를 받는다(두 분기)",
        [coW!, coD!].every((o) => o.started && o.handlerAborted === false && o.calls === 2 && o.sawDone && o.err === undefined),
        JSON.stringify([coW, coD]),
      ),
    ];
  },
};

export default check;
