/**
 * 배포본이 **레포로서 갖출 것을 갖췄나** (2026-08-20)
 *
 * 왜 회귀인가: 이 검토를 릴리스 절차의 *체크리스트 항목*으로 넣으면 바쁠 때 건너뛴다.
 * 오늘까지 이 레포가 배운 것이 정확히 그거다 — **게이트는 "있다" 가 아니라 "도는가"**.
 * 그래서 스위트에 넣는다(= 매 push 의 public CI 에서도 돈다).
 *
 * 잡는 것 — 전부 실제로 배포본에 있던 상태다:
 *  ① **끊긴 참조**: `docs/code-map.md` 가 "설계의 정본은 `docs/architecture.md`·`docs/decisions/`"
 *     라고 가리켰는데 **그 둘은 배포본에서 제외**된다. 받은 사람에겐 없는 문서다.
 *     (오늘의 F1 — SELECT 에 컬럼 누락 — 과 같은 부류: 참조하는 쪽만 보고 대상을 안 봤다.)
 *  ② **커뮤니티 파일 부재**: SECURITY·이슈 템플릿·CONTRIBUTING 이 없었다. 특히 이슈
 *     템플릿 부재는 이 제품에 비싸다 — 설치 실패가 OS·Node·npm 설정·로그로만 갈리는데
 *     "설치가 안 돼요" 한 줄이 오면 왕복이 시작된다(실제로 하루에 세 머신에서 겪었다).
 *  ③ **고아 문서**: 루트에 180줄짜리 지도가 **아무 데서도 링크되지 않은 채** 있었다.
 *
 * 등급: **동작 검사**(파일시스템 실측). 네트워크·GitHub API 는 안 쓴다 — 스위트는 싸고
 * 결정적이어야 한다. 토픽·레포 설명 같은 *원격* 메타는 릴리스 절차(R6)에서 본다.
 *
 * ★검사 대상 트리: 이 파일이 있는 레포. 개발 레포에선 오버레이(`_workspace/public-overlay/`)
 *  가, 배포 레포에선 루트가 커뮤니티 파일의 자리다 — **둘 다 받아준다**. 자리가 다르다고
 *  한쪽에서만 도는 검사를 만들면 그게 바로 "로컬 초록 ≠ CI 초록" 이다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OVERLAY = path.join(REPO, "_workspace/public-overlay");
/** 개발 레포면 오버레이가, 배포 레포면 루트가 공개 자산의 자리다. */
const PUBLIC_ROOT = existsSync(OVERLAY) ? OVERLAY : REPO;

const NOT_SHIPPED = [
  "docs/architecture.md",
  "docs/decisions/",
  "docs/distribution-plan.md",
  // 비전 정본 — 내부 실측(메모리 구성·인스턴스 수치)과 `docs/decisions/` 참조를 담고 있어
  // 배포본에선 끊긴 링크가 된다. 공개용 비전이 필요하면 **밖을 향해 따로 쓴다**(2026-08-25).
  "docs/vision.md",
  // 로드맵 — dev 작업 목록. 내부 품질 갭("여기 그물이 없다")과 개인 사용 통계가 실려 있고
  // `docs/decisions/` 참조가 배포본에선 끊긴다(2026-08-26).
  "docs/roadmap.md",
  // 비즈니스 비전 — 상용 전략 + "지금 백엔드로는 팔면 약관 위반" 이라는 자기 진술(2026-08-26).
  "docs/vision-business.md",
];
/** 배포 manifest 가 빼는 개발 전용 문서 — 검사 대상에서도 빠진다. */
const DEV_ONLY = [...NOT_SHIPPED, "CLAUDE.md", "PROJECT.md", "_workspace/", ".claude/", ".tiguclaw/"];

/**
 * 배포되는 마크다운 — 사용자가 clone 하면 **실제로 손에 들어오는** 문서.
 *
 * ★진실 소스는 `git ls-files` 다(파일시스템이 아니라). 처음에 `readdirSync` 로 썼다가
 *  두 가지를 동시에 틀렸다: 미추적 로컬 파일(`AGENT.md` — 런타임 인격 시드)을 "고아 문서"
 *  로 잡았고, **개발 레포 전용** README(배포본은 오버레이 판이 나간다)를 배포 문서로 쳐서
 *  그게 개발 문서를 가리키는 걸 결함으로 냈다. 둘 다 "무엇이 배포되는가" 를 안 보고
 *  "무엇이 디스크에 있는가" 를 본 탓이다 — 오늘 세 번째로 같은 부류다.
 */
const shippedDocs = (): string[] => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".md"));
  return tracked.filter(
    (f) =>
      !DEV_ONLY.some((d) => f === d || f.startsWith(d)) &&
      // 개발 레포에선 루트 README 가 dev 판이다(배포본은 오버레이 판) — 대상 아님.
      !(PUBLIC_ROOT !== REPO && /^README(\.en|\.ko)?\.md$/.test(f)),
  );
};

/** 배포본에 **없는** 것 — 문서가 이걸 "정본" 이라 가리키면 독자는 막다른 길에 선다. */

export const check: RegressionCheck = {
  name: "shipped-repo-complete",
  guards:
    "배포본이 받은 사람에게 없는 문서를 '정본' 이라 가리키던 것 + SECURITY·이슈 템플릿·CONTRIBUTING 부재 + 루트 고아 문서 (2026-08-20 배포본 검토)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 배포 문서가 **배포 안 되는 것**을 정본이라 가리키지 않는가 ──────────────
    const dangling: string[] = [];
    for (const rel of shippedDocs()) {
      const body = readFileSync(path.join(REPO, rel), "utf8");
      // 주석/설명이 아니라 **참조**를 본다: 마크다운 링크와 백틱 경로.
      for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)|`(docs\/[a-z0-9._/-]+)`/gi)) {
        const t = (m[1] ?? m[2] ?? "").split("#")[0]?.trim() ?? "";
        if (t === "" || /^(https?:|mailto:)/i.test(t)) continue;
        const norm = t.startsWith("docs/") ? t : path.posix.normalize(path.posix.join(path.posix.dirname(rel), t));
        // ★"배포본엔 없다" 고 **명시한** 문장은 통과시킨다 — 그건 독자를 속이지 않는다.
        if (NOT_SHIPPED.some((n) => norm === n || norm.startsWith(n))) {
          // ★면제는 **그 참조가 실제로 있는 줄**에서만 인정한다 (2026-08-20 적대 검토).
          //  종전엔 `body.split("\n").find(l => l.includes(t))` 로 **파일 전체의 첫 매칭 줄**을
          //  봤다. 그래서 어느 한 줄에 면제 문구를 달아두면 그 파일의 **같은 경로 참조 전부**가
          //  면제됐다 — 이 게이트가 잡은 결함을 고친 그 편집이, 같은 파일의 미래 재발을
          //  영구 면제한 셈이었다. 이제 매칭 위치의 줄만 본다.
          const at = (m.index ?? 0);
          const lineStart = body.lastIndexOf("\n", at) + 1;
          const lineEnd = body.indexOf("\n", at);
          const line = body.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
          if (!/배포본에 없|not shipped|개발 저장소/.test(line)) dangling.push(`${rel} → ${t}`);
        }
      }
    }
    out.push(
      assert(
        "★배포 문서가 '받은 사람에게 없는 문서' 를 정본이라 가리키지 않는다",
        dangling.length === 0,
        dangling.length === 0 ? "0건" : dangling.join(" · "),
      ),
    );

    // ── ② 레포로서 갖출 것 ───────────────────────────────────────────────────────
    //  손으로 관리하는 목록이지만 이건 **외부 표준**이다(GitHub 이 이 이름을 찾는다) —
    //  우리가 정하는 이름이 아니라서 파생시킬 근거가 없다. 대신 **작게** 유지한다.
    const required: Array<{ label: string; paths: string[]; why: string }> = [
      {
        label: "SECURITY",
        paths: [".github/SECURITY.md", "SECURITY.md"],
        why: "쉘·파일에 접근하는 제품인데 없으면 GitHub 에 비공개 신고 경로가 안 뜬다",
      },
      {
        label: "CONTRIBUTING",
        paths: ["CONTRIBUTING.md", ".github/CONTRIBUTING.md"],
        why: "미러 레포라는 사실·검증 명령을 모르면 기여자가 헛돈다",
      },
      {
        label: "이슈 템플릿",
        paths: [".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/config.yml"],
        why: "설치 실패는 OS·Node·npm 설정·로그로만 갈린다 — 없으면 매번 되묻는다",
      },
    ];
    for (const r of required) {
      const found = r.paths.find((p) => existsSync(path.join(PUBLIC_ROOT, p)));
      out.push(
        assert(
          `${r.label} 가 있다 — ${r.why}`,
          found !== undefined,
          found ?? `없음 (찾은 자리: ${PUBLIC_ROOT.replace(REPO, ".")}/{${r.paths.join(", ")}})`,
        ),
      );
    }

    // ── ②-b ★오버레이가 **통째로** 배포되는가 (2026-08-20 적대 검토 발견) ──────────
    //  위 ② 는 "오버레이 디스크에 있나" 만 본다. 그런데 sync 절차가 오버레이 파일을
    //  **손으로 열거**하고 있으면, 목록에 없는 파일은 배포에 **도달하지 않는다** —
    //  §1 이 PUB 추적파일을 전량 지우고 manifest 가 `_workspace/` 를 EXCLUDE 하기 때문이다.
    //  실제로 오늘 추가한 SECURITY·이슈템플릿·CONTRIBUTING 이 그 목록 밖이라, 다음 sync 에
    //  **조용히 사라질 상태**였고 dev 게이트는 계속 초록이었다.
    //  ★이 검사가 ② 를 의미 있게 만든다: 오버레이 ⊆ 배포 가 성립해야 "디스크에 있다"가
    //   "배포된다"를 뜻한다.
    {
      const skill = path.join(REPO, ".claude/skills/sync-public/SKILL.md");
      if (existsSync(skill)) {
        const body = readFileSync(skill, "utf8");
        const perFileCopies = [...body.matchAll(/^\s*cp .*public-overlay\/[^\s"]+/gm)].map(
          (m) => m[0].trim(),
        );
        out.push(
          assert(
            "★sync 가 오버레이를 통째로 복사한다(파일 열거 금지 — 열거하면 새 파일이 조용히 안 나간다)",
            /rsync -a "\$DEV\/_workspace\/public-overlay\/" "\$PUB\/"/.test(body),
            /rsync -a "\$DEV\/_workspace\/public-overlay/.test(body)
              ? "통째 복사"
              : "★손 열거 — 목록 밖 파일은 배포 안 됨",
          ),
          assert(
            "오버레이 파일을 하나씩 cp 하는 줄이 남아 있지 않다",
            perFileCopies.length === 0,
            perFileCopies.length === 0 ? "0건" : perFileCopies.join(" · ").slice(0, 160),
          ),
        );
      }
    }

    // ── ③ 고아 문서 — 링크되지 않은 문서는 없는 것과 같다 ────────────────────────
    //  README(한/영)에서 도달 가능한가만 본다. 표준 이름(LICENSE·CHANGELOG 등)은 제외 —
    //  그건 GitHub UI 가 스스로 보여준다.
    const STANDALONE = new Set([
      "README.md", "README.en.md", "README.ko.md", "CHANGELOG.md", "LICENSE.md", "NOTICE.md",
      "CONTRIBUTING.md", "SECURITY.md", "SYSTEM.md", "CODE_OF_CONDUCT.md",
    ]);
    const readmes = ["README.md", "README.en.md", "README.ko.md"]
      .map((f) => path.join(PUBLIC_ROOT, f))
      .filter(existsSync)
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    // ★대상은 **사람이 읽는 문서**뿐이다: `docs/` 아래와 루트. `agents/`·`skills/`·
    //  `commands/` 의 `.md` 는 frontmatter 를 가진 **런타임 데이터**지 문서가 아니고,
    //  컴포넌트 README(`packages/*`·`plugins/*`)는 코드 옆이 곧 제자리라 고아가 아니다.
    //  (첫 판이 이걸 안 갈라서 빌트인 에이전트 7종을 "고아 문서" 로 냈다 — 규칙의 오적용.)
    const orphans = shippedDocs().filter((rel) => {
      if (!rel.startsWith("docs/") && rel.includes("/")) return false;
      if (STANDALONE.has(path.basename(rel))) return false;
      const base = path.basename(rel);
      return !readmes.includes(rel) && !readmes.includes(base);
    });
    out.push(
      assert(
        "★배포 문서가 전부 README 에서 도달 가능하다(고아 0)",
        orphans.length === 0,
        orphans.length === 0 ? "0건" : orphans.join(", "),
      ),
    );

    return out;
  },
};
