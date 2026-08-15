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
import { hasSupervisorRespawn, shouldExitForRestart } from "../../core/restart.js";
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

  return out;
};

export const check: RegressionCheck = {
  name: "restart-needs-a-way-back",
  guards:
    "재기동 수단(schtasks 예약작업)을 못 잡았는데도 데몬이 그대로 죽어, 윈도우가 재시작 한 번에 무기한 먹통이 되던 것 — supervisor 없는 OS 에서 '확실한 종료' 는 '확실한 사망' 이다",
  run,
};
