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
   * - `blocked` — 받을 건 있는데 지금 누르면 실패한다(작업트리가 갈라짐). 이유를 보여준다.
   * - `unknown` — 판정 못 함(git 없음·원격 없음·네트워크 실패). **조용히 아무것도 안 띄운다.**
   */
  state: "up-to-date" | "available" | "blocked" | "unknown";
  /** origin 이 몇 커밋 앞서 있나. unknown 이면 0. */
  behind: number;
  /** `blocked` 사유 — 사용자에게 그대로 보여줄 한 줄. 그 외 상태에선 undefined. */
  blockedReason?: string;
  /** `git reset --hard` 가 파괴할 미커밋 변경(경로). 진단용 — 없으면 빈 배열. */
  dirty: readonly string[];
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

  // 받을 게 있다 — 이제 **받을 수 있나**. 여기가 이 모듈의 존재 이유다.
  //  ★`--untracked-files=no`: `reset --hard` 는 untracked 를 안 지운다. untracked 를 세면
  //   이 레포처럼 untracked 가 수백 개인 작업트리에서 항상 blocked 가 돼 기능이 죽는다
  //   (self-update.ts 의 `listDestructiveUncommitted` 가 정확히 그 사고를 겪었다).
  const status = await git(
    ["status", "--porcelain", "--untracked-files=no"],
    cwd,
    timeoutMs,
  );
  const dirty = status.ok
    ? status.out
        .split("\n")
        .map((l) => l.replace(/\r$/, ""))
        .filter((l) => l.trim() !== "")
        .map((l) => l.slice(3))
    : [];

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

  return { state: "available", behind, dirty };
};
