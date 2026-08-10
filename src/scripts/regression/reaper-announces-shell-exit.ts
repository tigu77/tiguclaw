/**
 * 회귀: 셸 상태를 바꾸는 자리는 **그 사실을 말하는 자리**이기도 하다.
 *
 * 사고 (2026-08-10, 사용자): "셸/프로세스가 꺼졌는데 대시보드에서 바로 갱신이 안 되는
 *  상황이 많아. 계속 뭐가 돌고 있나 했더니 새로고침하면 없어졌어."
 *
 *  뿌리: `shell.exited` 는 `child.on("close")` 에서만 발행됐다. 그건 **데몬이 그 자식을
 *  들고 있을 때만** 온다. 데몬이 재시작하면 연결이 끊겨 영영 안 오고, 부팅 리퍼
 *  (`reapPreviousGeneration`)는 DB 행만 `stale`/`killed` 로 고치고 **아무에게도 안
 *  알렸다.** 그래서 열려 있던 화면은 죽은 셸을 계속 "실행 중" 으로 그렸고, 새로고침해
 *  서버에서 다시 읽어야 사라졌다. 실측: `shell.started` 116건 vs `shell.exited` 106건.
 *
 * ★이 레포가 세 번째 겪는 부류다 — `llm.tool_slow`·`llm.compaction_stuck` 은 "발행은
 *  했는데 소비처가 없음" 이었고, 이번엔 반대로 **소비처는 있는데 발행이 없었다.**
 *
 * ★등급: **배선 린트**(소스 대조). 리퍼를 실제로 돌리려면 이전 세대 프로세스가 필요해
 *  동작 검사가 안 된다. 잡는 건 "상태 전이 옆에 발행이 있는가" — 실제 재발 형상이다.
 */
import { readFile } from "node:fs/promises";
import type { Assertion, RegressionCheck } from "./_framework.js";

const SRC = new URL(
  "../../core/llm-runtime/capabilities/file-ops-mcp.ts",
  import.meta.url,
);

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const src = await readFile(SRC, "utf8");

  const i = src.indexOf("export const reapPreviousGeneration");
  const reaper = i < 0 ? "" : src.slice(i, i + 2600);

  // ── ① 두 전이 **모두** 알린다 ─────────────────────────────────────────────
  //  killed(고아 정리)만 알리고 stale(프로세스 부재)을 빼면, 가장 흔한 경우가 조용해진다.
  for (const [what, marker] of [
    ["killed(고아 killTree)", 'markBgShellStatusDb(row.bashId, "killed"'],
    ["stale(프로세스 부재·신원 불일치)", 'markBgShellStatusDb(row.bashId, "stale"'],
  ] as const) {
    const at = reaper.indexOf(marker);
    // 그 전이 뒤 400자 안에 발행이 있어야 한다(같은 분기 안).
    const near = at < 0 ? "" : reaper.slice(at, at + 400);
    out.push({
      name: `★${what} 전이 뒤에 발행이 있다`,
      ok: at >= 0 && near.includes("announceReaped"),
      got:
        at < 0
          ? "★전이 자체를 못 찾음(리팩터링?)"
          : near.includes("announceReaped")
            ? "발행 확인"
            : "★DB 만 고치고 조용히 넘어감",
    });
  }

  // ── ② 페이로드가 자연 종료와 **같은 모양**이다 ─────────────────────────────
  //  소비처(view-shells.js handleShellExited)가 분기 없이 처리하려면 키가 같아야 한다.
  {
    const j = src.indexOf("const announceReaped");
    const body = j < 0 ? "" : src.slice(j, j + 900);
    const keys = ["shellId", "command", "cwd", "status", "exitCode", "startedAt"];
    const missing = keys.filter((k) => !body.includes(`${k}:`));
    out.push({
      name: "발행 페이로드가 자연 종료 경로와 같은 키를 쓴다",
      ok: missing.length === 0 && body.includes('publishShellEventSafe("shell.exited"'),
      got:
        missing.length === 0
          ? "키 6종 일치"
          : `누락: ${missing.join(", ")}`,
    });
  }

  // ── ③ 소비처가 그대로 존재한다(발행만 하고 그리는 곳이 없으면 무의미) ──────
  {
    const view = await readFile(
      new URL("../../../packages/dashboard/js/view-shells.js", import.meta.url),
      "utf8",
    );
    out.push({
      name: "대시보드가 shell.exited 를 소비한다(양방향 대조)",
      ok: view.includes('type === "shell.exited"') && view.includes("handleShellExited"),
      got: view.includes("handleShellExited") ? "소비처 있음" : "★소비처 없음",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "reaper-announces-shell-exit",
  guards:
    "데몬 재시작으로 child.on(close)가 영영 안 와, 부팅 리퍼가 DB 만 고치고 화면엔 안 알려 죽은 셸이 '실행 중' 으로 남던 것(새로고침해야 사라졌다)",
  run,
};
