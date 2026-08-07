/**
 * 회귀: **프로젝트 전용 능력은 프로젝트 레벨에서만 보이고, 본문은 누를 때만 온다**
 * (2026-08-07 사용자 요청·확정).
 *
 * 사용자 결정: "인벤토리가 다 알 필요는 없어. 프로젝트 내부의 스킬·에이전트는 프로젝트
 * 레벨에서만 관리되면 돼." 실측이 그 결정을 뒷받침했다 — 전역 인벤토리 스킬 14개에
 * 프로젝트 스킬(`tigu-engine-milestone`)이 **없다**. 섞으면 "메인 대화에서도 쓸 수 있다"는
 * 오해가 난다(없는 능력을 있다고 안내하던 사고의 사촌).
 *
 * ★비대화 방지: 본문을 `/projects/detail` 에 싣지 않는다. 스킬 하나가 10KB 를 넘어서,
 *  목록 한 번 보는 데 수십 KB 를 옮기게 된다. **누를 때만** 별도 호출로 가져온다.
 * ★임의 파일 읽기가 아니다: 경로를 받지 않고 프로젝트+종류+이름으로 해소한 뒤
 *  `source === "project"` 로 한 번 더 좁힌다 — 전역 자산은 이 통로로 안 나간다.
 * ★프록시 화이트리스트: 대시보드는 `/api/X` 분기가 **손으로** 있어야 bridge 로 간다.
 *  실제로 이번에도 빠뜨려 본문이 `not found` 로 왔다(헤드리스로 잡음). 그래서 같이 검사한다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "project-capability-detail",
  guards:
    "프로젝트 전용 스킬·에이전트를 눌러도 본문이 안 오거나(프록시 누락), 전역 인벤토리에 섞이던 것",
  run: async (): Promise<Assertion[]> => {
    const bridge = await sourceHas("../../../plugins/http-bridge/index.ts", [
      /pathname === "\/projects\/capability" && method === "GET"/,
      // ★프로젝트 것만 — 전역 자산이 이 통로로 새면 "프로젝트 레벨에서만" 이 깨진다.
      /x\.source === "project" && x\.name === name/,
      // 브라우저 DOM 에 통째로 붓지 않는다.
      /const CAP = 64 \* 1024;/,
    ]);
    const proxy = await sourceHas("../../../packages/dashboard/index.ts", [
      /pathname === "\/api\/projects\/capability" && method === "GET"/,
    ]);
    const front = await sourceHas("../../../packages/dashboard/js/view-projects.js", [
      // 누를 때만 가져온다(목록 로드에 본문 0).
      /const loadCapabilityBody = async \(kind, name, box\)/,
      /pd-item-body/,
      // 기존 이모지 관례 재사용(🛠️ 스킬 · 🤖 에이전트 · 🧩 MCP) — 새 어휘를 만들지 않는다.
      /"🛠️ 전용 스킬"/,
      /"🤖 전용 에이전트"/,
    ]);
    // 목록 응답에 본문이 섞이지 않는다(비대화 재발 방지).
    const detailLean = await sourceHas("../../../plugins/http-bridge/index.ts", [
      /\.map\(\(s\) => \(\{ name: s\.name, description: s\.description \}\)\)/,
    ]);

    return [
      assert(
        "★본문 조회가 프로젝트 스코프로 좁혀진다(전역 자산은 이 통로로 안 나간다)",
        bridge.ok,
        bridge.ok ? "http-bridge" : `누락: ${bridge.missing.join(" / ")}`,
      ),
      assert(
        "★대시보드 프록시에 분기가 있다(없으면 조용히 404 — 이번에도 빠뜨렸다)",
        proxy.ok,
        proxy.ok ? "dashboard/index.ts" : `누락: ${proxy.missing.join(" / ")}`,
      ),
      assert(
        "본문은 **누를 때만** 가져온다(목록 응답엔 이름·설명만)",
        front.ok && detailLean.ok,
        `프런트=${front.ok} 목록경량=${detailLean.ok}`,
      ),
    ];
  },
};
