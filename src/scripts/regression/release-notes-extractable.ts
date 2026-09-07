/**
 * 회귀: **릴리스 노트가 실제로 뽑힌다** (2026-08-23 4라운드 F7).
 *
 * 릴리스 절차는 CHANGELOG 에서 그 버전 섹션만 awk 로 잘라 `gh release create --notes-file`
 * 에 넘긴다. 섹션 헤더가 없거나 버전이 어긋나면 **awk 가 0바이트를 내고 `gh` 는 그대로
 * 빈 릴리스 노트를 만든다** — 에러 없이. 되돌리려면 공개된 릴리스를 편집해야 한다.
 *
 * ★이걸 손 체크리스트가 지키고 있었다. 체크리스트는 바쁠 때 건너뛰는 쪽이다.
 *  판정이 순수하니(파일 두 개를 읽고 비교) 기계가 본다. [[feedback_gate_must_actually_run]]
 *
 * ★배포 레포에서도 돈다 — 거기선 오버레이가 아니라 **루트** `CHANGELOG.md` 가 실물이다.
 *  (`_workspace/` 만 보고 "대상 아님" 으로 넘기면, 정작 사용자가 받는 파일엔 그물이 0이 된다.)
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const readFirst = async (rels: string[]): Promise<{ path: string; text: string } | null> => {
  for (const rel of rels) {
    try {
      return { path: rel, text: await readFile(new URL(rel, import.meta.url), "utf8") };
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const pkgRaw = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
  const version = String((JSON.parse(pkgRaw) as { version?: string }).version ?? "");
  // ★영어판이 릴리스 노트의 원본이다(`gh release` 는 영어권도 본다). 이름에 코드가 붙었다
  //  (2026-09-02) — 옛 이름은 배포 레포·옛 체크아웃을 위해 뒤에 남긴다.
  const found = await readFirst([
    "../../../_workspace/public-overlay/CHANGELOG.en.md", // dev(진실 소스)
    "../../../CHANGELOG.en.md", // 배포 레포(사용자가 받는 실물)
    "../../../_workspace/public-overlay/CHANGELOG.md", // 코드 없던 시절
    "../../../CHANGELOG.md",
  ]);

  out.push(
    assert(
      "package.json 에 버전이 있고 CHANGELOG 를 찾았다",
      version !== "" && found !== null,
      found === null ? "★CHANGELOG 를 못 찾았다(오버레이·루트 둘 다 없음)" : `v${version} · ${found.path.split("/").pop()}`,
    ),
  );
  if (found === null || version === "") return out;

  const lines = found.text.split("\n");
  const headIdx = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  out.push(
    assert(
      `★CHANGELOG 에 현재 버전 섹션이 있다 (## [${version}])`,
      headIdx >= 0,
      headIdx >= 0
        ? `${headIdx + 1}행`
        : `★없다 — 릴리스 노트 추출이 0바이트가 되고 gh 가 **빈 노트**를 조용히 만든다`,
    ),
  );
  if (headIdx < 0) return out;

  // 릴리스 절차의 awk 와 **같은 셈법**: 그 헤더 다음 줄부터 다음 `## [` 직전까지.
  const body: string[] = [];
  for (let i = headIdx + 1; i < lines.length; i += 1) {
    if (lines[i]!.startsWith("## [")) break;
    body.push(lines[i]!);
  }
  const meat = body.join("\n").trim();
  // ★`### Added` 같은 **헤더만** 남은 섹션도 0항목이다 — 종전엔 0바이트 경계만 막아
  //  "항목 없음" 을 통과시켰다(실측 19바이트 릴리스 노트). 헤더를 걷고 다시 잰다.
  const items = body
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join("\n")
    .trim();
  out.push(
    assert(
      "★추출된 릴리스 노트에 **항목**이 있다(헤더만 있는 섹션도 빈 것이다)",
      items.length > 0,
      items.length > 0
        ? `${meat.split("\n").length}줄 · 항목 ${items.length}자`
        : "★항목 0 — 빈 릴리스 노트가 조용히 공개된다",
    ),
    assert(
      "추출이 다음 버전 섹션을 넘어가지 않는다",
      !meat.includes("## ["),
      !meat.includes("## [") ? "경계 확인" : "★다른 버전 내용이 섞였다",
    ),
  );

  // 하단 링크 참조 — 없으면 GitHub 에서 `[0.36.0]` 이 링크가 아니라 대괄호 문자로 렌더된다.
  out.push(
    assert(
      `하단 링크 참조가 있다 ([${version}]: …)`,
      new RegExp(`^\\[${version.replace(/\./g, "\\.")}\\]:\\s*http`, "m").test(found.text),
      new RegExp(`^\\[${version.replace(/\./g, "\\.")}\\]:\\s*http`, "m").test(found.text)
        ? "참조 확인"
        : `★[${version}] 참조가 없다 — 버전 헤더가 링크로 안 뜬다`,
    ),
    assert(
      "[Unreleased] 비교 링크가 현재 버전을 가리킨다",
      new RegExp(`^\\[Unreleased\\]:.*v${version.replace(/\./g, "\\.")}\\.\\.\\.HEAD`, "m").test(found.text),
      new RegExp(`^\\[Unreleased\\]:.*v${version.replace(/\./g, "\\.")}\\.\\.\\.HEAD`, "m").test(found.text)
        ? "갱신 확인"
        : `★[Unreleased] 가 v${version} 이 아닌 옛 버전을 가리킨다(릴리스 때 같이 올리는 줄)`,
    ),
  );

  // ── ★직전 버전 헤더가 살아 있나 (2026-09-07 적대 검토 P7) ────────────────────
  //  `## [0.49.1]` 한 줄을 지우면 그 버전 항목들이 **이번 섹션에 흡수**되고, R5 의 awk 가
  //  그걸 그대로 GitHub 릴리스 노트로 낸다. «다음 헤더를 안 넘어간다» 단언은 헤더가 없으니
  //  **당연히** 초록이다 — 그래서 못 잡았다. [[feedback_changelog_header_drop]] 에 «2회» 라고
  //  적힌 그 사고에 그물이 없었다.
  //  ★판정은 목록이 아니라 **파생**이다: 하단 `[x.y.z]:` 링크 참조가 있는 버전은 본문에
  //   헤더가 있어야 한다(둘은 짝이다). 새 버전을 더해도 저절로 대상이 된다.
  const linked = [...found.text.matchAll(/^\[(\d+\.\d+\.\d+)\]:\s*http/gm)].map((m) => m[1] ?? "");
  const headed = new Set(
    [...found.text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1] ?? ""),
  );
  const orphanRefs = linked.filter((v) => !headed.has(v));
  out.push(
    assert(
      "★링크 참조가 있는 버전은 본문에 **헤더가 있다** — 헤더를 지우면 그 버전 내용이 이번 릴리스 노트에 섞여 나간다",
      orphanRefs.length === 0,
      orphanRefs.length === 0
        ? `버전 ${headed.size}개 · 고아 참조 0`
        : `★헤더 없는 참조: ${orphanRefs.slice(0, 5).join(", ")}`,
    ),
  );

  // ── ★한국어판에도 이번 릴리스가 있나 (2026-09-07 적대 검토 P8) ────────────────
  //  이 검사는 영어판만 읽었다. `CHANGELOG.ko.md` 에서 현재 버전 섹션을 통째로 지워도
  //  초록이었고, 한국어 사용자에겐 이 릴리스가 **없는 것**이 된다. 「양문」이 링크
  //  상호참조만 지키고 **내용 대칭**은 안 지키고 있었다.
  const ko = await readFirst([
    "../../../_workspace/public-overlay/CHANGELOG.ko.md",
    "../../../CHANGELOG.ko.md",
  ]);
  out.push(
    assert(
      "★양문이 **내용으로** 대칭이다 — 한국어판에도 이번 버전 섹션이 있다",
      ko === null || ko.text.includes(`## [${version}]`),
      ko === null
        ? "한국어판 없음(배포 레포·옛 체크아웃) — 대상 아님"
        : ko.text.includes(`## [${version}]`)
          ? `ko 에도 [${version}] 있음`
          : `★ko 에 [${version}] 이 없다 — 한국어 사용자에겐 이 릴리스가 없는 것이 된다`,
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "release-notes-extractable",
  guards:
    "릴리스 노트 추출(awk)이 0바이트를 내도 gh 가 빈 릴리스를 조용히 만들던 것 — 버전↔CHANGELOG 정합을 손 체크리스트가 지키고 있었다",
  run,
};
export default check;
