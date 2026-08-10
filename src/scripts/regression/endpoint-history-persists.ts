/**
 * 회귀: **엔드포인트 호출 기록이 새로고침·재시작을 넘어 남는다** (2026-08-01 사용자 신고).
 *
 * 신고: "엔드포인트 기록들이 다 사라졌어". 파 보니 **사라진 게 아니라 애초에 안 남았다**:
 *   ①`endpoint.call` 이 `SKIP_TYPES` 에 있어 **영속 대상이 아니었다.**
 *     사유 주석은 "전문은 transcripts 에 이미 영속" — 사실이지만 **뷰가 transcripts 를
 *     읽지 않는다.** 저장은 되는데 소비처가 없었다.
 *   ②뷰는 브라우저 메모리(`endpointLog`, 캡 60)에 라이브 SSE 로만 쌓았다 → 새로고침 전멸.
 *   ③화면 안내문은 *"전체 기록은 DB 에 영속됩니다"* 라고 **적혀 있었다**(주지 않는 보장).
 *
 * ★고리가 넷이라 하나만 끊겨도 화면은 조용히 빈다: 영속 → 서버 라우트 → 프록시 → 뷰 로드.
 *  실제로 프록시를 빠뜨려 "데이터는 다 있는데 화면은 비어 있는" 상태를 한 번 만들었고,
 *  헤드리스로 보기 전까지 통과처럼 보였다. 그래서 **고리마다** 단언한다.
 *  (프록시 고리는 `dashboard-api-proxy-complete` 가 전 경로에 대해 일반적으로 지킨다.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "endpoint-history-persists",
  guards:
    "엔드포인트 호출 기록이 영속 안 되고 브라우저 메모리에만 쌓여 새로고침·재시작이면 전멸하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 영속 — SKIP 이면 그 뒤 고리가 다 멀쩡해도 남는 게 없다.
    const persist = read("src/core/event-persist.ts");
    const skipBlock =
      /const SKIP_TYPES = new Set<string>\(\[([\s\S]*?)\n\]\)/.exec(persist)?.[1] ?? "";
    out.push(
      assert(
        "SKIP_TYPES 블록을 읽는다(검사 전제)",
        skipBlock.length > 20,
        `${skipBlock.length}자`,
      ),
    );
    // 주석에도 "endpoint.call" 이 나오므로 **실제 항목**(따옴표 + 쉼표)만 본다.
    const skipped = /^\s*"endpoint\.call",\s*$/m.test(skipBlock);
    out.push(
      assert(
        "★endpoint.call 이 영속된다(SKIP 아님) — 아니면 기록이 아예 안 남는다",
        !skipped,
        skipped ? "★SKIP 에 들어감 — 신고 사고 재현" : "영속 확인",
      ),
    );

    // ★② 서버 라우트 — 되읽을 창구가 있는가.
    const bridge = read("plugins/http-bridge/index.ts");
    // ★핸들러 **본문**의 유일한 지점을 본다 — 경로 문자열은 권한(role) 분기에도 있어서
    //  라우트를 통째로 지워도 그쪽에 걸렸다(변이 적발).
    //  ★가드와 본문을 **한 덩어리로** 본다 — 본문만 보면 `if (false)` 로 도달만 막아도
    //   통과하고, 경로 문자열만 보면 권한 분기의 같은 문자열에 걸린다(둘 다 변이로 확인).
    const hasRoute =
      /pathname === "\/endpoint-calls" && method === "GET"\)[\s\S]{0,3000}writeJson\(res, 200, \{ calls,/.test(
        bridge,
      );
    // 2026-08-10: 게이트웨이 호출도 같은 라우트가 준다(한 페이지 + 필터) — 두 타입을 함께 읽는다.
    const readsEvents = /types: \[\s*"endpoint\.call",\s*"gateway\.call"/.test(bridge);
    out.push(
      assert(
        "★bridge 에 /endpoint-calls 조회 라우트가 있고 영속분을 읽는다",
        hasRoute && readsEvents,
        `라우트=${hasRoute} 조회=${readsEvents}`,
      ),
    );
    // 끝을 못 본 호출을 영원히 "진행 중" 으로 두지 않는다(화면판 조용한 실패).
    out.push(
      assert(
        "start 만 있고 오래된 호출은 미완으로 확정한다(영구 '진행 중' 0)",
        // 상수 **이름**이 아니라 값이 실질 한도인지 본다 — 이름만 보면 무한대로 바꿔도 통과.
        (() => {
          const m = /const STALE_MS = (\d+) \* 60_000;/.exec(bridge);
          const min = m !== null ? Number(m[1]) : NaN;
          return Number.isFinite(min) && min > 0 && min <= 60 && /완료 기록 없음/.test(bridge);
        })(),
        `STALE_MS=${/const STALE_MS = ([^;]+);/.exec(bridge)?.[1] ?? "없음"}`,
      ),
    );

    // ★③ 뷰 로드 — 창구가 있어도 안 부르면 화면은 그대로 빈다(이번에 실제로 빠뜨렸다).
    const view = read("packages/dashboard/js/channel-hints.js");
    const loadsOnOpen =
      /const showEndpoints = \(\) => \{[\s\S]{0,200}loadEndpointHistory\(\)/.test(view);
    const fetches = /fetch\("\/api\/endpoint-calls/.test(view);
    out.push(
      assert(
        "★엔드포인트 뷰가 열릴 때 서버 이력을 불러온다",
        loadsOnOpen && fetches,
        `열때호출=${loadsOnOpen} fetch=${fetches}`,
      ),
    );
    // 한 번 실패했다고 영구히 빈 화면이 되면 안 된다(재시도 가능해야).
    out.push(
      assert(
        "이력 로드 실패 시 다음에 다시 시도한다(영구 빈 화면 0)",
        // 주석 처리된 줄에 걸리지 않게 **줄 첫 토큰**이 코드인지 본다(변이 적발).
        /^\s*epHistoryLoaded = false;/m.test(view),
        /^\s*epHistoryLoaded = false;/m.test(view) ? "재시도 확인" : "★한 번 실패로 영구 포기",
      ),
    );

    // ★④ 안내문이 **주는 보장**만 말하는가 — 종전엔 영속하지 않으면서 "DB 에 영속됩니다"
    //  라고 적혀 있었다. 문장이 코드보다 앞서면 그게 오늘 하루의 병이다.
    // 문구는 바뀔 수 있으니 **보장의 알맹이**(영속·재시작 생존)로 본다 — 문장 그대로를
    // 박아두면 표현을 다듬을 때마다 검사가 깨지고, 그러면 검사를 고치는 습관이 든다.
    const claimsPersist = /영속/.test(view) && /읽기 전용/.test(view);
    out.push(
      assert(
        "화면 안내문이 실제 동작과 일치한다",
        claimsPersist && !skipped,
        `안내=${claimsPersist} 실제영속=${!skipped}`,
      ),
    );
    return out;
  },
};
