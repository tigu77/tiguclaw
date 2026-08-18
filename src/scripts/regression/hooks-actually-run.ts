/**
 * 회귀: **훅이 실제로 돈다** — 배선이 아니라 동작 (2026-08-18).
 *
 * 사용자 질문: *"우리 훅도 테스트가 됐나?"* → 답은 **아니오** 였다.
 *
 * 훅 회귀는 `hook-adapter-parity` 하나뿐이었고 셋 다 `readFile` + 정규식이었다:
 * 세 어댑터가 부르는 훅 함수 집합이 같은가 · 턴 훅이 어댑터 밖에 있는가 · 내보낸 훅이
 * 어딘가에서 소비되는가. 전부 **"배선이 있나"** 이지 **"훅이 도는가"** 가 아니다.
 * `runPreToolUseHooks` 를 포함한 다섯 실행 함수 중 **회귀에서 호출되는 것은 0개**였다.
 *
 * 그래서 이런 게 전부 초록으로 통과했다:
 *
 * | 깨져도 안 잡히던 것 | 사용자가 겪는 것 |
 * |---|---|
 * | **exit 2 가 도구를 안 막는다** | 막았다고 믿는데 도구가 돈다. 조용하고 되돌릴 수 없다 |
 * | matcher 가 안 맞아 훅이 한 번도 안 돈다 | 설정은 있는데 아무 일도 안 일어난다 |
 * | `mcp__file-ops__Bash` 가 정규화 안 된다 | 사용자는 `Bash` 라고 적는다 → 우리 도구엔 훅이 **하나도** 안 걸린다 |
 * | 훅이 죽으면(exit 1) 차단으로 오해한다 | 멀쩡한 도구가 막힌다 |
 * | 손자가 파이프를 물면 promise 가 안 풀린다 | **그 턴이 영영 멈춘다**(`/stop` 도 훅 경로엔 안 간다) |
 * | 프로젝트 훅이 홈 훅을 덮는다 | 전역 안전장치가 프로젝트에서 조용히 사라진다 |
 *
 * ★자식 프로세스로 도는 이유 둘: `getPaths()` 가 홈을 동결한다(격리 불가), 그리고 **격리
 *  안 하면 사용자의 진짜 훅이 검사 중에 실행된다** — 훅은 임의 셸 명령이라 그건 사고다.
 *
 * ★훅이 "돌았다"는 판정은 **반환값이 아니라 부작용**(파일 생성)으로 본다. 반환값만 보면
 *  아무것도 안 돈 경우도 통과한다(`block:false` 는 "훅 없음" 과 "훅 통과" 가 같은 값이다).
 *
 * ★제품이 고장나 있었다는 뜻은 아니다 — 22개 프로브가 첫 실행에 전부 초록이었다. 없던 것은
 *  **그물**이지 동작이 아니다. 둘을 같은 말로 하지 않는다.
 */
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_hooks-run-child.ts",
);

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "hooks-run-"));
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
    encoding: "utf8",
    env: { ...process.env, TIGUCLAW_HOME: home },
    timeout: 60_000,
  });
  let got: Record<string, unknown> = {};
  try {
    got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Record<
      string,
      unknown
    >;
  } catch {
    got = {};
  }
  const tail = (r.stderr ?? "").trim().slice(-300);

  out.push(
    assert(
      "훅 프로브가 실제로 돌았다(빈손 통과 금지)",
      Object.keys(got).length >= 20,
      Object.keys(got).length >= 20
        ? `${Object.keys(got).length}개 판정 회수`
        : `★프로브 실패: ${tail}`,
    ),
  );
  if (Object.keys(got).length === 0) return out;

  // ── ① ★차단이 실제로 막는다 — 훅의 존재 이유 ────────────────────────────────
  out.push(
    assert(
      "★exit 2 가 도구를 실제로 막는다(막은 줄 아는데 도구가 도는 일이 없다)",
      got.denyBlocks === true && got.denyReasonFromStderr === true,
      `block=${String(got.denyBlocks)} 사유전달=${String(got.denyReasonFromStderr)}`,
    ),
  );
  out.push(
    assert(
      "차단 사유가 모델이 보는 문장에 실린다(3어댑터 공용 포맷터)",
      got.blockMessageHasReason === true,
      String(got.blockMessageHasReason),
    ),
  );

  // ── ② matcher — 맞는 것만 돈다 ───────────────────────────────────────────────
  out.push(
    assert(
      "★matcher 가 맞으면 돌고 안 맞으면 안 돈다(부작용으로 확인)",
      got.matcherFiredRightTool === true && got.matcherSkippedWrongTool === true,
      `발동=${String(got.matcherFiredRightTool)} 미발동=${String(got.matcherSkippedWrongTool)}`,
    ),
  );
  out.push(
    assert(
      "★MCP 도구 이름이 정규화돼 matcher 에 걸린다(사용자는 `Bash` 라고 적는다)",
      got.normalizesMcpName === true &&
        got.leavesPlainName === true &&
        got.mcpNameMatchesMatcher === true,
      `정규화=${String(got.normalizesMcpName)} 평문보존=${String(got.leavesPlainName)} 실경로매칭=${String(got.mcpNameMatchesMatcher)}`,
    ),
  );

  // ── ③ 실패·행 — 훅이 턴을 죽이지 않는다 ─────────────────────────────────────
  out.push(
    assert(
      "훅이 죽어도(exit 1) 차단이 아니다 — 멀쩡한 도구를 막지 않는다",
      got.failingHookRan === true && got.failingHookDoesNotBlock === true,
      `실행=${String(got.failingHookRan)} 무차단=${String(got.failingHookDoesNotBlock)}`,
    ),
  );
  out.push(
    assert(
      "★손자가 파이프를 물어도 턴이 안 멈춘다(백스톱 — 안 풀리면 그 턴은 영영 멈춘다)",
      got.hangResolved === true && got.hangDoesNotBlock === true,
      `${String(got.hangResolvedMs)}ms 에 풀림 · 무차단=${String(got.hangDoesNotBlock)}`,
    ),
  );

  // ── ④ 다섯 이벤트 전부 **실제로** 돈다 ──────────────────────────────────────
  out.push(
    assert(
      "★다섯 훅 이벤트가 전부 실행된다(Pre·Post·UserPromptSubmit·Stop·SubagentStop)",
      got.matcherFiredRightTool === true &&
        got.postFired === true &&
        got.upsFired === true &&
        got.stopFired === true &&
        got.subagentFired === true,
      `post=${String(got.postFired)} ups=${String(got.upsFired)} stop=${String(got.stopFired)} subagent=${String(got.subagentFired)}`,
    ),
  );
  out.push(
    assert(
      "훅 stdout 이 모델 컨텍스트로 주입된다",
      got.upsInjected === true,
      String(got.upsInjected),
    ),
  );

  // ── ⑤ 없을 때·겹칠 때 ───────────────────────────────────────────────────────
  out.push(
    assert(
      "훅이 0개면 아무것도 막지 않는다(오탐 0)",
      got.noHookNoBlock === true,
      String(got.noHookNoBlock),
    ),
  );
  out.push(
    assert(
      "★프로젝트 훅은 홈 훅에 **더해진다**(덮지 않는다 — 전역 안전장치가 사라지면 안 된다)",
      got.projectHookFired === true && got.homeHookStillFires === true,
      `프로젝트=${String(got.projectHookFired)} 홈=${String(got.homeHookStillFires)}`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "hooks-actually-run",
  guards:
    "훅이 '배선은 있는데 안 도는' 상태 — 종전 훅 회귀는 소스 grep 셋뿐이라 다섯 실행 함수 중 회귀가 부르는 건 0개였다. exit 2 가 도구를 안 막아도, MCP 이름이 정규화 안 돼 훅이 하나도 안 걸려도, 손자가 파이프를 물어 턴이 영영 멈춰도 전부 초록이었다",
  run,
};
