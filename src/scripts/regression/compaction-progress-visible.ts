/**
 * 회귀: 압축 진행이 **기다리는 동안** 보인다 — 그리고 발행한 이벤트에 소비처가 있다.
 *
 * 출발점 (2026-08-10, 사용자): "압축 직전에 오래 걸리는데 뭘 하는지 모르겠어서."
 *  종전엔 사후(`llm.compacted`)만 그렸다. 요약은 6~8만 자를 LLM 에 넣는 호출이라 긴데,
 *  그 동안 화면엔 스피너만 돌고 이유가 없었다. 그래서 압축 **직전**에 `llm.compacting`
 *  을 내고 대시보드가 그린다(codex=폴드 직전, claude=SDK PreCompact 훅 — 같은 이벤트).
 *
 * ★그리고 이 레포가 **두 번 겪은** 부류를 같이 막는다: 발행은 했는데 **소비처가 없는 것**.
 *  `llm.tool_slow`(2026-08-06)·`llm.compaction_stuck` 이 그랬다 — 백엔드는 성실히
 *  발행하는데 그리는 곳이 없어, 경고가 로그에만 있고 사용자에겐 없는 것과 같았다.
 *  이 검사는 압축 계열 3종에 대해 **발행 쪽과 그리는 쪽을 양방향으로 대조**한다.
 *
 * ★검사 등급: **배선 린트**(소스 문자열 대조)다. 동작 검사가 아니다 —
 *  `packages/dashboard/js` 는 브라우저 IIFE 라 node 에서 그대로 실행할 수 없고,
 *  이벤트 발행은 어댑터 깊숙이 있어 실호출엔 LLM 이 필요하다. 그래서 `if (false)` 같은
 *  무력화나 동의어 우회는 **못 잡는다**. 잡는 건 "한쪽만 늘렸다"는 실제 재발 형상이다.
 *  (지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘므로 한계를 여기 적어둔다.)
 */
import { readFile } from "node:fs/promises";
import type { Assertion, RegressionCheck } from "./_framework.js";

const read = async (rel: string): Promise<string> =>
  readFile(new URL(`../../../${rel}`, import.meta.url), "utf8");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const codex = await read(
    "src/core/llm-runtime/adapters/openai-codex-oauth-history.ts",
  );
  const claude = await read(
    "src/core/llm-runtime/adapters/claude-agent-sdk.ts",
  );
  const sse = await read("packages/dashboard/js/sse.js");

  // ── ① 두 어댑터가 **같은** 이벤트를 낸다(어댑터별 분기 0 = 멀티 LLM 대칭) ──────
  out.push({
    name: "codex — 압축 직전 llm.compacting 발행",
    ok: codex.includes('type: "llm.compacting"'),
    got: codex.includes('type: "llm.compacting"') ? "있음" : "없음",
  });
  out.push({
    name: "claude — SDK PreCompact 훅에서 같은 이벤트 발행",
    ok: claude.includes("PreCompact:") && claude.includes('type: "llm.compacting"'),
    got: `PreCompact 훅=${claude.includes("PreCompact:")} 발행=${claude.includes('type: "llm.compacting"')}`,
  });

  // ── ② 발행 지점이 **요약 호출보다 앞**이어야 "직전"이다 ─────────────────────
  //  뒤로 밀리면 사후 통지와 다를 게 없어진다(이 기능의 존재 이유가 사라진다).
  {
    const pub = codex.indexOf('type: "llm.compacting"');
    const loop = codex.indexOf("while (plan.needed && compactPass");
    out.push({
      name: "★codex 발행이 폴드 루프보다 **앞**에 있다(사후가 되면 의미 없음)",
      ok: pub > 0 && loop > 0 && pub < loop,
      got: `발행 idx=${pub} 루프 idx=${loop} (기대 발행 < 루프)`,
    });
  }

  // ── ③ 압축 계열 전부 대시보드에 소비처가 있다(발행만 하고 안 그리던 재발 차단) ──
  for (const t of ["llm.compacting", "llm.compacted", "llm.compaction_stuck"]) {
    out.push({
      name: `대시보드가 ${t} 를 그린다(소비처 존재)`,
      ok: sse.includes(`ev.type === "${t}"`),
      got: sse.includes(`ev.type === "${t}"`) ? "소비처 있음" : "★소비처 없음",
    });
  }

  // ── ④ 기다린 시간이 숫자로 남는다 ──────────────────────────────────────────
  //  "얼마나 걸리나" 를 재려던 순간 그 숫자가 로그에도 이벤트에도 없었다.
  out.push({
    name: "압축 경과(elapsedMs)가 이벤트에 실린다",
    ok: codex.includes("elapsedMs: Date.now() - compactStartedAt"),
    got: codex.includes("elapsedMs: Date.now() - compactStartedAt")
      ? "있음"
      : "없음",
  });
  out.push({
    name: "압축 경과가 로그에도 남는다(로그만으로 진단 가능)",
    ok: codex.includes("경과=${"),
    got: codex.includes("경과=${") ? "있음" : "없음",
  });
  out.push({
    name: "대시보드가 경과를 표시한다",
    ok: sse.includes("elapsedMs"),
    got: sse.includes("elapsedMs") ? "표시함" : "표시 안 함",
  });

  return out;
};

export const check: RegressionCheck = {
  name: "compaction-progress-visible",
  guards:
    "압축이 도는 동안 화면에 이유가 없어 '오래 걸리는데 뭘 하는지 모르겠던' 것 + 압축 계열 이벤트를 발행만 하고 그리는 곳이 없던 재발(llm.tool_slow·compaction_stuck 전례) + 경과 시간이 어디에도 안 남던 것",
  run,
};
