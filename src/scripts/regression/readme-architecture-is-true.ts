/**
 * 회귀: **README 가 코드에 대해 단언한 것이 실제로 참이다** (2026-08-23).
 *
 * 공개 README 에 「누가 무엇을 책임지나」 절을 넣으면서 두 가지를 **코드 사실로** 적었다:
 *  ① 매니저는 또 매니저를 띄울 수 없고 서브에이전트는 아무도 못 띄운다
 *  ② 매니저는 **결과를 거두기 전에 끝나지 않는다** — "부탁이 아니라 코어가 강제한다"
 *
 * ★문서가 코드를 단언하면 그 단언은 **검사 대상**이다. 게이트가 풀리는 순간 README 가
 *  거짓말을 하는데, 그건 코드 결함보다 고치기 어렵다(아무도 문서를 의심하지 않는다).
 *  실제로 `callerWorkerDepth` 는 **어댑터 게이트 셋뿐이던 시절** 셋 다 풀어도 회귀
 *  1,461건이 초록이었고, 그래서 코어로 내려온 이력이 있다.
 *
 * ★반대로 **모델 판단인 것은 단언하지 않는다.** 목표를 어떻게 쪼갤지·재시도할지는
 *  SYSTEM.md 가 안내하는 모델 몫이라, README 에 "자동으로 재시도한다" 고 쓰면 거짓이
 *  된다 — 그래서 그 문장은 넣지 않았고, 여기서 그 절제도 함께 지킨다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = async (rel: string): Promise<string> => {
  try {
    return await readFile(path.join(REPO, rel), "utf8");
  } catch {
    return "";
  }
};

export const check: RegressionCheck = {
  name: "readme-architecture-is-true",
  guards:
    "공개 README 가 단언한 구조(매니저 재귀 금지·결과 거두기 강제)의 코어 집행점이 사라져 문서가 거짓이 되는 것",
  run: async (): Promise<Assertion[]> => {
    const ko = await read("_workspace/public-overlay/README.md");
    const en = await read("_workspace/public-overlay/README.en.md");
    const jobs = await read("src/core/worker-jobs.ts");
    const worker = await read("src/core/llm-runtime/capabilities/worker-registry.ts");
    const prompt = await read("src/core/prompt-assembly.ts");
    if (ko === "" || jobs === "") {
      return [assert("소스 부재 시 통과(배포본 — 오탐 0)", true, "★확인 못 함")];
    }
    return [
      assert(
        "★README 의 세 역할 절이 있다(ko·en 대칭)",
        ko.includes("## 누가 무엇을 책임지나") && en.includes("## Who owns what"),
        `ko=${ko.includes("## 누가 무엇을 책임지나")} en=${en.includes("## Who owns what")}`,
      ),
      assert(
        // ① 매니저 재귀 금지 — 코어 가드(어댑터 게이트가 아니라).
        "★'매니저는 매니저를 못 띄운다' 의 코어 집행점이 있다",
        jobs.includes("callerWorkerDepth"),
        jobs.includes("callerWorkerDepth") ? "코어 가드 확인" : "★게이트 없음 — README 가 거짓이 된다",
      ),
      assert(
        // 손자 금지 — 서브에이전트는 아무것도 못 띄운다.
        "★'서브에이전트는 아무도 못 띄운다' 가 역할 문구·게이트로 서 있다",
        prompt.includes("subagentDepth") &&
          prompt.includes("당신은 더 이상 위임할 수 없습니다"),
        "손자 금지 확인",
      ),
      assert(
        // ② 거두기 강제 — 자식이 도는 동안 턴을 안 닫는다.
        "★'결과를 거두기 전에 끝나지 않는다' 가 코드로 강제된다(거두기 루프)",
        // ★**호출 문장**을 본다. 이름만 찾으면 `shouldKeepReapingREMOVED` 로 바꿔도
        //  통과한다(부분 문자열 — 오늘 네 번째 같은 부류다).
        worker.includes("while (\n          shouldKeepReaping({") &&
          worker.includes("setJobResultChannel(job.jobId, resultBox)"),
        worker.includes("while (\n          shouldKeepReaping({")
          ? "거두기 루프 확인"
          : "★루프 없음 — 문서가 거짓",
      ),
      assert(
        // ★절제: 모델 판단을 코드 보장처럼 쓰지 않는다.
        "★README 가 '자동 재시도' 를 단언하지 않는다(모델 판단을 코드 보장으로 쓰지 않기)",
        !/자동으로\s*재시도|automatically retries/i.test(ko + en),
        "과장 없음",
      ),
    ];
  },
};
