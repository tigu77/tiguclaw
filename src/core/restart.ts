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
 * 그 플랫폼이 **무조건** supervisor 위에서 도는가 (등록을 확인할 필요조차 없이).
 *  - darwin = launchd `KeepAlive=true`
 *  - linux  = systemd `Restart=always`
 *  - 그 외  = 무조건은 아니다 → **실제로 확인**해야 한다(win32 = `winSupervisorTaskExists`).
 *
 * ★**플랫폼을 인자로 받는다** (2026-08-15, 적대 검토 P3). 종전엔 `process.platform` 을
 *  직접 읽어 검사가 **도는 기계의 플랫폼만** 볼 수 있었다 — 윈도우에서 도는 CI 는 없으므로
 *  윈도우 분기의 오판은 mac/CI 에서 원리적으로 안 보인다. 표로 검사할 수 있게 둔다.
 *
 * ★**win32 를 여기 넣지 마라** (2026-08-22, 릴리즈 직전에 잡음). 감독자를 도입하면서 잠깐
 *  `|| platform === "win32"` 로 적었는데, 그건 **설치가 예약작업을 등록했을 때만** 참이다.
 *  그런데 `/update` 는 install 을 다시 돌리지 않는다(stop→ci→build→start 뿐) — 옛 HKCU Run
 *  으로 깔린 기존 사용자는 예약작업이 **없는 채로** 새 코드를 받는다. 그때 이 함수가 true 를
 *  주면 데몬은 "누가 되살려주겠지" 하고 죽고 **아무도 안 살린다.** 조건을 뒤집으면서 *그
 *  조건에 도달하는 기존 입력*을 안 본 2차결함이다 — 새 설치만 보면 영원히 안 보인다.
 *  → win32 는 **선언이 아니라 측정**으로 판정한다.
 */
export const hasSupervisorRespawnOn = (platform: string): boolean =>
  platform === "darwin" || platform === "linux";

/** 인스턴스 라벨 — `bin/daemon.mjs` 의 LABEL 과 같은 소스(TIGUCLAW_SERVICE_LABEL). */
const serviceLabel = (): string =>
  process.env.TIGUCLAW_SERVICE_LABEL?.trim() || "com.tiguclaw.daemon";

/**
 * 윈도우 KeepAlive 예약작업이 **실재하는가** — 죽어도 되는지의 유일한 근거.
 *
 * ★"있다고 선언" 이 아니라 **물어본다.** 08-15 교훈("재기동이 보장될 때만 죽는다")을
 *  감독자 방식에서도 그대로 지키는 자리다. 등록이 없으면 false → 데몬은 살아남는다.
 * 조회 실패(schtasks 부재·권한·예외)도 false — **모르면 죽지 않는다.**
 */
export const winSupervisorTaskExists = (): boolean => {
  if (process.platform !== "win32") return false;
  try {
    return (
      spawnSync("schtasks", ["/query", "/tn", serviceLabel()], {
        stdio: "ignore",
        windowsHide: true,
      }).status === 0
    );
  } catch {
    return false;
  }
};

export const hasSupervisorRespawn = (): boolean =>
  hasSupervisorRespawnOn(process.platform) || winSupervisorTaskExists();

/**
 * 재시작 요청을 받았을 때 정말 죽어도 되는가.
 *
 * 사고(2026-08-15): 윈도우 돌쇠가 "업데이트해도 시작이 안 되고 재시작도 안 된다".
 *  재기동 수단을 못 잡았는데 그대로 죽어 무기한 먹통이었다. 그때 판정을 **재기동이
 *  보장될 때만 죽는다**로 뒤집었고, 그 가드가 08-22 Defender 차단 때 데몬을 살렸다
 *  (`schtasks EPERM` → 재시작 중단 → 데몬 생존, 업데이트만 미적용).
 *
 * ★win32 는 **여기서 무조건 true 가 되면 안 된다.** 감독자(예약작업)가 실재할 때만
 *  참이고, 그 측정은 호출부가 `hasSupervisorRespawn()` 으로 해서 `respawnArranged` 에
 *  실어 준다. 옛 HKCU Run 설치가 `/update` 로 새 코드만 받은 경우가 정확히 이 갈래다 —
 *  등록이 없으므로 false → 죽지 않는다.
 */
export const shouldExitForRestart = (input: {
  platform: string;
  /** 무조건 supervisor 인 플랫폼이 아닐 때, 재기동을 실제로 확보했는가. */
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
