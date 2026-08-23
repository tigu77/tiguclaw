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
  const found = await readFirst([
    "../../../_workspace/public-overlay/CHANGELOG.md", // dev(진실 소스)
    "../../../CHANGELOG.md", // 배포 레포(사용자가 받는 실물)
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
  return out;
};

export const check: RegressionCheck = {
  name: "release-notes-extractable",
  guards:
    "릴리스 노트 추출(awk)이 0바이트를 내도 gh 가 빈 릴리스를 조용히 만들던 것 — 버전↔CHANGELOG 정합을 손 체크리스트가 지키고 있었다",
  run,
};
export default check;
