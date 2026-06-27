/**
 * 자가 업데이트 공유 루틴 — `git pull` + (조건부)`npm install` + ★typecheck 게이트 +
 * 분리 재시작을 한 번에 수행하는 *단일 결정론 함수*.
 *
 * 진실 소스: architect contract `_workspace/self-update_architect.md` (§2 9단계 ·
 * Q3 4 안전 불변식: typecheck 게이트 · 자동 롤백 · 분리 재시작 · 동시 가드).
 *
 * 호출 경로 2개가 *이 함수 하나* 만 부른다 — region 의 `update_self` 도구 / daemon 의
 * `/update` 슬래시. 위험 로직(git/npm/tsc/롤백/재시작 판단)은 전부 여기 닫혀 LLM 손을
 * 안 탄다(원칙 #2 LLM-agnostic 하드게이트 — claude·codex 어느 쪽이 호출해도 바이트 동일 실행).
 *
 * ★단방향 불변식: 이 모듈은 코어/하위만 의존하고 `src/index.ts`·플러그인을 import 하지
 * 않는다. 재시작은 `deps.restart` 콜백으로 *주입* 받는다(self-update 는 "언제 재시작"만
 * 알고 "어떻게"는 호출부가 넘김). 마커 통지 dest 도 호출부가 데이터로만 넘긴다.
 *
 * ★견고성 최우선(Q3): 모든 단계 try/catch — 어떤 경우도 throw 로 데몬을 죽이지 않는다.
 * 실패는 전부 `SelfUpdateResult` 상태 객체로 수렴. 깨진 코드(typecheck 실패)는 절대 재시작
 * 트리거 안 함(먹통 = respawn 루프 방지) — 대신 작업트리를 `git reset --hard` 로 롤백한다.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { appRoot, getPaths } from "./paths.js";
import { redactSecrets } from "./outbound-sanitize.js";

/** 마커파일 — 부팅 시 1회 소비되는 "업데이트 완료" 통지 좌표 (architect §4). */
export const UPDATE_COMPLETE_MARKER = ".update-complete";

export type SelfUpdateStatus =
  | "up-to-date" // 변경 0 — 재시작 X
  | "updating" // 게이트 통과 → 통지 적재 + 분리 재시작 트리거됨
  | "failed" // 어느 단계 실패 → 롤백됨(있다면) — 재시작 X
  | "busy"; // 동시 가드 — 이미 다른 업데이트 진행 중

/** 부팅 완료 통지를 보낼 generic 좌표 (worker-jobs 의 WorkerNotifyDest 와 동형 — 단방향). */
export interface SelfUpdateNotifyDest {
  /** 통지 채널명(예 "telegram"). 부팅 소비부가 이 값으로 dispatch. */
  channel: string;
  /** 채널 내 목적지(telegram=chatId, cli=무시). null = 채널 디폴트/무시. */
  target: string | null;
}

/**
 * 현재 turn 의 채널/threadKey 에서 완료 통지 좌표를 도출 — telegram threadKey
 * "tg:<chatId>" → chatId(worker-jobs deriveTargetFromThreadKey · index notifyDestFromMessage
 * 와 비트 동일). update_self 도구가 이 좌표를 runSelfUpdate.notify 로 운반해, 재시작 후
 * 부팅이 "업데이트 완료" 를 *요청자에게* 회신한다. 채널 미지원(cli 등)은 target=null.
 */
export const notifyDestFromCoords = (
  channel: string,
  threadKey: string,
): SelfUpdateNotifyDest => ({
  channel,
  target:
    channel === "telegram"
      ? threadKey.startsWith("tg:")
        ? threadKey.slice("tg:".length)
        : threadKey
      : null,
});

export interface SelfUpdateDeps {
  /**
   * 분리 재시작 콜백 — 게이트 통과 시에만, 답 전송 시간 확보 후(restartDelayMs) 호출.
   * 단방향 불변식: index.ts 의 restartDaemon 을 호출부가 주입(self-update 는 index 를 안 봄).
   *
   * ★선택(2026-06-26) — 명시 주입이 *우선*. 미지정 시 모듈 레지스트리
   * (`setSelfUpdateRestart` 로 부팅 시 1회 박힌 전역 restartDaemon)로 폴백한다.
   * 도구(update_self) 경로는 채널-특정 클로저로 restart 를 받기 어려워(restart=데몬 전역)
   * `notify` 만 넘기고 restart 는 레지스트리에 의존한다. 슬래시(/update) 는 명시 주입(우선).
   * 둘 다 없으면 noop(재시작 없음 — 안전 기본값, "updating" 이어도 프로세스는 안 죽음).
   */
  restart?: () => void;
  /**
   * 완료 통지 dest — 마커에 적재되어 *다음 부팅* 이 "업데이트 완료" 통지를 보낼 좌표.
   * 호출부(슬래시·도구)가 자기 msg.channel/threadKey 에서 도출해 넘긴다. 미지정 가능(통지 best-effort).
   */
  notify?: SelfUpdateNotifyDest;
  /** 테스트·격리용 — 기본 appRoot()(레포 루트). */
  cwd?: string;
  /** 답 전송 후 분리 재시작까지 지연(ms). 기본 5000. */
  restartDelayMs?: number;
}

export interface SelfUpdateResult {
  status: SelfUpdateStatus;
  /** 이전 short SHA. */
  from?: string;
  /** 새 short SHA. */
  to?: string;
  /** pull 로 바뀐 파일 수(요약용). */
  changedFiles?: number;
  ranNpmInstall?: boolean;
  /** failed 시 reset --hard 수행 여부. */
  rolledBack?: boolean;
  /** 실패 단계 redact 된 메시지. */
  error?: string;
  /** updating 시 = restartDelayMs. */
  restartInMs?: number;
}

// ── 동시 업데이트 가드 (단계 1, module-private 인프로세스 락) ───────────────────
// 진행 중 재호출은 git 작업트리를 동시에 건드리지 못하게 즉시 busy 반환. 재시작이
// 프로세스를 죽이므로(updating 경로) 자연 해제 — 단 모든 실패 경로도 finally 로 복구.
let updating = false;

const DEFAULT_RESTART_DELAY_MS = 5000;

// ── 재시작 콜백 레지스트리 (도구 경로용 — restart 는 데몬 전역) ────────────────
// 도구(update_self)는 채널-특정 클로저(sendAttachment 식)로 restart 를 받기 어렵다
// (restart=데몬 전역 동작, 채널과 무관). 부팅 시 index.ts 가 `setSelfUpdateRestart(
// restartDaemon)` 로 1회 박으면(index→core 단방향 정합), 도구는 restart 를 안 넘겨도
// 이 레지스트리로 재시작이 일어난다. 슬래시(/update)의 명시 deps.restart 가 *우선*.
let registeredRestart: (() => void) | undefined;

/**
 * 부팅 시 1회 호출 — 전역 restart 콜백 등록(index→core 단방향). 이후 `runSelfUpdate`
 * 가 deps.restart 미지정 시 이 콜백으로 분리 재시작한다(도구 경로 핵심).
 */
export const setSelfUpdateRestart = (fn: () => void): void => {
  registeredRestart = fn;
};

/** 재시작 콜백 해석 — 명시 deps.restart > 레지스트리 > noop(안전 기본값). */
const resolveRestart = (deps: SelfUpdateDeps): (() => void) =>
  deps.restart ?? registeredRestart ?? ((): void => {});

// Windows 는 npm 이 실행파일이 아니라 `npm.cmd`(배치 스크립트)라 `execFile("npm")` 이
// ENOENT 로 터진다. npm 호출만 shell 경유로(cmd.exe 가 PATHEXT 로 npm.cmd 해석). git 은
// git.exe 라 무관. npm 인자는 전부 고정 상수("install"/"run"/"typecheck"/플래그)이고 외부
// 입력이 안 섞이므로 shell:true 여도 인젝션 0 (동적값은 git reset 의 prevSha 뿐 — git 은 무shell).
const isWindows = process.platform === "win32";

/** execFile Promise 래퍼 — 기본 쉘 미경유(인자 배열, 인젝션 0). opts.shell 시에만 쉘 경유
 *  (Windows npm.cmd 용 — 인자 고정 상수 전제). exit≠0 도 reject(stderr 보존). */
const run = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  opts: { shell?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, shell: opts.shell ?? false },
      (err, stdout, stderr) => {
        if (err !== null) {
          // err.message 는 명령·exit 코드를 담음. stderr 를 붙여 진단성 확보.
          const detail = stderr.trim() !== "" ? `${err.message}\n${stderr}` : err.message;
          reject(new Error(detail));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

/** git rev-parse HEAD → short SHA. */
const headSha = async (cwd: string): Promise<string> => {
  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], cwd);
  return stdout.trim();
};

/** prev..HEAD 변경 파일 목록 (npm install 필요 판정 + 파일수 요약). */
const changedFilesBetween = async (
  prev: string,
  cwd: string,
): Promise<string[]> => {
  const { stdout } = await run(
    "git",
    ["diff", "--name-only", `${prev}`, "HEAD"],
    cwd,
  );
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
};

/**
 * 단일 결정론 자가 업데이트 루틴 — architect §2 9단계.
 *
 * 어떤 단계도 throw 로 데몬을 죽이지 않는다(견고성 불변식). 모든 외부 호출은 execFile.
 * 재시작은 typecheck 게이트 통과 시에만, 답 전송 시간 확보를 위해 restartDelayMs 지연 후.
 */
export const runSelfUpdate = async (
  deps: SelfUpdateDeps,
): Promise<SelfUpdateResult> => {
  // ── 단계 1: 동시 가드 ──────────────────────────────────────────────────────
  if (updating) {
    return { status: "busy" };
  }
  updating = true;

  const cwd = deps.cwd ?? appRoot();
  const restartDelayMs = deps.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  let triggeredRestart = false;

  try {
    // ── 단계 2: 현재 커밋 capture (롤백 앵커) ─────────────────────────────────
    let prevSha: string;
    try {
      prevSha = await headSha(cwd);
    } catch (e) {
      return {
        status: "failed",
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      };
    }

    // ── 단계 3: git pull --ff-only (현재 브랜치 origin — install/dev 자동, 분기 0) ──
    try {
      await run("git", ["pull", "--ff-only"], cwd);
    } catch (e) {
      // ff-only 실패(로컬 미커밋 변경·충돌·detached 등) → 정직 반환. 작업트리는 pull
      // 이 보존(부분 적용 0). 자동 stash/merge 는 파괴적·암묵이라 하지 않음(§1·O1).
      return {
        status: "failed",
        from: prevSha,
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      };
    }

    // ── 단계 4: 변경 0 판정 (HEAD 동일) → 재시작 X 즉시 반환 ───────────────────
    let newSha: string;
    try {
      newSha = await headSha(cwd);
    } catch (e) {
      return {
        status: "failed",
        from: prevSha,
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      };
    }
    if (newSha === prevSha) {
      return { status: "up-to-date", from: prevSha, to: prevSha };
    }

    // 바뀐 파일 목록 — 요약 + npm install 필요 판정. 실패해도 치명 아님(빈 목록 폴백).
    let changed: string[] = [];
    try {
      changed = await changedFilesBetween(prevSha, cwd);
    } catch {
      changed = [];
    }
    const depsChanged = changed.some(
      (f) =>
        f === "package.json" ||
        f === "package-lock.json" ||
        f.endsWith("/package.json") ||
        f.endsWith("/package-lock.json"),
    );

    // 롤백 헬퍼 — reset --hard <prev> + (deps 바뀌었으면) npm install 재실행.
    // 현재 도는 데몬은 손대지 않으므로 롤백 후에도 계속 산다(재시작 X). 롤백 자체 실패도
    // throw 0 — best-effort 로 정직 보고(rolledBack 플래그가 성공 여부 반영).
    const rollback = async (): Promise<boolean> => {
      try {
        await run("git", ["reset", "--hard", prevSha], cwd);
        if (depsChanged) {
          // deps 도 prev 상태로 되돌림 — 게이트 실패가 새 deps 였을 수도.
          await run("npm", ["install", "--no-audit", "--no-fund"], cwd, {
            shell: isWindows,
          }).catch(
            (e) => {
              console.error(
                `self-update: 롤백 중 npm install 실패(작업트리는 reset 됨): ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            },
          );
        }
        return true;
      } catch (e) {
        console.error(
          `self-update: 롤백(reset --hard ${prevSha}) 실패: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return false;
      }
    };

    // ── 단계 5: npm install (조건부) ──────────────────────────────────────────
    let ranNpmInstall = false;
    if (depsChanged) {
      try {
        await run("npm", ["install", "--no-audit", "--no-fund"], cwd, {
          shell: isWindows,
        });
        ranNpmInstall = true;
      } catch (e) {
        const rolledBack = await rollback();
        return {
          status: "failed",
          from: prevSha,
          to: newSha,
          changedFiles: changed.length,
          rolledBack,
          error: redactSecrets(
            `npm install 실패: ${e instanceof Error ? e.message : String(e)}`,
          ),
        };
      }
    }

    // ── 단계 6: ★typecheck 게이트 — 실패 시 롤백 + 재시작 X (먹통 방지) ─────────
    try {
      await run("npm", ["run", "typecheck"], cwd, { shell: isWindows });
    } catch (e) {
      const rolledBack = await rollback();
      return {
        status: "failed",
        from: prevSha,
        to: newSha,
        changedFiles: changed.length,
        ranNpmInstall,
        rolledBack,
        error: redactSecrets(
          `typecheck 게이트 실패: ${e instanceof Error ? e.message : String(e)}`,
        ),
      };
    }

    // ── 단계 7: 완료 마커 작성 (부팅 통지용, best-effort) ───────────────────────
    try {
      const marker = path.join(getPaths().home, UPDATE_COMPLETE_MARKER);
      const payload = {
        from: prevSha,
        to: newSha,
        changedFiles: changed.length,
        ts: Date.now(),
        ...(deps.notify !== undefined ? { notify: deps.notify } : {}),
      };
      await fs.writeFile(marker, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (e) {
      // 통지 마커 실패는 치명 아님 — 업데이트는 계속(통지만 안 옴). 로그만.
      console.error(
        `self-update: 완료 마커 작성 실패(업데이트는 계속): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // ── 단계 8: 5초 지연 분리 재시작 (답 전송 시간 확보 + 정상 종료 비차단) ───────
    // restartDaemon(주입) 이 OS별로 재시작(mac/linux=graceful exit→supervisor respawn,
    // win32=detached daemon.ts restart). 새 코드는 디스크에 이미 반영(pull 완료).
    // unref() 로 이 타이머가 정상 종료를 안 붙잡는다.
    const restart = resolveRestart(deps);
    try {
      setTimeout(() => {
        try {
          restart();
        } catch (e) {
          console.error(
            `self-update: 재시작 트리거 실패: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }, restartDelayMs).unref();
      triggeredRestart = true;
    } catch (e) {
      // setTimeout 자체 실패는 사실상 불가 — 방어적 처리.
      return {
        status: "failed",
        from: prevSha,
        to: newSha,
        changedFiles: changed.length,
        ranNpmInstall,
        error: redactSecrets(
          `재시작 예약 실패: ${e instanceof Error ? e.message : String(e)}`,
        ),
      };
    }

    // ── 단계 9: updating 반환 ──────────────────────────────────────────────────
    return {
      status: "updating",
      from: prevSha,
      to: newSha,
      changedFiles: changed.length,
      ranNpmInstall,
      restartInMs: restartDelayMs,
    };
  } finally {
    // 락 해제 — updating(재시작 예약됨) 경로는 프로세스가 곧 죽지만, 5s 창에서의 중복
    // 호출도 막아야 하므로 *재시작을 예약한 경우엔 락을 유지* 한다(죽을 때까지). 그 외
    // (up-to-date·failed·예약 전 throw) 경로는 즉시 해제해 다음 시도를 허용.
    if (!triggeredRestart) {
      updating = false;
    }
  }
};
