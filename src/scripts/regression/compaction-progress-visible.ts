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

  // ── ★경과시간 표식 — 붙이고·오르고·**걷힌다** (2026-08-25 사용자 요청) ──────────
  //  *"⏳ 16s 이것만 들어가도 괜찮을 것 같은데"* — 요약은 LLM 한 번 호출이라 진행률(%)이
  //  없다. 아는 건 "몇 초째" 뿐이고, 가짜 진행률 바는 90%에서 멈춰 서서 아무것도 안
  //  보여주는 것보다 나쁘다.
  //
  //  ★이 레포가 **반복해서 고쳐 온 유령**을 같이 막는다: 끝난 뒤에도 도는 `⏳`.
  //   오늘(08-25) 백그라운드 스텝에서 같은 걸 고쳤다 — 셋이 다 있어야 한다:
  //   ①시작 때 단다 ②1초마다 갱신한다 ③**끝나면 걷는다**. 하나라도 빠지면 유령이다.
  //  등급: 배선 린트(위 헤더의 한계가 그대로 적용된다).
  {
    const sse = await readFile(
      new URL("../../../packages/dashboard/js/sse.js", import.meta.url),
      "utf8",
    );
    out.push(
      {
        name: "★압축 안내에 경과 뱃지를 **단다**",
        ok: /compactingTimers\.set\(/.test(sse) && /dur-badge running/.test(sse),
        got: /dur-badge running/.test(sse) ? "부착 확인" : "★뱃지를 안 단다",
      },
      {
        name: "★1초마다 **갱신한다**(멈춘 숫자는 없는 것보다 나쁘다)",
        ok: /setInterval\(tickCompacting,\s*1000\)/.test(sse),
        got: /tickCompacting/.test(sse) ? "틱 확인" : "★틱이 없다 — 숫자가 안 오른다",
      },
      {
        name: "★압축이 끝나면 **걷는다**(끝난 뒤에도 도는 유령 방지)",
        ok:
          /stopCompactingTick\(/.test(sse) &&
          sse.indexOf("stopCompactingTick(") < sse.indexOf("renderCompacted(ev.payload"),
        got: /stopCompactingTick\(/.test(sse) ? "해제 확인" : "★해제가 없다 — 영원히 카운트업",
      },
      {
        name: "★형식이 공용 `fmtElapsed` 다(같은 시간이 화면마다 다르게 보이지 않게)",
        ok: /fmtElapsed\(now - e\.startTs\)/.test(sse) && !/tgFmtElapsed/.test(sse),
        got: /fmtElapsed\(now - e\.startTs\)/.test(sse) ? "공용 함수" : "★자기 형식을 새로 만들었다",
      },
      {
        name: "★렌더가 엘리먼트를 돌려준다(붙일 자리를 다시 찾아오지 않게)",
        ok: /return div;/.test(sse),
        got: /return div;/.test(sse) ? "반환 확인" : "★반환이 없다",
      },
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "compaction-progress-visible",
  guards:
    "압축이 도는 동안 화면에 이유가 없어 '오래 걸리는데 뭘 하는지 모르겠던' 것 + 압축 계열 이벤트를 발행만 하고 그리는 곳이 없던 재발(llm.tool_slow·compaction_stuck 전례) + 경과 시간이 어디에도 안 남던 것",
  run,
};
