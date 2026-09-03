/**
 * "받을 업데이트가 있는가" — 채널 무관 판정 (2026-08-21).
 *
 * ★**왜 코어인가.** 대시보드 버튼을 위해 만들지만, 대시보드 JS 안에서 git 을 부르면
 *  그 사실을 텔레그램·CLI·비서 자신은 영영 모른다. 판정은 여기 한 곳에 두고 채널은
 *  **렌더만** 한다(원칙 4 — 채널은 표현, 판단은 코어).
 *
 * ★**왜 별도 모듈인가.** `self-update.ts` 는 import 만으로 무거운 것을 끌고 오지 않지만,
 *  이 판정은 *데몬을 안 띄우고* 검사돼야 한다(principle-check Q7). 임시 git 레포를 만들어
 *  실제로 돌려 볼 수 있는 크기로 유지한다 — `listDestructiveUncommitted` 가 소스 정규식
 *  검사에 속아 통째로 망가졌던 전례가 이 파일의 설계 이유다.
 *
 * ★**왜 "뒤처짐"만 보지 않는가.** 이 레포엔 기록된 사고가 있다: 설치본 소스를 수정하면
 *  `git pull --ff-only` 가 충돌해 **영구 업데이트 불능**이 되는데 사용자는 그걸 모른다
 *  (`project_self_dev_flag_gate`). "받을 게 있다"만 보고 원클릭을 권하면 누르는 순간
 *  그 벽에 부딪힌다. 그래서 판정은 **뒤처짐 + 그걸 받을 수 있는 상태인가**를 함께 낸다.
 */
import { execFile } from "node:child_process";
import { changelogCandidates } from "./changelog.js";

/** git 한 방 — 실패는 throw 하지 않고 빈 결과로(판정은 데몬을 죽이지 않는다). */
const git = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (err, stdout) => {
        resolve({ ok: err === null, out: typeof stdout === "string" ? stdout : "" });
      },
    );
  });

/**
 * 업데이트 가용성 판정 결과.
 *
 * `state` 는 **버튼을 띄울지**까지 답한다 — 화면이 이걸 다시 판단하지 않게(가장자리는
 * 판단하지 않는다). `behind` 만 주고 화면에서 조건을 조립하면 그게 판단의 두 번째 사본이다.
 */
export interface UpdateAvailability {
  /**
   * - `up-to-date` — 받을 게 없다. 화면에 아무것도 안 띄운다.
   * - `available` — 받을 게 있고 받을 수 있다. **버튼을 띄운다.**
   * - `unreleased` — 받을 커밋은 있는데 **버전이 안 올랐다**(= 릴리스가 아니라 미러 동기화).
   *   화면에 아무것도 안 띄운다. 받고 싶으면 `/update` 로 언제든 받을 수 있다.
   * - `blocked` — 받을 건 있는데 지금 누르면 실패한다(작업트리가 갈라짐). 이유를 보여준다.
   * - `unknown` — 판정 못 함(git 없음·원격 없음·네트워크 실패). **조용히 아무것도 안 띄운다.**
   */
  state: "up-to-date" | "available" | "unreleased" | "blocked" | "unknown";
  /** origin 이 몇 커밋 앞서 있나. unknown 이면 0. */
  behind: number;
  /** `blocked` 사유 — 사용자에게 그대로 보여줄 한 줄. 그 외 상태에선 undefined. */
  blockedReason?: string;
  /** `git reset --hard` 가 파괴할 미커밋 변경(경로). 진단용 — 없으면 빈 배열. */
  dirty: readonly string[];
  /** 지금 설치된 버전. 못 읽으면 undefined. */
  version?: string;
  /**
   * ★**변경 내역은 여기 안 싣는다** (2026-08-27, 같은 날 두 번째 판). 첫 판은 확인창에
   *  넣으려고 이 응답에 태웠는데, 정태님이 *"설정에 변경 이력 밑에 업데이트 내역 하나
   *  더"* 로 자리를 바꿨다 — 그 자리는 **누를 때만** 읽으면 되므로(`readUpdateChangelog`),
   *  30분마다 도는 이 판정이 `git show` 를 할 이유가 없어졌다. 소비자 없는 필드를 남기면
   *  같은 내용에 경로가 둘이 되고, 그중 하나가 늙는다.
   */
  /** 원격이 올려둔 버전. `available` 이면 이 값이 위 `version` 보다 높다. */
  newVersion?: string;
}

const UNKNOWN: UpdateAvailability = { state: "unknown", behind: 0, dirty: [] };

/**
 * 원격 대비 뒤처짐 + 받을 수 있는 상태인지 판정.
 *
 * ★네트워크를 탄다(`git fetch`). 그래서 **호출 주기는 호출자가 정한다** — 이 함수는
 *  캐시·주기·재시도를 갖지 않는다(가짜 견고함 금지, principle-check Q6). 실패는 전부
 *  `unknown` 으로 수렴하고, `unknown` 은 화면에 아무것도 안 띄우는 상태다 —
 *  **모르면 조용한 것이 기본값**이다. 없는 업데이트를 있다고 하는 것보다 낫다.
 */
/**
 * `git status --porcelain -z` 파싱.
 *
 * ★rename/copy 는 **조각이 둘**이다(`XY 새경로\0원래경로\0`). 순진하게 NUL 로 쪼개
 *  전부 `slice(3)` 하면 두 번째 조각의 앞 세 글자가 잘려 나가 **엉뚱한 이름**이 된다 —
 *  비ASCII 경로가 8진 이스케이프로 나가던 것을 고치면서 그 자리에 같은 부류를 새로
 *  만들 뻔했다. 상태 코드가 R/C 면 다음 한 조각을 건너뛴다.
 *
 * @returns 상태 코드를 뗀 경로들(사용자에게 그대로 보여줄 수 있는 형태).
 */
export const parsePorcelainZ = (out: string): string[] => {
  const chunks = out.split("\0").filter((c) => c !== "");
  const paths: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (c.length < 4) continue; // 상태 2글자 + 공백 + 경로
    const xy = c.slice(0, 2);
    paths.push(c.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++; // 원래 경로 조각을 건너뛴다.
  }
  return paths;
};

/**
 * `x.y.z` 세 자리 비교. 판정 못 하면 `null`.
 *
 * ★prerelease(`1.2.3-rc.1`)는 **접두 숫자만** 본다 — 우리 릴리스는 세 자리뿐이고, 여기서
 *  semver 전체를 구현하면 그게 "직접 만들 일 아닌 것" 이다. 모르면 `null` 을 내고 호출자가
 *  **보수적으로**(=업데이트를 숨기지 않고) 처리한다.
 */
export const compareVersions = (a: string, b: string): number | null => {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
};

/** 어떤 커밋(`HEAD`·`@{u}`)의 `package.json` 버전. 못 읽으면 undefined. */
/**
 * **CHANGELOG 에서 "이번에 받으면 뭐가 바뀌나" 만 잘라낸다** — 순수 함수 (2026-08-27).
 *
 * ★사용자 지적: *"업데이트 버튼만 달랑 있으니까 변경 내역을 확인하기가 힘든데."* 맞다 —
 *  지금은 **받아봐야 안다.**
 *
 * ★그런데 **이미 손안에 있다.** 판정이 어차피 `git fetch` 를 돌리는데(그래야 몇 커밋
 *  뒤처졌는지 안다), fetch 는 원격 오브젝트를 **다운로드까지** 한다 — 작업트리만 안 건드릴
 *  뿐이다. 즉 칩이 "업데이트 있음" 을 띄운 순간 새 CHANGELOG 는 디스크에 있다.
 *  실증(뒤처진 클론에서): `origin/main` ref 를 지우면 `git show` 가 실패하고, `fetch` 만
 *  하면 작업트리는 0.40.0 인 채로 **원격 0.40.1 항목이 읽힌다** — 프록시를 막아도 읽힌다
 *  (= 오브젝트가 로컬에 있다). ★첫 실증은 이미 최신인 레포에서 해서 **아무것도 증명하지
 *  못했다**(정태님이 짚어줬다).
 *
 * ★커밋 제목이 아니라 **CHANGELOG** 인 이유: 우리 커밋은 길고 내부 용어다
 *  (`fix(events): 휘발성 축만 자른다`). CHANGELOG 는 애초에 사용자 문장으로 쓴다.
 *
 * @param body   원격 CHANGELOG 전문
 * @param from   지금 설치된 버전(이것보다 **위**인 항목만 남긴다). 모르면 undefined → 최신 1개.
 * ★**기본은 상한 없음**이다 (2026-08-27 개정). 종전 기본값 3은 `window.confirm` 이 스크롤도
 *  없는 평문 상자였기 때문에 있던 것인데, 보여주는 자리가 설정 패널로 바뀌면서 그 이유가
 *  사라졌다. 상한이 필요한 호출자가 **자기가** 정한다 — 안 그러면 "왜 3개까지지?" 를
 *  아무도 답할 수 없는 상수가 코어에 남는다.
 *
 * @param maxSections 최대 몇 버전까지 실을지. 안 주면 전부.
 */
export const changelogSince = (
  body: string,
  from: string | undefined,
  maxSections = Number.POSITIVE_INFINITY,
): {
  sections: Array<{ version: string; heading: string; body: string }>;
  omitted: number;
} => {
  // `## [1.2.3] - 날짜` 헤더로 자른다. `[Unreleased]` 는 버전이 아니라 건너뛴다.
  const re = /^## \[([^\]]+)\][^\n]*$/gm;
  const marks: Array<{ version: string; heading: string; start: number; headEnd: number }> = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    marks.push({
      version: m[1] as string,
      heading: m[0],
      start: m.index,
      headEnd: m.index + m[0].length,
    });
  }
  const all: Array<{ version: string; heading: string; body: string }> = [];
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i] as { version: string; heading: string; start: number; headEnd: number };
    if (!/^\d/.test(cur.version)) continue; // Unreleased 등
    const end = i + 1 < marks.length ? (marks[i + 1] as { start: number }).start : body.length;
    all.push({ version: cur.version, heading: cur.heading, body: body.slice(cur.headEnd, end).trim() });
  }
  // `from` 보다 **위**인 것만. 비교 불가면 최신 1개만(거짓말보다 적게 말한다).
  const newer =
    from === undefined
      ? all.slice(0, 1)
      : all.filter((s) => {
          const c = compareVersions(from, s.version);
          return c !== null && c < 0;
        });
  return { sections: newer.slice(0, maxSections), omitted: Math.max(0, newer.length - maxSections) };
};

/**
 * 원격(@{u}) CHANGELOG 를 **pull 없이** 읽는다. 없으면 undefined — 칩은 그대로 뜬다.
 *
 * ★자리가 **둘**이다 (2026-08-27 적대 검토 F4). 배포본은 루트에 `CHANGELOG.md` 가 있지만,
 *  **개발 레포는 정본이 `_workspace/public-overlay/` 안**이다(공개 오버레이가 배포 때 루트로
 *  옮긴다). 그래서 이 기능을 요청한 인스턴스에서 **정작 안 보였다** — 코드 주석은 "dev 레포가
 *  그렇다" 고 알고 있었는데 그게 요청자의 화면이라는 걸 못 봤다.
 *  ★경로를 **열거하지 않고 순서대로 시도**한다 — 둘 다 우리가 아는 자리이고, 늘어날 일이
 *  없으며(오버레이 규약이 정한다), 없으면 그냥 조용하다.
 */
/**
 * 찾을 자리 — 배포본은 루트, 개발 레포는 오버레이 안.
 * ★**이름**은 `changelog.ts` 가 정한다(언어별). 자리 × 이름을 여기서 곱한다 — 이름 규약을
 *  여기에 또 적으면 판정이 두 곳이 되고, 한쪽만 언어를 타는 상태가 조용히 생긴다.
 * ★언어를 **자리보다 먼저** 본다: 한국어 화면이면 두 자리 모두에서 한국어를 먼저 찾고,
 *  그래도 없을 때 영어로 떨어진다(원격이 아직 안 갈라진 옛 버전일 수 있다).
 */
const CHANGELOG_ROOTS = ["", "_workspace/public-overlay/"] as const;
const remoteChangelog = async (
  cwd: string,
  timeoutMs: number,
  locale?: string,
): Promise<string | undefined> => {
  for (const name of changelogCandidates(locale)) {
    for (const root of CHANGELOG_ROOTS) {
      const r = await git(["show", `@{u}:${root}${name}`], cwd, timeoutMs);
      if (r.ok && r.out.trim() !== "") return r.out;
    }
  }
  return undefined;
};

const versionAt = async (
  ref: string,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> => {
  const r = await git(["show", `${ref}:package.json`], cwd, timeoutMs);
  if (!r.ok) return undefined;
  try {
    const v = (JSON.parse(r.out) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
};

export const checkUpdateAvailability = async (
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<UpdateAvailability> => {
  const timeoutMs = opts.timeoutMs ?? 20_000;

  // 업스트림이 없으면(로컬 전용 클론·detached) 판정 대상이 아니다.
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd,
    timeoutMs,
  );
  if (!upstream.ok || upstream.out.trim() === "") return UNKNOWN;

  // 원격 갱신. 네트워크 실패 = 판정 불가지 "최신" 이 아니다.
  const fetched = await git(["fetch", "--quiet"], cwd, timeoutMs);
  if (!fetched.ok) return UNKNOWN;

  const counted = await git(
    ["rev-list", "--count", "HEAD..@{u}"],
    cwd,
    timeoutMs,
  );
  if (!counted.ok) return UNKNOWN;
  const behind = Number.parseInt(counted.out.trim(), 10);
  if (!Number.isFinite(behind)) return UNKNOWN;
  if (behind === 0) return { state: "up-to-date", behind: 0, dirty: [] };

  // ★**갈라졌나** (2026-08-21 적대 검토 B-F2). 이 모듈의 헤더는 *"'받을 게 있다'만 보고
  //  원클릭을 권하면 누르는 순간 그 벽에 부딪힌다"* 고 선언해 놓고, 실제로는 **미커밋
  //  변경만** 봤다. 로컬이 앞서 있으면(설치본 소스를 고치고 **커밋까지** 한 상태 —
  //  `selfDevelopment` 를 켠 사람이 정확히 그 상태다) `pull --ff-only` 가
  //  "Diverging branches can't be fast-forwarded" 로 실패한다. 실측으로 재현됐다.
  //  → 커밋 안 된 것과 **같은 등급**으로 막고, 이유를 그대로 말한다.
  const aheadRes = await git(["rev-list", "--count", "@{u}..HEAD"], cwd, timeoutMs);
  if (!aheadRes.ok) return UNKNOWN;
  const ahead = Number.parseInt(aheadRes.out.trim(), 10);
  if (!Number.isFinite(ahead)) return UNKNOWN;
  if (ahead > 0) {
    return {
      state: "blocked",
      behind,
      blockedReason:
        `로컬 커밋 ${ahead}개가 원격에 없어 갈라졌습니다 — fast-forward 로는 못 받습니다. ` +
        `그 커밋을 올리거나 되돌린 뒤 다시 시도하세요.`,
      dirty: [],
    };
  }

  // 받을 게 있다 — 이제 **받을 수 있나**. 여기가 이 모듈의 존재 이유다.
  //  ★`--untracked-files=no`: `reset --hard` 는 untracked 를 안 지운다. untracked 를 세면
  //   이 레포처럼 untracked 가 수백 개인 작업트리에서 항상 blocked 가 돼 기능이 죽는다
  //   (self-update.ts 의 `listDestructiveUncommitted` 가 정확히 그 사고를 겪었다).
  //  ★`-z`: 기본 `--porcelain` 은 비ASCII·공백 경로를 C-따옴표로 감싸 **8진 이스케이프**한다
  //   (`"\\355\\225\\234..."`). 그 문자열이 그대로 `blockedReason` 에 실려 사용자에게
  //   `window.alert` 로 뜬다 — 한국어 사용자는 **무엇을 정리해야 하는지 알 수 없다**
  //   (2026-08-21 적대 검토 B-F11, 실측 재현). `-z` 는 NUL 로 구분하고 따옴표를 안 쓴다.
  const status = await git(
    ["status", "--porcelain", "-z", "--untracked-files=no"],
    cwd,
    timeoutMs,
  );
  const dirty = status.ok ? parsePorcelainZ(status.out) : [];

  // ★`package-lock.json` 은 제외한다 — self-update 가 pull 직전에 `git checkout --` 로
  //  되돌리는 파일이라 ff-only 를 막지 않는다. 그걸 blocked 로 세면 npm install 을 한 번만
  //  돌려도 버튼이 영영 안 뜬다(실제로 흔한 상태다).
  const blocking = dirty.filter(
    (f) => f !== "package-lock.json" && !f.endsWith("/package-lock.json"),
  );
  if (blocking.length > 0) {
    const head = blocking.slice(0, 3).join(", ");
    const more = blocking.length > 3 ? ` 외 ${blocking.length - 3}개` : "";
    return {
      state: "blocked",
      behind,
      blockedReason: `커밋 안 된 로컬 수정이 있어 업데이트가 충돌합니다 — ${head}${more}. 정리하거나 커밋한 뒤 다시 시도하세요.`,
      dirty,
    };
  }

  // ★**버전이 올랐을 때만 버튼을 띄운다** (2026-08-26 사용자: *"업데이트 버튼은 버전이
  //  올라갔을 때만 반응한다가 기준이면 좋을 것 같은데"*).
  //
  //  종전엔 `behind > 0` 이면 무조건 띄웠다. 그런데 public 레포는 **미러**라 dev 변경마다
  //  sync 가 커밋을 쌓는다(오늘만 32커밋) — 사용자에겐 매번 "업데이트 있음" 이 뜨는데
  //  정작 달라지는 게 없는 날도 있다. 알림의 값은 **드물 때** 나온다.
  //
  //  ★받는 것 자체는 막지 않는다(사용자: *"그냥 업데이트 받아버리는 건 어쩔 수 없고"*) —
  //   `/update` 는 언제나 최신을 받는다. 여기서 정하는 건 **먼저 말을 거는가**뿐이다.
  //  ★버전을 못 읽거나 비교가 안 되면 **종전대로 띄운다** — 우리 파싱 실패로 진짜 릴리스를
  //   숨기는 쪽이 반대보다 나쁘다.
  const version = await versionAt("HEAD", cwd, timeoutMs);
  const newVersion = await versionAt("@{u}", cwd, timeoutMs);
  const cmp =
    version !== undefined && newVersion !== undefined
      ? compareVersions(version, newVersion)
      : null;
  if (cmp !== null && cmp >= 0) {
    return { state: "unreleased", behind, dirty, version, newVersion };
  }
  return { state: "available", behind, dirty, version, newVersion };
};

/**
 * **받으면 뭐가 바뀌나 — 마크다운 전문** (2026-08-27).
 *
 * ★정태님 설계: *"업데이트 버튼 옆에 물음표 하나 띄워서 설정에 변경 이력 밑에 업데이트 내역
 *  하나 더 있고 거기서 보여주면 어때?"* → *"저러면 업데이트 내역을 **다** 볼 수 있으니까."*
 *  그래서 **상한이 없다.** 확인창에 실을 땐 평문 2,400자로 잘라야 했지만, 설정 패널은
 *  스크롤이 되고 우리 마크다운 렌더러를 타므로 자를 이유가 사라졌다.
 *
 * ★응답 모양을 `/changelog`(설치본 CHANGELOG)와 **똑같이** `{ markdown }` 으로 맞춘다 —
 *  그래야 화면이 행 컴포넌트 하나로 둘을 그린다(같은 모양의 UI 를 두 벌 짓지 않는다).
 *
 * ★여기서 `git fetch` 를 **안 한다.** 첫 판은 했는데 실측이 2.6초였고(로컬 파일을 읽는
 *  `/changelog` 는 4ms), 무엇보다 **중복이었다** — 이 화면으로 오는 문(칩 옆 `?`)은 칩이
 *  떠야만 보이고, 칩이 떴다는 건 판정이 방금 fetch 를 돌렸다는 뜻이다.
 *  ★그리고 따로 fetch 하면 **칩과 이 화면이 다른 답을 할 수 있다**("받을 것 없음" 이라고
 *   해놓고 내역엔 새 버전이 뜨는 식). 같은 오브젝트를 보는 쪽이 맞다 — 갱신은 판정의 일이다.
 */
export const readUpdateChangelog = async (
  cwd: string,
  opts: { timeoutMs?: number; locale?: string } = {},
): Promise<{ markdown: string; version?: string; newVersion?: string }> => {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd,
    timeoutMs,
  );
  if (!upstream.ok || upstream.out.trim() === "") return { markdown: "" };
  const version = await versionAt("HEAD", cwd, timeoutMs);
  const newVersion = await versionAt("@{u}", cwd, timeoutMs);
  const body = await remoteChangelog(cwd, timeoutMs, opts.locale);
  if (body === undefined) return { markdown: "", version, newVersion };
  const cut = changelogSince(body, version);
  // 헤더(`## [0.41.0] - 날짜`)를 **되살려서** 잇는다 — 날짜와 버전 구분이 읽는 사람에게
  // 필요하고, 이게 없으면 여러 버전이 한 덩어리로 붙는다.
  const markdown = cut.sections.map((s) => `${s.heading}\n\n${s.body}`).join("\n\n");
  return { markdown, version, newVersion };
};
