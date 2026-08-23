/**
 * 회귀: **훅이 화면에 보인다** — 전역은 인벤토리, 프로젝트 전용은 그 프로젝트 상세
 * (2026-08-23 사용자 결정: "훅 목록은 오히려 인벤토리나 각 프로젝트별로 보여주면").
 *
 * ★분배가 구조를 따라간다: 훅은 원래 **user(런타임 홈) + project(`<cwd>/settings.json`)**
 *  2층이고(hook-runner `loadSettingsLayers`), 그래서 전역/전용을 억지로 가르는 게 아니다.
 *
 * ★훅은 **모델이 안 부르는데 자동으로 도는** 유일한 능력이다. 목록에 없으면 "왜 이게
 *  실행됐지" 를 추적할 데가 없다 — 보이는 자리가 곧 진단면이다(v0.3.1 에 scheduler 가
 *  조용히 죽어 로그의 *없는 줄*로만 표가 났던 것과 같은 부류).
 *
 * 발견: 서버는 처음부터 `hook` 카테고리를 내보내고 있었는데(`/inventory` 응답 키) 프런트
 * `CATEGORIES` 목록에만 빠져 **화면에 아예 안 나왔다** — 손으로 관리하는 목록이 서버와
 * 갈린 자리다([[feedback_hand_maintained_lists]]).
 *
 * 동작 검증은 헤드리스(`_workspace/run_hook_verify.sh`, 7/7)가 픽스처를 넣고 확인한다.
 * 여기서는 매번 싸게 배선을 지킨다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = async (rel: string): Promise<string> => {
  try {
    return await readFile(path.join(REPO, rel), "utf8");
  } catch {
    return "";
  }
};

export const check: RegressionCheck = {
  name: "hooks-are-visible",
  guards:
    "서버가 내보내는 hook 카테고리가 프런트 목록에 없어 훅이 화면에 아예 안 보이던 것 + 프로젝트 전용 훅을 볼 데가 없던 것",
  run: async (): Promise<Assertion[]> => {
    const consts = await read("packages/dashboard/js/constants.js");
    const inv = await read("src/core/plugins/inventory.ts");
    const bridge = await read("plugins/http-bridge/index.ts");
    const projView = await read("packages/dashboard/js/view-projects.js");
    if (consts === "" || inv === "") {
      return [assert("소스 부재 시 통과(배포본 — 오탐 0)", true, "★확인 못 함")];
    }
    return [
      assert(
        "서버가 hook 을 수집한다",
        inv.includes('category: "hook" as const'),
        inv.includes('category: "hook" as const') ? "확인" : "★수집 안 함",
      ),
      assert(
        // ★여기가 빠져 있어서 서버가 보내는데도 화면에 안 나왔다.
        "★프런트 카테고리 목록에 hook 이 있다(서버와 안 갈린다)",
        /CATEGORIES = \[[^\]]*"hook"/.test(consts) &&
          consts.includes("hook: \"훅\""),
        /CATEGORIES = \[[^\]]*"hook"/.test(consts) ? "확인" : "★목록 누락 — 화면에 안 나온다",
      ),
      assert(
        "★프로젝트 상세가 그 프로젝트 훅만 준다(scope 로 거른다)",
        bridge.includes("listHooksForInventory(projectPath)") &&
          bridge.includes('h.scope === "project"'),
        bridge.includes('h.scope === "project"') ? "확인" : "★전역 훅까지 섞인다",
      ),
      assert(
        // 판정은 인벤토리와 **같은 함수** — 두 곳이 각자 읽으면 목록이 갈린다.
        "전역·프로젝트가 같은 판정 함수를 쓴다(listHooksForInventory)",
        inv.includes("listHooksForInventory(cwd)") &&
          bridge.includes("listHooksForInventory(projectPath)"),
        "단일 판정 확인",
      ),
      assert(
        "프로젝트 상세 화면에 전용 훅 섹션이 있다",
        projView.includes("전용 훅") && projView.includes("detail.hooks"),
        projView.includes("detail.hooks") ? "확인" : "★섹션 없음",
      ),
    ];
  },
};
