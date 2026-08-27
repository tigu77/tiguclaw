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
 * ★**버전 드리프트를 닫으면 그 다음이 의미 드리프트다** (2026-08-06 추가). 이 검사가 시켜서
 *  0.1→0.3 을 올렸고, 그 업그레이드가 이틀 사이 사고 두 건을 냈다 — usage 필드가 스냅샷이
 *  되고(outputTokens=1), `result` 가 "스트림당 1회"에서 "턴당 1회"가 됐다. 둘 다 **버전은
 *  맞고 의미가 바뀐** 것이라 여기서는 안 걸린다. 업그레이드 절차는 세 겹으로 본다:
 *   ①여기(버전) ②`sdk-contract-surface`(선언된 계약 — 새 메시지 종류가 생겼나, 비용 0)
 *   ③**실제 왕복 1회**(의미 — 타입이 안 바뀌는 변화는 이것으로만 보인다). ③은 API 를
 *   쓰므로 스위트에 안 넣는다. 올릴 때 사람이 돌려라: 짧은 턴 하나로 `result` 개수·
 *   outputTokens>1·델타 수신을 확인하면 위 두 사고가 다 걸린다.
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

/**
 * ★**기한 있는 유예** — 상시 빨간불을 막되, 조용히 덮지는 않는다 (2026-08-11).
 *
 * 이 검사는 성격상 "당장 올릴 수 없는 릴리스"에서 빨간불이 된다(막 나온 것·큰 변경).
 * 그대로 두면 며칠간 빨갛고, 그러면 **아무도 안 보는 게이트**가 된다 — 이 레포가 이미
 * 겪은 형상이다(상시 FAIL 게이트가 죽어 고아 파일이 몇 주 살아남았다).
 *
 * 그래서 allowlist 가 아니라 **스누즈**다. 셋을 강제한다:
 *  ①**마이너 라인 고정** — 유예한 마이너에만 적용된다. 새 **마이너**가 오면 다시 빨간불.
 *   (2026-08-16 정정: 종전엔 정확한 패치까지 고정해서, 상류 패치 하나에 판단이 안 바뀌었는데도
 *    게이트가 빨개졌다 — 하루에 두 번. 상시 빨간 게이트는 아무도 안 본다.)
 *  ②**기한** — 지나면 자동으로 다시 빨간불. 잊혀지지 않는다.
 *  ③**이유** — 왜 미뤘는지 남는다(다음 사람이 판단을 이어받는다).
 * 그리고 유예가 만료·무효(버전 안 맞음)가 되면 **그 자체를 실패로** 잡아 죽은 항목이
 * 쌓이지 않게 한다.
 */
interface Deferral {
  readonly pkg: string;
  /** 이 latest 에만 적용 — 더 새 게 나오면 유예는 자동으로 무효다. */
  readonly latest: string;
  /** YYYY-MM-DD. 이 날이 지나면 다시 실패한다. */
  readonly until: string;
  readonly why: string;
}
const DEFERRED: readonly Deferral[] = [
  {
    pkg: "@openai/agents",
    latest: "0.17", // 마이너 라인 — 0.17.x 패치는 같은 판단이다(새 마이너면 다시 묻는다)
    until: "2026-09-03",
    why: "★2026-08-27 갱신(3번째, 사유는 유예 자신이 적어둔 것 그대로) — v0.40.0 태그 직전이고, **코어 LLM SDK 를 검증 없이 태그 직전에 세 마이너 건너뛰는 것**이야말로 이 유예가 막으려던 바로 그것이다(아래 v0.32.0 문장과 같은 상황이 그대로 반복됐다). 그래서 이번 릴리스에 포함하지 않고 **릴리스 직후 첫 작업**으로 왕복 검증 후 올린다. ★기한을 릴리스 다음 주로 짧게 잡은 것은 의도다 — 종전처럼 3주씩 주면 그 사이 새 마이너가 나와 또 무효화된다(0.15→0.16→0.17 로 세 번 그랬다). ★**다음 연기는 없다**: 상류가 또 올라가 있더라도 그때 실측 왕복을 하고 올리거나, 못 올릴 이유를 유예가 아니라 **코드로** 적어라. ── 이하 2026-08-19 원문 ── ★2026-08-19 갱신 — 0.16 유예 중에 0.17.0 이 나와 무효화됐다(0.15→0.16 때와 **같은 일이 반복**). 이제 세 마이너를 한 번에 건넌다(0.14.2 → 0.17.0). 유예 사유 자체는 그대로다: 이 부류(0.1→0.3 이 이틀 사이 usage 스냅샷·result 횟수 사고 두 건)는 여기서도 sdk-contract-surface 에서도 안 걸리고 **실제 왕복 1회로만** 보이는데, codex 가 아직 쿨다운(실측 1,004분 남음)이라 폴백 경로가 평소와 달라 그 왕복을 지금 못 한다. ★반복되는 무효화 자체가 신호다 — 상류가 주 단위로 마이너를 올리므로 '다음에'가 계속 밀린다. 쿨다운이 풀리면 **미루지 말고** 왕복 검증 후 올린다. v0.32.0 릴리스는 이 업그레이드를 포함하지 않는다(코어 LLM SDK 를 검증 없이 태그 직전에 세 마이너 건너뛰는 건 유예가 막으려던 바로 그것).",
  },
];
/**
 * 유예가 이 버전에 적용되는가 — **마이너 라인**이 같으면 같은 판단이다.
 *
 * ★모듈 스코프로 둔 이유: 이 판정이 `stale`·`snoozed` 둘의 **유일한 지렛대**인데, 안에
 *  숨겨두면 검사할 수가 없다(항상 true 로 바꿔도 그물이 안 잡혔다 — 변이로 확인).
 *  B 검토가 짚은 패턴 그대로다: **실행하는 검사만 잡는다.**
 */
export const sameMinorLine = (deferred: string, actual: string): boolean => {
  const a = parseVersion(deferred);
  const b = parseVersion(actual);
  if (a === null || b === null) return deferred === actual;
  return a.major === b.major && a.minor === b.minor;
};

const today = (): string => new Date().toISOString().slice(0, 10);
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
  // ★패치 없는 표기(`"0.16"`)도 받는다 — 유예를 **마이너 라인**으로 적을 수 있어야 한다.
  const m = /^(\d+)\.(\d+)(?:\.|$)/.exec(v.trim());
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

    // 유예 적용 — **마이너 라인**이 같고 기한 안이어야 한다(둘 중 하나만 어긋나도 무효).
    //
    // ★종전엔 **정확한 패치 버전**에 고정했다. 의도는 "더 새 릴리스가 나오면 다시 물어라"
    //  였는데, 그게 **마이너와 패치를 구분하지 않았다**: 상류가 0.16.0 → 0.16.1 처럼 패치를
    //  내면 판단이 하나도 바뀌지 않았는데 유예가 무효화돼 게이트가 빨개진다. 실제로
    //  2026-08-16 하루에 **두 번**(0.15.0→0.16.0→0.16.1) 그렇게 됐다.
    //  ★상시 빨간 게이트는 아무도 안 본다 — 이 레포가 이미 그 대가를 치렀다
    //   (`feedback_gate_must_actually_run`: 오탐으로 상시 FAIL 이던 게이트가 죽어 고아 파일이
    //    몇 주 살았다). 오탐을 남겨두는 건 검사를 지우는 것과 같다.
    //  그래서 `latest` 를 **마이너 라인**으로 읽는다(`"0.16"` = 0.16.x 전부). 새 **마이너**
    //  (0.17)가 오면 판단이 실제로 달라지므로 그때는 다시 묻는다 — 원래 의도 그대로다.
    const now = today();
    const deferralFor = (name: string, latest: string | undefined): Deferral | undefined =>
      DEFERRED.find(
        (d) =>
          d.pkg === name &&
          latest !== undefined &&
          sameMinorLine(d.latest, latest) &&
          d.until >= now,
      );
    const snoozed = drifted.filter((d) => deferralFor(d.name, d.latest) !== undefined);
    const live = drifted.filter((d) => deferralFor(d.name, d.latest) === undefined);

    // 죽은 유예 = 기한이 지났거나, 그 버전이 더 이상 latest 가 아니거나, 이미 올라간 것.
    // 죽은 유예 = 기한이 지났거나, 그 **마이너 라인**이 더 이상 대상이 아니거나(=이미 올라감).
    const stale = DEFERRED.filter(
      (d) =>
        d.until < now ||
        !drifted.some(
          (x) => x.name === d.pkg && x.latest !== undefined && sameMinorLine(d.latest, x.latest),
        ),
    );

    // ★판정 자체를 **실행해서** 본다 — 이게 유예의 유일한 지렛대다(변이로 확인: 항상 true 로
    //  바꿔도 나머지 단언들이 안 잡았다). 패치는 같은 판단, 새 마이너는 다시 묻기.
    const lineCases: Array<[string, string, boolean]> = [
      ["0.16", "0.16.1", true],
      ["0.16", "0.16.99", true],
      ["0.16", "0.17.0", false],
      ["0.16", "1.16.0", false],
      ["0.16.0", "0.16.5", true],
    ];
    const lineBad = lineCases.filter(([a, b, want]) => sameMinorLine(a, b) !== want);

    return [
      assert(
        "★유예 판정이 마이너 라인만 본다(패치는 같은 판단 · 새 마이너는 다시 묻기)",
        lineBad.length === 0,
        lineBad.length === 0
          ? `${lineCases.length}케이스 확인`
          : `★틀린 케이스: ${lineBad.map(([a, b, w]) => `${a}vs${b}→기대${w}`).join(", ")}`,
      ),
      assert(
        "0.x 캐럿 고정 의존성을 판정으로 뽑는다(검사 전제 — 0이면 공짜 통과)",
        locked.length > 0,
        `${locked.length}개: ${locked.map((d) => d.name).join(", ") || "(없음)"}`,
      ),
      assert(
        "★캐럿이 0.x 마이너를 잠근 채 상류가 그 너머로 가 있지 않다",
        live.length === 0,
        live.length === 0
          ? `확인 ${locked.length}개 · 드리프트 0` +
            (snoozed.length > 0
              ? ` · ★유예 ${snoozed.length}건: ${snoozed
                  .map((d) => `${d.name}→${d.latest}(~${deferralFor(d.name, d.latest)?.until})`)
                  .join(", ")}`
              : "")
          : live
              .map((d) => `${d.name} ${d.range}(설치 ${d.current}) → latest ${d.latest}`)
              .join(" · "),
      ),
      assert(
        "★유예는 살아 있는 것만 남는다(만료·무효 항목이 쌓이지 않는다)",
        stale.length === 0,
        stale.length === 0
          ? `유예 ${DEFERRED.length}건 전부 유효`
          : stale
              .map(
                (d) =>
                  `${d.pkg}@${d.latest} — ${d.until < now ? `기한 만료(${d.until})` : "그 버전이 더 이상 대상 아님"} → 이제 판단하거나 항목을 지워라`,
              )
              .join(" · "),
      ),
    ];
  },
};
