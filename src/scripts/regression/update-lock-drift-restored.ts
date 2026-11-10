/**
 * 회귀: 업데이트가 **우리가 다시 쓴 `package-lock.json`** 을 사용자 편집으로 읽어 거절하지 않는다 (2026-10-05 적대 검토).
 *
 * `npm install` 은 플랫폼·npm 버전에 따라 lock 을 다시 쓴다. 그 드리프트가 ff-only pull 을 막아 `/update` 가 영영 깨진
 * 윈도우 실사고(`e7e8716a`)가 있었고, 그래서 pull 직전에 lock 하나만 되돌렸다. 그 처리가 «lock 도 사용자 편집일 수
 * 있다» 며 지워졌고(`f9dbb846`), 그러면 한 번의 deps 업데이트 뒤부터 업데이트가 **영구 거절**된다. 거절 문장엔 파일
 * 이름도 없어 사용자는 무엇을 정리해야 할지 몰랐다.
 *
 * 무엇을 재나: lock 과 다른 추적 파일이 함께 더러울 때 — lock 은 되돌려지고, 거절 사유는 **다른 파일의 이름**만 댄다.
 *  pull 전에 끝나므로 네트워크·빌드 0.
 * 등급: **동작** — 실제 git 저장소에서 runSelfUpdate 를 돈다.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSelfUpdate } from "../../core/self-update.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const git = (args: readonly string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, windowsHide: true }, (err, stdout) => (err === null ? resolve(stdout) : reject(err)));
  });

export const check: RegressionCheck = {
  name: "update-lock-drift-restored",
  guards:
    "우리 npm install 이 다시 쓴 package-lock.json 을 사용자 편집으로 읽어 업데이트를 영구 거절하던 것 + 거절 문장에 무엇이 막는지 이름이 없던 것",
  run: async (): Promise<Assertion[]> => {
    const results: Assertion[] = [];
    for (const fixture of [
      { name: "LF 정책 + autocrlf=true", attributes: "* text=auto eol=lf\n", lock: "{}\n" },
      { name: "CRLF checkout + autocrlf=true", attributes: null, lock: "{}\r\n" },
    ]) {
      const root = await mkdtemp(path.join(tmpdir(), "upd-lock-"));
      try {
        const origin = path.join(root, "origin");
        const clone = path.join(root, "clone");
        await git(["init", "--quiet", "--bare", "-b", "main", origin], root);
        await git(["clone", "--quiet", origin, clone], root);
        await git(["config", "user.email", "r@r"], clone);
        await git(["config", "user.name", "r"], clone);
        // 제품 LF 정책과, 정책 없는 autocrlf=true의 CRLF 복원을 별도로 비교한다.
        await git(["config", "core.autocrlf", "true"], clone);
        if (fixture.attributes !== null) await writeFile(path.join(clone, ".gitattributes"), fixture.attributes);
        await writeFile(path.join(clone, "a.txt"), "1\n");
        await writeFile(path.join(clone, "package-lock.json"), "{}\n");
        await git(["add", "-A"], clone);
        await git(["commit", "--quiet", "-m", "c1"], clone);
        await git(["push", "--quiet", "-u", "origin", "main"], clone);

        // npm 이 다시 쓴 lock + 사용자가 고친 진짜 파일.
        await writeFile(path.join(clone, "package-lock.json"), '{"rewritten":true}\n');
        await writeFile(path.join(clone, "a.txt"), "user edit\n");
        const r = await runSelfUpdate({ cwd: clone, restart: () => {} });
        const lock = await readFile(path.join(clone, "package-lock.json"), "utf8");
        const userEdit = await readFile(path.join(clone, "a.txt"), "utf8");
        const err = r.error ?? "";
        const status = await git(["status", "--porcelain=v1", "--untracked-files=no"], clone);
        results.push(
          assert(`${fixture.name}: 사용자 편집이 있으면 거절한다`, r.status === "failed", `status=${r.status}`),
          assert(`${fixture.name}: lock은 정책에 맞는 정확한 바이트로 복원된다`, lock === fixture.lock, `lock=${JSON.stringify(lock)} · expected=${JSON.stringify(fixture.lock)}`),
          assert(`${fixture.name}: lock은 clean이고 a.txt만 변경 상태다`, status === " M a.txt\n", JSON.stringify(status)),
          assert(`${fixture.name}: 사용자 편집을 정확히 보존한다`, userEdit === "user edit\n", JSON.stringify(userEdit)),
          assert(`${fixture.name}: 거절 사유에 a.txt가 있다`, err.includes("a.txt"), err.slice(0, 160)),
          assert(`${fixture.name}: 거절 사유에 lock이 없다`, !err.includes("package-lock.json"), err.slice(0, 160)),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    return results;
  },
};
