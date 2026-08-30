/**
 * 회귀: **직렬화를 우회하는 턴도 「진행 중」으로 센다** (2026-08-01 실사고 2건째).
 *
 * 사고: 엔드포인트 호출이 4,610자를 만들던 중에 배포 재시작이 그것을 죽였다. 로그는
 *   `shutting down (진행 중 턴 0건)`
 * 이라고 찍혔다 — **정직하게 거짓**이었다. 엔드포인트는 동시 호출 race 를 없애려고
 * 직렬화 핸들러를 의도적으로 우회하는데(설계는 맞다), 거기 매달려 있던 **in-flight 등록도
 * 같이 건너뛰었다.** 그래서 `/health` 의 `active_turns` 가 0 이었고, 그걸 믿고 재시작했다.
 *
 * ★A5(같은 날 오전)가 메인 턴에 대해 고친 것과 **같은 결함이 경로 하나에 남아 있었다.**
 *  "조건을 바꿨으면 그 조건에 도달하는 입력 전수를 봐라" 를 그때 채널 메시지까지만 보고
 *  엔드포인트·게이트웨이 경로를 안 봤다.
 *
 * ★두 번째 결함: 그 호출은 DB 에 **흔적이 0** 이었다. 이벤트가 경계(iteration close·
 *  turn_done)에서만 발행되는데 4,610자를 한 iteration 안에서 흘리던 중이라 아직 아무
 *  경계도 못 지났다. 실패했는데 *아무것도* 안 보이는 형상 — 사후 진단이 불가능했다.
 *  그래서 종료 시 `llm.turn_error` 를 남긴다(통지는 채널이 있어야 닿지만 기록은 항상 남는다).
 */
import { readFileSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

export const check: RegressionCheck = {
  name: "inflight-covers-all-paths",
  guards:
    "엔드포인트가 직렬화를 우회하며 in-flight 등록까지 건너뛰어 재시작이 '진행 중 0건'이라 거짓말하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const {
      registerExternalTurn,
      unregisterExternalTurn,
      listExternalTurns,
      setInflightTurnReporter,
      getInflightTurns,
    } = await import("../../core/inflight-turns.js");

    // ★① 동작 — 등록하면 보이고, 해제하면 사라진다.
    const before = listExternalTurns().length;
    const t = { ac: new AbortController(), channel: "http-bridge", target: null };
    registerExternalTurn("endpoint:probe:xyz", t);
    const during = listExternalTurns();
    out.push(
      assert(
        "★직렬화 밖 턴을 등록하면 목록에 잡힌다",
        during.length === before + 1 && during.some(([k]) => k === "endpoint:probe:xyz"),
        `${before} → ${during.length} · 키=${during.map(([k]) => k).join(",")}`,
      ),
    );

    // ★② 리포터가 **합쳐서** 답한다 — 둘 중 하나만 세면 그게 이번 사고다.
    const serialized = new Map<string, typeof t>([["dashboard:default", t]]);
    setInflightTurnReporter({
      count: () => serialized.size + listExternalTurns().length,
      keys: () => [...serialized.keys(), ...listExternalTurns().map(([k]) => k)],
    });
    const merged = getInflightTurns();
    out.push(
      assert(
        "★/health 가 직렬화 턴 + 우회 턴을 합쳐서 답한다",
        merged?.count === 2 &&
          merged.keys.includes("dashboard:default") &&
          merged.keys.includes("endpoint:probe:xyz"),
        `count=${String(merged?.count)} keys=${merged?.keys.join(",") ?? "-"}`,
      ),
    );

    unregisterExternalTurn("endpoint:probe:xyz");
    const after = getInflightTurns();
    out.push(
      assert(
        "해제하면 다시 빠진다(누수 0 — 남으면 영원히 '진행 중'이라 재시작을 못 한다)",
        listExternalTurns().length === before && after?.count === 1,
        `잔존 ${listExternalTurns().length} · count=${String(after?.count)}`,
      ),
    );
    setInflightTurnReporter(null); // ★전역 복원 — 안 하면 다음 검사의 "미등록" 전제를 깬다.

    // ★③-0 배선 — **index.ts 의 리포터가 실제로 합치는가.** 위 ②는 검사가 만든 리포터를
    //  보므로 프로덕션 배선이 빠져도 통과한다(변이에서 실제로 빠져나갔다). 심을 검사한 것과
    //  그 심이 꽂혀 있는 것은 다른 사실이다.
    const idxSrc = read("src/index.ts");
    // ★`count:` 줄이 합치는지를 본다 — 범위로 뭉뚱그리면 `keys:` 줄에만 남아 있어도 통과한다
    //  (변이에서 실제로 빠져나갔다: count 만 망가뜨렸는데 keys 의 언급에 걸렸다).
    const reporterMerges = /count: \(\) => inflightTurns\.size \+ listExternalTurns\(\)/.test(
      idxSrc,
    );
    out.push(
      assert(
        "★index.ts 리포터가 직렬화 밖 턴을 합쳐서 센다(프로덕션 배선)",
        reporterMerges,
        reporterMerges ? "합산 확인" : "★리포터가 inflightTurns 만 센다 — 이번 사고 그대로",
      ),
    );

    // ★③ 배선 — 엔드포인트 경로가 **실제로** 등록·해제하는가. 위 ①②는 심(shim)만 본다.
    const bridge = read("plugins/http-bridge");
    // ★앞 경계를 잡는다 — `unregisterExternalTurn(...)` 안에 `registerExternalTurn(...)` 이
    //  **부분 문자열로 들어 있어서**, 등록을 통째로 지워도 해제 줄에 걸려 통과했다(변이 적발).
    const wired =
      /[^a-zA-Z]registerExternalTurn\(epMsg\.threadKey/.test(bridge) &&
      /unregisterExternalTurn\(epMsg\.threadKey/.test(bridge);
    out.push(
      assert(
        "★엔드포인트 호출이 진행 중 등록·해제를 한다",
        wired,
        wired ? "등록·해제 확인" : "★배선 없음 — 재시작이 다시 거짓말한다",
      ),
    );
    // 해제는 **성공·실패 공통 경로**에 있어야 한다(성공 때만 풀면 실패가 영원히 진행 중).
    out.push(
      assert(
        "해제가 성공·실패 공통 경로(publishEndpointDone)에 있다",
        /const publishEndpointDone = [\s\S]{0,120}unregisterExternalTurn/.test(bridge),
        /const publishEndpointDone = [\s\S]{0,120}unregisterExternalTurn/.test(bridge)
          ? "공통 경로 확인"
          : "★성공 경로에만 있음",
      ),
    );

    // ★④ 종료 시 **기록**이 남는가 — 통지는 채널이 있어야 닿지만 기록은 항상 남아야 한다.
    //  (이 호출은 이미 죽은 HTTP 연결이라 통지가 닿을 곳이 없다. 기록이 유일한 단서다.)
    const idx = idxSrc;
    out.push(
      assert(
        "★재시작으로 죽인 턴을 llm.turn_error 로 기록한다(사후 진단 가능)",
        /type: "llm\.turn_error"[\s\S]{0,300}daemon-restart/.test(idx),
        /type: "llm\.turn_error"/.test(idx) ? "기록 확인" : "★기록 없음 — 흔적 0으로 사라진다",
      ),
    );
    // 그 타입이 영속 대상인가 — SKIP 되면 기록해도 DB 에 안 남는다(endpoint.call 이 그랬다).
    const persist = read("src/core/event-persist.ts");
    const skipBlock = /const SKIP_TYPES = new Set<string>\(\[([\s\S]*?)\]\)/.exec(persist)?.[1] ?? "";
    out.push(
      assert(
        "★llm.turn_error 가 영속 대상이다(SKIP 이면 기록해도 안 남는다)",
        !skipBlock.includes("llm.turn_error"),
        skipBlock.includes("llm.turn_error") ? "★SKIP 에 들어감" : "영속 확인",
      ),
    );
    return out;
  },
};
