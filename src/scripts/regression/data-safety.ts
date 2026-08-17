/**
 * 회귀: **비가역 연산을 실제로 돌려서** 본다 — 마이그레이션·프루닝·백업 (2026-08-17).
 *
 * 전체검토(2026-08-17, 검토자 A~D)의 결론이 하나로 모였다:
 *
 *   **실행하는 검사만 잡는다.**
 *
 * 변이 40여 건 중 잡힌 것은 전부 그 함수를 **실제로 부르는** 검사였고, 뚫린 30여 건은
 *  ⓐ 그 함수를 **아무도 부르지 않거나**
 *  ⓑ 프로덕션 경로 대신 **손으로 만든 픽스처**를 봤다.
 *
 * ★그물 구멍 전부를 닫지는 않았다(대부분은 깨지면 시끄럽거나 관측면만 다친다 — 백로그로
 *  넘겼다). 이 파일은 **비가역인 것만** 지킨다: 지워지거나 덮어써지면 되돌릴 방법이 없는 것.
 *
 * | 무엇 | 종전에 왜 안 잡혔나 |
 * |---|---|
 * | FTS 마이그레이션이 원문을 덮어쓰는 것 | 검사가 **자기 손으로 INSERT 한 행**을 봤다 — 마이그레이션을 한 번도 안 불렀다. 그러면서 로그는 "원문 보존" 이라고 찍는다 |
 * | 희귀 이벤트 프루닝이 **최신을 지우는** 것 | 픽스처가 **상한을 절대 안 넘겼다** → 정렬 방향이 결과에 영향을 못 줬다 |
 * | 프루닝이 **running 잡**을 지우는 것 | 그 함수를 부르는 검사가 0건("★running 은 절대 안 지운다" 는 주석만 있었다) |
 * | 프루닝이 **`scheduler:` 스레드**를 지우는 것 | 같음(스케줄은 30일 넘게 도는 게 정상이라 일부러 제외한 자리) |
 * | 백업 실패가 **조용한** 것 | `db-backup-runs` 16건 중 `runBackupIfDue` 를 부르는 건 0건 — VACUUM 은 검사가 자기 손으로 다시 썼다 |
 *
 * ★자식 프로세스로 돈다: `initStore` 는 프로세스당 한 번이고, 여기 쓰는 것들은 전부 DB 를
 *  실제로 지우거나 덮어쓰므로 스위트 홈과 섞일 수 없다.
 */
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_data-safety-child.ts",
);

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "data-safety-"));
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
    encoding: "utf8",
    env: { ...process.env, TIGUCLAW_HOME: home },
  });
  let got: Record<string, unknown> = {};
  try {
    got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  } catch {
    got = {};
  }
  const tail = (r.stderr ?? "").trim().slice(-200);

  // 자식이 아예 못 돌면 그것부터 말한다 — 조용히 0건 통과하면 검사가 아니다.
  out.push(
    assert(
      "비가역 연산 프로브가 실제로 돌았다(빈손 통과 금지)",
      Object.keys(got).length >= 8,
      Object.keys(got).length >= 8 ? `${Object.keys(got).length}개 판정 회수` : `★프로브 실패: ${tail}`,
    ),
  );
  if (Object.keys(got).length === 0) return out;

  // ── ① FTS 마이그레이션 — 원문은 **바이트 그대로** 남는다 ────────────────────
  out.push(
    assert(
      "★FTS 마이그레이션이 원문(content)을 덮어쓰지 않는다(정리 ≠ 삭제)",
      got.ftsContentPreserved === true && got.ftsBodyKept === true,
      `보존=${String(got.ftsContentPreserved)} 본문유지=${String(got.ftsBodyKept)} 길이=${String(got.ftsContentLen)}`,
    ),
  );
  // ★"정리 ≠ 삭제" 의 **다른 쪽** — 색인본에서는 프리픽스가 빠져야 한다. 둘을 같이 봐야
  //  "아무것도 안 하고 통과"(픽스처가 그 경로를 안 지남)를 막는다 — 실제로 첫 픽스처가
  //  그랬다(원문을 덮어쓰는 변이를 넣어도 초록이었다).
  out.push(
    assert(
      "★그리고 색인본에서는 프리픽스가 빠진다(마이그레이션이 실제로 돌았다는 증거)",
      got.ftsIndexedStripped === true,
      `색인 분리=${String(got.ftsIndexedStripped)}`,
    ),
  );

  // ── ② 희귀 이벤트 프루닝 — 상한을 넘겼을 때 **최신이 남는다** ───────────────
  out.push(
    assert(
      "★상한 초과 시 최신 이벤트가 남는다(최근 사고 단서를 지우지 않는다)",
      got.pruneKeptNewest === true && got.pruneDroppedOldest === true,
      `최신유지=${String(got.pruneKeptNewest)} 최고령삭제=${String(got.pruneDroppedOldest)} 남은범위=${String(got.pruneRange)}`,
    ),
  );

  // ── ③ 터미널 잡 프루닝 — **running 은 안 지운다** ──────────────────────────
  //  재시작 복구의 유일한 소스라, 지워지면 "중단됐어요" 통지가 영영 안 온다.
  out.push(
    assert(
      "★프루닝이 running 잡을 지우지 않는다(재시작 복구의 유일한 소스)",
      got.pruneKeptRunning === true,
      `running 생존=${String(got.pruneKeptRunning)}`,
    ),
  );

  // ── ④ 내부 스레드 프루닝 — **`scheduler:` 는 지킨다** ──────────────────────
  out.push(
    assert(
      "★프루닝이 scheduler: 스레드를 지키고 worker: 는 정리한다",
      got.pruneThreadsFixtureOk === true &&
        got.pruneKeptScheduler === true &&
        got.pruneDroppedWorker === true,
      `픽스처=${String(got.pruneThreadsFixtureOk)} scheduler유지=${String(got.pruneKeptScheduler)} worker삭제=${String(got.pruneDroppedWorker)} 삭제수=${String(got.pruneThreadsRemoved)}`,
    ),
  );

  // ── ⑤ 백업 실패는 **말한다** ───────────────────────────────────────────────
  //  디스크 문제로 백업이 멎어도 통보 0이면, 7일 뒤 자가점검이 유일한 백스톱이다
  //  (그마저 기존 백업이 있을 때만 작동한다).
  out.push(
    assert(
      "★백업 실패가 error 로 돌아오고 문구가 나간다(조용한 실패 금지)",
      got.backupRan === true && got.backupReportedError === true && got.backupNoticeSpoken === true,
      `ran=${String(got.backupRan)} error=${String(got.backupReportedError)} 문구=${String(got.backupNoticeSpoken)}`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "data-safety",
  guards:
    "되돌릴 수 없는 연산(FTS 마이그레이션·이벤트/잡/스레드 프루닝·백업)을 **실제로 돌려서** 본다 — 종전엔 그 함수를 아무도 부르지 않거나 손으로 만든 픽스처만 봐서, 원문을 덮어쓰거나 최신을 지우거나 running 잡을 날리는 변이가 전부 초록이었다",
  run,
};
