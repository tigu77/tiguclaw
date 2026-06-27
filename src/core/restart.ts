// src/core/restart.ts
/**
 * 크로스플랫폼 데몬 재시작 — supervisor 유무와 무관하게 "새 데몬이 반드시 다시 뜨게".
 *
 * 배경(버그 #1): restartDaemon(index.ts)은 graceful exit 후 supervisor(launchd KeepAlive·
 *  systemd Restart=always)의 respawn 에 의존한다. mac/linux 는 정상이지만 **Windows 는
 *  HKCU Run(로그온 전용, supervisor 없음)** 이라 종료만 하고 안 살아난다.
 *
 * 배경(버그 #2 — 본 재수정): 1차 수정은 supervisor 없는 OS 에서 graceful exit 전에
 *  `daemon.ts restart`(=winRestart) 를 detached spawn 했다. 하지만 winRestart 는
 *  `taskkill /F /T`(프로세스 *트리* 종료)를 호출하는데, 그 재기동 헬퍼는 데몬의 *자식*
 *  프로세스(PPID=데몬)다. 데몬을 트리째 죽이면 /T 가 헬퍼 자신까지 끌고 들어가
 *  **wscript 재기동 전에 헬퍼가 끊긴다** → respawn 0(윈도우 실검증 확인).
 *
 * 해결: self-trigger 경로는 taskkill 을 아예 쓰지 않는다. 데몬은 (mac/linux 와 동형으로)
 *  **graceful exit** 만 하고 — 그 종료가 자식(대시보드·워커)·http 서버를 정리해 포트를
 *  비운다 — 별도로 띄운 **detached 헬퍼**가 잠깐 대기 후 wscript 로 win-launch.vbs 를
 *  재기동한다. 헬퍼는 콘솔 없는 detached 프로세스이고 데몬의 *자식 트리에서 분리*되어
 *  데몬 graceful 종료에 휩쓸리지 않으므로, 대기 뒤 살아서 새 데몬을 띄운다.
 *
 *  대기는 detached(콘솔 없는) 환경에서 안전한 `ping 127.0.0.1 -n 5 >nul`(≈4s) 지연으로
 *  한다(`timeout /t` 는 stdin 리다이렉트 상황에서 실패). 4s 는 데몬의 graceful shutdown +
 *  1.5s force-exit 백스톱 + 포트 해제보다 길어 포트 충돌 0.
 *
 * winRestart(taskkill+wscript)는 그대로 둔다 — CLI `tiguclaw restart`(외부 프로세스 실행,
 *  데몬의 자식이 아니라 taskkill /T 자살 문제 없음) 전용이다. self-trigger(/restart·
 *  self-update)만 이 헬퍼 경로를 쓴다.
 *
 * import 위생: index→이 코어 모듈(core 방향) 단방향. daemon.ts(CLI 스크립트)를 import 하지
 *  않고, wscript 헬퍼를 직접 격리 spawn 한다.
 */
import { spawn } from "node:child_process";
import path from "node:path";
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
 * supervisor 없는 OS 에서 "분리 재기동" 보장(taskkill 미사용).
 *
 * detached 헬퍼를 띄운다: "**짧은 대기 → wscript 로 win-launch.vbs 재기동**". 헬퍼는
 *  데몬의 자식 트리에서 분리(detached + unref)되어 데몬의 graceful 종료에 죽지 않는다.
 *  데몬은 헬퍼 spawn 직후 **graceful exit**(자식·http 서버 정리 = 포트 해제)하고, 헬퍼는
 *  대기(ping ≈4s > shutdown+1.5s 백스톱)가 끝나면 살아서 새 데몬을 띄운다.
 *
 * 반환 true = 헬퍼 spawn 성공(호출측은 graceful exit 로 진행 — 헬퍼가 respawn 담당).
 *  반환 false = spawn 실패 → 호출측은 그래도 graceful exit 로 최소한 종료는 보장(견고성).
 *
 * VBS 경로 = getPaths().home/win-launch.vbs — daemon.ts winVbsPath 와 동일 위치(둘 다
 *  TIGUCLAW_HOME 기준). cmd.exe `/c` 한 줄: ping 지연 → wscript(숨김 VBS 재기동).
 */
export const spawnDetachedRestart = (source: string): boolean => {
  const vbsPath = path.join(getPaths().home, "win-launch.vbs");

  try {
    const child = spawn(
      "cmd.exe",
      [
        "/c",
        // ping 127.0.0.1 -n 5 ≈ 4s 지연(콘솔 없는 detached 환경 안전 — timeout /t 는 stdin
        // 리다이렉트서 실패). 그 뒤 wscript 가 숨김 VBS 로 새 데몬 기동. taskkill 없음.
        `ping 127.0.0.1 -n 5 >nul & wscript "${vbsPath}"`,
      ],
      {
        // detached + unref + 자식 트리 분리 → 데몬 graceful 종료에 휩쓸리지 않음.
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // TIGUCLAW_SERVICE_LABEL·TIGUCLAW_HOME 등 상속 → 올바른 인스턴스 타겟.
        env: process.env,
      },
    );
    // 부모 이벤트 루프가 이 자식을 붙잡지 않게 분리(부모는 곧 graceful exit).
    child.unref();
    console.log(
      `daemon: detached restart helper spawned (${source}) — ping 지연 후 wscript 가 win-launch.vbs 재기동 (데몬은 graceful exit)`,
    );
    return true;
  } catch (err) {
    console.error(
      `daemon: detached restart helper spawn 실패 (${source}) — graceful exit 만 진행:`,
      err,
    );
    return false;
  }
};
