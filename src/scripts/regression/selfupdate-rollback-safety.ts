/**
 * 회귀: **self-update 롤백이 미커밋 작업물을 지우지 않는다** (2026-07-31 검토, 재현됨).
 *
 * 사고: `npm install`·typecheck 등 게이트가 실패하면 `rollback()` 이 무조건
 * `git reset --hard <prevSha>` 를 걸었다. 그런데 상류의 `git pull --ff-only` 는
 * **업데이트가 건드리지 않은 파일의 dirty 상태와 공존한다**(그 코드 주석도 그렇게 적었다).
 * 그래서 "pull 성공 → 게이트 실패 → reset" 경로에서 사용자의 미커밋 편집이 **비가역으로**
 * 사라졌다. `/update` 한 번에 작업이 증발하고, 되돌릴 방법이 없다.
 *
 * 재현(임시 git 레포): tracked 파일 수정 → 다른 파일만 바뀐 커밋 pull(성공) → reset
 *   옛: "MY UNCOMMITTED WORK" → "v1"  (소실)
 *   새: "MY UNCOMMITTED WORK" 유지     (보존)
 *
 * ★판단 기준은 "어느 쪽이 확실한가" 가 아니라 **어느 쪽이 비가역인가** 다.
 *  롤백을 생략하면 코드가 새 커밋 상태로 남지만 그건 사용자가 직접 되돌릴 수 있다.
 *  지워진 작업은 못 되돌린다. 그래서 되돌리지 않고 **정직 보고**한다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas, sourceOrder } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "selfupdate-rollback-safety",
  guards:
    "게이트 실패 시 git reset --hard 가 사용자의 미커밋 작업을 비가역으로 지우던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★순서 — 더티 검사가 `reset --hard` **앞**에 있어야 한다. 뒤에 있으면 이미 지운 뒤다.
    const order = await sourceOrder("../../core/self-update.ts", [
      /const rollback = async \(\): Promise<boolean> => \{/,
      /run\("git", \["status", "--porcelain"\], cwd\)/,
      /if \(dirty !== ""\) \{/,
      /return false;/,
      /run\("git", \["reset", "--hard", prevSha\], cwd\)/,
    ]);
    out.push(
      assert(
        "★더티 검사가 reset --hard 보다 **먼저** 있고, 더티면 reset 전에 반환한다",
        order.ok,
        order.detail,
      ),
    );

    // 조용히 넘어가지 않는다 — 무엇이 남았고 왜 안 되돌렸는지 말한다.
    const honest = await sourceHas("../../core/self-update.ts", [
      /★롤백 생략 — 미커밋 변경이 있습니다/,
      // 어떤 파일인지 알려준다(사용자가 판단할 근거).
      /\.map\(\(l: string\) => l\.slice\(3\)\)/,
      // 코드가 어느 상태로 남았는지도 말한다.
      /업데이트된 상태로 남아 있으니/,
    ]);
    out.push(
      assert(
        "★생략 사실·남은 파일·현재 코드 상태를 말한다(조용한 생략 0)",
        honest.ok,
        honest.ok ? "3개 확인" : `누락 ${honest.missing.join(" ")}`,
      ),
    );

    // 클린일 때는 여전히 롤백한다 — 안전장치가 기능 자체를 죽이면 안 된다.
    const stillRolls = await sourceHas("../../core/self-update.ts", [
      /run\("git", \["reset", "--hard", prevSha\], cwd\);/,
    ]);
    out.push(
      assert(
        "클린 작업트리에선 여전히 롤백한다(과잉 방어로 기능을 죽이지 않는다)",
        stillRolls.ok,
        stillRolls.ok ? "reset 경로 유지" : "롤백 자체가 사라졌다",
      ),
    );
    return out;
  },
};
