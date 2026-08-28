/**
 * 회귀: **계약의 화면 쪽** — 서버와 같은 판정, 그리고 한 규칙이 방어를 대체한다
 * (2026-08-28, 증분 5a).
 *
 * ★계약은 서버(`src/core/resource-revision.ts`)가 2026-08-27 에 세웠는데 **화면 쪽이 비어
 *  있었다**(실측: 대시보드 JS 에 `revision`·`decideApply` 0곳). 한쪽만 서 있는 계약은
 *  계약이 아니라 서버의 독백이다.
 *
 * ★**판정이 두 벌인 걸 허용하는 유일한 조건**이 이 검사다. 런타임이 달라(TS/브라우저 JS)
 *  구현을 공유할 수 없으므로, **같은 케이스 표로 양쪽을 실행해 대조**한다. 표를 두 벌 적으면
 *  그 순간 이 검사도 의미를 잃으므로 **표는 여기 한 벌**이고 둘 다 그것을 먹는다
 *  ([[feedback_simple_composable_no_duplication]]).
 *
 * 지키는 것 넷:
 *  ① 두 구현이 **모든 케이스에서 같은 답**을 낸다(하나라도 갈리면 화면이 영원히 스냅샷만
 *    다시 받거나, 더 나쁘게는 놓친 이벤트를 조용히 넘긴다).
 *  ② ★**한 규칙이 방어를 대체한다** — 중복 replay·순서 뒤바뀜·건너뜀을 **실제로 흘려 보고**
 *    상태가 맞는지 본다(진리표만 보면 "그래서 화면이 맞나" 는 여전히 모른다).
 *  ③ **스냅샷 요청이 합쳐진다** — 재연결 순간 이벤트가 몰아쳐도 밖으로는 한 번.
 *  ④ **모듈이 실제로 실린다** — 매니페스트와 `index.html` 둘 다 있어야 로드된다(전례:
 *    매니페스트에만 넣어 200 으로 서빙되는데 로드는 안 됐다).
 *
 * 등급: ①②③은 **동작**(`vm` 에서 클라 구현을 실제로 돌린다), ④는 두 목록 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { decideApply, revisionEpoch } from "../../core/resource-revision.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASH = path.join(REPO, "packages/dashboard");

type Local = { epoch: string; revision: number } | null;

export const check: RegressionCheck = {
  name: "resource-store-client",
  guards:
    "실시간 계약이 서버에만 있고 화면 쪽이 0이던 것(계약이 한쪽만 서면 독백이다) + 판정이 두 런타임에 각자 구현돼 조용히 갈리는 것 + 재연결 때 스냅샷이 폭풍처럼 나가는 것 + js 모듈이 매니페스트에만 있고 index.html 에 없어 로드가 안 되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = readFileSync(path.join(DASH, "js/resource-store.js"), "utf8");

    // ── 클라 구현을 **실제로 돌린다** ──
    const win: Record<string, unknown> = {};
    const ctx: Record<string, unknown> = {
      window: win,
      console: { warn: (): void => {}, error: (): void => {} },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const store = win.resourceStore as {
      decideApply: (local: Local, ev: { epoch: string; revision: number }) => string;
      resource: (
        name: string,
        fetchSnapshot?: () => Promise<{ epoch: string; revision: number; data: unknown }>,
      ) => {
        handle: (
          ev: { epoch: string; revision: number },
          apply: (prev: unknown, ev: unknown) => unknown,
        ) => string;
        subscribe: (fn: (data: unknown) => void) => () => void;
        resnapshot: () => Promise<void>;
        state: () => { epoch: string; revision: number; data: unknown } | null;
        stats: () => Record<string, number>;
      };
    };
    out.push(
      assert(
        "화면 쪽 구현이 실제로 로드된다(`window.resourceStore`)",
        typeof store?.decideApply === "function" && typeof store?.resource === "function",
        typeof store?.decideApply,
      ),
    );
    if (typeof store?.decideApply !== "function") return out;

    // ── ① 같은 표, 두 런타임 ────────────────────────────────────────────────
    const E = revisionEpoch();
    const CASES: Array<[string, Local, number, string]> = [
      ["스냅샷 전", null, 1, "resnapshot"],
      ["세대 다름", { epoch: `${E}-other`, revision: 5 }, 6, "resnapshot"],
      ["바로 다음", { epoch: E, revision: 5 }, 6, "apply"],
      ["같은 것 재수신", { epoch: E, revision: 5 }, 5, "ignore"],
      ["과거 replay", { epoch: E, revision: 5 }, 2, "ignore"],
      ["한 칸 건너뜀", { epoch: E, revision: 5 }, 7, "resnapshot"],
      ["멀리 건너뜀", { epoch: E, revision: 5 }, 999, "resnapshot"],
      ["0에서 첫 이벤트", { epoch: E, revision: 0 }, 1, "apply"],
    ];
    const mismatched = CASES.filter(([, local, rev]) => {
      const ev = { epoch: E, revision: rev };
      return decideApply(local, ev) !== store.decideApply(local, ev);
    });
    const wrong = CASES.filter(([, local, rev, want]) => {
      const ev = { epoch: E, revision: rev };
      return store.decideApply(local, ev) !== want;
    });
    out.push(
      assert(
        "★★서버(TS)와 화면(JS)이 **모든 케이스에서 같은 답**을 낸다 — 갈리면 화면이 영원히 스냅샷만 받거나(성능 붕괴), 더 나쁘게는 놓친 이벤트를 조용히 넘긴다",
        mismatched.length === 0,
        mismatched.length === 0
          ? `${CASES.length}케이스 일치`
          : `★갈림: ${mismatched.map(([n]) => n).join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★화면 판정이 진리표대로다(양쪽이 **같이 틀리는** 것도 잡는다 — 일치만 보면 둘 다 틀려도 초록이다)",
        wrong.length === 0,
        wrong.length === 0 ? `${CASES.length}케이스 통과` : `★틀림: ${wrong.map(([n]) => n).join(", ")}`,
      ),
    );

    // ── ② 한 규칙이 방어를 대체한다 — **흘려 보고 상태를 본다** ─────────────
    let snapshots = 0;
    const r = store.resource("regr-running-work", async () => {
      snapshots += 1;
      return { epoch: E, revision: 10, data: ["기준"] };
    });
    await r.resnapshot();
    // 순서대로 하나 — 적용된다.
    const d1 = r.handle({ epoch: E, revision: 11 }, (prev, ev) => [
      ...((prev as string[]) ?? []),
      `r${(ev as { revision: number }).revision}`,
    ]);
    // 같은 것이 replay 로 또 온다 — 버려야 한다(종전엔 dedup 집합이 하던 일).
    const d2 = r.handle({ epoch: E, revision: 11 }, (prev) => [...((prev as string[]) ?? []), "중복"]);
    // 과거 이벤트가 늦게 온다 — 버려야 한다(종전엔 sticky 종료가 하던 일).
    const d3 = r.handle({ epoch: E, revision: 3 }, (prev) => [...((prev as string[]) ?? []), "과거"]);
    const after = r.state();
    out.push(
      assert(
        "★★중복 replay·늦게 온 과거 이벤트가 **상태를 안 더럽힌다** — dedup 집합도 sticky 종료도 없이, 규칙 한 줄로",
        d1 === "apply" &&
          d2 === "ignore" &&
          d3 === "ignore" &&
          JSON.stringify(after?.data) === JSON.stringify(["기준", "r11"]) &&
          after?.revision === 11,
        `판정 ${d1}/${d2}/${d3} · 상태 ${JSON.stringify(after?.data)} rev=${after?.revision}`,
      ),
    );

    // 건너뛴 이벤트 — 스냅샷을 다시 받는다(종전엔 "replay 창 밖으로 밀린 긴 워커" 가 영영 안 왔다).
    const before = snapshots;
    const d4 = r.handle({ epoch: E, revision: 99 }, (prev) => prev);
    await new Promise((res) => setTimeout(res, 0));
    out.push(
      assert(
        "★★건너뛴 구간이 있으면 **스냅샷을 다시 받는다** — 이게 'replay 창 밖으로 밀린 긴 워커가 새로고침 뒤 영영 안 오던 것' 을 대체한다",
        d4 === "resnapshot" && snapshots === before + 1,
        `판정=${d4} · 스냅샷 ${before}→${snapshots}`,
      ),
    );

    // ── ③ 스냅샷 요청이 합쳐진다 ───────────────────────────────────────────
    let slowCalls = 0;
    let release: (() => void) | undefined;
    const slow = store.resource("regr-slow", async () => {
      slowCalls += 1;
      await new Promise<void>((res) => {
        release = res;
      });
      return { epoch: E, revision: 1, data: [] };
    });
    void slow.resnapshot();
    void slow.resnapshot();
    void slow.resnapshot();
    // ★한 틱 기다린다 — `resnapshot` 은 마이크로태스크에서 `fetchSnapshot` 을 부른다.
    //  안 기다리고 재면 **항상 0**이라 이 검사가 공허하게 초록이 된다(첫 판이 그랬다).
    await new Promise((res) => setTimeout(res, 0));
    out.push(
      assert(
        "★재연결 순간 이벤트가 몰아쳐도 스냅샷은 **한 번만** 나간다(도는 중이면 그 약속에 합류)",
        slowCalls === 1,
        `호출 ${slowCalls}회`,
      ),
    );
    release?.();

    // ── ⑤ 문지기가 실제로 서 있나 (증분 5b) ────────────────────────────────
    //  ★렌더링은 안 바꾸고 **입구에서만** 판정한다. 그래서 지킬 성질은 셋이다:
    //   SSE 가 묻는가 · 게이트가 스토어를 쓰는가 · 게이트가 없어도 현행대로 도는가.
    const sse = readFileSync(path.join(DASH, "js/sse.js"), "utf8");
    const drawer = readFileSync(path.join(DASH, "js/background-drawer.js"), "utf8");
    const workerBranch =
      /if \(typeof ev\.type === "string" && ev\.type\.indexOf\("worker\."\)[\s\S]{0,900}?\n {8}\}/.exec(
        sse,
      )?.[0] ?? "";
    out.push(
      assert(
        "★★SSE 가 `worker.*` 를 그리기 **전에** 순서를 묻는다 — 뒤에서 막던 것(sticky·대조)을 앞에서 가른다",
        /gateWorkerEvent/.test(workerBranch) &&
          /decision !== "apply"/.test(workerBranch) &&
          workerBranch.indexOf("gateWorkerEvent") < workerBranch.indexOf("handleWorkerEvent("),
        workerBranch === ""
          ? "★worker 분기를 못 찾음"
          : `gate@${workerBranch.indexOf("gateWorkerEvent")} < handle@${workerBranch.indexOf("handleWorkerEvent(")}`,
      ),
    );
    out.push(
      assert(
        "★게이트가 **스토어 판정**을 쓴다(자기 규칙을 새로 쓰지 않는다 — 그러면 판정이 세 벌이 된다)",
        /resourceStore\.resource\("running-work"/.test(drawer) &&
          /workRes\.handle\(/.test(drawer),
        `resource 등록=${/resourceStore\.resource\("running-work"/.test(drawer)} · handle 사용=${/workRes\.handle\(/.test(drawer)}`,
      ),
    );
    out.push(
      assert(
        "★게이트가 없거나 좌표 없는 이벤트면 **현행 그대로 그린다** — 계약을 모르는 발행자를 막아 세우면 고장이 아니라 침묵이 된다",
        /return "apply";/.test(drawer) && /typeof window\.gateWorkerEvent === "function"/.test(sse),
        `드로어 폴백=${/return "apply";/.test(drawer)} · SSE typeof 가드=${/typeof window\.gateWorkerEvent === "function"/.test(sse)}`,
      ),
    );

    // ★**소비자보다 먼저 실리는가** (2026-08-28 라이브 실측으로 잡은 것).
    //  처음엔 `resource-store.js` 를 위젯 호스트 옆(317번째)에 뒀는데 `background-drawer`(310)가
    //  먼저 돌아 `window.resourceStore` 를 못 잡았다. `typeof` 가드가 있어서 **조용히 폴백**
    //  으로 떨어졌고 — 게이트는 서 있는데 아무것도 안 갈랐다. 소스 검사는 전부 초록이었다
    //  (게이트도 있고 스토어도 부르니까). 이건 **순서**로만 잡힌다
    //  ([[feedback_gate_must_actually_run]] — "있다" 가 아니라 "도는가").
    const order = (f: string): number =>
      readFileSync(path.join(DASH, "index.html"), "utf8").indexOf(`src="/js/${f}"`);
    const storeAt = order("resource-store.js");
    const drawerAt = order("background-drawer.js");
    out.push(
      assert(
        "★★스토어가 **소비자(background-drawer)보다 먼저** 실린다 — 뒤면 `typeof` 가드에 걸려 조용히 폴백이 되고, 게이트가 서 있는 채로 아무것도 안 가른다(실제로 그랬다)",
        storeAt >= 0 && drawerAt >= 0 && storeAt < drawerAt,
        `store@${storeAt} drawer@${drawerAt}`,
      ),
    );

    // ── ⑥ 코어 데이터가 **특권 없이** 붙는가 (증분 5, §I 5번의 질문) ────────
    //  ★설계가 물은 건 기능이 아니라 경계다: *"코어 데이터도 같은 등록소로 붙는가."*
    //   날씨·지도는 밖에서 온 것이지만 Running Work 는 우리 것이라, 이게 같은 문으로
    //   들어오면 그 문이 진짜 문이다. 반대면 코어 전용 뒷문이 있다는 뜻이다.
    const rwWidget = readFileSync(
      path.join(REPO, "plugins/running-work/web/widget.js"),
      "utf8",
    );
    const rwEntry = readFileSync(
      path.join(REPO, "plugins/running-work/src/index.ts"),
      "utf8",
    );
    out.push(
      assert(
        "★★코어 데이터 위젯이 **플러그인과 같은 문**으로 들어온다(`tiguWidgets.register` + `/plugin-asset`) — 특권 경로가 있으면 그 등록소는 시늉이다",
        /window\.tiguWidgets\.register\("running-work\/live"/.test(rwWidget) &&
          /\/plugin-asset\/running-work\//.test(rwWidget),
        `register=${/tiguWidgets\.register/.test(rwWidget)} · asset=${/plugin-asset/.test(rwWidget)}`,
      ),
    );
    out.push(
      assert(
        "★그 플러그인엔 **서버 코드가 없다** — 값은 화면에서 `ctx.resource` 로 온다(코어를 직접 짚지 않는다)",
        !/src\/core/.test(rwEntry) && /ctx\.resource\("running-work"\)/.test(rwWidget),
        `코어 import=${/src\/core/.test(rwEntry)} · ctx.resource=${/ctx\.resource\(/.test(rwWidget)}`,
      ),
    );
    const host = readFileSync(path.join(DASH, "js/widget-host.js"), "utf8");
    out.push(
      assert(
        "★★구독 해지를 **코어가 한다**(`ctx.onDispose`) — 위젯이 잊어도 안 샌다. 상시 띄워두는 화면에서 이건 곧 누수다",
        /resource: \(name\) => \(\{[\s\S]{0,600}?dispose\.push\(off\)/.test(host),
        /dispose\.push\(off\)/.test(host) ? "onDispose 에 건다" : "★해지를 안 건다",
      ),
    );
    const overview = readFileSync(path.join(DASH, "js/view-overview.js"), "utf8");
    out.push(
      assert(
        "★live 위젯엔 poll 을 안 건다(라우트가 없으면 받아올 게 없다 — 종전엔 404 를 맞고 '값을 못 받았습니다' 로 떴다)",
        /homeDataRoutes\.includes\(w\.type\)/.test(overview) &&
          /if \(!homeDataRoutes\.includes\(w\.type\)\) continue;/.test(overview),
        `판정 사용=${/homeDataRoutes\.includes/.test(overview)}`,
      ),
    );

    // ── ④ 실제로 실리는가 — 두 목록 대조 ──────────────────────────────────
    const manifest = JSON.parse(
      readFileSync(path.join(DASH, "js/_manifest.json"), "utf8"),
    ) as string[];
    const html = readFileSync(path.join(DASH, "index.html"), "utf8");
    out.push(
      assert(
        "★모듈이 매니페스트와 `index.html` **둘 다**에 있다 — 하나만 있으면 서빙은 되는데 로드가 안 된다(전례가 있다)",
        manifest.includes("resource-store.js") &&
          html.includes('src="/js/resource-store.js"'),
        `manifest=${manifest.includes("resource-store.js")} html=${html.includes('src="/js/resource-store.js"')}`,
      ),
    );

    return out;
  },
};
