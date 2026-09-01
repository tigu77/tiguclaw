/**
 * 회귀: **매니저 턴이 스트림 중간에 죽어도 그때까지 쓴 보고가 답장에 실린다** (2026-09-01).
 *
 * ★라이브 사고: `worker:999d3987` 이 iter=15 에서 `TypeError: terminated` 로 죽었고 로그는
 *  `shown=0자` — 직전 트레이스는 `total=3859`. 모델이 쓰던 마무리 보고가 통째로 사라지고
 *  사용자에겐 일반 오류 문구만 갔다. 일은 이미 끝나 있었는데 **무엇을 했는지가 안 보였다.**
 *
 * ★원인은 특정 오류가 아니다 — 삼킴 경로가 «이미 흘러간 텍스트» 를 꺼내는 `closeTextSegment()`
 *  가 `deltaStream` 을 읽는데, 그건 `depth===0 && workerDepth===0` 에서만 켜진다. 즉
 *  2026-08-08 에 «잘린 문장만 남는다» 를 고친 그 수정이 **매니저에는 적용된 적이 없었고**,
 *  스트림 중간에 죽는 **모든** 실패가 같은 손실을 냈다.
 *
 * ★**등급: 동작.** 처음엔 소스 린트로 뒀는데, 린트는 «폴백이 적혀 있다» 만 본다. 여기서는
 *  가짜 백엔드로 실제 어댑터를 돌려 **답장에 그 글자가 있는지**를 본다 — 자식 프로세스에서
 *  `globalThis.fetch` 를 스텁하므로 스위트 전역이 안 더러워진다.
 *
 * ★자식이 `workerDepth: 1` 로 도는 것이 **이 검사의 핵심 조건**이다. 0 이면 `deltaStream` 이
 *  켜져 옛 경로로도 통과하므로 아무것도 안 잰다.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeInterpreter } from "./_probe-helpers.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "partial-report-survives-cut",
  guards:
    "매니저 턴이 스트림 중간에 끊기면 그때까지 쓴 보고가 통째로 사라지고 일반 오류 문구만 가던 것(실측 3,859자 유실) — deltaStream 이 매니저에서 꺼져 있어 «이미 흘러간 텍스트» 를 꺼낼 데가 없었다",
  run: async (): Promise<Assertion[]> => {
    const r = spawnSync(
      probeInterpreter(REPO),
      [path.join(REPO, "src/scripts/regression/_codex-partial-report-child.ts")],
      { cwd: REPO, env: { ...process.env }, encoding: "utf8", timeout: 120_000 },
    );
    const line = `${r.stdout ?? ""}`
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    if (line === undefined) {
      return [
        assert(
          "★프로브가 실제로 돌았다(0이면 아래는 미검사다)",
          false,
          `★실패 — ${`${r.stderr ?? ""}`.slice(-300)}`,
        ),
      ];
    }
    const j = JSON.parse(line) as {
      outcome: string;
      text: string;
      hasPartial: boolean;
      hasNotice: boolean;
    };

    return [
      assert(
        "★★끊기기 전까지 쓴 보고가 **답장에 남는다** — 없으면 사용자는 무슨 일이 있었는지 알 방법이 0이다(일은 이미 끝나 있었다)",
        j.outcome === "returned" && j.hasPartial,
        `결과=${j.outcome} · 부분보고=${j.hasPartial} · 앞머리="${j.text.slice(0, 30)}…"`,
      ),
      assert(
        "★그러면서 **끊겼다는 사실도 말한다** — 부분 보고만 남기면 정상 종료와 구분이 안 된다(그게 2026-08-08 의 원래 사고다)",
        j.hasNotice,
        j.hasNotice ? "안내 문구 포함" : "★안내가 없다 — 잘린 줄 모른다",
      ),
      assert(
        "★순서가 **보고 → 안내** 다 — 안내가 앞이면 사용자는 실패로 읽고 본문을 안 본다",
        j.text.indexOf("부분보고-표식") < j.text.indexOf("오류가 발생했습니다"),
        `보고 위치=${j.text.indexOf("부분보고-표식")} · 안내 위치=${j.text.indexOf("오류가 발생했습니다")}`,
      ),
    ];
  },
};
