/**
 * 회귀: **업데이트 전에 무엇이 바뀌는지 볼 수 있다** (2026-08-27).
 *
 * ★정태님 지적: *"업데이트 버튼만 달랑 있으니까 변경 내역을 확인하기가 힘든데."* 맞았다 —
 *  종전엔 **받아봐야 알았다.**
 *
 * ★그런데 데이터는 이미 손안에 있었다. 판정이 어차피 `git fetch` 를 돌리는데(그래야 몇 커밋
 *  뒤처졌는지 안다), fetch 는 원격 오브젝트를 **다운로드까지** 한다 — 작업트리만 안 건드린다.
 *  ★첫 실증은 이미 최신인 레포에서 해서 아무것도 증명하지 못했다(정태님이 짚어줬다) —
 *  그래서 이 검사는 **뒤처진 레포를 실제로 만들어서** 본다.
 *
 * ★**자리가 바뀌었다** (같은 날 두 번째 판). 첫 판은 `window.confirm` 에 평문을 실었는데,
 *  정태님이 *"메시지 박스면 마크다운 렌더러가 아니라 이상하게 보일 텐데"* → *"설정에 변경
 *  이력 밑에 업데이트 내역 하나 더 있고 거기서 보여주면 어때?"* → *"저러면 업데이트 내역을
 *  **다** 볼 수 있으니까"* 로 설계를 바꿨다. 그래서 계약도 바뀌었다:
 *
 *   ① **자르지 않는다** — 기본 상한이 사라졌다(스크롤되는 패널이니 자를 이유가 없다).
 *   ② **마크다운 그대로** — 장식을 걷지 않고 우리 렌더러가 그린다. 버전 헤더도 살린다.
 *   ③ **경로가 하나다** — `/update-availability` 는 내역을 **안 싣는다**. 30분마다 도는
 *      판정이 아무도 안 보는 `git show` 를 할 이유가 없고, 같은 내용에 경로가 둘이면 갈린다.
 *   ④ **화면 코드도 하나다** — 「변경 이력」과 「업데이트 내역」은 묻는 대상만 다르므로
 *      행 컴포넌트를 **공유**한다(70줄을 복사할 뻔했다).
 *
 * 등급: **동작 검사** — 잘라내기·조립은 임시 git 레포에서 **진짜로 돌린다**. 배선(엔드포인트·
 * 화면 결선)만 소스 대조다.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSince, readUpdateChangelog } from "../../core/update-availability.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const git = (args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, windowsHide: true }, (err) =>
      err === null ? resolve() : reject(err),
    );
  });

/** 진짜 CHANGELOG 모양(우리 파일에서 뜬 형태). 지어낸 픽스처가 아니다. */
const BODY = `# Changelog

## [Unreleased]

## [0.41.0] - 2026-08-27

### Added

- **새 기능 하나.** 설명 \`코드\` 와 **굵게**.

## [0.40.1] - 2026-08-27

### Fixed

- 고친 것.

## [0.40.0] - 2026-08-26

### Added

- 옛 것.

## [0.39.0] - 2026-08-25

### Added

- 더 옛 것.
`;

// ★버전이 **넷**인 이유: 종전 기본 상한이 3이었다. 픽스처에 셋만 두면 "상한 3" 과 "상한
//  없음" 이 **같은 답**을 내서 변이가 통과한다 — 실제로 첫 판이 그렇게 뚫렸다(같은 부류로
//  이 레포에서 두 번째다: "픽스처가 약해서 검사가 아무것도 안 지킨" 사례).

export const check: RegressionCheck = {
  name: "update-notes-are-visible",
  guards:
    "업데이트 칩이 '있다'만 말하고 무엇이 바뀌는지는 받아봐야 알던 것 — fetch 로 이미 받아둔 원격 CHANGELOG 를 안 읽고 있었다 + 그 내역을 확인창에 평문으로 잘라 싣던 것(설정 패널로 옮기며 상한·평문화가 사라졌다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 잘라내기 — 순수 함수를 실제로 부른다 ────────────────────────────────
    const from040 = changelogSince(BODY, "0.40.0");
    const from041 = changelogSince(BODY, "0.40.1");
    const latest = changelogSince(BODY, "0.41.0");
    const capped = changelogSince(BODY, "0.39.0", 1);
    const unknown = changelogSince(BODY, undefined);

    out.push(
      assert(
        "★내 버전보다 **위**인 것만 싣는다(이미 가진 걸 다시 보여주지 않는다)",
        from040.sections.map((s) => s.version).join(",") === "0.41.0,0.40.1",
        from040.sections.map((s) => s.version).join(",") || "(없음)",
      ),
      assert(
        "★한 칸 위면 그 하나만",
        from041.sections.map((s) => s.version).join(",") === "0.41.0",
        from041.sections.map((s) => s.version).join(",") || "(없음)",
      ),
      assert(
        "★최신이면 빈손(칩이 떠도 보여줄 게 없으면 아무 말 안 한다)",
        latest.sections.length === 0,
        `${latest.sections.length}건`,
      ),
      // ★이게 이번 설계의 계약이다 — *"저러면 업데이트 내역을 **다** 볼 수 있으니까"*.
      //  종전 기본값은 3이었고, 그건 스크롤 없는 `confirm` 상자 때문이었다. 자리가 바뀌었으니
      //  이유도 사라졌다. 기본이 다시 유한해지면 오래 밀린 설치가 **조용히** 일부만 본다.
      assert(
        "★★상한이 **기본으로는 없다**(설정 패널은 스크롤된다 — 밀린 만큼 전부 보인다)",
        changelogSince(BODY, "0.1.0").sections.length === 4 &&
          changelogSince(BODY, "0.1.0").omitted === 0,
        `${changelogSince(BODY, "0.1.0").sections.length}건 · 생략 ${changelogSince(BODY, "0.1.0").omitted}`,
      ),
      assert(
        "★상한을 **주면** 그때만 자르고 몇 개 생략했는지 말한다(조용히 삼키지 않는다)",
        capped.sections.length === 1 && capped.omitted === 2,
        `실린 ${capped.sections.length} · 생략 ${capped.omitted}(기대 1/2)`,
      ),
      assert(
        "★버전을 모르면 최신 1개만(모르면서 다 아는 척하지 않는다)",
        unknown.sections.length === 1 && unknown.sections[0]?.version === "0.41.0",
        `${unknown.sections.length}건 · ${unknown.sections[0]?.version}`,
      ),
      assert(
        "★`[Unreleased]` 는 버전이 아니다(항목으로 새지 않는다)",
        changelogSince(BODY, "0.1.0").sections.every((s) => /^\d/.test(s.version)),
        changelogSince(BODY, "0.1.0").sections.map((s) => s.version).join(","),
      ),
      // ★헤더를 살려야 여러 버전이 한 덩어리로 붙지 않는다(날짜도 거기 있다).
      assert(
        "★버전 헤더를 **원문 그대로** 들고 온다(날짜 포함 — 없으면 섹션이 뭉갠다)",
        from040.sections[0]?.heading === "## [0.41.0] - 2026-08-27" &&
          from040.sections[1]?.heading === "## [0.40.1] - 2026-08-27",
        JSON.stringify(from040.sections.map((s) => s.heading)),
      ),
    );

    // ── ② 실제 git 위에서 조립 — 뒤처진 레포를 만들어 돌린다 ──────────────────
    const root = await mkdtemp(path.join(tmpdir(), "upd-notes-"));
    try {
      const origin = path.join(root, "origin");
      const mine = path.join(root, "mine");
      const other = path.join(root, "other");
      await git(["init", "--quiet", "--bare", "-b", "main", origin], root);
      await git(["clone", "--quiet", origin, mine], root);
      const cfg = async (c: string): Promise<void> => {
        await git(["config", "user.email", "r@r"], c);
        await git(["config", "user.name", "r"], c);
      };
      await cfg(mine);
      // 내 설치본: 0.40.0, CHANGELOG 엔 0.40.0 까지.
      await writeFile(path.join(mine, "package.json"), JSON.stringify({ version: "0.40.0" }));
      await writeFile(
        path.join(mine, "CHANGELOG.md"),
        BODY.slice(BODY.indexOf("## [0.40.0]")),
      );
      await git(["add", "-A"], mine);
      await git(["commit", "--quiet", "-m", "c1"], mine);
      await git(["push", "--quiet", "-u", "origin", "main"], mine);

      // 아직 원격이 안 앞섰다 — 받을 게 없으면 **빈손**이어야 한다.
      const nothing = await readUpdateChangelog(mine);
      out.push(
        assert(
          "★받을 게 없으면 빈 마크다운(화면이 '없습니다' 를 띄운다 — 빈 화면 금지)",
          nothing.markdown === "" && nothing.version === "0.40.0",
          `markdown=${JSON.stringify(nothing.markdown.slice(0, 40))} · version=${nothing.version}`,
        ),
      );

      // 원격이 두 버전 앞선다.
      await git(["clone", "--quiet", origin, other], root);
      await cfg(other);
      await writeFile(path.join(other, "package.json"), JSON.stringify({ version: "0.41.0" }));
      await writeFile(path.join(other, "CHANGELOG.md"), BODY);
      await git(["add", "-A"], other);
      await git(["commit", "--quiet", "-m", "c2"], other);
      await git(["push", "--quiet", "origin", "main"], other);

      // ★**아직 fetch 를 안 했다** — 이 함수는 스스로 갱신하지 않는 게 계약이다(갱신은
      //  판정 칩의 일이고, 따로 하면 둘이 다른 답을 한다). 그래서 지금은 빈손이어야 한다.
      const beforeFetch = await readUpdateChangelog(mine);
      out.push(
        assert(
          "★★스스로 `fetch` 하지 않는다(칩이 본 것과 **같은 것**을 본다 — 두 화면이 갈리지 않게)",
          beforeFetch.markdown === "" && beforeFetch.newVersion === "0.40.0",
          `markdown=${JSON.stringify(beforeFetch.markdown.slice(0, 30))} · newVersion=${beforeFetch.newVersion}`,
        ),
      );

      // 칩의 판정이 하는 일 = `git fetch`. 그 뒤엔 **pull 없이** 읽혀야 한다.
      await git(["fetch", "--quiet"], mine);
      const got = await readUpdateChangelog(mine);
      const worktree = JSON.parse(
        await readFile(path.join(mine, "package.json"), "utf8"),
      ) as { version: string };

      out.push(
        assert(
          "★★**받기 전에** 읽힌다(작업트리는 그대로 — pull 없이 원격 CHANGELOG 를 본다)",
          worktree.version === "0.40.0" && got.version === "0.40.0" && got.newVersion === "0.41.0",
          `작업트리=${worktree.version} · 판정 version=${got.version} · newVersion=${got.newVersion}`,
        ),
        assert(
          "★밀린 **모든** 버전이 실린다(0.41.0 + 0.40.1)",
          got.markdown.includes("## [0.41.0]") && got.markdown.includes("## [0.40.1]"),
          JSON.stringify(got.markdown.slice(0, 90)),
        ),
        assert(
          "★이미 가진 버전(0.40.0)은 안 실린다",
          !got.markdown.includes("## [0.40.0]"),
          got.markdown.includes("## [0.40.0]") ? "★새어 나왔다" : "없음",
        ),
        assert(
          "★마크다운을 **그대로** 준다(장식을 걷지 않는다 — 렌더러가 그린다)",
          got.markdown.includes("**굵게**") && got.markdown.includes("`코드`"),
          `굵게=${got.markdown.includes("**굵게**")} · 백틱=${got.markdown.includes("`코드`")}`,
        ),
        assert(
          "★자른다는 말이 없다(자르지 않으니까 — 잘리면 여기서 걸린다)",
          !got.markdown.includes("…") && got.markdown.trim().endsWith("고친 것."),
          JSON.stringify(got.markdown.slice(-40)),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    // ── ③ 배선 ────────────────────────────────────────────────────────────────
    const core = await readFile(path.join(REPO, "src/core/update-availability.ts"), "utf8");
    const bridge = await readFile(path.join(REPO, "plugins/http-bridge/index.ts"), "utf8");
    const proxy = await readFile(path.join(REPO, "packages/dashboard/index.ts"), "utf8");
    // ★**주석을 지우고 센다.** 이 레포에 기록된 부류다 — 검사가 *그 규칙을 설명하는 글*을
    //  위반 사례로 세면 상시 FAIL 이 되고, 그러면 아무도 안 돌린다(반대로 문구를 피해
    //  돌려 쓰면 다음 사람이 또 밟는다). 검사 대상은 **코드**지 그걸 설명하는 글이 아니다.
    const stripLineComments = (src: string): string =>
      src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    const views = stripLineComments(
      await readFile(path.join(REPO, "packages/dashboard/js/view-models.js"), "utf8"),
    );
    const chip = await readFile(path.join(REPO, "packages/dashboard/js/update-chip.js"), "utf8");
    const html = await readFile(path.join(REPO, "packages/dashboard/index.html"), "utf8");
    const ko = JSON.parse(await readFile(path.join(REPO, "locales/ko.json"), "utf8")) as Record<string, string>;
    const en = JSON.parse(await readFile(path.join(REPO, "locales/en.json"), "utf8")) as Record<string, string>;

    // ★경로가 **둘**이면 갈린다 — 판정 응답이 내역을 다시 싣기 시작하면 여기서 걸린다.
    const availBody = core.slice(core.indexOf("export const checkUpdateAvailability"));
    out.push(
      assert(
        "★★판정(`/update-availability`)은 내역을 **안 싣는다**(같은 내용에 경로 둘 금지 + 30분 폴링이 헛일 안 한다)",
        !/notes/.test(availBody) && !/notes\?:/.test(core),
        /notes/.test(availBody) ? "★판정 응답에 notes 가 되살아났다" : "없음",
      ),
      assert(
        "★코어가 원격 CHANGELOG 를 **pull 없이** 읽는다 + **두 자리를** 본다",
        /git\(\[\s*"show",\s*`@\{u\}:\$\{rel\}`\]/.test(core) &&
          /"CHANGELOG\.md"/.test(core) &&
          /"_workspace\/public-overlay\/CHANGELOG\.md"/.test(core),
        // ★개발 레포는 정본이 오버레이 안이라, 루트만 보면 **요청자의 화면에서 안 뜬다**.
        `루트=${/"CHANGELOG\.md"/.test(core)} · 오버레이=${/public-overlay\/CHANGELOG\.md"/.test(core)}`,
      ),
      assert(
        "★브리지가 `/update-changelog` 를 **read 게이트로** 연다",
        /pathname === "\/update-changelog" && method === "GET"[\s\S]{0,80}?\?\s*"read"/.test(bridge) &&
          /readUpdateChangelog/.test(bridge),
        `라우트=${/pathname === "\/update-changelog"/.test(bridge)} · 코어 호출=${/readUpdateChangelog/.test(bridge)}`,
      ),
      assert(
        "★대시보드가 그걸 프록시한다(없으면 브라우저에서 404)",
        /pathname === "\/api\/update-changelog" && method === "GET"/.test(proxy) &&
          /proxyJson\(res, "\/update-changelog"\)/.test(proxy),
        `라우트=${/"\/api\/update-changelog"/.test(proxy)}`,
      ),
      // ── 화면 ──
      assert(
        "★★두 행이 **한 컴포넌트**를 쓴다(정의 1 · 사용 2 — 70줄 복사 금지)",
        (views.match(/const buildMarkdownRow = /g) ?? []).length === 1 &&
          (views.match(/buildMarkdownRow\(\{/g) ?? []).length === 2,
        `정의 ${(views.match(/const buildMarkdownRow = /g) ?? []).length} · 사용 ${(views.match(/buildMarkdownRow\(\{/g) ?? []).length}`,
      ),
      // ★받을 게 없으면 행 자체가 없다 — 그리고 그 판정을 **다시 만들지 않는다**.
      //  칩·`?`·이 행이 전부 `updateChipView` 하나를 본다(이 레포엔 "두 화면이 같은 값에
      //  반대로 행동한" 전례가 있다).
      assert(
        "★★받을 게 없으면 행을 **안 그린다** + 판정은 칩과 **같은 함수**(사본 금지)",
        /updateChipView\(updateChip\.state\(\)\)\.kind !== "ready"/.test(views) &&
          !/state === "available"/.test(views),
        `공유 판정=${/updateChipView\(updateChip\.state\(\)\)/.test(views)} · 재조립=${/state === "available"/.test(views)}`,
      ),
      assert(
        "★설정이 두 행을 **나란히** 그린다(변경 이력 → 업데이트 내역)",
        /buildChangelogRow\(\)\);\s*\n\s*page\.appendChild\(buildUpdateNotesRow\(\)\);/.test(views),
        /buildUpdateNotesRow\(\)\)/.test(views) ? "붙어 있음" : "★업데이트 내역 행이 없다",
      ),
      assert(
        "★업데이트 내역 행이 **원격**을 본다(설치본 CHANGELOG 를 다시 보여주면 의미가 없다)",
        /id: "update-notes"[\s\S]{0,400}?url: "\/api\/update-changelog"/.test(views),
        /url: "\/api\/update-changelog"/.test(views) ? "원격" : "★엉뚱한 URL",
      ),
      assert(
        "★`?` 가 마크업에 있고 **설정의 그 행으로** 데려간다(내용을 자기가 띄우지 않는다)",
        /id="update-notes"/.test(html) &&
          /showSettings\(\{ open: "update-notes" \}\)/.test(chip),
        `마크업=${/id="update-notes"/.test(html)} · 목적지=${/open: "update-notes"/.test(chip)}`,
      ),
      assert(
        "★그 행을 **클릭으로** 연다(여는 절차가 핸들러에만 있다 — hidden 을 흉내 내면 사본이다)",
        /data-settings-row="' \+ want \+ '"/.test(views) && /b\.click\(\)/.test(views),
        /b\.click\(\)/.test(views) ? "클릭" : "★직접 hidden 조작",
      ),
      assert(
        "★`?` 는 칩과 **함께** 사라진다(받을 게 없으면 물어볼 것도 없다 — 상시 배지 금지)",
        /notesBtn\.hidden = true/.test(chip) && /notesBtn\.hidden = v\.kind !== "ready"/.test(chip),
        `숨김=${/notesBtn\.hidden = true/.test(chip)} · ready 한정=${/v\.kind !== "ready"/.test(chip)}`,
      ),
      assert(
        "★확인창은 **짧다**(같은 글을 두 자리에서 렌더하면 하나가 늙는다)",
        /window\.confirm\(`\$\{head\}\$\{i18n\("upd\.confirm"\)\}`\)/.test(chip) &&
          !/formatUpdateNotes/.test(chip),
        `짧은 confirm=${/window\.confirm\(`/.test(chip)} · 옛 포맷터 잔존=${/formatUpdateNotes/.test(chip)}`,
      ),
      // ── i18n: 양 언어 ──
      assert(
        "★새 문구가 **두 언어 모두** 있다(한쪽만 있으면 영어 화면에 키가 그대로 뜬다)",
        ["models.updateNotes.head", "models.updateNotes.desc", "models.updateNotes.missing", "upd.notes"].every(
          (k) => typeof ko[k] === "string" && typeof en[k] === "string",
        ),
        ["models.updateNotes.head", "models.updateNotes.desc", "models.updateNotes.missing", "upd.notes"]
          .filter((k) => typeof ko[k] !== "string" || typeof en[k] !== "string")
          .join(",") || "4키 모두",
      ),
      assert(
        "★쓰지 않게 된 문구는 **지웠다**(죽은 키가 번역 부담으로 남지 않게)",
        ko["upd.notesTruncated"] === undefined && ko["upd.notesOmitted"] === undefined,
        `잔존=${["upd.notesTruncated", "upd.notesOmitted"].filter((k) => ko[k] !== undefined).join(",") || "0"}`,
      ),
    );

    return out;
  },
};
