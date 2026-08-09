/**
 * 회귀: **중립 턴은 격리되되 능력을 잃지 않는다** — 등급 ★혼합 (2026-08-09).
 *
 * 중립 턴 = 게이트웨이·restricted 엔드포인트. 앱이 준 `system` 이 곧 시스템 프롬프트고,
 * tiguclaw 인격·기억·스킬은 실리지 않아야 한다(README 계약).
 *
 * **사고 ①(누수):** `systemPromptOverride` 는 컨텍스트 조립을 제대로 건너뛰고 있었는데도 앱이
 * 소유자 정보를 받았다. 원인은 프롬프트가 아니라 **cwd** 였다 — SDK 가 cwd 에서 `AGENT.md`·
 * `SYSTEM.md` 를 스스로 주워간다. 홈 밖 폴더로 옮겨 닫혔다.
 *  ★홈 **하위**(`<home>/data/...`)로 뒀을 땐 여전히 샜다 — SDK 는 **상위 디렉터리를 거슬러
 *   올라가며** 찾기 때문이다. "빈 폴더" 가 아니라 **"홈 밖"** 이 조건이다.
 *
 * **사고 ②(그 수정이 만든 2차 결함):** cwd 를 옮기자 **비전이 죽었다.** claude 의 이미지 경로는
 * "첨부를 경로로 주고 모델이 `Read` 로 연다"(prompt-assembly `formatAttachments`)인데, 첨부가
 * cwd 밖이 되어 열리지 않았다. 실측에서 모델이 `Read` 를 부르려다 실패했고, 다른 기계의 실사용
 * 테스트(멀티모달)가 그걸 잡았다. ★**cwd 를 바꿨으면 cwd 에 의존하던 것을 전수로 봐야 했다**
 * ([[feedback_scope_of_a_fix]] — 이 검사가 그 자리다).
 *
 * 등급: cwd 판정은 **행동 게이트**(순수 함수 실행), 어댑터 배선은 **소스 대조**.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { neutralCwd } from "../../core/llm-runtime/capabilities/external-tools.js";
import { getPaths } from "../../core/paths.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ADAPTER = "../../../src/core/llm-runtime/adapters/claude-agent-sdk.ts";
const FILEOPS = "../../../src/core/llm-runtime/capabilities/file-ops-mcp.ts";

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

export const check: RegressionCheck = {
  name: "neutral-turn-isolation",
  guards:
    "중립 턴(게이트웨이)이 소유자 컨텍스트를 안 싣되 비전은 살아 있다 — 누수와, 그 수정이 비전을 죽인 2차 결함",
  run: async (): Promise<Assertion[]> => {
    const read = async (rel: string): Promise<string> =>
      strip(await readFile(new URL(rel, import.meta.url), "utf8"));
    const [adapter, fileOps] = await Promise.all([read(ADAPTER), read(FILEOPS)]);

    // ── ①★행동: 격리 cwd 가 홈 **밖**이다(하위 폴더는 상위 탐색에 걸려 소용없다) ──
    const dir = neutralCwd();
    const home = getPaths().home;
    const rel = path.relative(path.resolve(home), path.resolve(dir));
    const outsideHome = rel.startsWith("..") || path.isAbsolute(rel);

    // ── ②배선: 중립 턴 판정이 systemPromptOverride 유무이고, cwd 가 거기서 갈린다 ──
    const neutralDefined = /const neutralTurn = input\.systemPromptOverride !== undefined/.test(
      adapter,
    );
    const cwdBranches = /neutralTurn \? neutralCwd\(\) : getPaths\(\)\.home/.test(adapter);
    // 호출자가 cwd 를 명시하면 존중한다(프로젝트 위임 등 — 중립 판정이 그걸 덮으면 안 된다).
    const respectsExplicit = /input\.cwd \?\? \(neutralTurn/.test(adapter);

    // ── ③★2차 결함 가드: 첨부가 있는 중립 턴엔 Read 가 있어야 한다(없으면 비전이 죽는다) ──
    const readRestored =
      /neutralTurn && \(input\.attachments\?\.length \?\? 0\) > 0/.test(adapter) &&
      /readsOnly: true/.test(adapter);
    // 그리고 그 노출은 **Read 하나뿐**이어야 한다(셸·검색·쓰기가 딸려오면 격리가 무의미).
    const readOnlyIsRead =
      /opts\?\.readsOnly === true/.test(fileOps) &&
      /\(\(t as \{ name\?: string \}\)\.name \?\? ""\) === "Read"/.test(fileOps);
    // 첨부가 없으면 붙이지 않는다(도구 0 유지).
    const gatedOnAttachments = /attachments\?\.length \?\? 0\) > 0\n?\s*\?/.test(adapter);

    return [
      assert(
        "★격리 cwd 가 홈 **밖**이다(홈 하위면 SDK 상위 탐색에 걸려 그대로 샌다)",
        outsideHome,
        outsideHome ? `홈 밖: ${dir}` : `★홈 안이다 — ${dir}`,
      ),
      assert(
        "중립 턴 판정 = systemPromptOverride 유무",
        neutralDefined,
        neutralDefined ? "정의됨" : "★판정이 사라졌다",
      ),
      assert(
        "그 판정으로 cwd 가 갈린다(중립이면 격리 폴더)",
        cwdBranches,
        cwdBranches ? "분기 있음" : "★중립 턴이 홈에서 돈다 — 누수 재발",
      ),
      assert(
        "호출자가 cwd 를 명시하면 존중한다(프로젝트 위임을 덮지 않는다)",
        respectsExplicit,
        respectsExplicit ? "input.cwd 우선" : "★명시 cwd 를 무시한다",
      ),
      assert(
        "★첨부가 있는 중립 턴엔 Read 를 되돌려준다(없으면 비전이 죽는다 — 실측 2차 결함)",
        readRestored,
        readRestored ? "readsOnly Read 부착" : "★이미지가 모델에 안 보인다",
      ),
      assert(
        "그 노출은 **Read 하나뿐**이다(셸·검색·쓰기가 딸려오면 격리가 무의미)",
        readOnlyIsRead,
        readOnlyIsRead ? "Read 만" : "★읽기 외 도구가 새어 나온다",
      ),
      assert(
        "첨부가 없으면 도구 0 을 유지한다",
        gatedOnAttachments,
        gatedOnAttachments ? "첨부 게이트" : "★첨부 없는 턴에도 도구가 붙는다",
      ),
    ];
  },
};
