/**
 * 회귀: **배포본에 자산이 실제로 복사된다** (2026-08-26).
 *
 * ★종전엔 이 축을 **소스 리터럴**로만 봤다 — `copyTree("locales")` 라는 글자가 있으면 통과.
 *  그래서 그 호출을 `if (false)` 로 감싸도 초록이고, 짝 단언(`appRoot()/locales` 존재)은
 *  소스 실행에서 `appRoot()`=레포 루트라 **구조적으로 실패 불가**였다. 즉 **dist 로의 실제
 *  복사는 어느 단언도 보지 않았다**(적대 검토 G축 ②).
 *
 * 하루에 두 번 그 대가를 치렀다:
 *  ① `themes/nord.css` 를 지우고 배포했는데 배포본 목록에 그대로 떴다 — `fs.cp` 는 덮어쓰기만
 *     하고 **사라진 파일을 dist 에 남긴다**. 목록의 정본이 "파일" 인 구조에서 지운 것이 안
 *     지워지면 **그 구조 자체가 거짓말**이 된다.
 *  ② 그 고침(`prune: true`)이 인자를 바꾸자 **리터럴 단언이 거짓 빨간불**을 냈다 —
 *     검사할 것은 *복사하는가*이지 인자 모양이 아니다.
 *
 * 그래서 **스크립트를 임시 디렉터리에 실제로 돌린다.** 리터럴 대신 결과를 본다.
 *
 * 등급: **동작 검사**(자식 프로세스로 `bin/copy-dist-assets.mjs` 실행 — 진짜 복사).
 * 격리: 대상 dist 를 `argv[2]`(self-update 스테이징이 쓰는 그 규약)로 임시 경로에 주므로
 * 레포의 `dist/` 는 건드리지 않는다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(REPO, "bin/copy-dist-assets.mjs");

/** 목록의 정본이 **파일**인 트리 — 지운 것이 안 지워지면 그 구조가 거짓말이 된다. */
const PRUNED_TREES = ["locales", "themes"] as const;

export const check: RegressionCheck = {
  name: "dist-assets-actually-copied",
  guards:
    "배포 자산 복사를 소스 리터럴(copyTree(\"locales\") 라는 글자)로만 봐서, 그 호출을 if(false) 로 감싸도 초록이던 것 + 지운 파일이 dist 에 남아 배포본 목록이 거짓말하던 것(themes/nord.css 실사고)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    if (!existsSync(SCRIPT)) {
      return [
        assert("복사 스크립트 부재 시 통과(배포본 — 스크럽됨)", true, "★확인 못 함 — '이상 없음' 아님"),
      ];
    }

    const tmp = mkdtempSync(path.join(os.tmpdir(), "tgc-dist-"));
    try {
      const outDir = path.join(tmp, "dist");
      // ★지워져야 할 파일을 **미리 심는다** — prune 이 죽으면 이게 살아남는다.
      for (const tree of PRUNED_TREES) {
        mkdirSync(path.join(outDir, tree), { recursive: true });
        writeFileSync(path.join(outDir, tree, "zzz-stale-probe.json"), "{}\n", "utf8");
      }

      // ★대상 dist 는 `argv[2]` 로 지정한다 — self-update 의 스테이징 빌드가 쓰는 규약
      //  그대로다(ADR 2026-07-14 D3). 검사가 자기 전용 인자를 새로 만들면 그건 검사만
      //  아는 경로라 제품 경로를 안 보게 된다.
      const r = spawnSync(process.execPath, [SCRIPT, outDir], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 120_000,
      });
      const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      out.push(
        assert(
          "★복사 스크립트가 실제로 돈다(리터럴이 아니라 실행)",
          r.status === 0,
          r.status === 0 ? "exit 0" : `exit ${String(r.status)} — ${log.slice(-200)}`,
        ),
      );
      if (r.status !== 0) return out;

      // ① 실제로 실렸는가 — 레포에 있는 것이 dist 에도 있어야 한다.
      for (const tree of PRUNED_TREES) {
        const src = readdirSync(path.join(REPO, tree)).filter((f) => !f.startsWith("."));
        const dst = existsSync(path.join(outDir, tree))
          ? readdirSync(path.join(outDir, tree))
          : [];
        const missing = src.filter((f) => !dst.includes(f));
        out.push(
          assert(
            `★${tree}/ 가 dist 에 실린다(빠지면 배포본에서만 조용히 없다)`,
            src.length > 0 && missing.length === 0,
            missing.length === 0
              ? `${src.length}개 전부 복사됨`
              : `★빠진 것: ${missing.join(", ")}`,
          ),
        );
      }

      // ② ★지운 것이 지워지는가 — 이게 실사고의 자리다.
      const survivors = PRUNED_TREES.filter((t) =>
        existsSync(path.join(outDir, t, "zzz-stale-probe.json")),
      );
      out.push(
        assert(
          "★원본에서 사라진 파일은 dist 에서도 사라진다(prune — 안 그러면 목록이 거짓말한다)",
          survivors.length === 0,
          survivors.length === 0
            ? `${PRUNED_TREES.length}개 트리 전부 prune 됨`
            : `★남아버린 트리: ${survivors.join(", ")}`,
        ),
      );

      // ③ 헌법·빌트인 자산도 함께 — 이것들이 빠지면 부팅이 "작동 헌법이 비었습니다" 를 찍는다.
      for (const rel of ["SYSTEM.md", "skills", "agents"]) {
        out.push(
          assert(
            `${rel} 이(가) dist 에 실린다`,
            existsSync(path.join(outDir, rel)),
            existsSync(path.join(outDir, rel)) ? "있음" : "★없다 — 부팅이 헌법 없이 뜬다",
          ),
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return out;
  },
};
