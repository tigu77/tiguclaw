/**
 * 회귀: **"받을 업데이트가 있나" 판정이 실제 git 위에서 맞는가** (2026-08-21).
 *
 * ★소스 정규식으로 검사하지 않는다. 이 레포엔 정확히 그래서 놓친 전례가 있다 —
 *  `listDestructiveUncommitted` 가 `--untracked-files=no` 를 빠뜨려 **가드가 항상 발동**
 *  (untracked 352개짜리 작업트리)했는데, 검사가 소스 문구만 봐서 통째로 놓쳤다.
 *  그래서 여기선 **임시 레포를 만들어 진짜 git 을 돌린다.**
 *
 * 지키는 것 넷:
 *  ①뒤처지면 available, 아니면 up-to-date — 기본 판정
 *  ②untracked 는 막지 않는다 — `reset --hard` 가 안 지우는 것으로 기능을 죽이면 안 된다
 *  ③`package-lock.json` 드리프트도 막지 않는다 — self-update 가 pull 전에 되돌리는 파일
 *  ④판정 불가는 `unknown` — **조용한 실패**(없는 업데이트를 있다고 하지 않는다)
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkUpdateAvailability } from "../../core/update-availability.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const git = (args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, windowsHide: true }, (err) =>
      err === null ? resolve() : reject(err),
    );
  });

export const check: RegressionCheck = {
  name: "update-availability",
  guards:
    "업데이트 가용성 판정이 untracked·lockfile 때문에 항상 막히거나, 판정 실패를 '최신'으로 오인하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const root = await mkdtemp(path.join(tmpdir(), "upd-avail-"));
    try {
      const origin = path.join(root, "origin");
      const clone = path.join(root, "clone");
      const other = path.join(root, "other");
      await git(["init", "--quiet", "--bare", "-b", "main", origin], root);
      await git(["clone", "--quiet", origin, clone], root);
      const cfg = async (c: string): Promise<void> => {
        await git(["config", "user.email", "r@r"], c);
        await git(["config", "user.name", "r"], c);
      };
      await cfg(clone);
      await writeFile(path.join(clone, "a.txt"), "1\n");
      await writeFile(path.join(clone, "package-lock.json"), "{}\n");
      await git(["add", "-A"], clone);
      await git(["commit", "--quiet", "-m", "c1"], clone);
      await git(["push", "--quiet", "-u", "origin", "main"], clone);

      const s0 = await checkUpdateAvailability(clone);
      out.push(
        assert("최신이면 up-to-date", s0.state === "up-to-date", `state=${s0.state}`),
      );

      // origin 을 한 커밋 앞서게 한다.
      await git(["clone", "--quiet", origin, other], root);
      await cfg(other);
      await writeFile(path.join(other, "b.txt"), "2\n");
      await git(["add", "-A"], other);
      await git(["commit", "--quiet", "-m", "c2"], other);
      await git(["push", "--quiet"], other);

      const s1 = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★뒤처지면 available + behind 수를 준다",
          s1.state === "available" && s1.behind === 1,
          `state=${s1.state} behind=${s1.behind}`,
        ),
      );

      // ② untracked 는 `reset --hard` 가 안 지운다 → 막으면 안 된다.
      await writeFile(path.join(clone, "scratch.log"), "x\n");
      const s2 = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★untracked 파일이 업데이트를 막지 않는다(가드가 기능을 죽이던 전례)",
          s2.state === "available",
          `state=${s2.state} dirty=[${s2.dirty.join(",")}]`,
        ),
      );

      // ③ lockfile 드리프트는 self-update 가 pull 전에 되돌린다 → 막으면 안 된다.
      await writeFile(path.join(clone, "package-lock.json"), '{"x":1}\n');
      const s3 = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★package-lock.json 드리프트가 업데이트를 막지 않는다(npm install 한 번이면 생기는 상태)",
          s3.state === "available",
          `state=${s3.state} dirty=[${s3.dirty.join(",")}]`,
        ),
      );

      // 진짜 충돌 요인 — 추적 파일 수정. 여기선 막고 **이유를 준다**.
      await writeFile(path.join(clone, "a.txt"), "local edit\n");
      const s4 = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★추적 파일 로컬 수정은 blocked + 사용자에게 보여줄 이유를 준다",
          s4.state === "blocked" &&
            typeof s4.blockedReason === "string" &&
            s4.blockedReason.includes("a.txt"),
          `state=${s4.state} reason=${s4.blockedReason ?? "(없음)"}`,
        ),
      );

      // ★비ASCII·공백 경로가 **읽을 수 있게** 나온다 (2026-08-21 적대 검토 B-F11).
      //  `git status --porcelain` 은 기본적으로 그런 경로를 C-따옴표로 감싸 **8진 이스케이프**
      //  한다(`"\\355\\225\\234..."`). 그 문자열이 그대로 `blockedReason` 에 실려
      //  `window.alert` 로 뜨면 한국어 사용자는 **무엇을 정리해야 하는지 알 수 없다**.
      await writeFile(path.join(clone, "한글 파일.txt"), "k\n");
      await git(["add", "한글 파일.txt"], clone);
      const sKor = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★비ASCII·공백 경로가 사용자에게 읽히는 형태로 나온다(8진 이스케이프 금지)",
          (sKor.blockedReason ?? "").includes("한글 파일.txt") &&
            !(sKor.blockedReason ?? "").includes("\\3"),
          `reason=${sKor.blockedReason ?? "(없음)"}`,
        ),
      );
      // rename 은 조각이 둘이다 — 원래 경로가 목록에 새면 그것도 "엉뚱한 이름" 이다.
      await git(["mv", "한글 파일.txt", "옮긴 파일.txt"], clone);
      const sMv = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "rename(-z 두 조각)에서 원래 경로가 목록에 새지 않는다",
          !sMv.dirty.includes("한글 파일.txt") && sMv.dirty.includes("옮긴 파일.txt"),
          `dirty=[${sMv.dirty.join(", ")}]`,
        ),
      );
      await git(["reset", "-q", "--hard", "HEAD"], clone);
      await rm(path.join(clone, "옮긴 파일.txt"), { force: true });

      // ★로컬이 **앞서** 있으면(커밋까지 한 상태) ff-only 가 불가능하다 — 적대 검토 B-F2.
      //  이 모듈의 존재 이유가 "누르면 그 벽에 부딪히는" 걸 막는 것인데, 종전엔 **미커밋
      //  변경만** 봐서 갈라진 브랜치를 available 이라고 말했다. 설치본 소스를 고치고 커밋한
      //  사람(selfDevelopment)이 정확히 그 상태다.
      await writeFile(path.join(clone, "local-only.txt"), "x\n");
      await git(["add", "-A"], clone);
      await git(["commit", "-qm", "local"], clone);
      const sDiv = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★갈라진 브랜치(로컬이 앞섬)는 available 이 아니다 — 누르면 ff-only 로 실패한다",
          sDiv.state === "blocked" && (sDiv.blockedReason ?? "").includes("갈라"),
          `state=${sDiv.state} reason=${sDiv.blockedReason ?? "(없음)"}`,
        ),
      );
      await git(["reset", "-q", "--hard", "HEAD~1"], clone);

      // ⑤ ★**버전이 올랐을 때만 버튼이 뜬다** (2026-08-26). public 레포는 미러라 dev 변경마다
      //   sync 가 커밋을 쌓는다(하루 32커밋도 있었다) — `behind > 0` 만 보면 매번 "업데이트
      //   있음" 이 뜨고, 그러면 알림이 배경 소음이 된다. 알림의 값은 **드물 때** 나온다.
      //   ★받는 것 자체는 막지 않는다 — 여기서 정하는 건 **먼저 말을 거는가**뿐이다.
      //  ★픽스처 주의: push 는 **앞선 쪽(`other`)에서만** 한다. 뒤처진 `clone` 에서 밀면
      //   non-fast-forward 로 거절된다(첫 판에서 그렇게 걸렸다).
      await writeFile(path.join(other, "package.json"), '{"version":"1.0.0"}\n');
      await git(["add", "-A"], other);
      await git(["commit", "-qm", "v1"], other);
      await git(["push", "--quiet"], other);
      await git(["pull", "--quiet", "--ff-only"], clone); // 이제 clone 도 1.0.0 · behind 0

      // (a) 버전 그대로 + 커밋만 쌓임 = sync → 조용하다.
      await writeFile(path.join(other, "c.txt"), "3\n");
      await git(["add", "-A"], other);
      await git(["commit", "-qm", "sync"], other);
      await git(["push", "--quiet"], other);
      const sSync = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★버전이 그대로면 unreleased — 버튼을 안 띄운다(sync 는 알림이 아니다)",
          sSync.state === "unreleased" && sSync.behind > 0,
          `state=${sSync.state} behind=${sSync.behind} ${sSync.version}→${sSync.newVersion}`,
        ),
      );

      // (b) 버전이 오르면 = release → 띄운다.
      await writeFile(path.join(other, "package.json"), '{"version":"1.1.0"}\n');
      await git(["add", "-A"], other);
      await git(["commit", "-qm", "release"], other);
      await git(["push", "--quiet"], other);
      const sRel = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★버전이 오르면 available + 새 버전을 알려준다",
          sRel.state === "available" && sRel.newVersion === "1.1.0" && sRel.version === "1.0.0",
          `state=${sRel.state} ${sRel.version}→${sRel.newVersion}`,
        ),
      );

      // (c) 버전을 못 읽으면 **종전대로 띄운다** — 우리 파싱 실패로 진짜 릴리스를 숨기는
      //     쪽이 반대보다 나쁘다(보수적 폴백).
      await writeFile(path.join(other, "package.json"), '{"version":"garbage"}\n');
      await git(["add", "-A"], other);
      await git(["commit", "-qm", "bad-version"], other);
      await git(["push", "--quiet"], other);
      const sBad = await checkUpdateAvailability(clone);
      out.push(
        assert(
          "★비교 불가면 숨기지 않는다(파싱 실패로 릴리스를 가리지 않는다)",
          sBad.state === "available",
          `state=${sBad.state} ${sBad.version}→${sBad.newVersion}`,
        ),
      );

      // ④ 판정 불가 → unknown. "최신" 으로 수렴하면 업데이트가 영영 안 보인다.
      const s5 = await checkUpdateAvailability(root); // git 레포 아님
      out.push(
        assert(
          "★판정 불가는 unknown 이다 — '최신'으로 삼키지 않는다(조용한 실패)",
          s5.state === "unknown",
          `state=${s5.state}`,
        ),
      );
      const { compareVersions } = await import("../../core/update-availability.js");
      out.push(
        assert(
          "버전 비교 — 세 자리 · 자릿수 아닌 사전순이 아니다",
          compareVersions("0.9.0", "0.10.0") === -1 &&
            compareVersions("1.0.0", "1.0.0") === 0 &&
            compareVersions("2.0.0", "1.9.9") === 1 &&
            compareVersions("1.2.3-rc.1", "1.2.3") === 0 &&
            compareVersions("x", "1.0.0") === null,
          `0.9.0<0.10.0=${compareVersions("0.9.0", "0.10.0")} rc=${compareVersions("1.2.3-rc.1", "1.2.3")}`,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return out;
  },
};
