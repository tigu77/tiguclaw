/**
 * 회귀: **지금 보고 있는 화면을 끄는 일은 먼저 묻는다** (2026-08-30).
 *
 * ★사고(적대 검토 B-2, 실측): 같은 플러그인을 끄는 문이 **둘**인데 안전장치가 한쪽에만
 *  있었다. 모듈 화면은 `confirm` + `warning:"critical"` + `requiresRestart` 셋을 붙였고,
 *  플러그인 화면은 **아무것도 없이** 껐다:
 *
 *  ```
 *  끄기 전 200 · 63,216바이트  →  {"ok":true}  →  끈 뒤 000
 *  settings.json: {"dashboard":{"enabled":false}}      ← 재시작해도 안 돌아온다
 *  ```
 *
 *  되돌릴 문이 방금 없앤 그 화면이었다.
 *
 * ★**원인은 손 목록이다.** `SELF_REFERENTIAL_MODULE_NAMES` 가 서버·화면 **두 벌**이었고
 *  **두 벌 다 플러그인 화면엔 없었다.** 바로 위 세대에 `CRITICAL_MODULE_NAMES` 가 똑같이
 *  두 벌로 갈려서 선언(`tiguclaw.core`)으로 옮겼는데, 그 옆에서 같은 병이 다시 났다
 *  ([[feedback_hand_maintained_lists]]). 그래서 이 판정도 **매니페스트 선언**으로 내렸다.
 *
 * 지키는 것 다섯:
 *  ① 선언을 읽는 판정이 맞다(대시보드 O · 나머지 X).
 *  ② `core` 와 **다른 축**이다 — 코어는 못 끄고, 이건 끄되 묻는다(둘을 합치면 능력을 뺏는다).
 *  ③ 목록 행이 그 사실을 **싣고 나간다** — 화면은 서버가 준 것만 본다.
 *  ④ ★**두 화면 다** 그 필드로 게이트한다.
 *  ⑤ ★어느 쪽에도 **이름 목록이 되살아나지 않는다** — 되살아나면 또 갈린다.
 *
 * 등급: ①②③은 **동작**(판정·목록을 실제로 실행), ④⑤는 **소스 대조**(브라우저 DOM 핸들러라
 * 여기서 못 돌린다 — 그래서 이 둘은 약하다고 적어 둔다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { collectInventory } from "../../core/plugins/inventory.js";
import { isCoreModule, isSelfReferentialModule } from "../../core/plugins/inventory.js";
import { listAllPlugins } from "../../core/plugins/manager.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "disabling-the-screen-asks-first",
  guards:
    "플러그인 화면이 확인도 경고도 없이 대시보드를 꺼서 되돌릴 문이 함께 사라지던 것(실측 63,216바이트→000, 설정에 굳음) + 그 판정이 손 목록 두 벌로 갈려 한쪽 문에 아예 없던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 선언을 읽는다 ────────────────────────────────────────────────
    out.push(
      assert(
        "★★끄면 화면이 사라지는 것은 **대시보드**다 — 판정이 매니페스트 선언에서 나온다(손 목록이 아니다)",
        isSelfReferentialModule("dashboard"),
        `dashboard=${String(isSelfReferentialModule("dashboard"))}`,
      ),
    );
    const others = ["scheduler", "file-watch", "running-work", "self-growth", "http-bridge"];
    const wrong = others.filter((n) => isSelfReferentialModule(n));
    out.push(
      assert(
        "★나머지엔 안 붙는다 — 다 물어보면 확인창이 배경 소음이 되고, 그러면 진짜일 때 아무도 안 읽는다",
        wrong.length === 0,
        wrong.length === 0 ? `${others.length}개 전부 아님` : `★붙음: ${wrong.join(", ")}`,
      ),
    );

    // ── ② core 와 다른 축 ──────────────────────────────────────────────
    out.push(
      assert(
        "★★`core` 와 **다른 축**이다 — 코어(http-bridge)는 **끌 수 없고**, 이건 **끌 수 있되 묻는다**. 합치면 대시보드를 끄는 능력 자체를 뺏는 것이라 모듈 화면의 기존 동작이 죽는다",
        isCoreModule("http-bridge") &&
          !isSelfReferentialModule("http-bridge") &&
          isSelfReferentialModule("dashboard") &&
          !isCoreModule("dashboard"),
        `http-bridge: core=${String(isCoreModule("http-bridge"))}/self=${String(isSelfReferentialModule("http-bridge"))} · dashboard: core=${String(isCoreModule("dashboard"))}/self=${String(isSelfReferentialModule("dashboard"))}`,
      ),
    );

    // ── ③ 목록 행이 싣고 나간다 ────────────────────────────────────────
    const row = (await listAllPlugins()).find((p) => p.name === "dashboard");
    out.push(
      assert(
        "★★목록 행이 그 사실을 **싣고 나간다** — 안 실으면 화면은 다시 자기 목록을 만들 수밖에 없고, 그게 이 사고의 뿌리다",
        row?.selfReferential === true,
        row === undefined ? "행 없음" : `selfReferential=${String(row.selfReferential)}`,
      ),
    );

    // ── ④ 모듈 화면 — **진짜 돌린다** ────────────────────────────────────
    // ★종전엔 이 자리가 정규식 두 개(`selfReferential === true` 와 `window.confirm(`)가
    //  파일 **아무 데나** 있으면 통과였다. 두 검토조가 동시에 그걸 지적했고(B-G1·C-C4),
    //  이론이 아니라 **실현됐다**: 병합의 합성 경로가 플래그를 안 실어 대시보드 확인창이
    //  조용히 사라졌는데(B-P1) 그 정규식들은 계속 초록이었다.
    //
    // ★그래서 화면 파일을 **vm 에서 그대로 평가**해 핸들러를 꺼내 부른다. 베끼지 않는다 —
    //  베낀 사본은 그 자체가 두 번째 진실이고, 이 사고가 바로 그 부류였다.
    const dash = path.join(REPO, "packages/dashboard/js");
    const noop = (): void => {};
    const el: unknown = new Proxy(
      {},
      { get: (_t, k) => (k === "classList" || k === "style" || k === "dataset" ? el : k === "length" ? 0 : typeof k === "string" ? () => el : undefined) },
    );
    let asked = 0;
    let sent = 0;
    const ctx: Record<string, unknown> = {
      i18n: (k: string) => k,
      console: { log: noop, warn: noop, error: noop },
      document: { querySelectorAll: () => [], querySelector: () => el, getElementById: () => el, createElement: () => el, addEventListener: noop, body: el },
      window: { addEventListener: noop, confirm: () => { asked += 1; return false; } },
      setTimeout,
      clearTimeout,
      fetch: async () => { sent += 1; return { ok: true, json: async () => ({ ok: true }) }; },
      showToast: noop,
    };
    ctx["globalThis"] = ctx;
    vm.createContext(ctx);
    vm.runInContext(
      `(function(){\n${readFileSync(path.join(dash, "view-providers.js"), "utf8")}\n` +
        `;globalThis.__x={onModuleToggleClick,mergeInventoryModuleInfo};})()`,
      ctx,
    );
    const x = ctx["__x"] as {
      onModuleToggleClick: (p: unknown, b: unknown) => Promise<void>;
      mergeInventoryModuleInfo: (l: unknown[], inv: unknown) => Array<Record<string, unknown>>;
    };

    // ④-1 병합이 플래그를 **실제로** 싣는가 — dashboard 는 **합성 경로**로만 그려진다.
    const merged = x.mergeInventoryModuleInfo(
      [{ id: "core.daemon", kind: "core", name: "daemon" }],
      await collectInventory(),
    );
    const modRow = merged.find((r) => r["moduleName"] === "dashboard");
    out.push(
      assert(
        "★★모듈 화면이 쥐는 dashboard 행이 `selfReferential` 을 **싣고 있다** — 이 화면은 프로바이더와 매치가 안 돼 **합성 경로**로만 그려지므로, 매치 경로에만 넣으면 확인창이 조용히 사라진다(실제로 그랬다)",
        modRow?.["selfReferential"] === true,
        modRow === undefined ? "행 없음" : `selfReferential=${String(modRow["selfReferential"])}`,
      ),
    );

    // ④-2 게이트를 **불러본다** — 취소를 누르면 요청이 안 나가야 한다.
    asked = 0;
    sent = 0;
    await x.onModuleToggleClick({ moduleName: "dashboard", moduleEnabled: true, selfReferential: true }, { disabled: false });
    out.push(
      assert(
        "★★자기참조 모듈을 끄면 **묻고**, 취소하면 **요청이 안 나간다** — 종전 검사는 `window.confirm(` 이 파일 어딘가 있기만 하면 통과라, 결과를 무시하도록 바꿔도(=취소해도 꺼짐) 초록이었다",
        asked === 1 && sent === 0,
        `물음 ${asked}회 · 요청 ${sent}회`,
      ),
    );

    // ④-3 반대 방향 — 평범한 모듈까지 물으면 확인창이 배경 소음이 된다.
    asked = 0;
    sent = 0;
    await x.onModuleToggleClick({ moduleName: "scheduler", moduleEnabled: true }, { disabled: false });
    out.push(
      assert(
        "★평범한 모듈은 **안 묻고 그냥 나간다** — 다 물으면 확인창이 배경 소음이 되고, 그러면 진짜일 때 아무도 안 읽는다",
        asked === 0 && sent > 0,
        `물음 ${asked}회 · 요청 ${sent}회`,
      ),
    );

    // ── ⑤ 플러그인 화면 + 이름 목록 부활 (소스 대조) ─────────────────────
    // ★정직하게: 이쪽 핸들러는 렌더 루프 안의 인라인 화살표라 위처럼 못 꺼낸다. 그래서
    //  **가드의 모양**을 본다 — `confirm` 이 있기만 한 게 아니라 **결과로 되돌아 나가는지**.
    // ⑤ 플러그인 화면 — 판정을 **꺼내 부른다**(네 조합 전수).
    // ★종전엔 가드의 *모양*만 봤다. 그래서 조건을 뒤집어 **끌 때가 아니라 켤 때** 묻게
    //  해도 초록이었다(B조 M1) — 사고 그 자체가 복원되는데 그물이 0이었다.
    const ctx2: Record<string, unknown> = { ...ctx, window: { addEventListener: noop, confirm: () => false } };
    ctx2["globalThis"] = ctx2;
    vm.createContext(ctx2);
    vm.runInContext(
      `(function(){\n${readFileSync(path.join(dash, "view-plugins.js"), "utf8")}\n` +
        `;globalThis.__y={needsDisableConfirm};})()`,
      ctx2,
    );
    const needs = (ctx2["__y"] as { needsDisableConfirm: (p: unknown) => boolean }).needsDisableConfirm;
    const table: Array<[string, unknown, boolean]> = [
      ["끄기+자기참조", { enabled: true, selfReferential: true }, true],
      ["켜기+자기참조", { enabled: false, selfReferential: true }, false],
      ["끄기+평범", { enabled: true }, false],
      ["켜기+평범", { enabled: false }, false],
    ];
    const wrongRows = table.filter(([, input, want]) => needs(input) !== want);
    out.push(
      assert(
        "★★플러그인 화면의 확인 판정이 **네 조합을 다 맞힌다** — 끄기+자기참조에서만 묻는다. 극성을 뒤집으면(켤 때 묻기) 사고가 그대로 복원되는데 소스 대조로는 그게 안 보였다",
        wrongRows.length === 0,
        wrongRows.length === 0
          ? table.map(([n, i]) => `${n}=${String(needs(i))}`).join(" · ")
          : `★틀림: ${wrongRows.map(([n]) => n).join(", ")}`,
      ),
    );

    // ★판정이 맞아도 **아무도 안 부르면** 소용없다 (변이 M11: `if (false)` 로 바꿔도
    //  위 네 조합은 그대로 통과했다). 그래서 **부르는 자리**를 따로 본다 — 이름이 있어서
    //  이 검사가 가능하다(익명 조건이었으면 다시 정규식 점치기다).
    const vplSrc = readFileSync(path.join(dash, "view-plugins.js"), "utf8");
    out.push(
      assert(
        "★★그 판정을 **실제로 부른다** — 판정이 맞아도 호출부가 죽으면(`if (false)`) 확인창은 안 뜬다",
        // ★조건이 **그 판정 하나뿐**이어야 한다 (2026-08-30, 적대 검토 E조 F1). 종전엔
        //  `if (needsDisableConfirm(` 로만 봐서 `&& p.name !== "dashboard"` 한 조각이면
        //  **오늘 고친 사고가 통째로 복원되는데** 초록이었다 — 판정 함수의 네 조합은
        //  여전히 맞으므로 아무 신호도 없다. `if (false)` 는 닫았는데 **조건 추가**가 옆문이었다.
        /if\s*\(needsDisableConfirm\(p\)\)\s*\{/.test(vplSrc) &&
          /if\s*\(!window\.confirm\([\s\S]*?\)\)\s*return;/.test(vplSrc),
        `호출 ${String(/if\s*\(needsDisableConfirm\(/.test(vplSrc))} · 되돌아나감 ${String(/if\s*\(!window\.confirm\([\s\S]*?\)\)\s*return;/.test(vplSrc))}`,
      ),
    );

    const revived = [
      ["view-plugins.js", readFileSync(path.join(dash, "view-plugins.js"), "utf8")],
      ["view-providers.js", readFileSync(path.join(dash, "view-providers.js"), "utf8")],
      ["routes-settings.ts", readFileSync(path.join(REPO, "plugins/http-bridge/routes-settings.ts"), "utf8")],
    ].filter(([, src]) => /_MODULE_NAMES\s*=\s*(new Set|\[)/.test(src));
    out.push(
      assert(
        "★★어느 파일에도 **모듈 이름 목록이 되살아나지 않는다** — 이 판정은 두 세대 연속 손 목록으로 갈렸다(core 때 한 번, 여기서 또 한 번). 특정 이름이 아니라 **모양**으로 본다",
        revived.length === 0,
        revived.length === 0 ? "목록 0벌(선언에서만 읽는다)" : `★부활: ${revived.map(([f]) => f).join(", ")}`,
      ),
    );

    return out;
  },
};
