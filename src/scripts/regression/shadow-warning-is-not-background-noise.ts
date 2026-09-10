/**
 * 회귀: **덮임 경고가 배경소음이 되지 않는다** (2026-09-10 적대 검토 G-2).
 *
 * 사고 전 상태: `warnShadowed` 에 억제가 **없었다.** 이 함수를 부르는 네 축은
 * `discoverSkills`/`discoverAgents` 를 타고 **턴마다** 돌고, 대시보드 인벤토리는 한
 * 요청에 다섯 번 부른다. 그래서 이름이 겹치는 플러그인이 하나만 있어도 같은 줄이
 * 턴마다 쌓인다.
 *
 * ★같은 릴리스가 **형제 경고엔 억제를 넣었다**(`skill-registry.ts` 의 `reportedDefects`).
 *  같은 함수 끝에서 부르는 이쪽만 건너뛴 비대칭이었다. 형제가 셋이다 —
 *  `plugin-mcp-merge.ts` 의 `warnShadowedOnce`, `threadkey.ts` 의
 *  `warnBindingLookupOnce`. **새 관용구가 아니라 이 함수만 빠진 것**이었다.
 * ★실피해는 로그 소음만이 아니었다: 억제가 없어서 **출하된 검사 하나가 환경 의존**이
 *  됐다. `skill-drop-is-not-silent` 의 «재발화 0건» 단언이 `capability-shadow` 줄까지
 *  세므로, 빌트인을 덮는 플러그인을 깐 기계에선 빨개진다. 우리 홈에 이름 충돌이 없어
 *  초록이었을 뿐이다([[feedback_gate_must_actually_run]] 의 «남의 기계에서 거짓말하는
 *  그물»).
 * ★«영구 1회» 가 아니라 **«상태가 바뀔 때만»** 이다 — 플러그인을 뺐다 다시 넣으면 다시
 *  말해야 한다. 재발을 무시하면 그게 곧 침묵이고, 이 레포는 그 기제로 제안 5건을
 *  5주 방치한 전례가 있다([[project_growth_loop_closed]]).
 *
 * 판정은 **동작**으로 잰다 — 소스에 `Map` 이 있는지 grep 하지 않는다. `console.warn` 을
 * 가로채 **실제로 몇 줄이 나오는지** 센다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** `console.warn` 을 가로채 이 축의 줄만 모은다. */
const captureWarnings = async (fn: () => void | Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(" ");
    if (line.includes("[capability-shadow]")) lines.push(line);
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
};

export const check: RegressionCheck = {
  name: "shadow-warning-is-not-background-noise",
  guards:
    "플러그인 덮임 경고가 턴마다 다시 찍혀 배경소음이 되던 것 — 그래서 " +
    "빌트인을 덮는 플러그인을 깐 기계에선 `skill-drop-is-not-silent` 가 빨개졌다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { warnShadowed, __resetShadowWarningsForTest } = await import(
      "../../core/llm-runtime/capabilities/dedup-by-source.js"
    );

    const evil = [{ name: "harness", by: "evil" }];

    // ① 같은 충돌이 이어지면 **한 번만** 말한다 (턴마다 도는 자리다).
    __resetShadowWarningsForTest();
    const repeated = await captureWarnings(() => {
      for (let i = 0; i < 5; i++) warnShadowed("skill", evil);
    });
    out.push(
      assert(
        "★★같은 덮임 상태가 이어지면 경고는 **한 번만** 나온다 — 이 자리는 턴마다 돌아서, 매번 찍으면 배경소음이 되고 실제 경고가 그 안에 묻힌다",
        repeated.length === 1,
        `5회 호출에 ${repeated.length}줄`,
      ),
    );

    // ② 그래도 **내용은 온전하다** — 억제가 판정 재료를 지우면 안 된다.
    out.push(
      assert(
        "★억제해도 첫 줄은 «무엇이·누구에게» 를 그대로 싣는다 — 로그가 1차 진단면인데 수치가 빠지면 억제가 아니라 은폐다",
        repeated[0]?.includes("harness") === true && repeated[0]?.includes("evil") === true,
        repeated[0] ?? "(줄 없음)",
      ),
    );

    // ③ **상태가 바뀌면 다시** 말한다 — «영구 1회» 면 새 충돌이 조용히 묻힌다.
    const changed = await captureWarnings(() => {
      warnShadowed("skill", [...evil, { name: "verify", by: "other" }]);
    });
    out.push(
      assert(
        "★★덮임 목록이 바뀌면 **다시** 말한다 — 영구 1회로 막으면 두 번째 플러그인이 능력을 덮어도 아무도 모른다",
        changed.length === 1 && changed[0]?.includes("verify") === true,
        `${changed.length}줄 / ${changed[0] ?? "(없음)"}`,
      ),
    );

    // ④ 축이 다르면 서로를 막지 않는다 — 키가 축별이어야 한다.
    const otherAxis = await captureWarnings(() => {
      warnShadowed("agent", evil);
    });
    out.push(
      assert(
        "★축(스킬·에이전트·커맨드·엔드포인트)이 다르면 서로의 경고를 막지 않는다 — 한 키로 뭉치면 먼저 온 축이 나머지 셋을 침묵시킨다",
        otherAxis.length === 1,
        `${otherAxis.length}줄`,
      ),
    );

    // ⑤ 충돌이 **사라졌다가 다시 생기면** 다시 말한다(0건도 상태 변화다).
    // ★상태를 **여기서 새로 세운다** — 앞 단언들이 서명을 `harness+verify` 로 바꿔 놨다.
    //  그대로 이어 쓰면 «되돌아왔다» 가 «서명이 달라졌다» 와 구분되지 않아, `delete` 를
    //  지우는 변이가 **통과해 버린다**(실측으로 확인했다). 검사끼리 상태를 물려받으면
    //  마지막 단언이 조용히 무력해진다.
    __resetShadowWarningsForTest();
    await captureWarnings(() => {
      warnShadowed("skill", evil); // 처음 발견 — 여기서 서명이 `harness` 로 선다
    });
    const gone = await captureWarnings(() => {
      warnShadowed("skill", []); // 플러그인을 뺐다
    });
    const back = await captureWarnings(() => {
      warnShadowed("skill", evil); // 다시 깔았다 — 서명은 아까와 **같다**
    });
    out.push(
      assert(
        "★★충돌이 사라졌다가 **같은 모양으로** 다시 생기면 다시 말한다 — 서명이 같다고 침묵하면 플러그인을 뺐다 되깔았을 때 그 설치를 확인할 길이 없다",
        gone.length === 0 && back.length === 1,
        `사라질 때 ${gone.length}줄 / 되돌아올 때 ${back.length}줄`,
      ),
    );

    return out;
  },
};
