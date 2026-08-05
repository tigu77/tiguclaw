/**
 * 회귀: **최후 복구 경로(`bin/daemon.mjs`)가 타입체크를 통과한다** (2026-08-05).
 *
 * 발견: `npm run typecheck:bin` 이 **이미 빨간불인 채로** 있었다(implicit any 7건). 아무도
 * 안 돌렸기 때문이다 — 어디서도 자동으로 돌지 않는다:
 *   - `build:prod` 의 `tsconfig.build.json` include = `src`·`plugins`·`packages` (**bin 없음**)
 *   - `/update` 의 typecheck 게이트는 **조언(advisory)** 이고 그것도 src 설정
 *   - `deploy` 체인은 build:prod → deploy-guard → restart
 *
 * ★하필 이 파일이 **의존성-프리 라이프사이클**이다 — node_modules 가 깨져도 데몬을
 *  start/stop/restart/update 할 수 있게 빌트인만으로 돌도록 만든 **최후 복구 수단**
 *  ([[project_dep_free_daemon_lifecycle]]). 여기가 깨지면 증상은 "데몬을 못 살린다" 이고,
 *  그때는 고칠 도구도 같이 없다. 검사가 가장 필요한 파일이 검사 밖에 있었다.
 *
 * 그래서 **실제로 도는 자리**(회귀 스위트)로 옮긴다 — 게이트는 '있다'가 아니라 '도는가'다.
 * 비용 실측 0.9s. tsc 부재(배포본·dep-free 설치)면 통과(오탐 0), 단 그 사실을 남긴다.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const execFileAsync = promisify(execFile);

export const check: RegressionCheck = {
  name: "bin-lifecycle-typechecks",
  guards: "최후 복구 경로 bin/daemon.mjs 가 어떤 자동 게이트에도 안 걸려 빨간불인 채 방치되던 것",
  run: async (): Promise<Assertion[]> => {
    const tsc = path.join(REPO, "node_modules", ".bin", "tsc");
    const cfg = path.join(REPO, "tsconfig.bin.json");
    if (!existsSync(tsc) || !existsSync(cfg)) {
      return [
        assert(
          "tsc·설정 부재 시 통과(배포본·dep-free 설치 — 오탐 0)",
          true,
          `★확인 못 함(tsc ${existsSync(tsc)} · 설정 ${existsSync(cfg)}) — '이상 없음' 아님`,
        ),
      ];
    }
    let ok = true;
    let detail = "0 에러";
    try {
      await execFileAsync(tsc, ["-p", cfg], { cwd: REPO, timeout: 120_000 });
    } catch (e) {
      ok = false;
      const out = String((e as { stdout?: string }).stdout ?? "").trim();
      const first = out.split("\n").filter((l) => l.includes("error")).slice(0, 3);
      detail = first.length > 0 ? `★${first.join(" / ")}` : `★실패: ${String(e).slice(0, 160)}`;
    }
    return [
      assert(
        "★의존성-프리 라이프사이클(bin/daemon.mjs)이 타입체크를 통과한다",
        ok,
        detail,
      ),
    ];
  },
};
