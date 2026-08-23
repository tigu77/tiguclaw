/**
 * 회귀: **플러그인이 실제로 로드된다** (2026-08-23).
 *
 * ★타입 OK ≠ 로드 OK. 2026-08-22 에 `typecheck` 범위를 넓혀 `plugins/` 의 타입 오류는
 *  잡게 됐지만, 데몬은 플러그인을 **tsx 로 런타임 로드**한다 — import 실패나 모듈 스코프
 *  초기화 throw 는 타입체크를 통과하고 **부팅 시에야** "플러그인 로드 실패" 로 죽는다.
 *  데몬은 살아 있고 그 플러그인만 빠지므로, 표는 로그에 `loaded ... plugin:` 라인이
 *  *없는 것*으로만 남는다(에러가 눈에 안 띈다).
 *
 *  실사고 (v0.3.1, 2026-07-01): add_schedule 설명 문자열 파싱이 깨져 scheduler 플러그인이
 *  로드 실패 → **cron·reboot 전부 미발화**(아침뉴스·보안감사·재시작알림). typecheck 통과·
 *  릴리스까지 됨.
 *
 * ★왜 여기로 옮기나: `verify:plugins` 스크립트는 **있었다**. 그런데 `sync-public` 릴리스
 *  게이트에서만 돌아서, 릴리스를 안 하는 동안엔 아무도 안 불렀다. 같은 날 `typecheck` 에서
 *  똑같은 것을 배웠다 — 07-18 부터 있던 `typecheck:plugins` 가 호출부 0이라 컴파일 안 되는
 *  코드가 하루를 살아남았다. **게이트는 '있다' 가 아니라 '도는가'**
 *  ([[feedback_gate_must_actually_run]]). 그래서 매번 도는 자리로 옮긴다.
 *
 * 판정은 스크립트와 **같은 근거**를 쓴다: 로더(`core/plugins/loader.ts`)가 읽는
 * `package.json` 의 `tiguclaw.entry`/`mcp`. 파일명을 추측하지 않는다 — 2026-08-17 에
 * 이름을 손으로 열거해서 4개 플러그인을 한 번도 안 보면서 "전부 OK" 라고 말한 적이 있다.
 *
 * 등급: **동작 검사**(자식 프로세스 1회 — dynamic import 로 파싱+모듈 평가 강제).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(REPO, "src", "scripts", "verify-plugins-load.ts");

export const check: RegressionCheck = {
  name: "plugins-actually-load",
  guards:
    "플러그인의 구문·import·모듈 초기화 실패가 타입체크를 통과해 배포되고 부팅 때만 조용히 죽던 것(v0.3.1 scheduler → cron 전부 미발화) + 그걸 잡는 verify:plugins 가 릴리스 때만 돌아 평소엔 아무도 안 부르던 것",
  run: async (): Promise<Assertion[]> => {
    if (!existsSync(SCRIPT)) {
      return [
        assert(
          "verify 스크립트 부재 시 통과(배포본 — 스크럽됨, 오탐 0)",
          true,
          "★확인 못 함 — '이상 없음' 아님",
        ),
      ];
    }
    const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 180_000,
    });
    const outText = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // 빈손 통과 금지 — 스크립트가 플러그인을 **하나도 안 봤는데** exit 0 이면 그건 초록이
    // 아니라 미검사다(2026-08-17 에 실제로 그런 상태였다).
    const loaded = (outText.match(/🟢|OK/g) ?? []).length;
    const failed = r.status !== 0;
    const firstErr = outText
      .split("\n")
      .filter((l) => l.includes("🔴") || /실패|Error/.test(l))
      .slice(0, 2)
      .join(" / ");
    return [
      assert(
        "플러그인 로드 프로브가 실제로 돌았다(빈손 통과 금지)",
        loaded > 0 || failed,
        loaded > 0 ? `${loaded}건 확인` : `★출력 없음: ${outText.slice(-160)}`,
      ),
      assert(
        "★모든 플러그인 엔트리포인트가 import 된다(부팅 때만 드러나는 로드 실패 0)",
        !failed,
        failed ? `★${firstErr || outText.slice(-200)}` : "전부 로드",
      ),
    ];
  },
};
