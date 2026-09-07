/**
 * 회귀: **`docs/` 는 허용목록이고, 그 목록은 조용히 낡지 않는다** (2026-09-02 정태님 지적).
 *
 * ★뒤집은 이유: 종전엔 EXCLUDE 목록이었다 — `roadmap.md`·`decisions/`·`architecture.md`·
 *  `vision*.md`·`distribution-plan.md` 여섯을 **손으로** 빼고 나머지는 다 나갔다.
 *  그 손목록은 **틀리는 방향이 나빴다**: 새 내부 문서를 `docs/` 에 만들고 목록에 안 넣으면
 *  **조용히 공개로 나간다.** 로드맵엔 개인 사용 통계가, `decisions/` 엔 내부 실측·상용
 *  전략이 있다([[project_repo_private_pii]]).
 *
 * ★목록 자체를 없애지는 못했다 — `docs/decisions/` 참조가 **223곳**이라 폴더를 옮기는
 *  비용이 위험보다 크다. 그래서 **없애는 대신 방향을 뒤집었다**. 깜빡했을 때
 *  «문서가 안 나간다»(눈에 보이고 무해)가 «내부 문서가 새어 나간다»(안 보이고 되돌릴 수
 *  없다)보다 낫다. ★목록을 못 지울 땐 **실패가 덜 아픈 쪽을 고르는 것**도 답이다.
 *
 * ★그리고 이 검사가 «안 나간다» 를 조용히 두지 않는다 — `docs/` 에 새 파일이 생겼는데
 *  허용목록에 없으면 빨개진다. 사람이 한 번 보고 «내보낼 것/아닌 것» 을 정하게 만든다.
 *
 * 등급: **판정**(스킬의 목록을 읽어 디스크와 대조) — 두 벌을 만들지 않으려고 목록의
 * 정본은 스킬이고 여기선 그걸 **읽는다**(적어두면 그게 세 번째 사본이다).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 내보내지 **않는** 것으로 사람이 이미 판단한 것들 — 새 파일만 걸리게 한다. */
const KNOWN_INTERNAL = new Set([
  "architecture.md",
  "roadmap.md",
  "distribution-plan.md",
  "vision.md",
  "vision-business.md",
  // 플랫폼 장기 방향 — 내부 전략(경쟁·수익 구조·단계별 계획). 2026-09-07 정태님 작성.
  "platform-roadmap.md",
]);

export const check: RegressionCheck = {
  name: "docs-ship-is-allowlist",
  guards:
    "docs/ 배포 판정이 손으로 적은 EXCLUDE 목록이라, 새 내부 문서를 만들고 목록에 안 넣으면 조용히 공개로 나가던 것(로드맵=개인 사용 통계, decisions=내부 실측·상용 전략) + 뒤집은 허용목록이 시간이 지나 낡는 것(2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    let skill = "";
    try {
      skill = readFileSync(path.join(REPO, ".claude/skills/sync-public/SKILL.md"), "utf8");
    } catch {
      return [
        assert("배포 레포엔 스킬이 없다(스크럽됨) — 대상 아님", true, "★확인 못 함 — '이상 없음' 아님"),
      ];
    }
    const m = /DOCS_SHIP="([^"]+)"/.exec(skill);
    const ship = new Set((m?.[1] ?? "").split("|").filter((s) => s !== ""));
    const onDisk = readdirSync(path.join(REPO, "docs")).filter((f) => f.endsWith(".md"));
    const unclassified = onDisk.filter((f) => !ship.has(f) && !KNOWN_INTERNAL.has(f));

    const ghosts = [...ship].filter((f) => !onDisk.includes(f));

    return [
      assert(
        "★허용목록을 스킬에서 읽었다(0개면 아래는 공짜 초록이다)",
        ship.size >= 10,
        `${String(ship.size)}개`,
      ),
      assert(
        "★★방향이 **허용**이다 — EXCLUDE 로 돌아가면 새 내부 문서가 조용히 공개로 나간다",
        /awk -v ok="\$DOCS_SHIP"/.test(skill) && !/\^docs\/roadmap/.test(skill),
        /awk -v ok="\$DOCS_SHIP"/.test(skill) ? "허용목록 필터" : "★EXCLUDE 로 되돌아감",
      ),
      assert(
        "★★`docs/` 의 새 파일은 **분류되기 전엔 빨간불**이다 — 목록이 조용히 낡지 않게",
        unclassified.length === 0,
        unclassified.length === 0
          ? `${String(onDisk.length)}개 전부 분류됨`
          : `★미분류: ${unclassified.join(", ")} — 내보낼 것이면 DOCS_SHIP 에, 아니면 KNOWN_INTERNAL 에`,
      ),
      assert(
        "★허용목록에 **없는 파일 이름**이 남아 있지 않다(이름을 바꾸면 그 문서가 조용히 안 나간다)",
        ghosts.length === 0,
        ghosts.length === 0 ? "유령 0" : `★디스크에 없는 항목: ${ghosts.join(", ")}`,
      ),
      assert(
        "★★내부 문서가 허용목록에 **섞여 들어가지 않았다** — 이 검사의 진짜 목적이다",
        [...KNOWN_INTERNAL].every((f) => !ship.has(f)) && !ship.has("decisions"),
        [...KNOWN_INTERNAL].filter((f) => ship.has(f)).join(", ") || "내부 문서 유출 0",
      ),
    ];

    // ── ★★목록만 보지 말고 **거르는 코드를 돌린다** (2026-09-07 적대 검토 P1·P2·P9) ──
    //  종전엔 이 검사가 «`DOCS_SHIP` 에 뭐가 적혔나» 와 «`awk -v ok="$DOCS_SHIP"` 라는
    //  글자가 있나» 만 봤다. **실제로 거르는 파이프라인 본문은 아무도 안 봤다.** 세 방향으로
    //  뚫렸다(전부 스위트 초록):
    //   ①awk 본문을 `{ print }` 로 → 배포 docs 14 → **193개**(`decisions/` 173개 포함).
    //   ②`DOCS_SHIP="$DOCS_SHIP|platform-roadmap.md"` 한 줄 추가 → **쉘은 마지막 대입을
    //     쓰는데 이 검사의 정규식은 첫 번째를 읽는다.** 내부 전략 문서가 나간다.
    //   ③`grep -vE` 에 `^docs/security\.` 를 더해 → 배포 docs 14 → 10개. README 가
    //     가리키는 문서가 404 가 된다(반대 방향).
    //  ★고침은 단언을 늘리는 게 아니라 **판정을 실행으로 바꾸는 것**이다 — 스킬에서 §1
    //   파이프라인을 그대로 떼어 돌리고, 나온 `docs/` 집합을 목록과 대조한다. 셋이 한 번에
    //   닫힌다([[feedback_gate_must_actually_run]] 「게이트는 있다가 아니라 도는가」).
    //  ★**파괴적인 줄은 절대 안 돌린다** — 그 블록엔 `git ls-files -z | xargs -0 rm -f`
    //   (스테이징 비우기)와 `rsync` 가 같이 있다. 떼어낸 뒤 남아 있으면 실행을 거부한다.
    // ── 이력: 여기서 «스킬의 셸을 떼어 실행» 을 시도했다가 되돌렸다 (2026-09-07) ──
    //  세 라운드가 같은 구조를 뚫었다: 절대경로엔 제약이 없어 **스위트가 파일을 실제로
    //  지웠고**, 추출 앵커가 위치라 미끼로 우회됐고, 격리한 가짜 `git` 이 pathspec 축을
    //  눈멀게 했다. 안전하게 만들려면 컨테이너가 필요해 판돈이 안 맞는다 —
    //  **회귀가 문서의 셸을 실행하는 구조 자체가 틀렸다.**
    //  ★그 판정은 `sync-public` §4(파이프라인이 **이미 돈 뒤** 결과 폴더를 세는 자리)에 있다.
    //   거기서 잡는 것: awk 본문 조작 · grep 제외 추가. **못 잡는 것: 중복 대입 ·
    //   `docs/` 하위 폴더** — 로드맵에 백로그로 적어뒀다(2026-09-07 4라운드 실측).

  },
};
