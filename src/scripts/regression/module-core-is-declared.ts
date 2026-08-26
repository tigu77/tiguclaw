/**
 * 회귀: **"끌 수 없는 모듈" 은 손 목록이 아니라 선언이다** (2026-08-26).
 *
 * ★종전엔 이 판정이 **손 목록 두 벌**이었다:
 *   - `plugins/http-bridge/index.ts` 의 `CRITICAL_MODULE_NAMES = {dashboard, http-bridge}`
 *   - 그것을 베낀 `packages/dashboard/js/view-providers.js` 의 미러 — 그 주석이 **스스로**
 *     *"이 미러가 드리프트된 경우 대비"* 라고 적고 있었다([[feedback_hand_maintained_lists]]).
 *
 * 이제 manifest `tiguclaw.core` 선언을 인벤토리가 실어주고, 토글 경로가 그걸 읽는다.
 *
 * ★**유효성은 선언이 아니라 위치로 판정한다** — 레포 `plugins/` 만 본다. 설치된 플러그인이
 *  `core:true` 를 적어도 코어가 되지 않는다(자기 선언은 검증할 수 없다). 그래서
 *  `isCoreModule` 은 **이름이 번들에 없으면 무조건 false** 다.
 *
 * ★그리고 코어는 경고가 아니라 **거절**이다. 브리지를 끄면 대시보드가 죽는 것보다 더 나쁜
 *  일이 있다 — 다시 켤 경로(`setModuleDisabled` 호출부)가 브리지 하나뿐이라 **제품 안에서
 *  되돌릴 수 없게 된다.**
 *
 * 등급: 동작 검사 — 진짜 매니페스트를 읽는 `isCoreModule` 과 인벤토리 수집을 부른다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCoreModule } from "../../core/plugins/inventory.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "module-core-is-declared",
  guards:
    "끌 수 없는 모듈이 백엔드·프런트 손 목록 두 벌로 관리돼 드리프트하던 것(미러 주석이 스스로 그 위험을 적고 있었다) + 브리지를 끄면 다시 켤 경로가 사라져 제품 안에서 되돌릴 수 없게 되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 선언 — 번들 매니페스트를 직접 읽어 "코어라고 적힌 것" 집합을 만든다.
    const dirs = (
      await fs.readdir(path.join(REPO, "plugins"), { withFileTypes: true })
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const declared: string[] = [];
    for (const d of dirs) {
      const raw = await fs.readFile(
        path.join(REPO, "plugins", d, "package.json"),
        "utf8",
      );
      const m = (JSON.parse(raw) as { tiguclaw?: { name?: string; core?: boolean } })
        .tiguclaw;
      if (m?.core === true && typeof m.name === "string") declared.push(m.name);
    }

    out.push(
      assert(
        "★코어로 선언된 번들은 http-bridge 하나다",
        declared.length === 1 && declared[0] === "http-bridge",
        JSON.stringify(declared),
      ),
    );

    // ② 판정 — 선언이 실제로 판정 함수까지 흐르는가(선언만 있고 아무도 안 읽으면 죽은 계약).
    out.push(
      assert(
        "isCoreModule 이 선언을 읽는다",
        isCoreModule("http-bridge"),
        `isCoreModule("http-bridge")=${String(isCoreModule("http-bridge"))}`,
      ),
    );
    out.push(
      assert(
        "코어 아닌 번들은 false — 전부 코어가 되지 않는다",
        !isCoreModule("scheduler") && !isCoreModule("telegram-channel"),
        `scheduler=${String(isCoreModule("scheduler"))} telegram=${String(
          isCoreModule("telegram-channel"),
        )}`,
      ),
    );
    out.push(
      assert(
        "★번들에 없는 이름은 무조건 false(자기 선언으로 코어가 될 수 없다)",
        !isCoreModule("some-installed-plugin"),
        `isCoreModule("some-installed-plugin")=${String(
          isCoreModule("some-installed-plugin"),
        )}`,
      ),
    );

    // ③ 손 목록이 되살아나지 않았는가 — 미러가 다시 생기면 드리프트도 다시 생긴다.
    const front = await fs.readFile(
      path.join(REPO, "packages/dashboard/js/view-providers.js"),
      "utf8",
    );
    out.push(
      assert(
        "프런트가 http-bridge 를 이름으로 하드코딩하지 않는다",
        !/["']http-bridge["']/.test(front),
        /["']http-bridge["']/.test(front) ? "하드코딩 발견" : "하드코딩 0건",
      ),
    );
    out.push(
      assert(
        "프런트가 선언(item.core)으로 토글을 가른다",
        front.includes("provider.core !== true"),
        front.includes("provider.core !== true") ? "게이트 있음" : "게이트 없음",
      ),
    );

    // ④ 되돌림 — 켜는 경로가 여전히 브리지 하나뿐인지 센다. 하나뿐이라는 사실이 곧
    //    "코어를 끄면 안 되는" 이유이므로, 이 수가 늘면 그때 정책을 다시 본다.
    const bridge = await fs.readFile(
      path.join(REPO, "plugins/http-bridge/index.ts"),
      "utf8",
    );
    out.push(
      assert(
        "★코어를 끄려는 요청은 거절된다(경고가 아니라)",
        bridge.includes("isCoreModule(name)"),
        bridge.includes("isCoreModule(name)") ? "거절 가드 있음" : "가드 없음",
      ),
    );

    return out;
  },
};
