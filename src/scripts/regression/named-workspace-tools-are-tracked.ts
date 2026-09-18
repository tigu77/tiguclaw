/**
 * 회귀: **스킬·회귀가 «이름으로 부르는» `_workspace` 도구는 추적된다** (2026-09-17)
 *
 * 잡는 것: 절차가 부르는 파일이 **git 밖에 있어 조용히 사라지는 것.**
 *
 * ★`_workspace/*` 는 gitignore 다 — 일회성 프로브·캡처가 544개 10.4MB 쌓여서 그렇게 했고,
 *  그 판단은 옳다. 예외는 `public-overlay/`(공개 문서 진실 소스)와 `*.md`(기록)였다.
 *
 * ★그런데 **스킬이 부르는 도구**는 일회성 프로브가 아니다. `prepare-public-stage.mjs` ·
 *  `check-public-boot.mjs` · `check-public-ci.mjs` · `check-public-update.sh` 넷은 원래
 *  추적되고 있었는데(ignore 규칙 이전에 들어온 덕), **새로 만든 것은 그 규칙 밖으로 떨어진다.**
 *  실제로 2026-09-17 에 `sync-gate.sh` 가 그랬다 — sync-public 이 **매 블록에서 `source`**
 *  하는 파일인데 추적이 안 돼, 디스크에서 사라지면 싱크 절차가 통째로 깨질 상태였다.
 *  «컨텍스트를 비우기 전에 정리하자» 하다가 찾았다.
 *
 * ★**판정은 손 목록이 아니다** — «누가 이름으로 부르는가» 로 파생시킨다. 스킬과 회귀 소스를
 *  훑어 `_workspace/…` 참조를 **모으고**, 그 각각이 추적되는지 본다. 새 도구를 만들면 이
 *  검사가 저절로 따라온다([[feedback_hand_maintained_lists]]).
 *
 * ★반대편도 본다 — 참조가 **하나도 안 모이면** 스캐너가 눈을 잃은 것이다(항상 초록인 가짜
 *  검사). 알려진 도구 다섯이 잡히는지로 눈을 확인한다.
 *
 * 등급: **소스 게이트** — `git ls-files` 로 추적 여부를 실제로 묻는다.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = new URL("../../../", import.meta.url);
const REPO_DIR = REPO.pathname;

const tracked = (rel: string): Promise<boolean> =>
  new Promise((res) => {
    execFile("git", ["-C", REPO_DIR, "ls-files", "--error-unmatch", rel], (err) =>
      res(err === null),
    );
  });

/** 스킬·회귀 소스에서 `_workspace/<파일>` 참조를 모은다. */
const collectRefs = async (dir: URL, out: Set<string> = new Set()): Promise<Set<string>> => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
    if (e.isDirectory()) {
      await collectRefs(child, out);
      continue;
    }
    if (!/\.(md|ts|mjs|js)$/.test(e.name)) continue;
    const src = await readFile(child, "utf8");
    for (const m of src.matchAll(/_workspace\/([A-Za-z0-9_.\-/]+\.(?:mjs|sh|ts|js))/g)) {
      out.add(`_workspace/${m[1] ?? ""}`);
    }
  }
  return out;
};

export const check: RegressionCheck = {
  name: "named-workspace-tools-are-tracked",
  guards:
    "스킬이 매 블록에서 source 하는 도구가 gitignore 라 git 밖에 있던 것 — 사라지면 싱크 절차가 통째로 깨진다",
  run: async (): Promise<Assertion[]> => {
    // ★**배포 트리엔 이 검사의 대상이 없다** (2026-09-18 싱크에서 빨강 — `sync-gates-check-rc`
    //  와 **같은 부류의 두 번째**다). 이 검사는 `.claude/skills/` 와 `_workspace/` 를 읽는데
    //  둘 다 manifest 가 빼는 dev 전용이라, 배포 레포에선 ENOENT 로 **던진다.**
    //  스킬이 경고한 그 부류다: *"개발 레포에만 있는 경로를 읽으면 배포 레포에서 깨진다 —
    //  있는 쪽을 읽거나 «대상 아님» 을 **명시하고** 통과시켜라."*
    // ★**조용히 통과시키지 않는다.** 그리고 판정은 파일 목록이 아니라 **조건**이다:
    //  `.claude/` 가 없으면 배포 트리이고, 있는데 `_workspace/` 만 없으면 **진짜 실패**다.
    //  둘의 부재가 **함께** 성립하는지까지 재서 «항상 참인 가짜 검사» 가 되지 않게 한다.
    const exists = async (rel: string): Promise<boolean> => {
      try {
        await stat(new URL(rel, REPO));
        return true;
      } catch {
        return false;
      }
    };
    if (!(await exists(".claude"))) {
      const workspaceGone = !(await exists("_workspace"));
      return [
        assert(
          "배포 트리 — 이 검사의 대상(dev 하네스·`_workspace` 도구)이 통째로 없다. 개발 레포에서만 잰다",
          workspaceGone,
          `.claude/ 없음 · _workspace/ ${workspaceGone ? "없음" : "★있음(트리가 일관되지 않다)"}`,
        ),
      ];
    }
    // ★**스킬 쪽을 따로 모은다** (2026-09-17, 자기 변이 Q3 에서 적발). 한 자루에 섞으면
    //  스캐너를 엉뚱한 디렉터리로 돌려도 **이 파일 자신의 주석**이 도구 이름을 공급해
    //  «눈이 살아 있다» 가 통과한다 — 자기 글이 자기 증거가 되는 형상이다.
    const skillRefs = await collectRefs(new URL(".claude/skills/", REPO), new Set<string>());
    const refs = await collectRefs(
      new URL("src/scripts/regression/", REPO),
      new Set<string>(skillRefs),
    );

    const missing: string[] = [];
    for (const r of refs) {
      if (!(await tracked(r))) missing.push(r);
    }

    const KNOWN = [
      "_workspace/prepare-public-stage.mjs",
      "_workspace/check-public-boot.mjs",
      "_workspace/check-public-ci.mjs",
      "_workspace/sync-gate.sh",
    ];
    // 눈 검사는 **스킬 쪽 수집분만** 본다 — 이 파일의 주석은 증거가 될 수 없다.
    const seen = KNOWN.filter((k) => skillRefs.has(k));

    return [
      assert(
        "★**스캐너의 눈이 살아 있다** — 참조가 안 모이면 아래 단언이 공허하게 참이 된다",
        seen.length === KNOWN.length,
        `스킬에서 알려진 도구 ${KNOWN.length}개 중 ${seen.length}개 수집(스킬 참조 ${skillRefs.size}개 · 전체 ${refs.size}개)${
          seen.length < KNOWN.length ? ` · 못 본 것: ${KNOWN.filter((k) => !refs.has(k)).join(", ")}` : ""
        }`,
      ),
      assert(
        "★이름으로 불리는 `_workspace` 도구가 **전부 추적된다** — 하나라도 빠지면 절차가 깨진다",
        missing.length === 0,
        missing.length === 0
          ? `참조 ${refs.size}개 전부 추적됨`
          : `🔴 미추적 ${missing.length}개: ${missing.join(", ")}`,
      ),
    ];
  },
};
