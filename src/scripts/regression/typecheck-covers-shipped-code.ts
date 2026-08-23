/**
 * 회귀: **타입 게이트가 배포되는 코드 전부를 검사한다** (2026-08-22).
 *
 * 사고: `plugins/http-bridge` 의 `/chat-search` 핸들러가 `void` 반환형인데 `return true` 를
 *  했다. `npm run typecheck` 는 `tsconfig.json`(include=`src/**`)만 봐서 못 잡았고, 회귀
 *  1526건은 **소스 문자열 검사**라 전부 초록이었다 — *컴파일되는지는 아무도 안 물었다*.
 *  커밋·푸시는 초록인데 **배포가 불가능한 상태**로 하루가 지났고, 다음 `deploy:dev` 첫
 *  시도가 TS2322 둘로 죽어서야 드러났다. 배포를 안 했으면 계속 몰랐다.
 *
 * ★`typecheck:plugins`(tsconfig.plugins.json, 2026-07-18)가 **이미 있었다.** 안 잡힌 이유는
 *  없어서가 아니라 **아무도 안 불러서**다 — CI 없음·회귀 없음·배포 체인에도 없음. 그래서
 *  스크립트를 하나 더 만드는 대신 (a) 기본 게이트(`npm run typecheck`)의 범위를 빌드 범위와
 *  같게 넓히고 (b) 그 설정을 지우고 (c) **실제로 도는 자리**인 여기로 옮겼다
 *  ([[feedback_gate_must_actually_run]] — 게이트는 '있다'가 아니라 '도는가').
 *
 * ★범위는 `tsconfig.check.json` 이 `tsconfig.build.json` 을 extends 해 **상속**한다. 목록을
 *  두 벌 적으면 갈리므로([[feedback_hand_maintained_lists]]) 여기서도 이름을 열거하지 않고
 *  **tsc 가 실제로 읽은 파일 목록**(`--listFilesOnly`)으로 판정한다.
 *
 * 비용 실측: 전체 타입체크 3.4s + 파일목록 1.2s.
 * tsc·설정 부재(배포본·dep-free 설치)면 통과하되 그 사실을 남긴다(오탐 0, 침묵 0).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const execFileAsync = promisify(execFile);

/** tsc 는 에러가 있으면 non-zero 로 죽는다 — stdout 은 성공·실패 양쪽에서 꺼낸다. */
const runTsc = async (
  tsc: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> => {
  try {
    const { stdout } = await execFileAsync(tsc, args, {
      cwd: REPO,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: String((e as { stdout?: string }).stdout ?? "") };
  }
};

export const check: RegressionCheck = {
  name: "typecheck-covers-shipped-code",
  guards:
    "plugins/·packages/ 가 타입 게이트 밖이라 컴파일 안 되는 코드가 초록으로 커밋·푸시되던 것(배포 때만 드러남) + 그 게이트가 있어도 아무도 안 부르던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const tsc = path.join(REPO, "node_modules", ".bin", "tsc");
    const cfg = path.join(REPO, "tsconfig.check.json");
    const pkgPath = path.join(REPO, "package.json");

    // ── ① `npm run typecheck` 가 이 설정을 가리킨다 ────────────────────────────
    //  범위를 넓혀 놔도 스크립트가 옛 `tsc --noEmit`(=src 만) 로 되돌아가면 구멍이 그대로
    //  재발한다. 사람이 실제로 치는 명령이 넓은 쪽을 봐야 한다.
    {
      let ok = false;
      let detail = "package.json 을 못 읽음";
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        const script = pkg.scripts?.typecheck ?? "";
        ok = script.includes("tsconfig.check.json");
        detail = ok ? `typecheck = ${script}` : `★typecheck = ${script || "(없음)"}`;
      } catch (e) {
        detail = `★${String(e).slice(0, 120)}`;
      }
      out.push(assert("★`npm run typecheck` 가 넓은 설정을 가리킨다", ok, detail));
    }

    if (!existsSync(tsc) || !existsSync(cfg)) {
      out.push(
        assert(
          "tsc·설정 부재 시 통과(배포본·dep-free 설치 — 오탐 0)",
          true,
          `★확인 못 함(tsc ${existsSync(tsc)} · 설정 ${existsSync(cfg)}) — '이상 없음' 아님`,
        ),
      );
      return out;
    }

    // ── ② 게이트가 **실제로 읽는 파일**에 plugins/·packages/ 가 들어 있다 ────────
    //  이름 열거가 아니라 tsc 의 실제 파일 목록으로 판정 — include 를 좁히는 순간 걸린다.
    {
      const { stdout } = await runTsc(tsc, ["-p", cfg, "--listFilesOnly"]);
      const files = stdout.split("\n").filter((l) => l.includes(`${REPO}${path.sep}`));
      const count = (dir: string): number =>
        files.filter((f) => f.startsWith(path.join(REPO, dir) + path.sep)).length;
      const nPlugins = count("plugins");
      const nPackages = count("packages");
      const nSrc = count("src");
      out.push(
        assert(
          "★타입 게이트가 src·plugins·packages 를 전부 읽는다",
          nPlugins > 0 && nPackages > 0 && nSrc > 0,
          `src ${nSrc} · plugins ${nPlugins} · packages ${nPackages}` +
            (nPlugins > 0 && nPackages > 0 && nSrc > 0 ? "" : " — ★범위 밖이 있다"),
        ),
      );
    }

    // ── ③ 그 범위가 **지금 초록이다** ───────────────────────────────────────────
    {
      const { ok, stdout } = await runTsc(tsc, ["-p", cfg]);
      const errs = stdout.split("\n").filter((l) => /error TS\d+/.test(l));
      out.push(
        assert(
          "★배포되는 코드 전부가 타입체크를 통과한다",
          ok,
          ok ? "0 에러" : `★${errs.length}건 — ${errs.slice(0, 3).join(" / ").slice(0, 300)}`,
        ),
      );
    }

    return out;
  },
};
