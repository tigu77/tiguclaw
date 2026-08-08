/**
 * 회귀: **삼킨 실패는 화면과 로그 양쪽에 남는다** (2026-08-08).
 *
 * 실측(윈도우): 도구 8종을 5분 쓰던 턴이 codex SSE `terminated` 로 끊겼다. 사용자 화면엔
 * **"네, M6-a 부터 시작하겠습니다…" 90자만** 남았고 — 조기 종료와 구분이 안 된다 — 실패
 * 문구는 저장 경로로만 갔다. 그날 데몬 로그 61줄 중 관련 줄은 **0**이었다.
 *
 * 뿌리는 `sideEffectExecuted` 분기다. 부작용(도구 실행)이 이미 났으면 throw 하지 않고
 * **에러를 답장 텍스트로 바꿔** 정상 종료시킨다 — 폴백이 도구를 중복 실행하는 걸 막는
 * **옳은 설계**다. 문제는 바꾸면서 ①로그를 안 남기고 ②`finalText` 를 **덮어써서** 이미
 * 스트리밍된 텍스트가 화면에 그대로 남는다는 것이었다.
 *
 * ★사용자가 끊긴 걸 알아야 "이어서 해줘" 라고 말할 수 있다. 그게 이 검사의 목적이다.
 * 3주간 삼킴이 13건(전체 발화의 2.3%)이었고 12건은 사유조차 답장 문구를 긁어야 알았다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "swallowed-failure-visible",
  guards:
    "부작용 뒤 삼킨 실패가 화면(delta)과 로그 양쪽에 드러난다 — 조기 종료로 오인되지 않게",
  run: async (): Promise<Assertion[]> => {
    const src = await readFile(
      new URL(
        "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
        import.meta.url,
      ),
      "utf8",
    );
    // 삼킴 분기 본문만 잘라서 본다 — 파일 어딘가에 있는 게 아니라 **이 분기 안에** 있어야 한다.
    const start = src.indexOf("if (sideEffectExecuted) {");
    const body = start === -1 ? "" : src.slice(start, start + 3500);

    return [
      assert(
        "삼킴 분기가 존재한다(검사가 빈손으로 통과하지 않는다)",
        start !== -1,
        start === -1 ? "★분기 없음" : `offset ${start}`,
      ),
      assert(
        "★삼키기 전에 로그를 남긴다 — 사용자만 알고 운영자는 모르는 실패를 없앤다",
        /console\.error\([\s\S]{0,200}codex-swallowed/.test(body),
        /codex-swallowed/.test(body) ? "로그 있음" : "★로그 없음",
      ),
      assert(
        "★로그에 판정 수치가 실린다(증상만 적힌 로그는 두 번째로 볼 때 쓸모없다)",
        /iter=\$\{iteration\}/.test(body) &&
          /tools=\$\{executedToolNames\.size\}/.test(body) &&
          /shown=\$\{shown\.length\}/.test(body),
        "iter·tools·shown",
      ),
      assert(
        "★실패 문구가 **화면(delta)** 으로도 나간다 — 저장본만 고치면 화면은 그대로다",
        /deltaStream\.push\([\s\S]{0,80}notice\)/.test(body) &&
          /deltaStream\.flush\(\)/.test(body),
        "delta push+flush",
      ),
      assert(
        "★이미 스트리밍된 텍스트를 **덮어쓰지 않고 뒤에 붙인다**(잘린 문장만 남지 않게)",
        /finalText = shown !== ""/.test(body) && /\$\{shown\}/.test(body),
        "append",
      ),
      assert(
        "일반 실패 안내가 **이어가는 법**을 알려준다(사용자가 다음 행동을 알 수 있게)",
        /이어서 진행해줘/.test(body),
        "이어가기 안내",
      ),
    ];
  },
};
