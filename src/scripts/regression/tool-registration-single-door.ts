/**
 * 회귀: **도구 등록은 문이 하나다** (2026-09-05 구조 감사 ④ 첫 절개).
 *
 * codex 어댑터의 `runOpenAiCodex` 안에 «브리지의 도구를 등록하는» 세 조각(선언·이름→브리지
 * 지도·노출 목록 push)이 **열아홉 번** 손으로 반복돼 있었다. 하나만 빠져도 조용하다:
 *  - 지도에 없으면 → 모델이 그 이름을 불렀을 때 **«모르는 도구»** 가 된다.
 *  - 목록에 없으면 → 있는 능력이 **모델 눈에 안 보인다**(있는데 없는 것과 같다).
 * 셋을 손으로 맞추는 자리는 언젠가 어긋나고, 어긋나도 로그 한 줄 안 남는다.
 *
 * ★**플러그인·외부 MCP 는 이 문을 안 쓴다** — 거긴 «먼저 잡은 쪽이 갖는다»(`claimToolNames`)
 *  가 더 붙어 **모양이 다르다**. 다른 것을 같게 만들면 그게 다음 사고다(가로채기 방지선이
 *  사라진다). 그래서 이 검사도 그 둘은 «접혀야 할 자리» 로 세지 않는다.
 *
 * ★등급: **동작** — 헬퍼를 실제로 돌려 지도·목록·순서를 확인한다. 다만 정직하게 적어둔다:
 *  **codex 실턴으로는 확인 못 했다**(감사 당시 codex 쿨다운 98시간). 어댑터 전체 경로는
 *  쿨다운이 풀린 뒤 첫 codex 턴이 실증한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADAPTER = "src/core/llm-runtime/adapters/openai-codex-oauth.ts";

/** 헬퍼 원문을 그대로 꺼내 돌린다(스텁을 검사하지 않기 위해). */
const sliceHelper = (src: string): string | null => {
  const start = src.indexOf("const registerBridgeTools = async");
  if (start < 0) return null;
  const end = src.indexOf("\n};", start);
  return end < 0 ? null : src.slice(start, end + 3);
};

export const check: RegressionCheck = {
  name: "tool-registration-single-door",
  guards:
    "도구 등록의 세 조각(지도·목록·선언)을 열아홉 곳에서 손으로 맞추던 것 — 하나만 빠지면 모델이 도구를 못 부르거나 못 보는데 조용하다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let src: string;
    try {
      src = readFileSync(path.join(REPO, ADAPTER), "utf8");
    } catch {
      return [assert("어댑터 없음(배포 레포 아님)", true, "건너뜀")];
    }

    // ── ① 문이 하나 있다 ─────────────────────────────────────────────────────
    const helper = sliceHelper(src);
    out.push(
      assert(
        "★등록 문이 하나 있다(registerBridgeTools)",
        helper !== null,
        helper === null ? "★없음 — 세 조각을 손으로 맞추는 상태" : `${helper.length}자`,
      ),
    );
    if (helper === null) return out;

    // ── ② 손으로 맞추는 자리가 안 남았다 ─────────────────────────────────────
    //  `claim` 경로(플러그인·외부 MCP)는 대상이 아니다 — 그 줄들은 `claimToolNames` 를 쓴다.
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const manual = [...bare.matchAll(/toolBridgeMap\.set\(\(t as \{ name: string \}\)\.name/g)].length;
    out.push(
      assert(
        "★세 조각을 손으로 맞추는 자리가 없다(문 밖 등록 0)",
        manual === 0,
        `수동 등록 ${manual}곳` + (manual === 0 ? "" : " ★하나가 빠져도 조용하다"),
      ),
    );
    out.push(
      assert(
        "claim 경로(먼저 잡은 쪽이 갖는다)는 그대로다 — 다른 것을 같게 만들지 않았다",
        /claimToolNames\(/.test(bare) && /keepClaimed\(/.test(bare),
        `claimToolNames ${[...bare.matchAll(/claimToolNames\(/g)].length}곳`,
      ),
    );

    // ── ③ 실제로 돌린다 — 지도·목록·순서 ─────────────────────────────────────
    // ★타입만 벗기고 **본문은 원문 그대로** 돌린다 — 스텁을 만들면 스텁을 검사하게 된다.
    //  (모듈 지역 함수라 import 할 수 없고, 검사를 위해 export 를 새로 여는 건 표면을
    //   넓히는 일이다 — `dead-exports` 가 «검사만 쓰는 export» 를 잡아주지도 않는다.)
    const js = helper
      .replace(/<B extends \{[^}]*\}>/, "")
      .replace(/bridge: B,/, "bridge,")
      .replace(/map: Map<string, B>,/, "map,")
      .replace(/out: unknown\[\],/, "out,")
      .replace(/\): Promise<void> =>/, ") =>")
      .replace(/\(t as \{ name: string \}\)/g, "t");
    const run = new Function(
      `${js}\nreturn registerBridgeTools;`,
    )() as (
      b: { listTools: () => Promise<unknown[]> },
      m: Map<string, unknown>,
      o: unknown[],
    ) => Promise<void>;

    const a = { id: "A", listTools: async () => [{ name: "alpha" }, { name: "beta" }] };
    const b = { id: "B", listTools: async () => [{ name: "gamma" }] };
    const map = new Map<string, unknown>();
    const list: unknown[] = [];
    await run(a, map, list);
    await run(b, map, list);

    out.push(
      assert(
        "★이름마다 **그 브리지**가 지도에 박힌다(모델이 부르면 그리로 간다)",
        map.get("alpha") === a && map.get("beta") === a && map.get("gamma") === b,
        `alpha→${(map.get("alpha") as { id: string })?.id} beta→${(map.get("beta") as { id: string })?.id} gamma→${(map.get("gamma") as { id: string })?.id}`,
      ),
    );
    out.push(
      assert(
        "★목록에 전부 실린다(지도에만 있고 목록에 없으면 있는 능력이 안 보인다)",
        list.length === 3,
        `${list.length}개 · ${JSON.stringify(list.map((x) => (x as { name: string }).name))}`,
      ),
    );
    out.push(
      assert(
        "순서가 호출 순서 그대로다(모델에 보이는 도구 차례를 안 바꾼다)",
        JSON.stringify(list) === JSON.stringify([{ name: "alpha" }, { name: "beta" }, { name: "gamma" }]),
        JSON.stringify(list),
      ),
    );

    return out;
  },
};
export default check;
