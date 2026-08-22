/**
 * 회귀: **데몬에게는 돌아올 길이 있어야 한다** (2026-08-15 → 2026-08-22 재설계).
 *
 * 사고 1 (08-15, 사용자 신고): *"업데이트해도 시작이 안 되고 재시작을 해도 재시작이 안 되네"*.
 *   로그에 통째로 있었다 — `schtasks /create 실패 … graceful exit 만 진행` → `force exit`.
 *   **재기동 수단을 못 잡았다고 적어놓고 그대로 죽었다.** 종전 근거 *"spawn 실패해도 최소한
 *   종료는 보장(견고성)"* 이 정확히 뒤집혀 있었다: supervisor 가 있으면 확실한 종료가 곧
 *   확실한 재기동이지만, 없으면 **확실한 사망**이다.
 *
 * 사고 2 (08-22): Windows Defender 가 그 재기동 명령줄을 `Trojan:Win32/Commando.A!ml` 로
 *   분류하고 `schtasks` 실행을 EPERM 으로 **차단**했다. 오탐이지만 틀린 탐지는 아니다 —
 *   런타임 예약작업 생성 + `ping 127.0.0.1` 지연 + 숨김 스크립트 실행은 드로퍼의 표준
 *   수법이라 행위만으로는 구분할 수 없다. (사고 1의 가드가 이때 데몬을 살렸다.)
 *
 * ★같은 자리가 세 번 다른 이유로 터진 뒤에야 원인이 보였다: **윈도우만 데몬이 자기 부활을
 *  스스로 책임졌다.** 그래서 고친 건 호출 방식이 아니라 책임의 위치다 — 재기동은 죽는 쪽이
 *  아니라 살아 있는 쪽(감독자)이 한다. 이 검사는 그 구조가 되돌아가지 않게 지킨다.
 *
 * ★판정을 `index.ts` 에 두면 검사하려고 **데몬을 띄워야 한다**(import 만으로 부팅한다).
 *  그래서 순수 함수로 뽑았다 — "검사가 껄끄러우면 코드가 잘못 놓인 것".
 */
import { readFile } from "node:fs/promises";
import {
  hasSupervisorRespawn,
  hasSupervisorRespawnOn,
  shouldExitForRestart,
} from "../../core/restart.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 사고 1 재현 — supervisor 를 **모르는** OS + 재기동 미확보 = 죽지 않는다 ──
  //  win32 는 이제 supervisor 를 갖지만(②), 그 판정이 참인 유일한 근거는 install 이
  //  감독자를 등록한다는 것이다. 규칙 자체는 남는다 — 모르는 곳에서는 사라지지 않는다.
  out.push(
    assert(
      "★supervisor 를 모르는 OS 에서 재기동을 못 잡으면 종료하지 않는다(사고 1 재현)",
      !shouldExitForRestart({ platform: "freebsd", respawnArranged: false }),
      shouldExitForRestart({ platform: "freebsd", respawnArranged: false })
        ? "★죽는다 — 되살릴 것이 없는데 종료한다(무기한 먹통)"
        : "유지 확인",
    ),
  );
  out.push(
    assert(
      "재기동을 잡았으면 종료한다(정상 재시작은 그대로)",
      shouldExitForRestart({ platform: "freebsd", respawnArranged: true }),
      "정상 경로 확인",
    ),
  );

  // ── ①-b ★**세 플랫폼을 표로 고정한다** (적대 검토 P3) ───────────────────────
  //  종전엔 `process.platform` 을 써서 **mac 에서 돌면 늘 초록**이었다. 윈도우에서 도는
  //  CI 는 없으므로 윈도우 분기의 오판은 원리적으로 안 보인다. 리터럴 표로 본다.
  //  ★win32 가 false→true 로 바뀐 것은 **설계 변경의 결과**다(감독자 도입). 이 표를 그냥
  //   고쳐 초록을 만들면 안 되고, ②의 등록 검사와 **같이** 참이어야 의미가 있다.
  for (const [platform, hasSupervisor] of [
    ["darwin", true], // launchd KeepAlive — 등록 확인 불요
    ["linux", true], // systemd Restart=always — 등록 확인 불요
    // ★win32 는 **false 여야 한다.** 감독자는 예약작업이 *실재할 때만* 있는 것이라
    //  무조건 참으로 두면 옛 HKCU Run 설치가 `/update` 로 새 코드만 받았을 때
    //  "누가 살려주겠지" 하고 죽는다(2026-08-22 릴리즈 직전 적발). 측정은 ③-b 참조.
    ["win32", false],
    ["freebsd", false], // 모르는 곳 = 죽지 않는다
  ] as const) {
    out.push(
      assert(
        `${platform} 의 supervisor 판정이 고정돼 있다(기대 ${hasSupervisor})`,
        hasSupervisorRespawnOn(platform) === hasSupervisor,
        `실제 ${hasSupervisorRespawnOn(platform)}`,
      ),
    );
  }

  // ── ①-c ★**옛 설치가 업데이트만 받은 갈래** — 등록이 없으면 죽지 않는다 ──────
  //  `/update` 는 install 을 다시 돌리지 않는다(stop→ci→build→start). 그래서 HKCU Run 으로
  //  깔린 기존 윈도우 사용자는 **예약작업 없이** 새 코드를 받는다. 이때 죽으면 아무도 안
  //  살린다 = "업데이트했더니 비서가 사라졌다". 신규 설치만 보면 영원히 안 보이는 갈래다.
  out.push(
    assert(
      "★win32 + 예약작업 없음 = 종료하지 않는다(옛 설치가 업데이트만 받은 경우)",
      !shouldExitForRestart({ platform: "win32", respawnArranged: false }),
      shouldExitForRestart({ platform: "win32", respawnArranged: false })
        ? "★죽는다 — 등록이 없는데 supervisor 를 단정했다(무기한 먹통)"
        : "유지 확인",
    ),
  );
  out.push(
    assert(
      "win32 + 예약작업 있음 = 종료한다(정상 재시작)",
      shouldExitForRestart({ platform: "win32", respawnArranged: true }),
      "정상 경로 확인",
    ),
  );

  // ── ①-d ★win32 판정은 **선언이 아니라 측정**이어야 한다 ──────────────────────
  //  `hasSupervisorRespawn()` 이 `winSupervisorTaskExists()`(schtasks 조회)를 실제로
  //  부르는지 본다. 여기를 `|| platform === "win32"` 로 되돌리면 ①-c 가 무의미해진다.
  {
    const measured = await sourceHas("../../core/restart.ts", [
      /export const winSupervisorTaskExists[\s\S]{0,400}?schtasks[\s\S]{0,200}?"\/query"/,
      /hasSupervisorRespawnOn\(process\.platform\) \|\| winSupervisorTaskExists\(\)/,
      // 조회 실패도 false — "모르면 죽지 않는다".
      /catch \{\s*return false;/,
    ]);
    out.push(
      assert(
        "★win32 supervisor 는 schtasks 로 **측정**한다(선언 금지·조회 실패는 false)",
        measured.ok,
        measured.ok ? "측정 경로 확인" : `누락 ${measured.missing.join(" ")}`,
      ),
    );
  }

  // ── ①-e ★`start` 가 등록을 **수렴**시킨다(부재 + 낡음) ───────────────────────
  //  `/update` 는 install 을 다시 돌리지 않으므로(stop→ci→build→start) 기존 사용자에게
  //  등록 변경을 배달하는 **유일한 길이 start** 다. 두 부류를 다 고쳐야 한다:
  //   ① 부재 — 옛 HKCU Run 설치엔 예약작업이 없다("업데이트했더니 비서가 사라졌다")
  //   ② 낡음 — 등록은 Task Scheduler 에 있어 코드를 고쳐도 안 바뀐다(창이 계속 떴다)
  //  ★①만 고치고 ②를 안 봐서 같은 실수를 두 번 했다. 그래서 "부재 시 등록" 이 아니라
  //   **매번 재등록(수렴)** 인지를 본다 — 설정을 하나씩 비교하는 검사는 손으로 관리하는
  //   목록이라 반드시 늙는다.
  {
    const conv = await sourceHas("../../../bin/daemon.mjs", [
      // 정의점 하나 — install·start 가 같은 함수로 수렴한다.
      //  ★등록 **전에 멈춘다**: 작업이 돌고 있으면 `Register -Force` 가 실패해 수렴이
      //   조용히 건너뛰어진다(실측: 갱신 중 반복 트리거가 되살려 등록이 안 바뀌었다).
      /const winEnsureTask = \(c\) => \{[\s\S]{0,900}?Stop-ScheduledTask[\s\S]{0,300}?buildWinTaskScript\(c\)/,
      /const winInstall = \(c\) => \{[\s\S]{0,300}?winEnsureTask\(c\)/,
      /const winStart = \(c\) => \{[\s\S]{0,900}?winEnsureTask\(c\)/,
      // 재등록 실패해도 기존 등록이 있으면 진행 — 일시 실패가 기동을 막지 않는다.
      /if \(exists\) \{[\s\S]{0,300}?return true;/,
    ]);
    out.push(
      assert(
        "★install·start 가 같은 함수로 등록을 수렴시킨다(부재만이 아니라 낡음도 고친다)",
        conv.ok,
        conv.ok ? "수렴 경로 확인" : `누락 ${conv.missing.join(" ")}`,
      ),
    );
  }

  // ── ② 무조건 supervisor 인 OS 는 respawn 인자와 무관하게 종료한다 ────────────
  for (const p of ["darwin", "linux"]) {
    out.push(
      assert(
        `${p} 는 respawn 인자와 무관하게 종료한다(supervisor 가 되살린다)`,
        shouldExitForRestart({ platform: p, respawnArranged: false }) &&
          shouldExitForRestart({ platform: p, respawnArranged: true }),
        "supervisor 경로 확인",
      ),
    );
  }
  out.push(
    assert(
      "supervisor 판정과 종료 판정이 같은 사실을 본다",
      hasSupervisorRespawn() ===
        shouldExitForRestart({ platform: process.platform, respawnArranged: false }),
      `platform=${process.platform}`,
    ),
  );

  // ── ③ ★사고 2 직격 — 데몬은 **런타임에 예약작업을 만들지 않는다** ────────────
  //  Defender 가 악성으로 분류한 조합이 바로 이것이다(런타임 생성 + ping 지연 + 숨김
  //  스크립트). 편의상 되살리기 쉬운 코드라 소스에서 형태 자체를 막는다.
  {
    // ★"없어야 통과" 라 `sourceHas`(있으면 ok)를 못 쓴다 — 직접 읽는다.
    const banned: Array<[RegExp, string]> = [
      [/"\/create"/, "런타임 예약작업 생성(schtasks /create)"],
      [/ping 127\.0\.0\.1/, "ping 지연(샌드박스 회피 수법과 동형)"],
      // ★`wscript` 자체가 악성이라서가 아니다 — **데몬이 죽기 직전에** 런타임 작업을 만들어
      //  숨김 스크립트를 지연 실행하는 **조합**이 드로퍼 수법이었다. 설치가 등록해 둔 작업이
      //  런처를 실행하는 건(bin/daemon.mjs) 정상이고 Defender 도 안 막는다(실측).
      //  그래서 금지는 이 두 파일(데몬의 재시작 경로)에만 건다.
      [/wscript/, "데몬 재시작 경로의 숨김 스크립트 실행"],
    ];
    for (const rel of ["../../core/restart.ts", "../../index.ts"]) {
      const src = await readFile(new URL(rel, import.meta.url), "utf8");
      const hit = banned.filter(([re]) => re.test(src)).map(([, why]) => why);
      out.push(
        assert(
          `★${rel.split("/").pop()} 에 Defender 가 악성으로 본 형태가 없다`,
          hit.length === 0,
          hit.length === 0 ? "금지 형태 0" : `★되살아났다 — ${hit.join(" · ")}`,
        ),
      );
    }
  }

  // ── ④ ★win32=true 의 **근거** — install 이 KeepAlive 감독자를 등록한다 ────────
  //  ①-b 의 win32=true 는 이 등록이 있을 때만 참이다. 등록이 사라지면 데몬은 "되살아난다"
  //  고 믿고 죽는데 아무도 안 살린다 = 사고 1 의 재발이다. **판정과 근거를 같이 본다.**
  {
    const reg = await sourceHas("../../../bin/daemon.mjs", [
      /Register-ScheduledTask/,
      /MultipleInstances IgnoreNew/, // 중복 데몬 방지(작업 인스턴스 == 감독자 수명)
      /RepetitionInterval/, // 감독자까지 죽었을 때의 바닥 그물
      /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/, // 없으면 기본 3일 후 강제 종료
      /"supervise"/, // 작업이 실행하는 것 = 감독자
      // ★창을 없애는 수단 = **숨김 런처(VBS)** 지 principal 이 아니다 (2026-08-22).
      //  경위: node 직접 실행(창 뜸) → S4U(내 SSH 에선 됐지만 실사용 경로에서 `액세스가
      //  거부되었습니다`) → wscript 런처. 액션이 wscript 여야 하고,
      //  런처는 `sh.Run(cmd, 0, True)` 여야 한다 — `0`=숨김, **`True`=대기**.
      //  대기를 빼면 wscript 가 즉시 끝나 작업 인스턴스도 끝나고, `IgnoreNew` 가 무효가 돼
      //  **1분마다 감독자가 하나씩 더 뜬다**(같은 홈·같은 포트 = 사고).
      /New-ScheduledTaskAction -Execute 'wscript\.exe'/,
      /-LogonType Interactive/,
      /sh\.Run "\$\{cmd\.replace\(\/"\/g, '""'\)\}", 0, True/,
      // 런처를 **등록 전에** 쓴다 — 없으면 등록은 성공하고 실행만 조용히 실패한다.
      /writeFileSync\(winVbsPath\(c\), buildWinVbs\(c\), "utf8"\);[\s\S]{0,400}?buildWinTaskScript\(c\)/,
    ]);
    out.push(
      assert(
        "★install 이 KeepAlive 예약작업을 등록한다(win32 supervisor 판정의 근거)",
        reg.ok,
        reg.ok ? "등록 4요소 확인" : `누락 ${reg.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑤ ★감독자가 실제로 **되살린다** — 한 번 띄우고 끝나면 supervisor 가 아니다 ─
  {
    const sup = await sourceHas("../../../bin/daemon.mjs", [
      /child\.on\("exit"/,
      /setTimeout\(spawnOnce, THROTTLE_MS\)/, // 크래시 루프 스로틀(launchd 동형)
      /spawnOnce\(\);\s*\}\);/, // 정상 종료 → 즉시 재기동
    ]);
    out.push(
      assert(
        "★감독자가 자식 종료를 감지해 다시 띄운다(스로틀 포함)",
        sup.ok,
        sup.ok ? "재기동 루프 확인" : `누락 ${sup.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑥ ★마이그레이션 — 옛 자동시작을 지운다(안 지우면 데몬이 **두 개** 뜬다) ────
  //  HKCU Run 과 예약작업이 둘 다 살아 있으면 로그온 시 같은 홈·같은 포트로 두 인스턴스가
  //  뜬다. 조용한 데이터 사고라 install 경로에서 반드시 정리해야 한다.
  {
    const mig = await sourceHas("../../../bin/daemon.mjs", [
      /winRemoveLegacyAutostart\(c\);[\s\S]{0,400}?buildWinTaskScript/,
      /"delete",\s*RUN_KEY/,
    ]);
    out.push(
      assert(
        "★install 이 옛 HKCU Run 등록을 먼저 지운다(중복 기동 방지)",
        mig.ok,
        mig.ok ? "마이그레이션 확인" : `누락 ${mig.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑦ ★stop/restart 는 **작업을 멈춘다** — 데몬만 죽이면 감독자가 되살린다 ────
  //  감독자가 생긴 뒤로 `taskkill` 만으로는 멈출 수 없다(즉시 부활 → "stop 이 안 먹는다").
  //  launchd 에서 프로세스를 kill 하지 않고 `bootout` 하는 것과 같은 이유다.
  {
    const stop = await sourceHas("../../../bin/daemon.mjs", [
      /const winStopTask = \(c\) => \{[\s\S]{0,900}?Stop-ScheduledTask/,
      /const winStop = \(c\) => \{\s*const survived = winStopTask\(c\);/,
      /const winRestart = \(c\) => \{\s*const survived = winStopTask\(c\);/,
    ]);
    out.push(
      assert(
        "★stop·restart 가 작업 인스턴스를 멈춘다(데몬만 죽이면 감독자가 되살린다)",
        stop.ok,
        stop.ok ? "작업 종료 경로 확인" : `누락 ${stop.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑦-b ★`stop` 은 **비활성화까지** 해야 멈춘다 (2026-08-22, 실측으로 잡힘) ────
  //  `Stop-ScheduledTask` 는 지금 도는 인스턴스만 끝낸다. 1분 반복 트리거가 그대로면
  //  90초 안에 되살아나 **stop 이 안 먹는다**(그 기계에서 실제로 그랬다: pid 35108 부활).
  //  Disable/Enable 이 짝이라 한쪽만 지우면 조용히 깨진다 — 둘을 같이 본다.
  //  ★이 결함은 **1분을 기다려야** 보인다. 즉시 확인으로는 초록이라 검사로 못 박으면
  //   다음 사람이 못 본다.
  {
    const gate = await sourceHas("../../../bin/daemon.mjs", [
      /const winStopTask = \(c\) => \{[\s\S]{0,900}?Disable-ScheduledTask/,
      /const winStart = \(c\) => \{[\s\S]{0,900}?Enable-ScheduledTask/,
      /const winRestart = \(c\) => \{[\s\S]{0,900}?Enable-ScheduledTask/,
    ]);
    out.push(
      assert(
        "★stop 은 작업을 비활성화하고, start·restart 는 다시 활성화한다(반복 트리거 부활 차단)",
        gate.ok,
        gate.ok
          ? "Disable/Enable 쌍 확인"
          : `★stop 이 안 먹는다(1분 뒤 부활) — 누락 ${gate.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑧ ★**배선** — 판정을 만들어놓고 호출부가 반환값을 버리면 사고가 되살아난다 ─
  //  (적대 검토 P1) 종전엔 이 검사가 restart.ts 만 보고 index.ts 는 한 줄도 안 봤다.
  {
    const wiring = await sourceHas("../../index.ts", [
      /const respawnArranged = hasSupervisorRespawn\(\);/,
      /if \(!shouldExitForRestart\(\{ platform: process\.platform, respawnArranged \}\)\)/,
      /return false;/,
    ]);
    out.push(
      assert(
        "★index.ts 배선이 판정 결과를 실제로 쓴다(반환값을 버리지 않는다)",
        wiring.ok,
        wiring.ok ? "배선 확인" : `누락 ${wiring.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑨ ★재시작 중단을 **한 채널만** 알지 않는다 (적대 검토 P10) ──────────────
  //  종전엔 텔레그램 `/restart` 만 실패를 말했다. 대시보드 버튼과 `/update` 는 반환값을
  //  버려서, 사용자는 "곧 완료 알림이 옵니다" 를 받고 **그 알림이 영영 안 왔다**.
  {
    const su = await sourceHas("../../core/self-update.ts", [
      /if \(restart\(\) === false\)/,
      /재시작을 못 했습니다/,
    ]);
    out.push(
      assert(
        "★self-update 가 재시작 중단을 사용자에게 알린다(옛 코드로 돈다고 말한다)",
        su.ok,
        su.ok ? "통지 확인" : `누락 ${su.missing.join(" ")}`,
      ),
    );
    const tg = await sourceHas("../../index.ts", [
      /if \(restartDaemon\(`telegram:\$\{msg\.channel\}`\)\) return;/,
    ]);
    out.push(
      assert(
        "텔레그램 /restart 도 중단을 말한다",
        tg.ok,
        tg.ok ? "통지 확인" : `누락 ${tg.missing.join(" ")}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "restart-needs-a-way-back",
  guards:
    "재기동 수단을 못 잡았는데도 데몬이 그대로 죽어 윈도우가 재시작 한 번에 무기한 먹통이 되던 것 + 그 재기동 수단(런타임 schtasks 생성·ping 지연·숨김 스크립트)이 Defender 에 악성으로 차단되던 것 — 재기동은 죽는 쪽이 아니라 살아 있는 쪽(감독자)이 한다",
  run,
};
