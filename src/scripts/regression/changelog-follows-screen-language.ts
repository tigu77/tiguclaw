/**
 * 회귀: **변경 내역이 화면 언어를 따른다** (2026-09-02 정태님:
 * *"대시보드에서 변경내역이나 업데이트 내역도 언어에 따라 연결되면 어떨까"*).
 *
 * ★배경 — 이건 제안이 아니라 **같은 날 내가 만든 회귀**였다. v0.46.0 에서 변경 내역을
 *  `CHANGELOG.md`(영어)·`CHANGELOG.ko.md`(한국어)로 갈랐는데, 그걸 읽는 두 자리는
 *  **이름 하나만** 알고 있었다 — `/changelog`(설치본)·`/update-changelog`(원격). 그래서
 *  한국어 화면에서도 영어가 나왔다. 문서를 나누며 소비처를 안 본 것이다
 *  ([[feedback_scope_of_a_fix]] 「계약변경→호출부」).
 *
 * ★**등급: 동작.** 오늘 레드팀이 내 grep 그물 넷을 조건 반전 한 줄로 전부 뚫었다. 그래서
 *  여기선 **진짜 파일과 진짜 git 원격**을 만들어 돌린다 — 문자열이 남아 있어도 고른 결과가
 *  바뀌면 빨개진다. 배선(화면이 언어를 싣는가)만 소스 검사다.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  changelogCandidates,
  localeFromQuery,
  readInstalledChangelog,
} from "../../core/changelog.js";
import { readUpdateChangelog } from "../../core/update-availability.js";
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const git = (args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, windowsHide: true }, (err) =>
      err === null ? resolve() : reject(err),
    );
  });

const EN = "## [0.46.0] - 2026-09-02\n\n### Fixed\n\n- English body marker.\n";
const KO = "## [0.46.0] - 2026-09-02\n\n### Fixed\n\n- 한국어 본문 표시.\n";

export const check: RegressionCheck = {
  name: "changelog-follows-screen-language",
  guards:
    "변경 내역을 언어별 파일로 가른 뒤에도 대시보드가 `CHANGELOG.md` 한 이름만 읽어, 한국어 화면에서 영어 변경 내역이 나오던 것(v0.46.0 에서 갈랐고 같은 날 정태님이 지적) + 언어 코드가 파일 경로에 그대로 이어져 경로 탈출이 되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 설치본 읽기 — 진짜 파일로 고른다 ────────────────────────────────
    const root = await mkdtemp(path.join(tmpdir(), "cl-lang-"));
    try {
      await writeFile(path.join(root, "CHANGELOG.md"), EN);
      await writeFile(path.join(root, "CHANGELOG.ko.md"), KO);

      const ko = await readInstalledChangelog(root, "ko");
      out.push(
        assert(
          "★★한국어 화면이면 **한국어 파일**을 읽는다 — 이게 오늘 신고받은 그 동작이다",
          ko.includes("한국어 본문 표시") && !ko.includes("English body marker"),
          ko.includes("한국어") ? "한국어" : `★영어가 왔다: ${JSON.stringify(ko.slice(0, 50))}`,
        ),
      );

      const base = await readInstalledChangelog(root, undefined);
      out.push(
        assert(
          "★언어가 없으면 기본(영어) — 갈라지기 전 동작과 같다(회귀 0)",
          base.includes("English body marker"),
          base.includes("English") ? "영어" : `★${JSON.stringify(base.slice(0, 50))}`,
        ),
      );

      // ★언어 파일이 **없을 때** 빈손이면 안 된다 — 그 언어 사용자는 변경 내역을 영영 못 본다.
      await rm(path.join(root, "CHANGELOG.ko.md"));
      const fellBack = await readInstalledChangelog(root, "ko");
      out.push(
        assert(
          "★★그 언어 파일이 없으면 **기본으로 떨어진다** — 빈손이면 그 언어 사용자는 영영 못 본다",
          fellBack.includes("English body marker"),
          fellBack === "" ? "★빈손" : "폴백함",
        ),
      );

      // ★빈 파일도 «없음» 으로 친다 — 번역을 시작만 하고 비워둔 파일이 화면을 지우면 안 된다.
      await writeFile(path.join(root, "CHANGELOG.ko.md"), "   \n");
      const emptyKo = await readInstalledChangelog(root, "ko");
      out.push(
        assert(
          "★빈 언어 파일은 «없음» 으로 친다 — 번역을 시작만 한 파일이 화면을 지우면 안 된다",
          emptyKo.includes("English body marker"),
          emptyKo.trim() === "" ? "★빈 화면" : "폴백함",
        ),
      );

      // ★경로 탈출 — 이 값은 쿼리로 오고 파일 경로에 들어간다.
      const evil = await readInstalledChangelog(root, "../../../../etc/passwd");
      out.push(
        assert(
          "★★경로 탈출이 안 된다 — 이 값은 쿼리로 오고 경로에 들어간다(같은 오리진에 /api/messages 가 있다)",
          evil.includes("English body marker") && !evil.includes("root:"),
          evil.includes("root:") ? "★파일이 읽혔다" : "막힘",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    // ── ② 언어 코드 판정 — 모양으로만 통과 ────────────────────────────────
    out.push(
      assert(
        "★언어 코드는 **모양**으로 통과시킨다(목록이 아니다 — 언어가 늘어도 코드를 안 고친다)",
        localeFromQuery("ko") === "ko" &&
          localeFromQuery("en") === "en" &&
          localeFromQuery("pt-br") === "pt-br",
        `ko=${localeFromQuery("ko")} · pt-br=${localeFromQuery("pt-br")}`,
      ),
    );
    out.push(
      assert(
        "★★모양에 안 맞으면 **버린다** — 던지지 않고 기본으로 간다(못 보는 것보다 영어로라도 보이는 게 낫다)",
        localeFromQuery("../etc") === undefined &&
          localeFromQuery("ko/../..") === undefined &&
          localeFromQuery("") === undefined &&
          localeFromQuery(null) === undefined &&
          localeFromQuery("ko.md") === undefined,
        `../etc=${localeFromQuery("../etc")} · ko.md=${localeFromQuery("ko.md")}`,
      ),
    );
    out.push(
      assert(
        "★후보는 **언어 먼저, 영어 나중** 순이다 — 뒤집히면 언제나 영어가 이긴다. 맨 끝은 코드 없던 시절 이름(옛 설치본용)",
        JSON.stringify(changelogCandidates("ko")) ===
          JSON.stringify(["CHANGELOG.ko.md", "CHANGELOG.en.md", "CHANGELOG.md"]) &&
          JSON.stringify(changelogCandidates(undefined)) ===
            JSON.stringify(["CHANGELOG.en.md", "CHANGELOG.md"]),
        JSON.stringify(changelogCandidates("ko")),
      ),
    );

    // ── ③ 원격(업데이트 내역) — 진짜 git 으로 ─────────────────────────────
    const gr = await mkdtemp(path.join(tmpdir(), "cl-lang-git-"));
    try {
      const origin = path.join(gr, "origin");
      const mine = path.join(gr, "mine");
      const other = path.join(gr, "other");
      await git(["init", "--quiet", "--bare", "-b", "main", origin], gr);
      await git(["clone", "--quiet", origin, mine], gr);
      const cfg = async (c: string): Promise<void> => {
        await git(["config", "user.email", "r@r"], c);
        await git(["config", "user.name", "r"], c);
      };
      await cfg(mine);
      await writeFile(path.join(mine, "package.json"), JSON.stringify({ version: "0.45.0" }));
      await writeFile(path.join(mine, "CHANGELOG.md"), "## [0.45.0] - 2026-09-01\n\n- old\n");
      await git(["add", "-A"], mine);
      await git(["commit", "--quiet", "-m", "c1"], mine);
      await git(["push", "--quiet", "-u", "origin", "main"], mine);

      // 원격이 한 버전 앞서고 **두 언어**를 들고 있다.
      await git(["clone", "--quiet", origin, other], gr);
      await cfg(other);
      await writeFile(path.join(other, "package.json"), JSON.stringify({ version: "0.46.0" }));
      await writeFile(path.join(other, "CHANGELOG.md"), EN);
      await writeFile(path.join(other, "CHANGELOG.ko.md"), KO);
      await git(["add", "-A"], other);
      await git(["commit", "--quiet", "-m", "c2"], other);
      await git(["push", "--quiet", "origin", "main"], other);
      await git(["fetch", "--quiet", "origin"], mine);

      const rk = await readUpdateChangelog(mine, { locale: "ko" });
      out.push(
        assert(
          "★★«받으면 뭐가 바뀌나» 도 한국어를 읽는다 — 두 행이 나란한데 한쪽만 영어면 더 이상하다",
          rk.markdown.includes("한국어 본문 표시") && !rk.markdown.includes("English body marker"),
          rk.markdown.includes("한국어") ? "한국어" : `★${JSON.stringify(rk.markdown.slice(0, 60))}`,
        ),
      );
      const re = await readUpdateChangelog(mine, {});
      out.push(
        assert(
          "★언어 없이 부르면 기본(영어) — 종전 호출부가 그대로 동작한다",
          re.markdown.includes("English body marker"),
          re.markdown.includes("English") ? "영어" : `★${JSON.stringify(re.markdown.slice(0, 60))}`,
        ),
      );
      out.push(
        assert(
          "★언어를 타도 **버전 판정은 그대로**다(내역만 바뀌지 «받을 게 있나» 는 안 바뀐다)",
          rk.version === "0.45.0" && rk.newVersion === "0.46.0",
          `version=${rk.version} · new=${rk.newVersion}`,
        ),
      );

      // ★**자리가 둘**이다 — 배포본은 루트, 개발 레포는 `_workspace/public-overlay/` 안이
      //  정본이다. 루트만 보면 이 기능을 요청한 인스턴스에서 **정작 안 뜬다**(2026-08-27
      //  적대 검토 F4 가 실제로 그랬다). 종전엔 그 보장을 소스에서 문자열로 봤는데, 자리 ×
      //  이름이 언어별로 곱해지며 리터럴이 사라졌고 애초에 grep 으로 지킬 성질이 아니다 —
      //  **오버레이 자리에만** 파일을 둔 원격을 만들어 읽어낸다.
      await git(["rm", "--quiet", "CHANGELOG.md", "CHANGELOG.ko.md"], other);
      await writeFile(path.join(other, "package.json"), JSON.stringify({ version: "0.47.0" }));
      const ov = path.join(other, "_workspace", "public-overlay");
      await mkdir(ov, { recursive: true });
      await writeFile(path.join(ov, "CHANGELOG.md"), EN);
      await writeFile(path.join(ov, "CHANGELOG.ko.md"), KO);
      await git(["add", "-A"], other);
      await git(["commit", "--quiet", "-m", "c3"], other);
      await git(["push", "--quiet", "origin", "main"], other);
      await git(["fetch", "--quiet", "origin"], mine);

      const ovKo = await readUpdateChangelog(mine, { locale: "ko" });
      out.push(
        assert(
          "★★루트에 없고 **오버레이에만** 있어도 찾는다 — 개발 레포가 그 배치다(여기서 안 뜨면 요청자 화면에서 안 뜬다)",
          ovKo.markdown.includes("한국어 본문 표시"),
          ovKo.markdown === "" ? "★못 찾음" : "찾음(한국어)",
        ),
      );
    } finally {
      await rm(gr, { recursive: true, force: true });
    }

    // ── ④ 배선 — 화면이 언어를 **싣는가** ─────────────────────────────────
    const views = readSourceSync("packages/dashboard/js/view-models.js");
    const urls = [...views.matchAll(/url:\s*[`"]\/api\/(update-)?changelog([^`"]*)/g)];
    out.push(
      assert(
        "★★변경 내역 행 **둘 다** 화면 언어를 싣는다 — 안 실으면 서버는 영어를 줄 수밖에 없다",
        urls.length === 2 && urls.every((m) => m[2]?.includes("lang=") === true),
        urls.length === 0
          ? "★행을 못 찾음"
          : urls.map((m) => `/${m[1] ?? ""}changelog${m[2] ?? ""}`).join(" · "),
      ),
    );
    // ★**가운데 토막**도 본다 (2026-09-02). 화면이 언어를 싣고 브리지가 그걸 읽는데,
    //  그 사이 대시보드 프록시가 **경로만** 넘겨서 쿼리가 사라졌다 — 배포하고 실물을 열어
    //  보고서야 나왔다. 양끝만 검사하면 이 부류는 영영 안 보인다.
    const dashSrv = readSourceSync("packages/dashboard/index.ts");
    out.push(
      assert(
        "★★대시보드 프록시가 두 라우트의 **쿼리를 그대로 넘긴다** — 안 넘기면 화면이 실어도 도착하지 않는다",
        /proxyJson\(res, "\/changelog" \+ \(url\.search \?\? ""\)\)/.test(dashSrv) &&
          /proxyJson\(res, "\/update-changelog" \+ \(url\.search \?\? ""\)\)/.test(dashSrv),
        /"\/changelog" \+ /.test(dashSrv) ? "둘 다 전달" : "★경로만 넘긴다 — 쿼리가 사라진다",
      ),
    );

    const ops = readSourceSync("plugins/http-bridge/routes-ops.ts");
    out.push(
      assert(
        "★서버 두 라우트가 그 값을 **검증기를 통과시켜** 쓴다 — 날것을 경로에 이으면 탈출이 된다",
        (ops.match(/localeFromQuery\(url\.searchParams\.get\("lang"\)\)/g) ?? []).length === 2,
        `${(ops.match(/localeFromQuery\(/g) ?? []).length}곳`,
      ),
    );

    return out;
  },
};
