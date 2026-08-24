/**
 * 회귀: **프로파일별 추론 강도 오버라이드** — 파싱 · 운반 · 쓰기 (2026-08-24 사용자 요청).
 *
 * 요청: 같은 모델을 프로파일마다 다른 강도로. 종전엔 `models.reasoning` 이 **모델 단위
 * 전역**뿐이라 「깊게」와 「빠르게」가 같은 모델을 다르게 쓰는 걸 표현할 방법이 없었다.
 *
 * 층은 셋이고 **좁은 것이 이긴다**:
 *   풀 원소(이 프로파일의 이 모델) > `models.reasoning`(이 모델 전역) > 카탈로그 기본
 *
 * ★지키는 것은 "필드가 있나" 가 아니라 **조용한 실패** 셋이다:
 *  ①강도가 문자열 왕복에서 증발 — 이 기능 전엔 풀을 `join(",")` 로 만들어 **다시 파싱**했다.
 *   객체는 그 길을 통과할 수 없다(`[object Object]`). 그래서 왕복을 걷어냈고, 그게 되돌려지면
 *   강도만 조용히 사라진다(모델은 그대로 도니 아무도 모른다).
 *  ②비서가 "high 의 opus 를 중간으로" 를 받고 **전역**을 고쳐 다른 프로파일까지 바꾸는 것.
 *   tiguclaw 는 말로 다 되는 게 철학이라, 이 경로가 틀리면 기능이 반쪽이 아니라 **거짓말**이다.
 *  ③켜는 길만 있고 끄는 길이 없는 것(한 번 적은 값이 영영 남는 덫).
 *
 * ★등급: **행동 게이트**. 격리 홈에 실제 settings.json 을 쓰고 실물 해석기·쓰기 함수·MCP
 *  핸들러를 돌린다. 자식 프로세스인 이유는 `_profile-pool-reasoning-child.ts` 주석 참조
 *  (`getPaths()` 홈 동결 — `_model-reasoning-child` 와 같은 함정).
 */
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_profile-pool-reasoning-child.ts",
);

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "profile-pool-reasoning-"));
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
    encoding: "utf8",
    env: { ...process.env, TIGUCLAW_HOME: home },
  });
  let got: Record<string, unknown> = {};
  try {
    got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  } catch {
    got = {};
  }
  const tail = ((r.stderr ?? "").trim() + " " + String(got.error ?? "")).trim().slice(-300);

  // 자식이 못 돌면 그것부터 말한다 — 조용히 0건 통과하면 검사가 아니다.
  out.push(
    assert(
      "프로브가 실제로 돌았다(빈손 통과 금지)",
      Object.keys(got).length >= 16 && got.error === undefined,
      Object.keys(got).length >= 16 && got.error === undefined
        ? `${Object.keys(got).length}개 판정 회수`
        : `★프로브 실패: ${tail}`,
    ),
  );
  if (Object.keys(got).length < 12 || got.error !== undefined) return out;

  out.push(
    assert(
      "문자열·객체를 섞어 써도 한 모양(`{spec, reasoning?}`)으로 정규화된다",
      got.parsedShape === true,
      `parsedShape=${String(got.parsedShape)}`,
    ),
    assert(
      "★강도가 ModelSpec 까지 운반된다(문자열 왕복에서 증발하지 않는다)",
      got.carriedHigh === "max",
      `high 의 opus → ${String(got.carriedHigh)} (기대 max)`,
    ),
    assert(
      "★같은 모델이 프로파일마다 다른 강도를 갖는다(이 기능의 존재 이유)",
      got.carriedHigh === "max" && got.carriedQuick === "low",
      `high=${String(got.carriedHigh)} quick=${String(got.carriedQuick)}`,
    ),
    assert(
      "★메인 턴 경로(기본 프로파일)에서도 강도가 살아 간다 — 제일 자주 지나는 자리다",
      got.mainTurn === "max",
      `resolveModelSpecs → ${String(got.mainTurn)} (기대 max)`,
    ),
    assert(
      "안 덮은 원소는 강도를 안 싣는다(전역·카탈로그로 내려간다)",
      got.uncoveredIsUndefined === true,
      `uncovered=${String(got.uncoveredIsUndefined)}`,
    ),
    assert(
      "★비서가 프로파일을 지정하면 **그 프로파일만** 바뀐다",
      got.toolOk === true && got.quickAfter === "high" && got.highUntouched === "max",
      `ok=${String(got.toolOk)} quick=${String(got.quickAfter)} high=${String(got.highUntouched)}`,
    ),
    assert(
      "★전역 `models.reasoning` 과 옆 키(hooks)를 안 건드린다",
      got.globalUntouched === "medium" && got.hooksKept === true,
      `global=${String(got.globalUntouched)} hooks=${String(got.hooksKept)}`,
    ),
    assert(
      "어느 층이 이기는지 말한다(조용한 무시 금지)",
      typeof got.toolText === "string" && String(got.toolText).includes("이깁니다"),
      typeof got.toolText === "string" ? String(got.toolText).split("\n").pop() ?? "" : "-",
    ),
    assert(
      "해제하면 문자열로 되돌린다(끄는 길이 있다 · 빈 껍데기 금지)",
      got.clearedToString === true,
      `cleared=${String(got.clearedToString)}`,
    ),
    assert(
      "★없는 프로파일·없는 모델엔 쓰지 않고, 도구가 그 사실을 말한다",
      got.noProfileWrite === false && got.noModelWrite === false && got.toolRefuses === true,
      `profile=${String(got.noProfileWrite)} model=${String(got.noModelWrite)} 도구거부=${String(got.toolRefuses)}`,
    ),
    assert(
      "★프로젝트 층이 같은 이름 프로파일로 덮고 있으면 **됐다고 말하지 않는다**",
      got.projectShadowRefused === true && got.projectShadowEffective === "low",
      got.projectShadowRefused === true
        ? `거부 + 유효값 ${String(got.projectShadowEffective)} 유지`
        : `★"됐습니다" 라고 답함 — 유효값=${String(got.projectShadowEffective)}`,
    ),
    assert(
      "그 거부가 **어디를 고쳐야 하는지** 말한다(조용한 무시 금지)",
      typeof got.projectShadowText === "string" &&
        String(got.projectShadowText).includes(".tiguclaw/settings.json"),
      typeof got.projectShadowText === "string"
        ? String(got.projectShadowText).split("\n")[0].slice(0, 70)
        : "-",
    ),
    assert(
      "프로파일 미지정이면 종전대로 전역에 쓴다(회귀 0)",
      got.globalStillWorks === "high",
      `global(sol)=${String(got.globalStillWorks)}`,
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "profile-pool-reasoning",
  guards:
    "프로파일별 추론 강도 — 강도가 문자열 왕복에서 증발하거나, 비서가 프로파일 요청을 전역에 써서 다른 프로파일까지 바꾸거나, 끄는 길이 없던 것",
  run,
};
export default check;
