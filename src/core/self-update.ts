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
import { extractTelegramChatId } from "./threadkey.js";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { sourceRoot, getPaths } from "./paths.js";
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
 * 현재 turn 의 채널/threadKey(+캡처 좌표)에서 완료 통지 좌표를 도출 — update_self·워커
 * notify 캡처 공용. update_self 도구가 이 좌표를 runSelfUpdate.notify 로 운반해, 재시작 후
 * 부팅이 "업데이트 완료" 를 *요청자에게* 회신한다. 채널 미지원(cli 등)은 target=null.
 *
 * ★채널/세션 분리(ADR 2026-07-15 §D3): `channelAddress`(배달 좌표 캡처, telegram=chatId)가
 * 있으면 **그걸 우선** 쓴다 — 세션 id 가 채널 무관(dashboard:*)이 되면 threadKey 파싱으로는
 * telegram chatId 를 못 얻기 때문. 미지정이면 기존 telegram threadKey "tg:<chatId>" 파싱
 * 폴백(회귀 0, 비트 동일). §0 단방향: 좌표는 캡처된 generic 데이터, 세션 id 파싱 의존 제거.
 */
export const notifyDestFromCoords = (
  channel: string,
  threadKey: string,
  channelAddress?: string,
): SelfUpdateNotifyDest => {
  const captured = channelAddress?.trim();
  if (captured !== undefined && captured !== "") {
    return { channel, target: captured };
  }
  return {
    channel,
    target:
      channel === "telegram"
        ? (extractTelegramChatId(threadKey) ?? threadKey)
        : null,
  };
};

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
  /** 테스트·격리용 — 기본 sourceRoot()(소스 빌드 루트 = 레포 루트, built 서도). */
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
// git.exe 라 무관. npm 인자는 전부 고정 상수("install"/플래그)이고 외부 입력이 안 섞이므로
// shell:true 여도 인젝션 0 (동적값은 git reset 의 prevSha 뿐 — git 은 무shell). typecheck 는
// npm 을 안 거치고 `node <tsc.js>` 직접(Windows tsc PATH 이슈 회피, 단계 6 참조).
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
          // err.message 는 명령·exit 코드를 담음. stdout+stderr 를 붙여 진단성 확보 — tsc 는
          // 진단(에러 목록)을 **stdout** 으로 낸다(stderr 아님). stdout 을 빼면 "왜 실패했나"가
          // 통째로 유실돼 호출자·사용자에게 "진입점 미생성"만 남는다(회사 /update 실사고).
          const detail = [err.message, stdout.trim(), stderr.trim()]
            .filter((s) => s !== "")
            .join("\n");
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

/** built 런타임 모드 여부 — 명시 env 만 진실(daemon.ts runtimeMode 와 동일 판정).
 *  Amendment 2026-07-14: **기본 built**(뒤집힘). 정확히 "source" 일 때만 skip(재빌드 없음),
 *  나머지(미설정·오타 포함)는 built = pull 후 재빌드+dist 원자 교체.
 *  ★유닛에 새겨진 TIGUCLAW_RUNTIME(install 시 mode-persistence)을 데몬 process.env 로 읽어
 *   판정하므로, source 로 설치된 dev 데몬은 여기서 skip 되고 built 설치는 재빌드된다. */
const isBuiltRuntime = (): boolean =>
  process.env.TIGUCLAW_RUNTIME?.trim() !== "source";

/**
 * ★built 모드 재빌드 + 원자 dist 교체 (ADR 2026-07-14 D3).
 *
 * built 인스턴스는 `dist/` 산출물로 돌기 때문에 `git pull` 만으론 새 코드가 반영되지
 * 않는다(stale). 새 버전을 돌리려면 on-instance 재빌드가 필수다(D6 — built 인스턴스는
 * 정의상 툴체인 보유).
 *
 * ★원자성 불변식: 도는 데몬의 `dist/` 는 교체 성공 직전까지 무손상. 반쯤 빌드된 dist 로
 * 절대 재시작하지 않는다. 그래서 **스테이징 디렉터리에 완전 빌드 → 진입점 검증 → dist 를
 * 원자 rename 으로 교체**한다. 빌드 도중 크래시가 나도 옛 산출물은 그대로 살아있다.
 *
 * 성공 판정 = 스테이징에 **실행 진입점(src/index.js)** 이 emit 되었는가.
 *  tsconfig.build.json 은 noEmitOnError=false 라 잔여 *타입* 에러가 있어도 .js 는 나온다
 *  (typecheck 를 조언으로 강등한 결정 계승 — 타입에러로 정당 업데이트를 막지 않음).
 *  진짜 실패 = "실행 가능한 산출물 생산 불가"(진입점 미emit / tsc 실행 불가 / 자산 복사
 *  실패 / 플러그인 미러 실패). 이건 npm install 실패와 동류의 정당한 블로킹 신호.
 *
 * throw 0 — 결과 객체 반환(호출부가 실패 시 롤백 + no-restart 결정).
 */
const rebuildBuiltDist = async (
  cwd: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(cwd, `.dist-staging-${stamp}`);
  const distDir = path.join(cwd, "dist");
  const backup = path.join(cwd, `.dist-old-${stamp}`);
  const rmrf = async (p: string): Promise<void> => {
    try {
      await fs.rm(p, { recursive: true, force: true });
    } catch {
      /* best-effort 정리 — 실패해도 치명 아님 */
    }
  };

  try {
    // 1) tsc → staging. noEmitOnError=false 라 타입에러여도 .js emit → exit code 로 막지
    //    않고(조언), 진입점 emit 여부로 판정. tsc 는 built 인스턴스 필수 툴체인(D6).
    const tscBin = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
    // tsc 출력을 캡처해 진입점 미생성 시 **실제 원인**을 사용자에게 전달(회사 /update 가
    // "진입점 미생성"만 뜨고 이유가 안 보이던 문제 — 이유는 데몬 로그에만 남았다).
    let tscOutput = "";
    try {
      const r = await run(
        "node",
        [tscBin, "-p", "tsconfig.build.json", "--outDir", staging],
        cwd,
      );
      tscOutput = `${r.stdout}\n${r.stderr}`.trim();
    } catch (e) {
      tscOutput = redactSecrets(e instanceof Error ? e.message : String(e));
      console.warn(
        `self-update: built 재빌드 tsc 비정상 종료(진입점 emit 로 최종 판정) — ${tscOutput}`,
      );
    }

    // 2) 진입점 emit 검증 — 없으면 "실행 가능한 산출물 생산 불가" = 실패. tsc 마지막 출력을
    //    실어 원인 노출(무출력이면 node_modules/tsc 손상 의심 → CLI `tiguclaw update`(npm ci 선행) 유도).
    const entryJs = path.join(staging, "src", "index.js");
    if (!existsSync(entryJs)) {
      await rmrf(staging);
      const tail = redactSecrets(tscOutput)
        .split("\n")
        .filter((l) => l.trim() !== "")
        .slice(-6)
        .join("\n")
        .slice(-600);
      return {
        ok: false,
        error: tail
          ? `진입점 미생성: dist(staging)/src/index.js\n원인(tsc 마지막 출력):\n${tail}`
          : "진입점 미생성: dist(staging)/src/index.js — tsc 무출력(node_modules/typescript 손상 의심). 터미널에서 `tiguclaw update`(npm ci 선행) 로 복구하세요.",
      };
    }

    // 3) 비-.ts 자산(SYSTEM.md·skills·agents·플러그인 package.json) 복사 → staging.
    const copyBin = path.join(cwd, "bin", "copy-dist-assets.mjs");
    try {
      await run("node", [copyBin, staging], cwd);
    } catch (e) {
      await rmrf(staging);
      return {
        ok: false,
        error: `자산 복사 실패: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    // 4) 플러그인 미러 검증 — dist/plugins 부재면 부팅 시 플러그인 0개(맥락 §2 블로커).
    if (!existsSync(path.join(staging, "plugins"))) {
      await rmrf(staging);
      return { ok: false, error: "staging/plugins 부재(플러그인 미러 실패)" };
    }

    // 5) ★원자 교체 — dist→backup, staging→dist. 둘 다 cwd 하위(동일 파일시스템)라
    //    rename 원자. 이 순간 이후로만 새 코드가 재시작 대상이 된다.
    let distMovedOut = false;
    try {
      if (existsSync(distDir)) {
        await fs.rename(distDir, backup);
        distMovedOut = true;
      }
      await fs.rename(staging, distDir);
    } catch (e) {
      // 교체 중 실패 — 옛 dist 복원 시도 후 스테이징 폐기(도는 데몬 무손상 유지).
      if (distMovedOut && !existsSync(distDir)) {
        try {
          await fs.rename(backup, distDir);
        } catch {
          /* 복원 실패 — 그대로 보고(드문 경계) */
        }
      }
      await rmrf(staging);
      return {
        ok: false,
        error: `dist 원자 교체 실패: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    // 6) 옛 dist 백업 정리(best-effort — 실패해도 새 dist 는 이미 자리).
    await rmrf(backup);
    return { ok: true };
  } catch (e) {
    await rmrf(staging);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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

  // ★sourceRoot() (not appRoot()) — 재빌드는 소스 툴체인(node_modules·tsconfig.build.json·
  // bin·.git) 위치가 필요하다. built 런타임은 appRoot()=dist 라 거기엔 그게 없어 전체 실패했다
  // (Windows /update MODULE_NOT_FOUND). sourceRoot 는 built 서도 repo root 로 해소된다.
  const cwd = deps.cwd ?? sourceRoot();
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
    // 선처리: package-lock.json 로컬 드리프트 폐기. 이 파일은 npm install 이 재생성하는
    // *생성물*이라 플랫폼·npm 버전차로 로컬이 쉽게 더러워지고("local changes to
    // package-lock.json would be overwritten by merge"), 그게 ff-only pull 을 막아 자가
    // 업데이트가 영영 깨진다(Windows 실사고). 생성물 한 파일만 origin 기준으로 되돌리는 건
    // 안전 — 사용자 의미 편집이 아니고, pull 후 (단계 5)npm install 이 필요시 다시 만든다.
    // 다른 트래킹 파일의 미커밋 변경은 건드리지 않으므로 여전히 ff-only 가 정직 실패한다
    // (암묵 파괴 0 — §1·O1 유지). best-effort: 없거나 이미 clean 이면 무시.
    try {
      await run("git", ["checkout", "--", "package-lock.json"], cwd);
    } catch {
      /* 파일 없음·이미 clean·git 미지원 — pull 이 판정하므로 무시 */
    }
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
          await run("npm", ["install", "--no-audit", "--no-fund", "--include=dev"], cwd, {
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
        await run("npm", ["install", "--no-audit", "--no-fund", "--include=dev"], cwd, {
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

    // ── 단계 6: typecheck — 조언(advisory)만, 업데이트를 *절대 막지 않음* (사용자 B안, 2026-07-02) ──
    // 배경: 결정론 게이트가 환경 차이(npm.cmd·tsc PATH·typescript 미설치)마다 깨져 3연타 버그.
    // 그때마다 게이트가 *코드가 아닌 환경 문제*로 실패해 **멀쩡한 pull 을 롤백** — 즉 게이트+
    // 롤백이 도움보다 해를 끼침(정당한 업데이트를 반복 차단). 배포본은 릴리스 클린룸(§7)+
    // verify:plugins 로 이미 typecheck 통과 = *안전은 상류에 있다*. → 온-인스턴스 typecheck 는
    // *조언*으로 강등: tsc 있으면 돌려 결과를 로그로만 남기고, 통과/타입에러/부재/환경실패 무관
    // 하게 업데이트는 진행(재시작). 이로써 환경 브리틀니스로 정당한 업데이트가 막히는 일 0.
    // (실 broken 코드는 릴리스 상류에서 걸러진다. npm install 실패는 여전히 롤백 — 그건 진짜
    // "deps 설치 불가" 이지 환경 브리틀 아님. git pull 은 §3 에서 lockfile-safe.) 절대경로=cwd 무관.
    try {
      const tscPath = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
      await fs.access(tscPath); // 부재 시 catch → 조언 skip(업데이트 진행)
      await run("node", [tscPath, "--noEmit"], cwd);
      console.log("self-update: typecheck 통과(조언).");
    } catch (e) {
      // 게이트가 아니라 조언 — 타입에러·tsc 부재·환경실패 어느 것도 업데이트를 막지 않는다.
      console.warn(
        `self-update: typecheck 조언 비통과/미실행(업데이트는 그대로 진행) — ${redactSecrets(
          e instanceof Error ? e.message : String(e),
        )}`,
      );
    }

    // ── 단계 6b: built 모드 재빌드 + 원자 dist 교체 (ADR 2026-07-14 D3) ─────────
    // source 모드: 이 블록 통째 skip — pull 이 곧 반영(현행 동작 완전 불변).
    // built 모드: dist/ 산출물로 돌므로 재빌드 없이는 stale. 스테이징 빌드 → 진입점
    //  검증 → dist 원자 교체. ★빌드 실패 = 스테이징 폐기 + reset --hard(prev) + 재시작
    //  안 함 → 옛 dist 가 계속 산다(먹통 0). 이건 npm install 실패와 동류의 정당한 블로킹.
    if (isBuiltRuntime()) {
      const rebuild = await rebuildBuiltDist(cwd);
      if (!rebuild.ok) {
        const rolledBack = await rollback();
        return {
          status: "failed",
          from: prevSha,
          to: newSha,
          changedFiles: changed.length,
          ranNpmInstall,
          rolledBack,
          error: redactSecrets(
            `built 재빌드 실패(옛 dist 유지·재시작 안 함): ${rebuild.error}`,
          ),
        };
      }
      console.log("self-update: built 재빌드 + dist 원자 교체 완료.");
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
