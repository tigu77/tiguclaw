/**
 * 회귀: **공개 manifest 세 벌이 서로 어긋나지 않는다** (2026-08-26).
 *
 * ★실증. 공개 제외 목록이 **세 곳**에 손으로 적혀 있다:
 *
 *   1. `docs/distribution-plan.md §1.6`  — 산문. 스스로 "진실 소스" 라 부른다.
 *   2. `.claude/skills/sync-public/SKILL.md` + `.tiguclaw/` 미러 — 산문. **실제 복사를 한다.**
 *   3. `src/scripts/regression/shipped-repo-complete.ts` 의 `NOT_SHIPPED` — 배열. **검사를 한다.**
 *
 * 2026-08-26 에 이게 실제로 갈렸다: `docs/vision.md` 는 3 에만 있었고 1·2 엔 없었다. 즉
 * **검사는 "안 나간다" 고 믿는데 실제 복사는 내보내는** 상태였다. 게다가 1 에는 내가 적은
 * *"코어 비전 `docs/vision.md` 는 그대로 SHIP"* 이라는 **거짓 문장**까지 있었다.
 *
 * ★소비자가 둘인 것(복사 / 검사)은 정상이다 — **사고는 목록이 둘 이상인 것**이다
 * ([[feedback_hand_maintained_lists]]). 목록을 한 데이터로 합치는 게 정답이지만, 그 전까지
 * **갈리는 순간 빨간불이 되게** 한다. 조용히 갈리는 것보다 요란하게 실패하는 게 낫다.
 *
 * 등급: 대조 검사(파일 텍스트) — 판정 대상은 사람이 유지하는 목록 그 자체다.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 검사가 실제로 쓰는 목록(정본 후보) — 소스에서 뽑는다. 손으로 복사하지 않는다. */
const readNotShipped = (): string[] => {
  const src = readFileSync(
    path.join(REPO, "src/scripts/regression/shipped-repo-complete.ts"),
    "utf8",
  );
  const block = /const NOT_SHIPPED = \[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
  // ★경로 모양만 센다 — 블록 안 **주석의 한국어 인용문**도 따옴표라 함께 걸렸다(실증).
  return [...block.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((v) => /^[\w.\/-]+$/.test(v));
};

const MIRRORS = [
  "docs/distribution-plan.md",
  ".claude/skills/sync-public/SKILL.md",
  ".tiguclaw/skills/sync-public/SKILL.md",
];

export const check: RegressionCheck = {
  name: "ship-manifest-agrees",
  guards:
    "공개 제외 목록이 세 곳(배포계획 산문·sync 스킬 산문 2사본·회귀 NOT_SHIPPED)에 손으로 적혀 있어 갈리던 것 — 실제로 docs/vision.md 가 검사엔 '제외', 복사 목록엔 '포함' 이라 검사가 초록인 채 공개로 나갈 뻔했다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const notShipped = readNotShipped();

    out.push(
      assert(
        "NOT_SHIPPED 를 소스에서 읽어냈다(빈손 통과 금지)",
        notShipped.length >= 4,
        `${notShipped.length}개: ${JSON.stringify(notShipped)}`,
      ),
    );
    if (notShipped.length === 0) return out;

    for (const mirror of MIRRORS) {
      const abs = path.join(REPO, mirror);
      if (!existsSync(abs)) {
        // 배포본엔 dev 자산이 없다 — 부재는 통과(오탐 0), 단 "확인 못 함" 을 남긴다.
        out.push(
          assert(`${mirror} 부재 시 통과(배포본)`, true, "★확인 못 함 — '일치' 아님"),
        );
        continue;
      }
      const text = readFileSync(abs, "utf8");
      const missing = notShipped.filter((p) => !text.includes(p));
      out.push(
        assert(
          `${mirror} 가 제외 목록 전부를 담는다`,
          missing.length === 0,
          missing.length === 0
            ? `${notShipped.length}개 전부 언급됨`
            : `빠진 것: ${JSON.stringify(missing)} — 이 파일은 실제 복사/배포 판단에 쓰인다`,
        ),
      );
    }

    // ★거짓 문장 재발 방지 — 제외 대상을 "SHIP" 이라 적어둔 자리가 없어야 한다.
    //  2026-08-26 에 실제로 `docs/vision.md 는 그대로 SHIP` 이 배포계획에 적혀 있었다.
    const plan = path.join(REPO, "docs/distribution-plan.md");
    if (existsSync(plan)) {
      const text = readFileSync(plan, "utf8");
      const contradictions = notShipped.filter((p) =>
        new RegExp(`\`${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`[^\\n]{0,40}SHIP`).test(
          text,
        ),
      );
      out.push(
        assert(
          "★제외 대상을 'SHIP' 이라 적은 문장이 없다",
          contradictions.length === 0,
          contradictions.length === 0
            ? "모순 문장 0건"
            : JSON.stringify(contradictions),
        ),
      );
    }
    return out;
  },
};
