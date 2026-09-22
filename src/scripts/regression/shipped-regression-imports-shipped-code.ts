/**
 * **배포되는 회귀가 배포 안 되는 모듈을 정적 import 하지 않는다** (2026-09-22).
 *
 * 사고 — **같은 부류가 두 번 났다.**
 *  · 2026-08-08: `bench-*` 회귀가 `../bench/metrics.js` 를 정적 import 해 배포 트리
 *    typecheck 가 rc=2. 그때 manifest 에 `src/scripts/regression/bench-*` 제외를 적었다.
 *  · 2026-09-22: **같은 일이 또 났다.** 이번엔 `_bench-low-pin-child.ts` 인데, 그 패턴이
 *    `bench-` 로 시작하는 이름만 봐서 **`_` 접두 자식을 놓쳤다.** 규칙은 맞았고 **이름
 *    모양 하나**에 걸린 것이다([[feedback_hand_maintained_lists]]).
 *
 * ★그래서 이 검사는 **이름이 아니라 관계**를 본다: «`src/scripts/bench/` 를 import 하는
 *  회귀 파일은 manifest 가 반드시 제외해야 한다». 새 이름 모양이 생겨도 자동으로 걸린다.
 *
 * ★잡는 자리가 여기인 이유: `npm run typecheck`(rootDir=`.`)는 DEV 에선 **통과**한다
 *  — bench 가 거기 있으니까. 배포 트리에서만 빨개지고, 그건 sync §5 까지 가야 보인다.
 *  «수동 게이트는 자동으로 도는 자리로 옮겨라»([[feedback_gate_must_actually_run]]).
 *
 * 등급: **소스 검사**(정적 import 관계). 실행은 필요 없다 — 재는 것이 «무엇을 짚는가» 다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** manifest 가 회귀 파일을 제외하는 이름 규칙(동기화 대상: `docs/distribution-plan.md`). */
const EXCLUDED_BY_MANIFEST = (base: string): boolean =>
  /^_?bench-/.test(base) ||
  base === "plugin-widget-end-to-end.ts" ||
  base === "plugin-public-surface.ts";

/**
 * 배포에서 빠지는 소스 경로 — 이걸 짚는 파일은 같이 빠져야 한다.
 *
 * ★**앵커를 붙이지 마라** (2026-09-22, 이 검사를 만들며 당함). 첫 판은
 *  `/(^|\/)\.\.\/bench\//` 였는데, 실제 `import … from "../bench/x.js"` 는 `..` 앞이
 *  `"` 라 **안 맞았다.** 그런데도 초록이 아니라 빨강이 나와서 «잡힌다» 고 읽을 뻔했다 —
 *  같은 파일에 우연히 있던 `"../../../bench/…"` 가 `/` 앞이라 걸린 것이었다.
 *  **그물이 맞는 이유로 맞는지 확인하지 않으면, 다음 파일에선 조용히 뚫린다.**
 */
const NOT_SHIPPED = [/\.\.\/bench\//, /scripts\/bench\//];

export const check: RegressionCheck = {
  name: "shipped-regression-imports-shipped-code",
  guards:
    "배포되는 회귀가 manifest 가 뺀 모듈(src/scripts/bench/)을 정적 import 해 배포 트리 typecheck·build 가 깨지던 것 — 2026-08-08 에 한 번, 2026-09-22 에 이름 모양이 달라 또 한 번",
  run: async (): Promise<Assertion[]> => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    let importersTotal = 0;
    // ★**자기 자신은 뺀다** — 규칙을 정의하는 정규식이 코드라서 스스로에게 걸린다
    //  (실측: 처음 돌렸을 때 이 파일이 유일한 위반자로 나왔다). 술어를 담은 파일이
    //  술어에 걸리는 것은 위반이 아니다.
    const selfBase = path.basename(fileURLToPath(import.meta.url)).replace(/\.js$/, ".ts");
    for (const f of files) {
      if (f === selfBase) continue;
      const src = readFileSync(path.join(dir, f), "utf8");
      // 주석 안의 경로를 코드로 세지 않는다.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const importsBench = NOT_SHIPPED.some((re) => re.test(code));
      if (!importsBench) continue;
      importersTotal += 1;
      if (!EXCLUDED_BY_MANIFEST(f)) offenders.push(f);
    }
    const excludedPresent = files.filter((f) => EXCLUDED_BY_MANIFEST(f)).length;
    return [
      assert(
        "★전제 — 제외 대상과 bench 참조가 **짝이 맞는다**(어느 트리든 빈 검사가 아니다)",
        // ★★**이 검사는 주변 환경에 기대면 안 된다** (2026-09-22, 배포 트리 회귀가 잡음).
        //  첫 판은 `importersTotal > 0` 을 전제로 걸었는데, **배포 트리에선 0이 정답**이다
        //  (제외가 먹었으니까). DEV 에서만 참인 전제를 걸어 배포 트리를 빨갛게 만들었다 —
        //  오늘 `turn-origin-reaches-adapter` 에서 고친 것과 **같은 부류**를 또 저질렀다.
        //  ★그래서 «둘 다 있거나 둘 다 없거나» 를 잰다. DEV 면 제외 대상이 있고 그것들이
        //   bench 를 짚는다. 배포 트리면 둘 다 0이고, 그게 **제외가 실제로 먹었다는 증거**다.
        //   어느 쪽이든 «0건이라 통과» 가 아니라 **짝이 맞는지**를 말한다.
        (excludedPresent > 0) === (importersTotal > 0),
        `제외 대상 ${excludedPresent}개 · bench 참조 ${importersTotal}개 / 전체 ${files.length}개 ` +
          `(${excludedPresent > 0 ? "DEV 트리" : "배포 트리"})`,
      ),
      assert(
        "★★**bench 를 짚는 회귀는 전부 manifest 가 뺀다** — 안 그러면 배포 트리 build 가 rc=2",
        offenders.length === 0,
        offenders.length === 0
          ? `bench 참조 ${importersTotal}개 전부 제외 대상(이름 규칙 통과)`
          : `★배포로 나가는데 bench 를 짚는다: ${offenders.join(" · ")}`,
      ),
      assert(
        "★이름 규칙이 `_` 접두 자식도 덮는다 — 2026-09-22 에 그 한 글자로 뚫렸다",
        EXCLUDED_BY_MANIFEST("_bench-x.ts") && EXCLUDED_BY_MANIFEST("bench-x.ts") &&
          !EXCLUDED_BY_MANIFEST("turn-origin-reaches-adapter.ts"),
        `_bench-x=${String(EXCLUDED_BY_MANIFEST("_bench-x.ts"))} bench-x=${String(EXCLUDED_BY_MANIFEST("bench-x.ts"))} 무관파일=${String(EXCLUDED_BY_MANIFEST("turn-origin-reaches-adapter.ts"))}`,
      ),
    ];
  },
};
