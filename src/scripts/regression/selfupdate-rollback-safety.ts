/**
 * 회귀: **self-update 롤백이 미커밋 작업물을 지우지 않는다** (2026-07-31 검토, 재현됨).
 *
 * 사고: `npm install`·typecheck 등 게이트가 실패하면 `rollback()` 이 무조건
 * `git reset --hard <prevSha>` 를 걸었다. 그런데 상류의 `git pull --ff-only` 는
 * **업데이트가 건드리지 않은 파일의 dirty 상태와 공존한다**(그 코드 주석도 그렇게 적었다).
 * 그래서 "pull 성공 → 게이트 실패 → reset" 경로에서 사용자의 미커밋 편집이 **비가역으로**
 * 사라졌다. `/update` 한 번에 작업이 증발하고, 되돌릴 방법이 없다.
 *
 * ★판단 기준은 "어느 쪽이 확실한가" 가 아니라 **어느 쪽이 비가역인가** 다.
 *  롤백을 생략하면 코드가 새 커밋 상태로 남지만 그건 사용자가 직접 되돌릴 수 있다.
 *  지워진 작업은 못 되돌린다. 그래서 되돌리지 않고 **정직 보고**한다.
 *
 * ★2차 결함(2026-07-31 3차 검토): 그 가드가 `git status --porcelain` 으로 **untracked 까지**
 *  셌다. `reset --hard` 는 untracked 를 지우지 않는데도. 결과 — untracked 가 하나라도 있는
 *  작업트리(이 레포는 352개)에서는 가드가 **항상** 발동해 롤백이 통째로 꺼졌다.
 *  안전장치가 기능을 죽인 것이다. 그리고 **이 검사가 소스 정규식이라 그걸 못 봤다**
 *  (코드 문구는 멀쩡했으니까). 그래서 아래는 임시 레포에 **진짜 git 을 돌린다.**
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd }, (_e, stdout) => resolve(stdout));
  });

export const check: RegressionCheck = {
  name: "selfupdate-rollback-safety",
  guards:
    "게이트 실패 시 git reset --hard 가 사용자의 미커밋 작업을 비가역으로 지우던 것 + 그 가드가 untracked 를 세어 롤백을 통째로 꺼뜨리던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { listDestructiveUncommitted } = await import("../../core/self-update.js");

    const repo = await mkdtemp(path.join(tmpdir(), "tiguclaw-rollback-"));
    try {
      await git(["init", "-q"], repo);
      await git(["config", "user.email", "regr@example.invalid"], repo);
      await git(["config", "user.name", "regression"], repo);
      await writeFile(path.join(repo, "tracked.txt"), "v1\n", "utf8");
      await git(["add", "."], repo);
      await git(["commit", "-q", "-m", "init"], repo);

      // ① 완전히 깨끗 → 파괴 대상 0(롤백을 막을 이유가 없다).
      const clean = await listDestructiveUncommitted(repo);
      out.push(
        assert(
          "깨끗한 작업트리는 파괴 대상 0(롤백이 여전히 동작한다)",
          clean.length === 0,
          `대상 ${clean.length}개 ${clean.join(",")}`,
        ),
      );

      // ★② untracked 만 있는 경우 → `reset --hard` 는 이걸 **안 지운다**.
      //  여기서 0이 아니면 가드가 헛발동해 롤백이 영구히 꺼진다(실제 사고 형상).
      await writeFile(path.join(repo, "scratch.log"), "임시 산출물\n", "utf8");
      await writeFile(path.join(repo, "note.md"), "메모\n", "utf8");
      const untrackedOnly = await listDestructiveUncommitted(repo);
      out.push(
        assert(
          "★untracked 파일은 파괴 대상이 아니다(reset --hard 가 안 지운다)",
          untrackedOnly.length === 0,
          untrackedOnly.length === 0
            ? "untracked 2개 무시 — 롤백 가능 상태 유지"
            : `★헛발동: ${untrackedOnly.join(",")} 때문에 롤백이 영구히 꺼진다`,
        ),
      );

      // ③ tracked 수정 → 파괴 대상이다(원래 사고). 롤백을 막아야 한다.
      await writeFile(path.join(repo, "tracked.txt"), "MY UNCOMMITTED WORK\n", "utf8");
      const trackedDirty = await listDestructiveUncommitted(repo);
      out.push(
        assert(
          "★tracked 미커밋 수정은 파괴 대상으로 잡힌다(작업 증발을 막는다)",
          trackedDirty.includes("tracked.txt"),
          `대상 ${trackedDirty.join(",") || "(없음)"}`,
        ),
      );

      // ④ 그 판정이 옳다는 근거 — 실제로 reset --hard 를 걸어 무엇이 죽는지 본다.
      //  (판정과 현실이 갈리면 판정이 틀린 것이다. 여기서 대조군을 만든다.)
      await git(["reset", "--hard", "HEAD"], repo);
      const survived = await readFile(path.join(repo, "scratch.log"), "utf8").catch(
        () => "",
      );
      const destroyed = await readFile(path.join(repo, "tracked.txt"), "utf8");
      out.push(
        assert(
          "대조군 — reset --hard 는 untracked 를 살리고 tracked 수정만 파괴한다",
          survived.trim() !== "" && destroyed.trim() === "v1",
          `untracked 생존=${survived.trim() !== ""} tracked=${destroyed.trim()}`,
        ),
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }

    // 조용히 넘어가지 않는다 — 무엇이 남았고 왜 안 되돌렸는지 말한다.
    // (문구는 사람이 읽는 것이라 동작으로 볼 수 없다 — 여기만 소스 확인으로 남긴다.)
    const honest = await sourceHas("../../core/self-update.ts", [
      /★롤백 생략 — 추적 중인 파일에 미커밋 변경이 있습니다/,
      /업데이트된 상태로 남아 있으니/,
    ]);
    out.push(
      assert(
        "생략 사실·남은 파일·현재 코드 상태를 말한다(조용한 생략 0)",
        honest.ok,
        honest.ok ? "2개 확인" : `누락 ${honest.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
