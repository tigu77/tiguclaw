/**
 * 회귀: **Glob/Grep 은 턴·요청 취소를 받으면 실행 중인 rg 를 끝내고 «취소» 로 답한다** (2026-10-29).
 *
 * 공백(인계 `docs/handoffs/inbox/2026-10-29-search-cancellation-and-verification-env-review.md` §1): 세 어댑터가 file-ops 에 턴 신호를
 *  넘기는데 `rgCollect` 가 signal 없이 rg 를 띄우고 Glob/Grep 이 신호를 안 들어, 취소돼도 rg 가 끝까지 돌 수 있었다. 미리 취소된 호출도
 *  rg 를 띄웠다. ★이 검사는 그 취소 경로를 지킨다 — 특정 장시간 검색의 직접 원인을 재현한 것이 아니다.
 * 위험: 취소를 빈 검색 성공(`[]`)·부분 결과로 포장하면 모델이 «없다» 로 읽는다. 일반 성공·매칭 0·출력 상한은 그대로여야 한다.
 *
 * 등급: **동작** — 하위 임시 홈의 가짜 rg(직접 자식 확인)를 실제 도구·브리지로 돌린다. 모델 호출 0 · 실제 rg 0. POSIX 전용.
 * 설계: `docs/decisions/2026-10-29-search-tool-cancellation.md`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

const isCancel = (t: unknown): boolean => typeof t === "string" && t.startsWith("Error:") && t.includes("검색이 취소되었습니다");

export const check: RegressionCheck = {
  name: "search-tool-cancellation",
  guards: "Glob/Grep 이 턴·요청 취소를 받아도 rg 를 끝까지 돌리고, 미리 취소된 호출도 rg 를 띄우던 것 — 취소를 빈 결과로 포장하지 않기",
  run: async (): Promise<Assertion[]> => {
    if (process.platform === "win32") {
      return [assert("win32 — 가짜 rg 가 sh 스크립트라 건너뜀(Windows 취소는 미검증)", true, "skip")];
    }
    assertIsolated();
    const r = await spawnWithin(90_000, "search-cancel", ["--import", "tsx", path.join(HERE, "_search-cancel-child.ts")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (r.timedOut || line === undefined) {
      return [assert("자식이 결과를 냈다", false, r.timedOut ? "timeout" : r.err.slice(-800))];
    }
    const d = JSON.parse(line) as R;
    const out: Assertion[] = [];
    out.push(assert("가짜 rg 가 관리 경로로 선택됐다(운영 rg 미실행) · 자식 오류 없음", d.resolved === true && d.error === undefined, { resolved: d.resolved, error: d.error }));
    if (d.error !== undefined) return out;

    for (const [k, m] of Object.entries(d.mid as R)) {
      out.push(
        assert(
          `★실행 중 취소(${k}) — 시한 안에 반환 · «취소» 오류 · 부분 결과 없음 · 직접 자식 rg 종료`,
          m.started === true && m.returned === true && m.ms < 3_000 && isCancel(m.text) && !String(m.text).includes("PARTIAL_MARK") && m.directChild === true && m.dead === true,
          m,
        ),
      );
    }
    out.push(assert("rg 실행 감시가 실제로 센다(양성 대조: 취소 없는 호출 = 1회)", d.launchCounterWorks === true, d.launchCounterWorks));
    out.push(assert("★시작 전 취소(Grep·팩토리) — rg 를 띄우지 않고 «취소» 오류", d.pre.grep.launched === 0 && d.pre.grep.ran === 0 && isCancel(d.pre.grep.text), d.pre.grep));
    out.push(assert("★시작 전 취소(Glob·요청) — rg 를 띄우지 않고 «취소» 오류", d.pre.glob.launched === 0 && d.pre.glob.ran === 0 && isCancel(d.pre.glob.text), d.pre.glob));
    out.push(
      assert(
        "★rg 정상 종료 뒤 mtime 조회 중 취소(Glob) — 결과를 버리고 «취소» 오류",
        d.globDuringStat.ran === 1 && d.globDuringStat.aborted === true && isCancel(d.globDuringStat.text),
        d.globDuringStat,
      ),
    );
    out.push(
      assert(
        "★rg 정상 결과 직후·반환 전 취소(Grep) — 결과를 버리고 «취소» 오류",
        d.grepAfterResult.ran === 1 && d.grepAfterResult.aborted === true && isCancel(d.grepAfterResult.text),
        d.grepAfterResult,
      ),
    );

    const k = d.keep as R;
    let grepLines: unknown;
    let globLines: unknown;
    try {
      grepLines = JSON.parse(k.grepLines);
      globLines = JSON.parse(k.globLines);
    } catch {
      /* 아래 단언이 원문을 보여준다 */
    }
    out.push(assert("보존 — Grep 일반 성공(살아 있는 신호)", JSON.stringify(grepLines) === JSON.stringify(["/fake/a.txt:1:hit", "/fake/b.txt:2:hit"]), k.grepLines));
    out.push(
      assert(
        "보존 — Glob 일반 성공(살아 있는 신호)",
        Array.isArray(globLines) && globLines.length === 2 && globLines.includes(d.expect.one) && globLines.includes(d.expect.two),
        k.globLines,
      ),
    );
    out.push(assert("보존 — 신호 없는 서버의 Grep 일반 성공", k.grepNoSignal === k.grepLines, k.grepNoSignal));
    out.push(assert("보존 — 매칭 0(exit 1)은 빈 결과 성공(Grep·Glob)", k.grepNomatch === "[]" && k.globNomatch === "[]", { grep: k.grepNomatch, glob: k.globNomatch }));
    out.push(
      assert(
        "보존 — 출력 상한은 받은 데까지 + truncated(Grep·Glob)",
        k.grepFlood?.truncated === true && k.grepFlood.n > 0 && k.globFlood?.truncated === true && k.globFlood.n > 0,
        { grep: k.grepFlood, glob: k.globFlood },
      ),
    );
    out.push(assert("검사가 띄운 가짜 rg 가 남지 않았다(회수 0)", d.reaped === 0, d.reaped));
    return out;
  },
};
