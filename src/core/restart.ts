// src/core/restart.ts
/**
 * 재시작 판정 — **"죽어도 되는가"** 하나만 답한다.
 *
 * ★2026-08-22 이전엔 이 모듈이 윈도우에서 *직접 재기동까지* 했다. 데몬이 종료 직전에
 *  `schtasks` 로 1회성 예약작업을 만들어 `ping` 으로 4초 지연한 뒤 숨김 VBS 로 자기를
 *  다시 띄우는 구조였다. 같은 자리가 **세 번 다른 이유로** 터졌다:
 *    #1 detached 헬퍼가 `taskkill /T` 에 같이 죽음
 *    #2 job object 가 데몬 종료 시 헬퍼까지 정리
 *    #3 런처 VBS 가 없어도 schtasks 는 성공을 보고 → 데몬은 믿고 죽고 무기한 먹통
 *  그리고 마지막으로 Windows Defender 가 그 명령줄을 `Trojan:Win32/Commando.A!ml` 로
 *  분류해 `schtasks` 생성을 EPERM 으로 차단했다. **오탐이지만 틀린 탐지는 아니다** —
 *  런타임 예약작업 생성 + `ping` 지연 + 숨김 스크립트 실행은 드로퍼의 표준 수법이라
 *  행위만 보고는 구분할 근거가 없다.
 *
 * ★고친 것은 호출 방식이 아니라 **책임의 위치**다. 재기동은 죽는 쪽이 아니라 살아 있는
 *  쪽이 한다 — 윈도우도 이제 감독자를 갖는다(`bin/daemon.mjs supervise`, 설치 시 등록되는
 *  예약작업이 실행). 그래서 데몬은 mac·리눅스와 **똑같이 그냥 종료**하면 되고, 이 파일에
 *  있던 재기동 코드는 통째로 사라졌다. 세 플랫폼이 같은 규칙을 쓴다.
 *
 * 남은 판정: supervisor 가 **있다고 아는** 플랫폼에서만 죽는다. 모르는 플랫폼에서
 *  "확실히 종료" 는 "확실히 재기동" 이 아니라 **"확실히 사망"** 이다(2026-08-15 교훈 —
 *  재시작이 안 된 건 눈에 보이지만 사라진 건 안 보인다).
 */
import { spawnSync } from "node:child_process";

/**
 * 현 OS 가 supervisor(자동 respawn) 위에서 도는가.
 *  - darwin = launchd `KeepAlive=true`
 *  - linux  = systemd `Restart=always`
 *  - win32  = 예약작업 KeepAlive(감독자 프로세스 + 1분 반복 트리거) ← 2026-08-22 추가
 *  - 기타   = 알 수 없음 → 죽지 않는다.
 *
 * ★**플랫폼을 인자로 받는다** (2026-08-15, 적대 검토 P3). 종전엔 `process.platform` 을
 *  직접 읽어 검사가 **도는 기계의 플랫폼만** 볼 수 있었다 — 윈도우에서 도는 CI 는 없으므로
 *  윈도우 분기의 오판은 mac/CI 에서 원리적으로 안 보인다. 표로 검사할 수 있게 둔다.
 *
 * ★전제: 이 판정이 참이려면 **설치가 supervisor 를 등록해야** 한다(`tiguclaw install`).
 *  세 OS 다 마찬가지고, 설치 없이 직접 띄운 경우(`npm run dev`)는 어디서도 안 살아난다.
 */
export const hasSupervisorRespawnOn = (platform: string): boolean =>
  platform === "darwin" || platform === "linux" || platform === "win32";

export const hasSupervisorRespawn = (): boolean =>
  hasSupervisorRespawnOn(process.platform);

/**
 * 재시작 요청을 받았을 때 정말 죽어도 되는가.
 *
 * 사고(2026-08-15): 윈도우 돌쇠가 "업데이트해도 시작이 안 되고 재시작도 안 된다".
 *  재기동 수단을 못 잡았는데 그대로 죽어 무기한 먹통이었다. 그때 판정을 **재기동이
 *  보장될 때만 죽는다**로 뒤집었고, 그 가드가 08-22 Defender 차단 때 데몬을 살렸다
 *  (`schtasks EPERM` → 재시작 중단 → 데몬 생존, 업데이트만 미적용).
 *
 * 지금은 윈도우에도 supervisor 가 있으므로 세 OS 가 같은 답을 낸다. 판정 자체는 남긴다 —
 *  supervisor 없는 환경(미설치·기타 플랫폼)에서 사라지지 않기 위해서다.
 */
export const shouldExitForRestart = (input: {
  platform: string;
  /** supervisor 를 모르는 플랫폼에서 재기동을 실제로 잡았는가. */
  respawnArranged: boolean;
}): boolean =>
  hasSupervisorRespawnOn(input.platform) ? true : input.respawnArranged;

/**
 * 옛 self-restart 예약작업(`<label>-selfrestart`) 잔재 정리 — 부팅 시 best-effort.
 *
 * ★남겨두는 이유: `install` 을 다시 돌리지 않고 업데이트만 한 기계에는 Defender 가 악성
 *  으로 분류한 그 작업이 목록에 남는다. 재발화는 안 하지만(1회성) 보안 소프트가 계속
 *  경고를 띄울 수 있어 조용히 걷어낸다. win32 외 no-op, 실패해도 부팅을 막지 않는다.
 */
export const cleanupSelfRestartTask = (): void => {
  if (process.platform !== "win32") return;
  const label =
    process.env.TIGUCLAW_SERVICE_LABEL?.trim() || "com.tiguclaw.daemon";
  try {
    spawnSync("schtasks", ["/delete", "/tn", `${label}-selfrestart`, "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // best-effort — 무시.
  }
};
