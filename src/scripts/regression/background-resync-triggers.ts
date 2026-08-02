/**
 * 회귀: **백그라운드 상태를 "보는 순간"마다 서버와 맞춘다** (2026-08-02 사용자 제보).
 *
 * 증상: 다른 세션 탭을 갔다 오거나 다른 화면을 보다가 돌아오면 **끝난 잡이 계속 "진행 중"**.
 * 새로고침하면 정상 → 서버는 멀쩡하고 **클라가 안 맞춘 것**.
 *
 * 근본: 대조 함수(`hydrateActiveJobs`)와 배선(`window.reconcileBgJobs`)은 **이미 있었는데**
 * 트리거가 **부팅 1회 + SSE 재연결(`es.onopen`)** 뿐이었다. 화면 전환은 둘 다 아니다 —
 * SSE 가 계속 붙어 있으니 `onopen` 이 안 뜬다. 그 사이 끝난 잡의 `worker.done` 은 화면이
 * 없을 때 지나가고 **다시 오지 않는다**. `hydrateActiveJobs` 주석이 그 경우("갱신해 줄
 * 이벤트가 더는 없다")를 **이미 설명하고 있었다** — 만들어 두고 안 부른 것이다.
 *
 * ★오늘만 세 번째다: 상시 빨간 CI · 수동 게이트 · 그리고 이것. **만들어 둔 것이 도는가**를
 *  코드가 아니라 트리거에서 확인해야 한다.
 *
 * ★판정은 한 곳(`resyncBackground`)에 두고 트리거가 그걸 부른다 — 트리거마다 각자
 *  fetch 를 쓰면 잡만 맞추고 셸은 안 맞추는 식으로 갈린다(실제로 셸은 노출조차 없었다).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JS = path.join(REPO, "packages/dashboard/js");
const read = (f: string): string => readFileSync(path.join(JS, f), "utf8");

export const check: RegressionCheck = {
  name: "background-resync-triggers",
  guards:
    "끝난 잡이 세션 전환·화면 복귀 후에도 '진행 중' 으로 굳던 것(대조 함수는 있는데 트리거가 부팅뿐이었음)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const all = readdirSync(JS)
      .filter((f) => f.endsWith(".js"))
      .map((f) => read(f))
      .join("\n");

    // ★① 판정이 한 곳인가 — 잡·셸을 **함께** 맞추는 단일 함수.
    const act = read("activity.js");
    const single =
      /const resyncBackground = \(\) => \{[\s\S]{0,400}reconcileBgJobs[\s\S]{0,200}resyncShells/.test(
        act,
      );
    out.push(
      assert(
        "★재동기 판정이 한 곳이고 잡·셸을 함께 맞춘다",
        single,
        single ? "resyncBackground 확인" : "★잡만 맞추거나 트리거마다 흩어짐",
      ),
    );

    // ★② 세 트리거가 다 있는가 — 하나라도 없으면 그 경로에서 유령이 남는다.
    const triggers: Array<[string, string, RegExp]> = [
      ["드로어 열기", "background-drawer.js", /const openBg = \(\) => \{[\s\S]{0,300}resyncBackground\(\)/],
      ["세션 탭 전환", "tabs.js", /const switchToThread[\s\S]{0,600}resyncBackground\(\)/],
      ["탭 복귀(visibility)", "activity.js", /visibilitychange[\s\S]{0,400}resyncBackground\(\)/],
    ];
    const missing = triggers.filter(([, f, re]) => !re.test(read(f)));
    out.push(
      assert(
        `★"보는 순간" 트리거 ${triggers.length}종이 모두 배선됐다`,
        missing.length === 0,
        missing.length === 0
          ? triggers.map(([n]) => n).join(" · ")
          : `★누락: ${missing.map(([n]) => n).join(", ")}`,
      ),
    );

    // ★③ 탭 복귀에서 **연결이 살아 있어도** 맞추는가 — 종전엔 죽었을 때만 재연결하고
    //  살아 있으면 아무것도 안 했다. 숨어 있는 동안 끝난 잡은 그 경로로 굳는다.
    out.push(
      assert(
        "탭 복귀 시 연결이 살아 있어도 재동기한다(재연결만으로 부족)",
        /forceReconnect\(\);\s*\n\s*else resyncBackground\(\);/.test(act),
        /else resyncBackground/.test(act) ? "else 분기 확인" : "★연결 살아있으면 아무것도 안 함",
      ),
    );

    // ★④ 기존 두 진입점(부팅·SSE 재연결)도 유지되는가 — 새 트리거가 옛것을 대체하면
    //  첫 화면과 끊김 복구가 다시 비어버린다.
    out.push(
      assert(
        "부팅·SSE 재연결 대조가 유지된다(새 트리거가 옛것을 대체하지 않음)",
        /hydrateActiveJobs\(\);/.test(read("background-drawer.js")) &&
          /es\.onopen[\s\S]{0,400}reconcileBgJobs/.test(act),
        "부팅 + onopen 확인",
      ),
    );

    // ★⑤ 셸도 서버 재동기가 노출돼 있는가 — 잡만 고치고 셸을 빼면 반쪽이다.
    out.push(
      assert(
        "셸 재동기도 노출된다(window.resyncShells)",
        /window\.resyncShells = fetchShellsSeed;/.test(read("view-shells.js")),
        /resyncShells/.test(all) ? "노출 확인" : "★셸은 여전히 부팅에만",
      ),
    );
    return out;
  },
};
