/**
 * "도구를 안 썼다" 경고는 **도구가 필요한 지시였을 때만** 뜬다 (2026-08-20 사용자 신고)
 *
 * 사고: 사용자가 *"다른 작업 하지 말고 정확히 한 줄만 답하세요: SPAWN_OK"* 라는 핑을
 * 시켰는데, 에이전트가 시킨 대로 하자 `[agent-no-tools]` 가 떠서 *"결과가 지어낸 것일 수
 * 있습니다"* 라고 말했다. 30초 안에 두 번 떴다(회사돌쇠 로그 18:34:11 · 18:34:36).
 *
 * ★전제가 늙었다 — 배경 스폰(2026-08-19) 이후 핑·질의·판단 스폰이 정상 용법이 됐다.
 * ★끄지 않는다: 진짜로 지어내는 경우를 잡는 게 목적이라, **질문만 좁힌다.**
 * ★그리고 **반복은 세라** — 매 턴 뜨는 경고는 배경 소음이 되고, 그러면 진짜일 때 아무도
 *  안 본다(이 레포가 12일 묻힌 적이 있다). 오탐을 없애는 게 곧 경고를 살리는 일이다.
 *
 * 등급: **동작 검사**(판정 순수함수 실행) + 배선(경고가 그 판정을 통과해야 뜬다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolsWereExpected } from "../../core/llm-runtime/capabilities/tools-expected.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "agent-no-tools-narrowed",
  guards:
    "도구 0회만 보고 경고해서, 시킨 대로 한 에이전트에게 '지어냈을 수 있다'고 말하던 것 (2026-08-20 사용자 신고 — 30초에 2회 오탐)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // [설명, 프롬프트, 경고해야 하나]
    const cases: Array<[string, string, boolean]> = [
      ["★신고 사례: 핑", "이건 스폰 동작 확인용 핑입니다. 다른 작업 하지 말고 정확히 다음 한 줄만 답하세요: SPAWN_OK", false],
      ["순수 계산", "1+1 을 답하고 끝내라", false],
      ["순수 판단·의견", "이 설계가 맞는지 의견만 말해줘", false],
      ["요약 요청(대상 없음)", "지금까지 논의를 세 줄로 정리해줘", false],
      ["★도구 금지를 명시 + 경로 언급", "src/a.ts 를 보되 도구는 쓰지 마라", false],
      ["파일 읽기", "src/core/router.ts 를 읽고 요약해줘", true],
      ["윈도우 경로", "E:\\work\\test\\VoxelBuilder 를 점검해줘", true],
      ["유닉스 절대경로", "/etc/hosts 를 확인해줘", true],
      ["셸 명령", "npm run build 를 돌려서 결과를 알려줘", true],
      ["git 명령", "git log 를 보고 최근 커밋을 정리해", true],
      ["URL", "https://example.com 을 가져와 요약해", true],
      ["확장자만 언급", "package.json 을 확인해줘", true],
      ["빈 프롬프트", "", false],
    ];
    for (const [name, prompt, want] of cases) {
      const got = toolsWereExpected(prompt);
      out.push(assert(`${name} → 경고 ${want ? "필요" : "불필요"}`, got === want, `${String(got)}`));
    }

    // 배선 — 경고가 이 판정을 실제로 통과하는가(안 그러면 위 판정은 장식이다).
    const src = readFileSync(
      path.join(REPO, "src/core/llm-runtime/capabilities/agent-registry.ts"),
      "utf8",
    );
    out.push(
      assert(
        "★경고가 이 판정을 통과해서만 뜬다 — 조건이 childToolSteps===0 하나로 돌아가면 오탐이 부활한다",
        /childToolSteps === 0 && toolsWereExpected\(/.test(src),
        /childToolSteps === 0 \)/.test(src) ? "★단독 조건으로 회귀" : "판정 통과",
      ),
    );
    return out;
  },
};
