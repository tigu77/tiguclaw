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
    ["darwin", true], // launchd KeepAlive
    ["linux", true], // systemd Restart=always
    ["win32", true], // 예약작업 KeepAlive (감독자 + 1분 반복) — 2026-08-22
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

  // ── ② supervisor 있는 OS 는 respawn 인자와 무관하게 종료한다 ────────────────
  for (const p of ["darwin", "linux", "win32"]) {
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
      [/wscript/, "숨김 스크립트 실행"],
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
