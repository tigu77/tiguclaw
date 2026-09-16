/**
 * 회귀: **배포본에 없는 문서를 가리키는 소스 주석은 «없는 게 정상» 이라고 설명돼 있다** (2026-09-16)
 *
 * 잡는 것: 설치본을 읽는 사람이 소스 주석의 `docs/decisions/…` 를 따라가 **없는 파일**을
 * 만나고, 그것을 결함이나 유실로 읽는 것.
 *
 * ★실제로 났다. 다른 인스턴스가 `plugins/computer-use/src/index.ts` 의 *"설계 정본:
 *  `docs/decisions/2026-09-15-computer-use.md`"* 를 따라가 못 찾고 **«어디서도 찾지
 *  못했다»** 를 미해결 항목으로 보고했다. 파일은 개발 저장소에 멀쩡히 있었다 — `docs/`
 *  배포가 **허용목록**이라 그 폴더가 안 나갈 뿐이다(`sync-public` §1, 내부 실측·상용
 *  전략이 섞여 있어 의도된 제외다).
 *
 * ★**주석을 고치지 않는다.** 실측 34개 파일·48건이고, 손으로 고치면 새로 쓰는 주석마다 또
 *  어긋난다([[feedback_hand_maintained_lists]]). 배치 자체는 옳다 — 주석은 개발 저장소에서
 *  읽는 글이다. 고쳐야 할 것은 **읽는 사람이 그걸 모른다**는 쪽이고, 그건 한 곳에 적으면
 *  끝난다.
 *
 * ★그래서 이 검사는 **개수를 고정하지 않는다**(스냅샷은 정당한 증감마다 빨개진다). 대신
 *  «그런 참조가 하나라도 있으면, 배포되는 지도 문서가 그 사실을 설명한다» 는 **조건부**
 *  성질을 본다. 참조가 0이 되면 설명 의무도 사라진다.
 *
 * ★**경계 — 이 부류를 보는 게이트가 이미 둘 있다. 같은 판단을 세 번 하지 않는다.**
 *
 *  | 게이트 | 무엇을 본다 | 요구 |
 *  |---|---|---|
 *  | `shipped-asset-self-contained` | `skills/`·`agents/` — **비서가 읽고 따라가는** 자산 | 자기완결(실측 0건) |
 *  | `shipped-repo-complete` ① | **배포되는 문서**(`docs/`·오버레이)의 참조 | 같은 줄에 «배포본에 없다» 표시가 없으면 금지 |
 *  | **이것** | `src/`·`plugins/` 의 **소스 주석** | 고치지 않되, 배포되는 지도가 설명할 것 |
 *
 *  ★셋의 요구가 다른 이유: **따라가는 주체**가 다르다. 기계가 따라가면 자기완결이어야 하고,
 *  독자가 따라가면 «여기 없다» 를 그 자리에서 알려야 하고, 개발자가 읽는 주석이면 한 곳에
 *  적어 두면 된다. 이 파일을 고칠 때 옆 둘의 범위를 침범하지 마라 — 넓히는 순간 같은
 *  판단이 두 곳이 된다([[feedback_simple_composable_no_duplication]]).
 *
 * 등급: **소스 게이트** — 배포 대상 트리를 읽어 판정한다.
 */
import { readFile, readdir } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = new URL("../../../", import.meta.url);

/** `docs/` 중 **배포되는** 것 — `sync-public` §1 의 허용목록과 같은 판정(정본은 그 스킬). */
const DOCS_SHIPPED = /^(code-map|core-boundaries|features|gateway|hooks|plugins|security|setup)(\.(ko|en))?\.md$/;

/**
 * `docs/<rel>` 이 **배포되는가** — 순수.
 *
 * ★수집기와 **갈라** 둔다(2026-09-16, 자기 변이에서 적발). 붙여 두면 수집기가 눈을 잃었을
 *  때 참조가 0이 되고, 아래 조건부 단언이 **공허하게 참**이 된다 — 「항상 초록인 가짜
 *  검사」([[feedback_gate_must_actually_run]]). 판정을 떼어 두면 눈이 멀었는지 **아는
 *  입력**으로 직접 잴 수 있다.
 */
export const isShippedDocRef = (rel: string): boolean =>
  !rel.includes("/") && DOCS_SHIPPED.test(rel);

/** 배포되는 소스가 짚은 `docs/…` 경로를 전부 모은다. */
const collectDocRefs = async (
  dir: URL,
  out: { file: string; ref: string }[] = [],
): Promise<{ file: string; ref: string }[]> => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
    if (e.isDirectory()) {
      // 회귀·스크립트는 배포 대상이 아니다(manifest EXCLUDE).
      if (e.name === "regression" || e.name === "scripts" || e.name === "bench") continue;
      await collectDocRefs(child, out);
      continue;
    }
    if (!/\.(ts|js|md)$/.test(e.name)) continue;
    const src = await readFile(child, "utf8");
    for (const m of src.matchAll(/docs\/([A-Za-z0-9._/-]+\.md)/g)) {
      const rel = m[1] ?? "";
      // `docs/decisions/x.md` → 파일명이 허용목록에 없거나 하위 폴더면 미배포다.
      if (!isShippedDocRef(rel)) out.push({ file: child.pathname.replace(REPO.pathname, ""), ref: rel });
    }
  }
  return out;
};

export const check: RegressionCheck = {
  name: "dev-only-doc-refs-are-explained",
  guards:
    "설치본을 읽는 사람이 소스 주석의 docs/decisions/… 를 따라가 없는 파일을 만나고 그것을 유실·결함으로 읽는 것(실제로 다른 인스턴스가 미해결로 보고했다)",
  run: async (): Promise<Assertion[]> => {
    const refs = [
      ...(await collectDocRefs(new URL("src/", REPO))),
      ...(await collectDocRefs(new URL("plugins/", REPO))),
    ];
    const map = await readFile(new URL("docs/code-map.md", REPO), "utf8");

    const files = new Set(refs.map((r) => r.file));
    const MARK = "소스 주석이 `docs/decisions/…` 를 가리켜도 그 파일은 여기 없다";
    const explained = map.includes(MARK);
    // 그 문단만 떼어낸다 — 인용 블록이 끊기는 곳(`>` 만 있는 줄)까지.
    const para = ((): string => {
      const at = map.indexOf(MARK);
      if (at < 0) return "";
      const rest = map.slice(at);
      const end = rest.indexOf("\n>\n");
      return end < 0 ? rest : rest.slice(0, end);
    })();
    // ★**트리마다 증거가 다르다 — 있는 쪽을 읽는다** (2026-09-17, 배포 트리 게이트가 잡음).
    //  첫 판은 `.claude/skills/sync-public/SKILL.md` 의 `DOCS_SHIP` 만 읽었는데 그 폴더는
    //  manifest EXCLUDE 라 **배포 레포에서 ENOENT 로 검사 자체가 던졌다**. 스킬이 경고해 둔
    //  부류다(*"개발 레포에만 있는 경로를 읽으면 배포 레포에서 깨진다"*).
    //  ★조용히 건너뛰지 않는다. 두 트리가 **다른 질문**에 답할 뿐이다:
    //    개발 트리 — «나갈 것인가»  → 허용목록(의도)
    //    배포 트리 — «나갔는가»      → 파일 실재(사실, 이쪽이 더 강한 증거다)
    const allowlistSrc = await readFile(
      new URL(".claude/skills/sync-public/SKILL.md", REPO),
      "utf8",
    ).catch(() => null);
    const shipEvidence: { how: string; ok: boolean } =
      allowlistSrc === null
        ? {
            how: "배포 트리 — docs/code-map.md 실재",
            ok: await readFile(new URL("docs/code-map.md", REPO), "utf8").then(
              () => true,
              () => false,
            ),
          }
        : {
            how: "개발 트리 — sync-public DOCS_SHIP 허용목록",
            ok: (/DOCS_SHIP="([^"]+)"/.exec(allowlistSrc)?.[1] ?? "")
              .split("|")
              .includes("code-map.md"),
          };

    const out: Assertion[] = [
      assert(
        "★**판정의 눈이 살아 있다** — 이게 멀면 아래 조건부 단언이 공허하게 참이 된다",
        // ★자기 변이에서 적발: 분류기를 «전부 배포됨» 으로 바꾸면 참조가 0이 되어 검사가
        //  통과했다. 트리 상태와 무관하게 **아는 입력**으로 분류기를 직접 잰다.
        isShippedDocRef("code-map.md") === true &&
          isShippedDocRef("security.ko.md") === true &&
          isShippedDocRef("decisions/2026-09-15-computer-use.md") === false &&
          isShippedDocRef("roadmap.md") === false &&
          isShippedDocRef("architecture.md") === false,
        `code-map=${isShippedDocRef("code-map.md")} · security.ko=${isShippedDocRef("security.ko.md")} · decisions/x=${isShippedDocRef("decisions/2026-09-15-computer-use.md")} · roadmap=${isShippedDocRef("roadmap.md")} · architecture=${isShippedDocRef("architecture.md")}`,
      ),
      assert(
        "★미배포 문서를 짚는 소스 참조가 있으면, **배포되는 지도**가 그 사실을 설명한다",
        // 조건부 — 참조가 0이면 설명 의무도 없다(개수를 고정하지 않는다).
        refs.length === 0 || explained,
        `참조 ${refs.length}건 / ${files.size}개 파일 · code-map 설명 ${explained ? "있음" : "없음"}${
          refs.length > 0 ? ` · 예: ${refs[0]?.file}→${refs[0]?.ref}` : ""
        }`,
      ),
      assert(
        "★그 설명이 **실제로 배포되는 문서**에 있다 — 개발 저장소에만 적으면 읽을 사람이 못 본다",
        // ★같은 파일의 상수를 자기가 검사하면 항진명제다(자기 변이에서 적발). 배포 여부의
        //  **정본은 `sync-public` 의 `DOCS_SHIP` 허용목록**이므로 거기를 읽어 대조한다 —
        //  누가 `code-map.md` 를 목록에서 빼면 이 설명이 조용히 배달 안 되고, 그때 빨개진다.
        shipEvidence.ok,
        `${shipEvidence.how} = ${shipEvidence.ok}`,
      ),
      assert(
        "★설명이 **왜 없는지**까지 말한다 — «의도된 제외» 를 모르면 결함으로 읽힌다",
        // ★문서 전체에서 낱말을 찾으면 264줄 어딘가에 우연히 있어 통과한다(자기 변이 M2).
        //  **그 문단 안에서만** 본다.
        /배포본엔 안 싣는다/.test(para) && /개발 저장소에만/.test(para),
        `문단(${para.length}자) 내 사유 ${/배포본엔 안 싣는다/.test(para)} · 소재 ${/개발 저장소에만/.test(para)}`,
      ),
    ];
    return out;
  },
};
