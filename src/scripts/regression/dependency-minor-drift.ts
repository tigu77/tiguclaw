/**
 * 회귀: **캐럿이 0.x 마이너 라인을 잠그고 상류가 떠나갔는가** (2026-08-05).
 *
 * 사고: `@anthropic-ai/claude-agent-sdk` 가 `^0.1.0` 으로 박혀 **릴리스 187개**(0.1.77 →
 * 0.3.222) 뒤처져 있었다. `@openai/agents` 도 15개. 6개월 가까이 아무도 몰랐다.
 *
 * ★근본은 게으름이 아니라 **캐럿의 0.x 규칙**이다 — `^0.1.0` 은 0.2·0.3 으로 **영원히 안
 *  올라간다**(0.x 에서 캐럿은 마이너를 major 처럼 고정). 그래서 `npm update` 로는 안 잡히고
 *  `npm outdated` 를 **사람이 볼 때만** 보인다. 그 사람 습관이 안 돌면 그대로 6개월이다
 *  (원래 이걸 잡았어야 할 `claude-code-parity-audit` 스킬은 94일간 0회 실행이었다).
 *
 * 그래서 **판정 기준**으로 검사한다 — 이름 목록 0([[hand-maintained-lists]]):
 *   "`^0.x` 로 고정돼 있는데 상류 `latest` 가 그 마이너 라인 너머로 갔다" → 실패.
 * 새 의존성이 같은 함정에 빠져도 목록을 고칠 필요 없이 자동으로 걸린다.
 *
 * 버전 조회는 **`npm outdated --json` 에 위임**한다(current/wanted/latest 를 이미 준다) —
 * 레지스트리 클라이언트를 우리가 만들지 않는다(원칙 #5).
 *
 * 오프라인·레지스트리 장애: **통과**(오탐 0). 단 그 사실을 detail 에 남긴다 — "확인 못 함"과
 * "이상 없음" 은 다른 말이고, 조용히 초록인 검사가 이 사고의 반대편 형상이다.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const execFileAsync = promisify(execFile);

interface OutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
}

/** `^0.<minor>.<patch>` 형태면 잠긴 마이너 번호, 아니면 null(=이 함정 대상 아님). */
const lockedZeroMinor = (range: string): number | null => {
  const m = /^\^0\.(\d+)\./.exec(range.trim());
  return m === null ? null : Number(m[1]);
};

/** "0.3.222" → {major:0, minor:3} */
const parseVersion = (v: string): { major: number; minor: number } | null => {
  const m = /^(\d+)\.(\d+)\./.exec(v.trim());
  return m === null ? null : { major: Number(m[1]), minor: Number(m[2]) };
};

/**
 * `npm outdated --json` 실행. **뒤처진 게 있으면 exit 1** 이라 throw 되는데, 그때도
 * stdout 에 JSON 이 온다 — 그 사실을 모르고 짜면 "뒤처짐 있음"이 곧 "조회 실패"가 되어
 * 검사가 정확히 잡아야 할 상황에서만 눈을 감는다.
 */
const readOutdated = async (): Promise<Record<string, OutdatedEntry> | null> => {
  try {
    const { stdout } = await execFileAsync("npm", ["outdated", "--json"], {
      cwd: REPO,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout || "{}") as Record<string, OutdatedEntry>;
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    if (typeof out === "string" && out.trim() !== "") {
      try {
        return JSON.parse(out) as Record<string, OutdatedEntry>;
      } catch {
        return null;
      }
    }
    return null; // 오프라인·레지스트리 장애 — 검사 불가.
  }
};

export const check: RegressionCheck = {
  name: "dependency-minor-drift",
  guards: "캐럿이 0.x 마이너를 영구 고정해 코어 SDK 가 릴리스 187개 뒤처진 걸 아무도 모르던 것",
  run: async (): Promise<Assertion[]> => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const ranges = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    // 함정 대상 = `^0.x` 로 고정된 것 전부(이름 열거 0 — 판정 기준이 목록을 대신한다).
    const locked = Object.entries(ranges)
      .map(([name, range]) => ({ name, range, minor: lockedZeroMinor(range) }))
      .filter((d): d is { name: string; range: string; minor: number } => d.minor !== null);

    const outdated = await readOutdated();
    if (outdated === null) {
      return [
        assert(
          "npm outdated 조회 — 실패 시 통과(오프라인 오탐 0)",
          true,
          "★확인 못 함(네트워크·레지스트리) — '이상 없음' 아님",
        ),
      ];
    }

    // 상류가 잠긴 마이너 라인 너머로 간 것.
    const drifted = locked
      .map((d) => ({ ...d, latest: outdated[d.name]?.latest, current: outdated[d.name]?.current }))
      .filter((d) => {
        const v = d.latest === undefined ? null : parseVersion(d.latest);
        // major 가 올라갔으면 캐럿 문제가 아니라 별개 판단(메이저 업그레이드) — 여기선 제외.
        return v !== null && v.major === 0 && v.minor > d.minor;
      });

    return [
      assert(
        "0.x 캐럿 고정 의존성을 판정으로 뽑는다(검사 전제 — 0이면 공짜 통과)",
        locked.length > 0,
        `${locked.length}개: ${locked.map((d) => d.name).join(", ") || "(없음)"}`,
      ),
      assert(
        "★캐럿이 0.x 마이너를 잠근 채 상류가 그 너머로 가 있지 않다",
        drifted.length === 0,
        drifted.length === 0
          ? `확인 ${locked.length}개 · 드리프트 0`
          : drifted
              .map((d) => `${d.name} ${d.range}(설치 ${d.current}) → latest ${d.latest}`)
              .join(" · "),
      ),
    ];
  },
};
