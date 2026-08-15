/**
 * 회귀: **재기동이 보장될 때만 죽는다** (2026-08-15).
 *
 * 사고(사용자 신고): 윈도우 돌쇠가 *"업데이트해도 시작이 안 되고 재시작을 해도 재시작이
 * 안 되네"*. 로그에 원인이 통째로 있었다 —
 *
 *   [error] daemon: schtasks /create 실패 (telegram:telegram, status=null) — graceful exit 만 진행
 *   [log]   daemon: restart requested (telegram:telegram) — graceful exit
 *   [fatal] daemon: graceful shutdown 지연 — force exit
 *
 * **재기동 수단을 못 잡았다고 로그에 적어놓고 그대로 죽었다.** 윈도우는 supervisor 가 없어
 * (HKCU Run = 로그온 1회) 그 길로 무기한 먹통이고, 사용자는 재시작 버튼을 눌렀을 뿐이다.
 *
 * ★종전 근거가 정확히 뒤집혀 있었다: *"spawn 실패해도 graceful exit 는 진행(최소한 종료는
 *  보장 — 견고성)"*. supervisor 가 있는 OS 에서 "확실한 종료" 는 곧 "확실한 재기동" 이지만,
 *  없는 OS 에서는 **"확실한 사망"** 이다. 같은 행동이 두 환경에서 정반대 결과를 내면
 *  그건 하나의 규칙일 수 없다.
 *
 * ★이 판정을 `index.ts` 에 두면 검사하려고 **데몬을 띄워야 한다**(import 만으로 부팅한다).
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

  // ── ① 사고 재현 — supervisor 없는 OS + 재기동 미확보 = **죽지 않는다** ───────
  out.push(
    assert(
      "★win32 에서 재기동을 못 잡으면 종료하지 않는다(사고 재현)",
      !shouldExitForRestart({ platform: "win32", respawnArranged: false }),
      shouldExitForRestart({ platform: "win32", respawnArranged: false })
        ? "★죽는다 — 윈도우엔 되살릴 것이 없다(무기한 먹통)"
        : "유지 확인",
    ),
  );
  out.push(
    assert(
      "win32 에서 재기동을 잡았으면 종료한다(정상 재시작은 그대로)",
      shouldExitForRestart({ platform: "win32", respawnArranged: true }),
      "정상 경로 확인",
    ),
  );

  // ── ①-b ★**세 플랫폼을 표로 고정한다** (적대 검토 P3) ───────────────────────
  //  종전 ④는 `process.platform` 을 써서, **mac 에서 돌면 늘 초록**이었다. 그래서
  //  `hasSupervisorRespawn()` 에 `|| win32` 를 넣어도(윈도우가 "supervisor 있음" 으로
  //  오판 → spawnDetachedRestart 를 아예 안 부르고 즉시 죽음) 아무도 못 봤다. 윈도우에서
  //  도는 CI 는 없으므로 **원리적으로 안 보이는 구멍**이었다. 리터럴 표로 본다.
  for (const [platform, hasSupervisor] of [
    ["darwin", true],
    ["linux", true],
    ["win32", false],
  ] as const) {
    out.push(
      assert(
        `${platform} 의 supervisor 판정이 고정돼 있다(기대 ${hasSupervisor})`,
        hasSupervisorRespawnOn(platform) === hasSupervisor,
        `실제 ${hasSupervisorRespawnOn(platform)}`,
      ),
    );
  }

  // ── ② supervisor 있는 OS 는 **영향 없음** — 이 수정이 mac/linux 를 안 건드린다 ─
  //  종료가 곧 재기동이므로 respawn 인자와 무관하게 죽어야 한다. 여기서 조건이 섞이면
  //  mac 데몬이 재시작을 거부하는 정반대 사고가 된다.
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

  // ── ③ ★**돌던 형태를 지킨다** — 액션 문자열을 함부로 바꾸지 않는다 ────────────
  //  2026-08-15 에 나는 이 액션의 `&`·`>`·중첩 따옴표가 schtasks 를 깨뜨린다고 보고 `.cmd`
  //  파일로 뺐다가 **되돌렸다**. 로그 전수: 06-27~08-06 **19번 요청 19번 성공, 실패 0**.
  //  그 가설은 "왜 08-15 에만" 을 설명하지 못하고, 그날 받은 `status=null` 은 인자 거부
  //  (status=1)가 아니라 **프로세스가 안 떴다**는 뜻이라 형상도 반대다.
  //  ★증거가 지지하지 않는 변경으로 돌던 코드를 바꾸지 않는다 — 이 검사는 그 결정을 지킨다.
  {
    const wiring = await sourceHas("../../core/restart.ts", [
      /const action = `cmd \/c ping 127\.0\.0\.1 -n 5 >nul & wscript "\$\{vbsPath\}"`;/,
      /"\/tr",\s*action,/,
    ]);
    out.push(
      assert(
        "★19/19 로 돌던 액션 형태가 유지된다(가설로 바꾸지 않는다)",
        wiring.ok,
        wiring.ok ? "액션 유지 확인" : `누락 ${wiring.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑤ 실패 이유가 로그에 남는다 — 윈도우는 로그가 1차 진단면이다 ────────────
  //  종전엔 `status=null` 만 찍혀서 "프로세스가 아예 안 떴다" 이상을 알 수 없었다.
  {
    const diag = await sourceHas("../../core/restart.ts", [
      /error=\$\{create\.error\.message\}/,
      /task=\$\{taskName\}/,
    ]);
    out.push(
      assert(
        "★schtasks 실패 시 원인(error)·작업명을 같이 남긴다",
        diag.ok,
        diag.ok ? "진단 필드 확인" : `누락 ${diag.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑥ ★**배선** — 판정 함수를 만들어놓고 호출부가 반환값을 버리면 사고가 되살아난다 ─
  //  (적대 검토 P1) `_wiring.ts` 헤더가 이미 적어둔 부류인데 정작 이 검사가 restart.ts 만
  //  보고 index.ts 는 한 줄도 안 봤다. 호출부를 `if (!hasSupervisorRespawn()) spawn(...)`
  //  + `respawnArranged = true` 로 되돌리면 **한 줄로** 사고가 복귀하고 7건이 전부 초록이었다.
  //  판정과 배선은 **같은 검사**에서 본다.
  {
    const wiring = await sourceHas("../../index.ts", [
      /const respawnArranged = hasSupervisorRespawn\(\)\s*\?\s*true\s*:\s*spawnDetachedRestart\(source\);/,
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

  // ── ⑦ ★실패는 **false 로 취급**된다 (적대 검토 P2) ──────────────────────────
  //  종전엔 로그 문자열만 봐서 "실패를 말하는가" 는 보고 "실패로 취급하는가" 는 안 봤다.
  //  `return false` 를 `return true` 로 바꾸면 로그는 "재시작을 중단한다" 라고 찍으면서
  //  실제로는 죽는다 — 이번 사고와 **똑같은 형상**(로그와 행동의 불일치)이다.
  {
    // ★각 실패 분기를 **문맥과 함께** 묶는다. `sourceOrder` 로 `/return false;/` 를 세 번
    //  나열하면 같은 첫 위치만 봐서 성립하지 않는다(첫 판이 그렇게 틀렸다).
    const branches = await sourceHas("../../core/restart.ts", [
      /if \(!existsSync\(vbsPath\)\)[\s\S]{0,400}?return false;/,
      /create\.status !== 0[\s\S]{0,700}?return false;/,
      /run\.status !== 0[\s\S]{0,500}?return false;/,
    ]);
    out.push(
      assert(
        "★런처 부재·create 실패·run 실패는 전부 false 로 끝난다(로그만 찍고 살아나가지 않는다)",
        branches.ok,
        branches.ok ? "세 분기 확인" : `누락 ${branches.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑧ ★2단계 프로토콜(create→run) — /run 을 지우면 **자정에** 뜬다 (P5) ──────
  //  작업은 `/sc once /st 00:00` 이라 즉시 실행(`/run`)이 없으면 최대 24시간 먹통이다.
  {
    const two = await sourceHas("../../core/restart.ts", [
      /"\/create",/,
      /"\/run",\s*"\/tn",/,
    ]);
    out.push(
      assert(
        "★예약작업을 만들고 **즉시 실행**한다(/run 없으면 자정까지 먹통)",
        two.ok,
        two.ok ? "create+run 확인" : `누락 ${two.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑨ ★런처 존재 확인 — schtasks 성공 ≠ 재기동 보장 (P4) ────────────────────
  //  같은 VBS 를 띄우는 CLI(`winStart`)는 이미 확인한다. 죽을지 정하는 쪽이 더 느슨하면 안 된다.
  {
    const guard = await sourceHas("../../core/restart.ts", [/existsSync\(vbsPath\)/]);
    out.push(
      assert(
        "★런처(VBS)가 없으면 재기동을 확보했다고 하지 않는다",
        guard.ok,
        guard.ok ? "존재 확인" : "★schtasks 성공만으로 죽는다",
      ),
    );
  }

  // ── ⑩ ★재시작 중단을 **한 채널만** 알지 않는다 (적대 검토 P10) ──────────────
  //  종전엔 텔레그램 `/restart` 만 실패를 말했다. 대시보드 버튼(`control.restart`)과
  //  `/update` 는 반환값을 **버렸다** — 특히 업데이트는 사용자가 "약 5초 후 재시작합니다,
  //  잠시 후 완료 알림이 옵니다" 를 받은 뒤 **그 알림이 영영 안 오는** 형태였다(마커는
  //  다음 부팅에만 소비된다). 사용자 신고 "업데이트해도 시작이 안 되고" 의 절반이 이것.
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
    const tg = await sourceHas("../../index.ts", [/if \(restartDaemon\(`telegram:\$\{msg\.channel\}`\)\) return;/]);
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
    "재기동 수단(schtasks 예약작업)을 못 잡았는데도 데몬이 그대로 죽어, 윈도우가 재시작 한 번에 무기한 먹통이 되던 것 — supervisor 없는 OS 에서 '확실한 종료' 는 '확실한 사망' 이다",
  run,
};
