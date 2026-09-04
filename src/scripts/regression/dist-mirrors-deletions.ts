/**
 * 회귀: **소스에서 지운 자산이 빌드본에 남지 않는다** (2026-09-04).
 *
 * 사고: `schedule-safety-check` 스킬을 걷고 `deploy:dev` 를 했는데 `dist/skills/` 에 그대로
 * 남아 **자식 인덱스에 다시 실렸다.** 그 파일엔 `reach:` 가 없으니 기본값(전 칸)으로 들어가
 * 그날 한 최적화가 **배포본에서만 반쪽**이 됐다. 배포 로그는 «✅ restarted» 였다 —
 * 성공했다고 말하는 절차가 실제로는 옛 산출물을 싣고 있었다.
 *
 * ★**같은 부류를 이미 겪었다.** 2026-08-26 에 `plugins/` 에서 지운 `_probe` 가 매 부팅마다
 *  로드되던 사고가 있었고 그때 `pruneOrphanDirs` 를 만들었다 — 그런데 **옆 레인(skills·
 *  agents)엔 안 붙였다.** 「A 를 고쳤으면 A 와 같은 모양인 B 를 봐라」의 교과서적 재발이다.
 *
 * ★**소스를 읽어 판정하지 않는다** — `copy-dist-assets.mjs` 에 `prune` 글자가 있는지 보는
 *  검사는 철자만 지킨다. 여기서는 **실제로 복사를 돌려** 지운 것이 사라지는지 본다:
 *  임시 레포를 만들고 → 자산 두 벌을 넣고 복사 → 하나를 지우고 다시 복사 → 사라졌나.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(import.meta.dirname, "../../..");

/** 자산 트리 하나에 스킬/에이전트 흉내를 낸 항목을 만든다. */
const seed = (root: string, rel: string, names: string[]): void => {
  for (const n of names) {
    const d = path.join(root, rel, n);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${n}\ndescription: 흉내\n---\n본문\n`);
  }
};

export const check: RegressionCheck = {
  name: "dist-mirrors-deletions",
  guards:
    "소스에서 지운 스킬·에이전트가 dist 에 남아 배포본에서만 계속 로드되던 것 (등급: 동작)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    const tmp = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-dist-"));
    const dist = path.join(tmp, "dist");
    mkdirSync(dist, { recursive: true });
    // 스크립트는 `dist/` 존재를 선행 조건으로 본다(없으면 방어적으로 아무것도 안 한다).
    writeFileSync(path.join(dist, ".keep"), "");
    // tsc 산출물이 섞이는 자리를 흉내 — plugins 는 통째 prune 하면 안 되는 레인이다.
    for (const lane of ["plugins", "packages"]) {
      mkdirSync(path.join(dist, lane, "keeper"), { recursive: true });
      writeFileSync(path.join(dist, lane, "keeper", "index.js"), "// tsc 산출물");
      // 소스에 대응이 **없는** 트리 — 지워진 플러그인·패키지의 옛 산출물을 흉내낸다.
      mkdirSync(path.join(dist, lane, "orphan"), { recursive: true });
      writeFileSync(path.join(dist, lane, "orphan", "index.js"), "// 지워진 것의 잔해");
    }

    seed(tmp, "skills", ["alive", "doomed"]);
    seed(tmp, "agents", ["alive-agent", "doomed-agent"]);
    for (const lane of ["plugins", "packages"]) mkdirSync(path.join(tmp, lane, "keeper"), { recursive: true });
    writeFileSync(path.join(tmp, "SYSTEM.md"), "헌법");

    // ★스크립트를 **임시 레포 안으로 복사해서** 돌린다 — `repoRoot` 를 자기 파일 위치에서
    //  뽑기 때문이다(env·cwd 로 못 바꾼다). 진짜 경로로 부르면 **이 검사가 실제 dist 를
    //  prune 한다** — 검사가 제품을 건드리면 그건 검사가 아니다.
    mkdirSync(path.join(tmp, "bin"), { recursive: true });
    copyFileSync(
      path.join(REPO, "bin/copy-dist-assets.mjs"),
      path.join(tmp, "bin", "copy-dist-assets.mjs"),
    );
    const run = (): void => {
      execFileSync(process.execPath, [path.join(tmp, "bin", "copy-dist-assets.mjs")], {
        cwd: tmp,
        stdio: "pipe",
      });
    };

    let ranFirst = false;
    try {
      run();
      ranFirst = true;
    } catch (e) {
      out.push(
        assert(
          "복사 스크립트가 임시 레포에서 돈다(검사 전제 — 안 돌면 아래가 전부 공허하다)",
          false,
          e instanceof Error ? e.message.slice(0, 160) : String(e),
        ),
      );
    }

    if (ranFirst) {
      out.push(
        assert(
          "1차 복사로 자산이 dist 에 들어간다(전제)",
          existsSync(path.join(dist, "skills", "doomed")) &&
            existsSync(path.join(dist, "agents", "doomed-agent")),
          `skills=${readdirSync(path.join(dist, "skills")).join(",")}`,
        ),
      );

      // ─── 지우고 다시 복사 ───────────────────────────────────────────────
      rmSync(path.join(tmp, "skills", "doomed"), { recursive: true, force: true });
      rmSync(path.join(tmp, "agents", "doomed-agent"), { recursive: true, force: true });
      run();

      out.push(
        assert(
          "★지운 스킬이 dist 에서 사라진다 — 안 사라지면 배포본에서 계속 돈다",
          !existsSync(path.join(dist, "skills", "doomed")),
          existsSync(path.join(dist, "skills", "doomed")) ? "★남아 있다" : "사라짐",
        ),
      );
      out.push(
        assert(
          "★지운 에이전트도 dist 에서 사라진다(옆 레인 — 이번 사고의 재발 지점)",
          !existsSync(path.join(dist, "agents", "doomed-agent")),
          existsSync(path.join(dist, "agents", "doomed-agent")) ? "★남아 있다" : "사라짐",
        ),
      );
      out.push(
        assert(
          "살아 있는 것은 그대로 남는다(과잉 삭제 아님)",
          existsSync(path.join(dist, "skills", "alive")) &&
            existsSync(path.join(dist, "agents", "alive-agent")),
          `skills=[${readdirSync(path.join(dist, "skills")).join(",")}] agents=[${readdirSync(path.join(dist, "agents")).join(",")}]`,
        ),
      );
      // ★그리고 **고아 디렉터리**(소스에 대응이 없는 것)는 두 레인 다 사라져야 한다.
      //  ★이 축이 이 검사에 없었다 (2026-09-04 3R R-14): `pruneOrphanDirs("plugins")` 호출을
      //   지웠는데 **여기는 초록**이었고 옆 게이트가 대신 잡았다. 「지운 것이 빌드본에 남지
      //   않는다」를 이름에 걸고 있는 검사가 그 절반(prune 레인)만 보고 있었다.
      //   그리고 `packages` 는 **호출 자체가 없었다** — 옆 레인을 안 본 것이 세 번째다.
      for (const lane of ["plugins", "packages"]) {
        out.push(
          assert(
            `★${lane} 의 고아 디렉터리는 사라진다 — 소스에 없는 것이 빌드본에 남으면 안 된다`,
            !existsSync(path.join(dist, lane, "orphan")),
            existsSync(path.join(dist, lane, "orphan")) ? "★남아 있다" : "사라짐",
          ),
        );
      }
      // ★`plugins`·`packages` 는 통째 prune 하면 tsc 산출물이 날아간다 — 다른 처방(orphan)이다.
      //  ★**두 레인을 다 심는다** (2026-09-04 적대 검토 G-4). 종전엔 `plugins` 만 심어서,
      //   `packages` 에 prune 을 달면 **built 대시보드 서버(dist/packages/dashboard/index.js)가
      //   통째로 사라지는데 2,766건이 전부 초록**이었다. 코드 주석은 두 레인을 나란히 적어
      //   놓고 그물은 하나만 봤다 — 이번 릴리스가 고친 것과 **같은 기제**(옆 레인을 안 봄).
      for (const lane of ["plugins", "packages"]) {
        const artifact = path.join(dist, lane, "keeper", "index.js");
        out.push(
          assert(
            `★${lane} 의 tsc 산출물은 안 지운다 — 그 레인은 통째 prune 이 아니다`,
            existsSync(artifact),
            existsSync(artifact) ? "보존" : "★날아갔다",
          ),
        );
      }
    }

    rmSync(tmp, { recursive: true, force: true });
    return out;
  },
};
