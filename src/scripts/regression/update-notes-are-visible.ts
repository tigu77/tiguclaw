/**
 * 회귀: **업데이트 전에 무엇이 바뀌는지 볼 수 있다** (2026-08-27).
 *
 * ★정태님 지적: *"업데이트 버튼만 달랑 있으니까 변경 내역을 확인하기가 힘든데."* 맞았다 —
 *  종전엔 **받아봐야 알았다.**
 *
 * ★데이터는 이미 손안에 있었다. 판정이 어차피 `git fetch` 를 돌리는데(그래야 몇 커밋
 *  뒤처졌는지 안다), fetch 는 원격 오브젝트를 **다운로드까지** 한다 — 작업트리만 안 건드린다.
 *  ★첫 실증은 이미 최신인 레포에서 해서 아무것도 증명하지 못했다(정태님이 짚어줬다) —
 *  그래서 이 검사는 **뒤처진 레포를 실제로 만들어서** 본다.
 *
 * ★**자리가 바뀌었다** (같은 날 두 번째 판). 정태님이 *"메시지 박스면 마크다운 렌더러가
 *  아니라 이상하게 보일 텐데"* → *"설정에 변경 이력 밑에 업데이트 내역 하나 더"* →
 *  *"저러면 업데이트 내역을 **다** 볼 수 있으니까"* 로 설계를 바꿨다. 계약도 바뀌었다:
 *  ①자르지 않는다 ②마크다운 그대로 ③경로가 하나다(판정 응답은 내역을 안 싣는다)
 *  ④화면 코드도 하나다(두 행이 컴포넌트를 공유) ⑤받을 게 없으면 행 자체가 없다.
 *
 * ★★**세 번째 판 — 그물을 고쳤다** (2026-08-27 적대 검토, 변이 37종 중 11종 통과).
 *  제품 코드는 전부 옳았는데(P축 0건) **검사가 성겼다.** 뚫린 자리와 고침:
 *
 *   G-a  화면 계약을 **소스 문자열**로 지켜서, 행 가드를 **반대로 뒤집어도**(받을 게
 *        있을 때 행이 사라진다) 29건이 전부 초록이었다. → 판정을 `updateNotesVisible`
 *        순수 함수로 뽑고, 여기서 **진리표를 실행**한다 + 행 조립기도 **실제로 부른다**.
 *   G2   실제 호출부에 상한 3을 되살려도 안 잡혔다 — git 픽스처의 원격이 **2버전**만
 *        앞서서 상한 3이 작동해도 결과가 같았다. **첫 판이 뚫린 것과 같은 부류가
 *        다른 자리에 남아 있었다.** → 원격을 4버전 앞서게 한다.
 *   G4   `views` 에만 주석을 걷어서, `core` 의 오버레이 경로를 지우고 **주석에** 남기면
 *        통과했다(그 경로가 없으면 개발 레포에선 기능이 통째로 죽는다). → 전부 걷는다.
 *   G6   "판정은 내역을 안 싣는다" 가 `notes` 라는 **이름**에만 걸려 있어, 필드명을
 *        바꾸면 되살릴 수 있었다. → 이름이 아니라 **행위**(그 함수를 부르나)로 본다.
 *   G7   `[Unreleased]` 단언이 **어떤 변이로도 빨강이 될 수 없었다**(그 경로에선 어차피
 *        비교 불가로 걸러진다). → 판별력이 있는 입력으로 바꾼다.
 *   G8   `availBody` 슬라이스가 파일 **뒤쪽까지** 먹어서, 정상 코드가 오탐 FAIL 을 냈다
 *        (죽은 게이트로 가는 진입로 — 이 레포가 데인 부류). → 슬라이스를 닫는다.
 *
 * 등급: **동작 검사** — 잘라내기·조립은 임시 git 레포에서, 화면 판정과 행 조립은 `vm` 에서
 * **실제로 부른다**. 남은 소스 대조는 배선(엔드포인트·결선)뿐이고 그 사실을 아래에 적었다.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
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

/**
 * 주석을 **지운다** — 줄머리 통째 + 줄끝 `//`.
 *
 * ★이 레포에 기록된 부류다: 검사가 *그 규칙을 설명하는 글*을 위반 사례로 세면 상시 FAIL 이
 *  되고, 그러면 아무도 안 돌린다. 반대로 문구를 피해 돌려 쓰면 다음 사람이 또 밟는다.
 * ★★**줄끝도 걷는다** (적대 검토 G-a·M38). 종전엔 줄머리만 걷어서 `code(); // 마커` 로
 *  뚫렸다 — 마커를 주석에 남기고 코드를 지우면 통과했다. `//` 앞에 공백/줄머리를 요구해
 *  `"http://…"` 같은 URL 은 건드리지 않는다.
 */
const stripComments = (src: string): string =>
  src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "").replace(/(^|\s)\/\/[^\n]*$/gm, "$1");

/** IIFE 안의 최상위 선언 하나를 떼어낸다(블록 화살표 · 한 줄 화살표 둘 다). */
const sliceConst = (src: string, name: string): string => {
  const head = `      const ${name} = `;
  const from = src.indexOf(head);
  if (from < 0) throw new Error(`${name} 정의를 못 찾음 — 구조가 바뀌었나`);
  const firstLineEnd = src.indexOf("\n", from);
  const firstLine = src.slice(from, firstLineEnd);
  if (!firstLine.trimEnd().endsWith("{")) return firstLine; // 한 줄짜리
  const end = src.indexOf("\n      };", from);
  if (end < 0) throw new Error(`${name} 의 끝을 못 찾음`);
  return src.slice(from, end + "\n      };".length);
};

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

## [0.38.0] - 2026-08-24

### Added

- 제일 옛 것.
`;

// ★버전이 **다섯**인 이유: 종전 기본 상한이 3이었다. 픽스처가 상한 이하이면 "상한 3" 과
//  "상한 없음" 이 **같은 답**을 내서 변이가 통과한다 — 실제로 두 번 그렇게 뚫렸다(첫 판은
//  `BODY` 가 3개, 두 번째 판은 `BODY` 를 넷으로 늘렸는데 **git 픽스처가 2개**였다).
//  넷 이상이 밀린 상태를 양쪽에서 만든다.

export const check: RegressionCheck = {
  name: "update-notes-are-visible",
  guards:
    "업데이트 칩이 '있다'만 말하고 무엇이 바뀌는지는 받아봐야 알던 것 — fetch 로 이미 받아둔 원격 CHANGELOG 를 안 읽고 있었다 + 그 내역을 확인창에 평문으로 잘라 싣던 것 + 받을 게 없는데도 '없습니다' 행이 상시 붙어 있던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 잘라내기 — 순수 함수를 실제로 부른다 ────────────────────────────────
    const from040 = changelogSince(BODY, "0.40.0");
    const from041 = changelogSince(BODY, "0.40.1");
    const latest = changelogSince(BODY, "0.41.0");
    const capped = changelogSince(BODY, "0.39.0", 1);
    const unknown = changelogSince(BODY, undefined);
    const all = changelogSince(BODY, "0.1.0");

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
      // ★이번 설계의 계약 — *"저러면 업데이트 내역을 **다** 볼 수 있으니까"*.
      assert(
        "★★상한이 **기본으로는 없다**(설정 패널은 스크롤된다 — 밀린 만큼 전부 보인다)",
        all.sections.length === 5 && all.omitted === 0,
        `${all.sections.length}건 · 생략 ${all.omitted}(기대 5/0)`,
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
      // ★G7: 종전 판은 `from="0.1.0"` 만 봤는데, 그 경로에선 `compareVersions` 가 애초에
      //  `Unreleased` 를 못 비교해 걸러낸다 — 즉 **필터를 통째로 지워도 초록**이었다
      //  (판별력 0). `from === undefined` 경로는 앞에서부터 자르므로 필터가 진짜로 필요하다.
      assert(
        "★`[Unreleased]` 는 버전이 아니다(두 경로 **모두**에서 항목으로 새지 않는다)",
        [...unknown.sections, ...all.sections].every((s) => /^\d/.test(s.version)),
        [...unknown.sections, ...all.sections].map((s) => s.version).join(","),
      ),
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
      // ★내 설치본은 **0.38.0** — 원격이 넷 앞서게 한다(G2). 둘만 앞서면 상한 3이 되살아나도
      //  결과가 같아서 검사가 아무것도 안 지킨다.
      await writeFile(path.join(mine, "package.json"), JSON.stringify({ version: "0.38.0" }));
      await writeFile(path.join(mine, "CHANGELOG.md"), BODY.slice(BODY.indexOf("## [0.38.0]")));
      await git(["add", "-A"], mine);
      await git(["commit", "--quiet", "-m", "c1"], mine);
      await git(["push", "--quiet", "-u", "origin", "main"], mine);

      // 아직 원격이 안 앞섰다 — 받을 게 없으면 **빈손**이어야 한다.
      const nothing = await readUpdateChangelog(mine);
      out.push(
        assert(
          "★받을 게 없으면 빈 마크다운(화면이 '없습니다' 를 띄운다 — 빈 화면 금지)",
          nothing.markdown === "" && nothing.version === "0.38.0",
          `markdown=${JSON.stringify(nothing.markdown.slice(0, 40))} · version=${nothing.version}`,
        ),
      );

      // 원격이 네 버전 앞선다.
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
          beforeFetch.markdown === "" && beforeFetch.newVersion === "0.38.0",
          `markdown=${JSON.stringify(beforeFetch.markdown.slice(0, 30))} · newVersion=${beforeFetch.newVersion}`,
        ),
      );

      // 칩의 판정이 하는 일 = `git fetch`. 그 뒤엔 **pull 없이** 읽혀야 한다.
      await git(["fetch", "--quiet"], mine);
      const got = await readUpdateChangelog(mine);
      const worktree = JSON.parse(await readFile(path.join(mine, "package.json"), "utf8")) as {
        version: string;
      };
      const heads = ["0.41.0", "0.40.1", "0.40.0", "0.39.0"].filter((v) =>
        got.markdown.includes(`## [${v}]`),
      );

      out.push(
        assert(
          "★★**받기 전에** 읽힌다(작업트리는 그대로 — pull 없이 원격 CHANGELOG 를 본다)",
          worktree.version === "0.38.0" && got.version === "0.38.0" && got.newVersion === "0.41.0",
          `작업트리=${worktree.version} · 판정 version=${got.version} · newVersion=${got.newVersion}`,
        ),
        // ★G2 의 본체 — **네 개 전부**. 상한이 어디선가 되살아나면 여기서 3개로 떨어진다.
        assert(
          "★★밀린 **모든** 버전이 실린다(4개 — 실제 호출부에 상한이 되살아나면 여기서 걸린다)",
          heads.length === 4,
          `${heads.length}/4 · ${heads.join(",")}`,
        ),
        assert(
          "★이미 가진 버전(0.38.0)은 안 실린다",
          !got.markdown.includes("## [0.38.0]"),
          got.markdown.includes("## [0.38.0]") ? "★새어 나왔다" : "없음",
        ),
        assert(
          "★마크다운을 **그대로** 준다(장식을 걷지 않는다 — 렌더러가 그린다)",
          got.markdown.includes("**굵게**") && got.markdown.includes("`코드`"),
          `굵게=${got.markdown.includes("**굵게**")} · 백틱=${got.markdown.includes("`코드`")}`,
        ),
        assert(
          "★자른다는 말이 없다(자르지 않으니까 — 잘리면 여기서 걸린다)",
          !got.markdown.includes("…") && got.markdown.trim().endsWith("더 옛 것."),
          JSON.stringify(got.markdown.slice(-40)),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    // ── ③ 화면 판정 — **실행한다**(소스 문자열이 아니라) ──────────────────────
    // ★적대 검토 G-a: 종전엔 이 계약 전체가 substring 두 개에 걸려 있어서, 가드를 반대로
    //  뒤집거나 빈 블록으로 만들어도 전부 초록이었다. 이제 진짜로 부른다.
    const chipRaw = await readFile(path.join(REPO, "packages/dashboard/js/update-chip.js"), "utf8");
    const viewsRaw = await readFile(path.join(REPO, "packages/dashboard/js/view-models.js"), "utf8");

    const CASES: Array<[string, unknown, boolean]> = [
      ["받을 게 있다", { state: "available", newVersion: "9.9.9" }, true],
      ["막혀 있다(못 받는다)", { state: "blocked", blockedReason: "x" }, false],
      ["최신", { state: "up-to-date" }, false],
      ["커밋만 앞섬(릴리스 아님)", { state: "unreleased" }, false],
      ["판정 불가", { state: "unknown" }, false],
      ["아직 안 왔다", null, false],
      ["응답이 이상하다", {}, false],
    ];

    const ctx: Record<string, unknown> = {
      i18n: (k: string) => `<${k}>`,
      // 행 조립기와 빈 fragment 를 **구분되는 표식**으로 바꿔치기한다 — DOM 없이 결과를 읽는다.
      buildMarkdownRow: (spec: { id: string; url: string }) => ({ row: spec.id, url: spec.url }),
      document: { createDocumentFragment: () => ({ empty: true }) },
      updateChip: { state: (): unknown => null },
    };
    vm.createContext(ctx);
    vm.runInContext(
      [
        sliceConst(chipRaw, "updateChipView"),
        sliceConst(chipRaw, "updateNotesVisible"),
        sliceConst(viewsRaw, "buildUpdateNotesRow"),
        "this.__vis = updateNotesVisible; this.__row = buildUpdateNotesRow;",
      ].join("\n"),
      ctx,
    );
    const visible = ctx.__vis as (a: unknown) => boolean;
    const buildRow = ctx.__row as () => { row?: string; url?: string; empty?: boolean };
    const chipState = ctx.updateChip as { state: () => unknown };

    const wrongVis = CASES.filter(([, a, want]) => visible(a) !== want);
    const wrongRow = CASES.filter(([, a, want]) => {
      chipState.state = (): unknown => a;
      const r = buildRow();
      return want ? r.row !== "update-notes" : r.empty !== true;
    });
    chipState.state = (): unknown => ({ state: "available" });
    const readyRow = buildRow();

    out.push(
      assert(
        "★★「받을 게 있나」 판정이 진리표대로다(**실행해서** 확인 — 소스 문자열이 아니다)",
        wrongVis.length === 0,
        wrongVis.length === 0
          ? `${CASES.length}케이스 통과`
          : `★틀림: ${wrongVis.map(([n, , w]) => `${n}(기대 ${w})`).join(" / ")}`,
      ),
      assert(
        "★★행 조립기를 **실제로 불러** 확인한다(받을 게 있을 때만 행, 아니면 빈손)",
        wrongRow.length === 0,
        wrongRow.length === 0
          ? `${CASES.length}케이스 통과`
          : `★틀림: ${wrongRow.map(([n, , w]) => `${n}(기대 ${w ? "행" : "빈손"})`).join(" / ")}`,
      ),
      assert(
        "★그 행은 **원격**을 본다(설치본 CHANGELOG 를 다시 보여주면 의미가 없다)",
        readyRow.url === "/api/update-changelog",
        String(readyRow.url),
      ),
    );

    // ── ④ 배선 — 여기부터는 **소스 대조**다(등급을 정직하게 적는다) ───────────
    // ★주석은 전부 걷는다 (G4). 종전엔 `views` 만 걷어서, `core` 의 오버레이 경로를 지우고
    //  주석에 남기면 통과했다 — 그 경로가 없으면 개발 레포에선 기능이 통째로 죽는다.
    const core = stripComments(
      await readFile(path.join(REPO, "src/core/update-availability.ts"), "utf8"),
    );
    const bridge = stripComments(
      await readFile(path.join(REPO, "plugins/http-bridge/index.ts"), "utf8"),
    );
    const proxy = stripComments(
      await readFile(path.join(REPO, "packages/dashboard/index.ts"), "utf8"),
    );
    const chip = stripComments(chipRaw);
    const views = stripComments(viewsRaw);
    const html = stripComments(
      await readFile(path.join(REPO, "packages/dashboard/index.html"), "utf8"),
    );
    const ko = JSON.parse(await readFile(path.join(REPO, "locales/ko.json"), "utf8")) as Record<
      string,
      string
    >;
    const en = JSON.parse(await readFile(path.join(REPO, "locales/en.json"), "utf8")) as Record<
      string,
      string
    >;

    // ★G8: 슬라이스를 **닫는다**. 종전엔 파일 끝까지 먹어서 `readUpdateChangelog` 안의
    //  정상 코드(`const notes = …`)가 오탐 FAIL 을 냈다 — 오탐은 게이트를 죽인다.
    // ★G6: 그리고 판정 기준을 **이름이 아니라 행위**로 바꾼다. 필드명을 `releaseSections`
    //  로 갈면 통과하던 것을, "그 함수를 부르나" 로 보면 동의어가 없다.
    const availStart = core.indexOf("export const checkUpdateAvailability");
    const availEnd = core.indexOf("export const readUpdateChangelog");
    const availBody =
      availStart >= 0 && availEnd > availStart ? core.slice(availStart, availEnd) : "";

    const KEYS = [
      "models.updateNotes.head",
      "models.updateNotes.desc",
      "models.updateNotes.missing",
      "upd.notes",
      "upd.notesHead",
      "upd.confirm",
    ];
    const DEAD = ["upd.notesTruncated", "upd.notesOmitted"];

    out.push(
      assert(
        "★판정 함수 본문을 정확히 떼어냈다(못 떼면 아래가 미검사다)",
        availBody !== "" && availBody.includes('state: "available"'),
        availBody === "" ? "★슬라이스 실패" : `${availBody.length}자`,
      ),
      assert(
        "★★판정(`/update-availability`)이 변경 내역을 **읽지 않는다**(같은 내용에 경로 둘 금지 + 30분 폴링이 헛일 안 한다)",
        !/remoteChangelog\(/.test(availBody) && !/changelogSince\(/.test(availBody),
        `remoteChangelog=${/remoteChangelog\(/.test(availBody)} · changelogSince=${/changelogSince\(/.test(availBody)}`,
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
      assert(
        "★★두 행이 **한 컴포넌트**를 쓴다(정의 1 · 사용 2 — 70줄 복사 금지)",
        (views.match(/const buildMarkdownRow = /g) ?? []).length === 1 &&
          (views.match(/buildMarkdownRow\(\{/g) ?? []).length === 2,
        `정의 ${(views.match(/const buildMarkdownRow = /g) ?? []).length} · 사용 ${(views.match(/buildMarkdownRow\(\{/g) ?? []).length}`,
      ),
      assert(
        "★설정이 두 행을 **나란히** 그린다(변경 이력 → 업데이트 내역)",
        /buildChangelogRow\(\)\);\s*\n\s*page\.appendChild\(buildUpdateNotesRow\(\)\);/.test(views),
        /buildUpdateNotesRow\(\)\)/.test(views) ? "붙어 있음" : "★업데이트 내역 행이 없다",
      ),
      assert(
        "★`?` 가 마크업에 있고 **설정의 그 행으로** 데려간다(내용을 자기가 띄우지 않는다)",
        /id="update-notes"/.test(html) && /showSettings\(\{ open: "update-notes" \}\)/.test(chip),
        `마크업=${/id="update-notes"/.test(html)} · 목적지=${/open: "update-notes"/.test(chip)}`,
      ),
      assert(
        "★그 행을 **클릭으로** 연다(여는 절차가 핸들러에만 있다 — hidden 을 흉내 내면 사본이다)",
        /data-settings-row="' \+ want \+ '"/.test(views) && /b\.click\(\)/.test(views),
        /b\.click\(\)/.test(views) ? "클릭" : "★직접 hidden 조작",
      ),
      // ★`?` 는 위 진리표와 **같은 함수**를 쓴다 — 그래서 여기선 "그 함수를 쓰나"만 본다.
      //  형태를 정확히 맞춰 `&& false` 같은 덧붙임을 막는다(적대 검토 M29).
      assert(
        "★`?` 는 칩과 **함께** 사라진다 + 위와 **같은 판정**을 쓴다(사본 금지)",
        /if \(notesBtn\) notesBtn\.hidden = !updateNotesVisible\(a\);/.test(chip) &&
          /notesBtn\.hidden = true;/.test(chip) &&
          !/v\.kind !== "ready"/.test(chip),
        `공유 판정=${/notesBtn\.hidden = !updateNotesVisible\(a\);/.test(chip)} · 숨김=${/notesBtn\.hidden = true;/.test(chip)}`,
      ),
      assert(
        "★확인창은 **짧다**(같은 글을 두 자리에서 렌더하면 하나가 늙는다)",
        /window\.confirm\(`\$\{head\}\$\{i18n\("upd\.confirm"\)\}`\)/.test(chip) &&
          !/formatUpdateNotes/.test(chip),
        `짧은 confirm=${/window\.confirm\(`/.test(chip)} · 옛 포맷터 잔존=${/formatUpdateNotes/.test(chip)}`,
      ),
      // ── i18n: 양 언어 ──
      // ★`upd.notesHead`·`upd.confirm` 도 본다 (적대 검토 G11 부류) — 확인창이 쓰는 키가
      //  한쪽 언어에서 사라지면 코어가 ko 로 폴백해 **영어 화면에 한국어가 샌다**.
      assert(
        "★확인창·행이 쓰는 문구가 **두 언어 모두** 비지 않고 있다",
        KEYS.every(
          (k) =>
            typeof ko[k] === "string" && ko[k] !== "" && typeof en[k] === "string" && en[k] !== "",
        ),
        KEYS.filter(
          (k) => typeof ko[k] !== "string" || typeof en[k] !== "string" || en[k] === "",
        ).join(",") || `${KEYS.length}키 모두`,
      ),
      assert(
        "★쓰지 않게 된 문구는 **지웠다**(죽은 키가 번역 부담으로 남지 않게)",
        DEAD.every((k) => ko[k] === undefined && en[k] === undefined),
        `잔존=${DEAD.filter((k) => ko[k] !== undefined || en[k] !== undefined).join(",") || "0"}`,
      ),
    );

    return out;
  },
};
