// src/core/restart.ts
/**
 * 크로스플랫폼 데몬 재시작 — supervisor 유무와 무관하게 "새 데몬이 반드시 다시 뜨게".
 *
 * 배경(버그 #1): restartDaemon(index.ts)은 graceful exit 후 supervisor(launchd KeepAlive·
 *  systemd Restart=always)의 respawn 에 의존한다. mac/linux 는 정상이지만 **Windows 는
 *  HKCU Run(로그온 전용, supervisor 없음)** 이라 종료만 하고 안 살아난다.
 *
 * 배경(버그 #2): 1차 수정은 `daemon.ts restart`(=winRestart) 를 detached spawn 했는데,
 *  winRestart 의 `taskkill /F /T`(프로세스 *트리* 종료)가 데몬의 자식인 그 헬퍼까지
 *  wscript 재기동 전에 죽여 respawn 0.
 *
 * 배경(버그 #3 — 본 재수정): 2차 수정은 detached cmd 헬퍼(ping→wscript)를 띄웠다. 메커니즘은
 *  맞았으나, 데몬을 **schtasks 예약작업으로 기동하면 그 job object 가 데몬 종료 시 자식
 *  프로세스(=detached 헬퍼)까지 함께 정리**해 헬퍼가 ping 대기 중 죽는다(윈도우 실검증).
 *  detached + unref 로도 job object 경계는 못 벗어난다.
 *
 * 해결: 재기동을 데몬의 자식이 아니라 **독립 schtasks 1회성 예약작업**으로 띄운다. Task
 *  Scheduler 가 작업을 *소유*하므로 데몬을 어떤 방식(schtasks job·로그온 VBS·수동)으로
 *  띄웠든 데몬 종료에 휩쓸리지 않는다. 작업이 ping(≈4s 대기 = 데몬 graceful 종료·포트
 *  해제 시간 확보) 후 wscript 로 win-launch.vbs 를 실행해 새 데몬을 띄운다.
 *
 *  데몬은 (mac/linux 와 동형으로) graceful exit 만 한다 — 그 종료가 자식(대시보드·워커)·
 *  http 서버를 정리해 포트를 비운다. 작업은 독립이라 그 사이 살아 있다가 새 데몬을 기동.
 *
 * winRestart(taskkill+wscript)는 그대로 둔다 — CLI `tiguclaw restart`(외부 프로세스 실행)
 *  전용이다. self-trigger(/restart·self-update)만 이 schtasks 경로를 쓴다.
 *
 * import 위생: index→이 코어 모듈(core 방향) 단방향. daemon.ts(CLI 스크립트)를 import 하지
 *  않고, schtasks 를 직접 호출한다.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { getPaths } from "./paths.js";

/**
 * 현 OS 가 supervisor(자동 respawn) 위에서 도는가.
 *  - darwin = launchd KeepAlive=true → respawn O
 *  - linux  = systemd Restart=always → respawn O
 *  - win32  = HKCU Run(로그온 전용) → respawn X ← graceful exit 만으론 안 살아남
 *  - 기타   = 알 수 없음 → 보수적으로 detached 재기동 시도(있으면 이득, 없어도 exit 진행)
 */
export const hasSupervisorRespawn = (): boolean =>
  process.platform === "darwin" || process.platform === "linux";

/**
 * 인스턴스별 self-restart 예약작업명. TIGUCLAW_SERVICE_LABEL(없으면 기본)에서 파생 —
 *  dev/install/win 다중 인스턴스가 같은 머신서 서로의 작업을 덮어쓰지 않게 격리한다.
 *  (daemon.ts LABEL 과 동일 소스 = process.env.TIGUCLAW_SERVICE_LABEL ?? "com.tiguclaw.daemon".)
 */
export const selfRestartTaskName = (): string => {
  const label =
    process.env.TIGUCLAW_SERVICE_LABEL?.trim() || "com.tiguclaw.daemon";
  return `${label}-selfrestart`;
};

/**
 * supervisor 없는 OS(win32)에서 "독립 예약작업 재기동" 보장.
 *
 * `schtasks /create`(1회성 once, /f 로 덮어써 누적 방지) + `/run`(즉시 실행). 작업 액션 =
 *  `cmd /c ping 127.0.0.1 -n 5 >nul & wscript "<vbsPath>"` → ≈4s 대기 후 숨김 VBS 로 새 데몬
 *  기동. Task Scheduler 소유라 데몬 종료(graceful·job object 정리 무관)에 안 죽는다.
 *
 * 반환 true = create+run 성공(호출측은 graceful exit 로 진행 — 작업이 respawn 담당).
 *  반환 false = 실패 → 호출측은 그래도 graceful exit 로 최소한 종료는 보장(견고성).
 *
 * VBS 경로 = getPaths().home/win-launch.vbs — daemon.ts winVbsPath 와 동일 위치(둘 다
 *  TIGUCLAW_HOME 기준).
 */

/**
 * 재시작 요청을 받았을 때 **정말 죽어도 되는가** (2026-08-15).
 *
 * 사고(사용자 신고): 윈도우 돌쇠가 "업데이트해도 시작이 안 되고 재시작을 해도 재시작이
 * 안 된다". 로그에 원인이 그대로 있었다 —
 *   `schtasks /create 실패 (telegram:telegram, status=null) — graceful exit 만 진행`
 *   `restart requested … graceful exit` → `force exit`
 * **재기동 수단을 못 잡았는데 그대로 죽었다.** 윈도우는 supervisor 가 없어(HKCU Run =
 * 로그온 1회) 그 길로 무기한 먹통이다. 사용자는 재시작을 눌렀을 뿐인데 비서가 사라진다.
 *
 * ★종전 근거는 *"spawn 실패해도 graceful exit 는 진행(최소한 종료는 보장 — 견고성)"* 였다.
 *  그 문장이 **거꾸로**다. supervisor 가 있는 OS 에서 "확실히 종료" 는 곧 "확실히 재기동"
 *  이지만, 없는 OS 에서는 **"확실히 사망"** 이다. 같은 행동이 두 환경에서 정반대 결과를
 *  낸다 — 그러면 그건 하나의 규칙일 수 없다.
 *
 * 그래서 판정을 뒤집는다: **재기동이 보장될 때만 죽는다.** 못 잡았으면 살아 있는 게
 * 사용자에게 이롭다(재시작이 안 된 건 눈에 보이지만, 사라진 건 안 보인다).
 */
export const shouldExitForRestart = (input: {
  platform: string;
  /** supervisor 없는 OS 에서 detached respawn 을 실제로 잡았는가. */
  respawnArranged: boolean;
}): boolean =>
  input.platform === "darwin" || input.platform === "linux"
    ? true // supervisor 가 되살린다 — 종료가 곧 재기동.
    : input.respawnArranged;

/**
 * 재기동 헬퍼 `.cmd` 본문 — **순수 함수**(검사 가능).
 *
 * ★종전엔 `/tr` 에 `cmd /c ping … >nul & wscript "<vbs>"` 를 통째로 넘겼다. 그 한 줄에
 *  `&`·`>`·**중첩 따옴표**가 다 들어 있는데, `schtasks /tr` 은 그 조합에서 악명 높게 깨진다
 *  (그리고 깨지면 이유를 안 알려준다 — 우리가 받은 게 `status=null` 이다).
 *  스크립트 파일로 빼면 `/tr` 인자는 **경로 하나**가 되어 그 지뢰밭이 통째로 사라진다.
 */
export const buildRestartCmdScript = (vbsPath: string): string =>
  [
    "@echo off",
    "rem tiguclaw self-restart helper — schtasks 가 소유하므로 데몬이 죽어도 살아남는다.",
    "rem ping = 지연(데몬 graceful 종료 + 포트 해제 시간 확보). timeout 은 콘솔이 없으면 실패한다.",
    "ping 127.0.0.1 -n 5 >nul",
    `wscript "${vbsPath}"`,
    "",
  ].join("\r\n");

export const spawnDetachedRestart = (source: string): boolean => {
  const vbsPath = path.join(getPaths().home, "win-launch.vbs");
  const taskName = selfRestartTaskName();
  // ★액션을 **파일로** 뺀다 — `/tr` 인자는 경로 하나뿐이라 `&`·`>`·중첩 따옴표가 없다.
  const cmdPath = path.join(getPaths().home, "win-selfrestart.cmd");

  try {
    try {
      writeFileSync(cmdPath, buildRestartCmdScript(vbsPath), "utf8");
    } catch (e) {
      console.error(
        `daemon: 재기동 헬퍼 스크립트 기록 실패 (${source}, ${cmdPath}): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
    // 1) 1회성 작업 생성 — /sc once /st 00:00 (즉시 /run 으로 발화하므로 시각은 형식상).
    //    /f = 기존 동명 작업 덮어쓰기(누적·생성충돌 0).
    const create = spawnSync(
      "schtasks",
      [
        "/create",
        "/tn",
        taskName,
        "/tr",
        cmdPath,
        "/sc",
        "once",
        "/st",
        "00:00",
        "/f",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    if (create.status !== 0) {
      // ★`status` 만 찍으면 아무것도 모른다 — 실제로 받은 게 `status=null` 이었고(=프로세스가
      //  아예 안 떴다는 뜻) 거기서 진단이 멈췄다. 윈도우는 원격 접속이 늘 되는 게 아니라
      //  **로그 한 줄이 1차 진단면**이다. spawn 자체 오류·stderr 를 같이 남긴다.
      console.error(
        `daemon: schtasks /create 실패 (${source}, status=${String(create.status)}` +
          `${create.error === undefined ? "" : `, error=${create.error.message}`}` +
          `${create.signal === null || create.signal === undefined ? "" : `, signal=${create.signal}`}` +
          `) — task=${taskName} tr=${cmdPath} · 재시작을 **중단**한다(윈도우엔 supervisor 가 없다)`,
      );
      return false;
    }
    // 2) 즉시 실행 — 데몬이 graceful exit 하는 동안 작업이 독립적으로 ping→wscript 진행.
    const run = spawnSync("schtasks", ["/run", "/tn", taskName], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (run.status !== 0) {
      console.error(
        `daemon: schtasks /run 실패 (${source}, status=${String(run.status)}` +
          `${run.error === undefined ? "" : `, error=${run.error.message}`}` +
          `) — task=${taskName} · 재시작을 **중단**한다`,
      );
      return false;
    }
    console.log(
      `daemon: self-restart 예약작업 실행 (${source}, task=${taskName}) — ping 지연 후 wscript 가 win-launch.vbs 재기동 (데몬은 graceful exit)`,
    );
    return true;
  } catch (err) {
    console.error(
      `daemon: schtasks self-restart spawn 실패 (${source}) — graceful exit 만 진행:`,
      err,
    );
    return false;
  }
};

/**
 * 부팅 시 잔존 self-restart 예약작업 best-effort 정리. /sc once 라 재발화는 안 하지만
 *  Task Scheduler 목록에 죽은 작업이 남는 걸 막는다(멱등 — 없으면 조용히 무시). win32 외
 *  no-op. 실패해도 부팅을 막지 않는다.
 */
export const cleanupSelfRestartTask = (): void => {
  if (process.platform !== "win32") return;
  try {
    spawnSync("schtasks", ["/delete", "/tn", selfRestartTaskName(), "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // best-effort — 무시.
  }
};
