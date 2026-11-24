/**
 * 회귀: **켜진 플러그인의 스킬은 이름을 몰라도 찾아 쓴다** — 그리고 안 켜진 것은 «소속» 으로 안내하지 않는다 (2026-11-24 ⑥).
 *
 * 실측(설계 `docs/decisions/2026-11-24-plugin-skill-discovery.md` §2): 상시 인덱스가 캡을 넘으면 플러그인 스킬은 밀려나고
 *  머리말이 `find_skills` 로 보내는데, ①`find_skills` 는 질의를 통째 부분일치해 «화면 클릭» 같은 다단어에 0건이었고
 *  ②`find_capabilities` 는 플러그인 도구는 보여도 그 플러그인이 준 사용 절차(스킬)를 몰랐다.
 * 지키는 것: 다단어 낱말 검색 · 로드된 플러그인(관리자 LIVE 의 이름+폴더)만 [스킬] 항목 · 칸(reach)·자동 호출 금지·가려진 이름 ·
 *  응답 이름 상한 · 호출 시점 판정 · 세 어댑터가 같은 cwd·칸을 두 도구에 넘김. 등급: **실행**(자식 프로세스·하위 임시 홈).
 */
import { type Assertion, type RegressionCheck } from "./_framework.js";
import { runChildChecks } from "./_child-checks.js";

export const check: RegressionCheck = {
  name: "plugin-skill-discovery",
  guards:
    "캡 밖으로 밀린 활성 플러그인 스킬을 다단어 검색으로 못 찾고(`find_skills` 통짜 부분일치) `find_capabilities` 가 플러그인의 사용 절차를 안내하지 않던 것 + 그 안내가 로드되지 않은 폴더(번들 이름 사본·매니페스트 없음)·꺼진 플러그인·칸 밖·가려진 이름까지 «소속» 으로 내보내는 것",
  run: async (): Promise<Assertion[]> => runChildChecks(new URL("./_plugin-skill-discovery-child.ts", import.meta.url)),
};
