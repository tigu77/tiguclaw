/**
 * 회귀: **프런트가 부르는 `/api/*` 가 전부 프록시에 있다** (2026-08-01, 같은 날 세 번째).
 *
 * 대시보드는 화이트리스트 방식이다 — 브라우저 JS 가 `fetch("/api/X")` 를 하면
 * `packages/dashboard/index.ts` 에 `pathname === "/api/X"` 분기가 **손으로** 있어야 bridge 로
 * 프록시된다. 없으면 **404 인데 조용하다**: `catch` 가 삼키거나 빈 화면으로 보일 뿐이다.
 *
 * 실사고: 엔드포인트 호출 이력을 되살리며 `/api/endpoint-calls` 를 프런트에 붙였는데
 * 프록시 분기를 빠뜨렸다. 서버 라우트도 있고 데이터도 있는데 화면은 "아직 호출이 없습니다"
 * 였다. 헤드리스로 보기 전까지 통과처럼 보였다.
 *
 * ★같은 날 같은 구조를 두 번 더 봤다 — `js/_manifest.json`(서빙 화이트리스트)이 index.html
 *  태그와 양방향으로 어긋났고, 브랜드 아이콘은 라우트 자체가 없었다. **손으로 관리하는
 *  목록**이 셋 다 원인이다. 그래서 목록을 없앨 수 없다면 **판정으로 묶는다**.
 *
 * 판정: 프런트 `js/*.js` 에서 `/api/...` 리터럴을 뽑아, 프록시 소스에 그 경로 분기가
 * 있는지 본다. 새 API 를 붙이면 저절로 대상이 된다(이름 열거 0).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASH = path.join(REPO, "packages/dashboard");

export const check: RegressionCheck = {
  name: "dashboard-api-proxy-complete",
  guards:
    "프런트가 부르는 /api 경로에 프록시 분기가 없어 404 인데 화면이 조용히 비던 것(엔드포인트 이력)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const proxy = readFileSync(path.join(DASH, "index.ts"), "utf8");

    // 프런트가 실제로 부르는 경로를 **뽑는다**(손으로 적지 않는다).
    const called = new Set<string>();
    for (const f of readdirSync(path.join(DASH, "js")).filter((n) => n.endsWith(".js"))) {
      // ★**주석은 빼고 본다** (2026-08-28). 형제 검사(`dashboard-view-restore`)가 이미
      //  적어둔 규칙인데 여기만 없었다 — *"결함을 설명한 글을 코드로 세면 상시 실패한다."*
      //  실제로 걸렸다: 홈 위젯 주석에 예시로 적은 `/api/plugin-data/weather/forecast` 를
      //  **호출로 세서** 프록시 누락이라고 보고했다(그 경로는 프리픽스 배선으로 이미 있다).
      //  검사 대상은 코드이지 그걸 설명하는 글이 아니다([[feedback_gate_must_actually_run]]).
      const src = readFileSync(path.join(DASH, "js", f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      // ★**다중 세그먼트를 본다** (2026-08-17, 전체검토 C-4). 종전엔 `[a-z0-9-]+` 라
      //  한 세그먼트만 잡아 `/api/projects/detail` 이 `/api/projects` 로 **축약**됐고,
      //  그건 프록시에 있으니 초록이었다 — 사각지대에 `/api/projects/detail`,
      //  `/api/projects/capability`, `/api/attachments/...` 셋이 들어 있었다.
      //  (템플릿 보간 `${…}` 이 오면 그 앞까지만 잡힌다 — 접두 매칭 쪽에서 커버된다.)
      //  ★끝 슬래시는 떼고 모은다 — `"/api/attachments/" + a.rel` 처럼 **이어붙이는** 호출은
      //   슬래시로 끝나는데, 배선 판정이 `startsWith("<경로>/")` 라 그대로 두면 `//` 가 되어
      //   있는 배선을 못 맞춘다(이 정규식을 넓히자마자 그 오탐이 나왔다).
      for (const m of src.matchAll(/["'`](\/api\/[a-z0-9\-/]+)/gi)) {
        called.add((m[1] ?? "").replace(/\/+$/, ""));
      }
    }
    out.push(
      assert(
        "프런트에서 /api 호출 경로를 뽑는다(검사 전제 — 0이면 공짜 통과)",
        called.size >= 8,
        `${called.size}개`,
      ),
    );
    if (called.size === 0) return out;

    // ★두 배선 형태를 다 인정한다 — 고정 경로(`pathname === "/api/x"`)와 **동적 경로**
    //  (`pathname.startsWith("/api/x/")`, 예: 첨부 파일). 정확일치만 보면 후자가 오탐이 된다
    //  (첫 실행에서 실제로 `/api/attachments` 를 잘못 잡았다).
    const isWired = (p: string): boolean =>
      new RegExp(`pathname === "${p}"`).test(proxy) ||
      new RegExp(`pathname\\.startsWith\\("${p}/"\\)`).test(proxy);
    const missing = [...called].filter((p) => !isWired(p));
    out.push(
      assert(
        `★프런트가 부르는 ${called.size}개 경로가 전부 프록시에 있다(조용한 404 = 0)`,
        missing.length === 0,
        missing.length === 0
          ? `${called.size}개 전부 분기 존재`
          : `★프록시 누락 ${missing.length}건: ${missing.join(", ")}`,
      ),
    );

    // ★**쿼리를 달고 부르는 경로는 프록시가 쿼리를 흘려야 한다** (2026-09-04 3R P-2).
    //  경로가 있어도 쿼리를 버리면 **다른 응답이 온다** — `?jobId=` 단건 요청이 조용히
    //  목록으로 떨어져 «원문이 사라졌습니다» 가 됐고, 서버는 멀쩡하니 로그에도 안 남는다.
    //  이 검사의 계약(*"화면이 부르는 것을 서버가 낸다"*)에서 **부르는 것**은 경로만이
    //  아니라 **경로+쿼리**다. 이름을 열거하지 않는다 — 프런트에 `?` 가 붙어 있으면 대상이다.
    const withQuery = new Set<string>();
    for (const f of readdirSync(path.join(DASH, "js")).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(path.join(DASH, "js", f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const m of src.matchAll(/["'`](\/api\/[a-z0-9\-/]+)\?/gi)) {
        withQuery.add(m[1] ?? "");
      }
    }
    /**
     * 그 경로의 프록시 분기 본문 — `pathname === "…"` 부터 **다음** 분기 직전까지.
     * ★다음 분기를 찾는 시작점은 **이 매치의 끝**이다. 첫 판은 `at + 10` 이었는데 그건
     *  아직 매치 안(`pathname === "` 만 14자)이라 자기 자신을 다시 찾았다 → 본문이 늘
     *  빈 문자열 → **아무것도 못 보고 초록**. 게이트를 만들면서 이 파일이 경고하는 바로
     *  그 병을 냈다([[feedback_gate_must_actually_run]]).
     */
    // ★**주석을 걷고 본다.** 이 분기의 주석이 *"바로 아래 `/endpoint-calls${url.search}` 를
    //  포함해 10곳이 통째로 넘긴다"* 라고 적고 있어서, 코드에서 `url.search` 를 떼어내도
    //  **설명하는 글**이 단언을 통과시켰다. 이 파일이 위에서 이미 프런트 쪽에 대해 같은
    //  규칙을 적어놨는데 프록시 쪽엔 안 적용하고 있었다 — 옆을 안 본 것이 또 하나.
    const proxyCode = proxy
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const branchOf = (p: string): string | undefined => {
      const head = `pathname === "${p}"`;
      const at = proxyCode.indexOf(head);
      if (at < 0) return undefined;
      const next = proxyCode.indexOf('pathname === "/api/', at + head.length);
      return proxyCode.slice(at, next < 0 ? proxyCode.length : next);
    };
    // ★분기를 못 찾으면 «통과» 가 아니라 **판정 불가**다 — 조용히 빠지면 이 검사가 다시
    //  공허해진다. 그런 경로도 목록에 실어 사람이 보게 한다.
    const dropped = [...withQuery].filter((p) => {
      const b = branchOf(p);
      return b === undefined || !/url\.search|searchParams/.test(b);
    });
    out.push(
      assert(
        `★쿼리를 달고 부르는 ${withQuery.size}개 경로가 프록시에서 쿼리를 잃지 않는다`,
        withQuery.size > 0 && dropped.length === 0,
        withQuery.size === 0
          ? "★쿼리 호출을 하나도 못 뽑았다(검사가 공허하다)"
          : dropped.length === 0
            ? `${withQuery.size}개 전부 전달: ${[...withQuery].join(", ")}`
            : `★쿼리를 버린다 ${dropped.length}건: ${dropped.join(", ")}`,
      ),
    );

    // 반대 방향 — 프록시에만 있고 아무도 안 부르는 경로는 **죽은 코드**다. 치명적이지 않아
    //  경고 대신 세어만 두면 다음 사람이 "이건 뭐지"에 시간을 쓴다. 목록으로 남긴다.
    const proxied = new Set([
      ...[...proxy.matchAll(/pathname === "(\/api\/[a-z0-9\-/]+)"/gi)].map((m) => m[1]),
      ...[...proxy.matchAll(/pathname\.startsWith\("(\/api\/[a-z0-9\-/]+)\//gi)].map((m) => m[1]),
    ]);
    const unused = [...proxied].filter((p) => !called.has(p));
    out.push(
      assert(
        "프록시에만 있고 프런트가 안 부르는 경로를 드러낸다(죽은 배선 가시화)",
        true, // 판정이 아니라 관측 — 실패시키지 않는다(SSE·수동 호출 등 정당한 경우가 있다).
        unused.length === 0 ? "미사용 0" : `미사용 ${unused.length}건: ${unused.join(", ")}`,
      ),
    );
    return out;
  },
};
