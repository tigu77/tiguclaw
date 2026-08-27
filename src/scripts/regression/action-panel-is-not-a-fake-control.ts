/**
 * 회귀: **액션 패널이 가짜 컨트롤이 아니다 + 목록을 두 곳에서 짓지 않는다** (2026-08-27).
 *
 * v0.39.0 적대 검토 G축 ③. 두 결함이 한 자리에서 나왔다:
 *
 * **① 비활성 버튼** — 렌더러가 `<button disabled>` 를 찍었는데 실행 endpoint 는 레포 어디에도
 *    없다(플러그인 자신이 "아직 연결하지 않았습니다" 라고 적어뒀다). **비활성 버튼은
 *    "누를 수 있다" 고 말하고 안 눌리는 거짓말**이라 읽는 목록으로 바꿨다. 실행이 붙는 날
 *    버튼으로 되돌린다 — 그때 이 검사도 같이 고친다.
 *
 * **② 같은 목록을 두 곳에서 지었다** — 대시보드는 `provider.actions`(=`ActionSpec[]`)에서
 *    패널을 만드는데, self-growth 가 `kind: "action-panel"` 뷰를 **손으로 하나 더** 지었다.
 *    거기 `data.actions` 는 `["run-weekly-review"]` = **문자열 배열**이라 렌더러가 기대하는
 *    객체가 아니었고, 결과는 패널 **둘** + 그중 하나의 라벨이 `undefined` 였다.
 *    ([[feedback_hand_maintained_lists]] — 손으로 관리하는 목록은 조용히 갈린다.)
 *
 * ★그래서 지키는 규칙은 "문자열을 객체로 고쳐라" 가 아니라 **"패널을 짓는 곳은 하나다"** 다.
 *  모양을 고치면 다음 플러그인이 또 손으로 짓는다.
 *
 * 등급: **소스 대조**(대시보드 JS 가 IIFE 라 import 불가 — 그물 ⑤). 렌더 자체는 배포 후
 * 헤드리스로 확인했다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 패널을 **짓는** 유일한 자리. 여기 말고 어디에도 `kind: "action-panel"` 이 있으면 안 된다. */
const BUILDER = "packages/dashboard/js/view-providers.js";

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(e)) out.push(p);
  }
  return out;
};

export const check: RegressionCheck = {
  name: "action-panel-is-not-a-fake-control",
  guards:
    "액션 패널이 실행 endpoint 없이 <button disabled> 를 찍어 '누를 수 있다'고 거짓말하던 것 + 플러그인이 같은 목록으로 action-panel 뷰를 손으로 하나 더 지어 패널이 둘 뜨고 라벨이 undefined 이던 것",
  run: async (): Promise<Assertion[]> => {
    const util = readFileSync(path.join(REPO, "packages/dashboard/js/util.js"), "utf8");
    // 렌더러의 action-panel 분기만 떼어 본다(파일 전체엔 다른 버튼이 많다).
    const from = util.indexOf('view.kind === "action-panel"');
    const raw = from < 0 ? "" : util.slice(from, util.indexOf("} else {", from));
    // ★주석을 지우고 본다. 안 그러면 **금지 대상을 설명하는 주석**이 위반으로 세어져 상시
    //  빨강이 된다 — 이 레포에서 같은 부류로 네 번째다(첫 실행에서 바로 걸렸다).
    const branch = raw.replace(/\/\/[^\n]*/g, "");

    // 패널을 짓는 곳 — 빌더 말고 아무 데도 없어야 한다.
    const builders = [
      ...walk(path.join(REPO, "plugins")),
      ...walk(path.join(REPO, "src")),
      ...walk(path.join(REPO, "packages")),
    ]
      .filter((f) => /kind:\s*"action-panel"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f))
      // 검사 자신은 규칙을 **설명**할 뿐이다(설명글을 코드로 세면 상시 빨강 — 이 레포에서 3번 났다).
      .filter((f) => !f.startsWith("src/scripts/regression/"));

    return [
      assert(
        "★렌더러의 action-panel 분기를 실제로 찾았다(0이면 아래 둘은 미검사다)",
        branch.length > 100,
        `분기 ${branch.length}자`,
      ),
      assert(
        "★액션을 비활성 버튼으로 그리지 않는다(실행 경로가 없는데 컨트롤인 척하지 마라)",
        !/disabled/.test(branch) && !/createElement\("button"\)/.test(branch),
        /disabled/.test(branch)
          ? "★<button disabled> 로 되돌아갔다 — 실행이 붙었으면 이 검사를 고쳐라"
          : "읽는 목록으로 그린다",
      ),
      assert(
        "★패널을 짓는 곳이 하나다(둘이면 같은 목록이 갈리고 하나는 라벨이 undefined 가 된다)",
        builders.length === 1 && builders[0] === BUILDER,
        builders.length === 1
          ? `유일한 빌더: ${builders[0]}`
          : `★${builders.length}곳: ${builders.join(", ")} — 손으로 짓지 말고 provider.actions 에 넣어라`,
      ),
      assert(
        "★빌더가 ActionSpec 원본을 그대로 넘긴다(중간에 문자열로 납작해지지 않는다)",
        /kind: "action-panel", data: \{ actions: provider\.actions \}/.test(
          readFileSync(path.join(REPO, BUILDER), "utf8"),
        ),
        /data: \{ actions: provider\.actions \}/.test(
          readFileSync(path.join(REPO, BUILDER), "utf8"),
        )
          ? "provider.actions 그대로"
          : "★빌더가 actions 를 변형한다 — 렌더러는 ActionSpec 객체를 기대한다",
      ),
    ];
  },
};
