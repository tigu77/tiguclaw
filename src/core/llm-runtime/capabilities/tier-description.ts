/**
 * `tier` 인자 설명 — 매니저(`run_in_background`)와 서브에이전트(`spawn_agent`)가 **한 문구**를 쓴다 (2026-10-03).
 * ★두 도구가 각자 적으면 «무엇에 high 를 쓰나» 의 기준이 갈린다. 둘 다 `resolveModelChain` 으로 같은 해석을 한다.
 */
export const tierDescription = (who: "매니저" | "서브에이전트"): string =>
  `선택 — ${who} 모델 프로파일. settings.json 의 프로파일 이름(default/high/mid/low 또는 커스텀)을 쓰면 그 프로파일의 풀+폴백으로 실행되고, ` +
  "`provider:model` 직접 지정도 가능합니다(가용 프로파일은 작동 컨텍스트의 `## 모델 프로파일` 섹션 참고). " +
  "품질 중요(코드리뷰·설계·근본원인 분석)=high, 구현=mid, 단순·대량·요약=low. 미지정 시 기본 모델.";

/**
 * 등급이 **모델로 풀리는가** — 안 풀리면 거절 문구, 풀리면 undefined (2026-10-03 재검토 P1). 두 도구가 같이 쓴다.
 * ★풀리지 않는 등급(`sonnet`·없는 프로필 이름)은 종전에 **조용히 기본 모델**로 돌았다 — 카드엔 그 이름이 보이는데 실제는
 *  기본이고, 명세의 모델까지 덮었다. `default` 는 원래 «기본 모델» 이라 통과시킨다.
 */
export const unresolvableTierText = async (tier: string | undefined, cwd: string | undefined): Promise<string | undefined> => {
  if (tier === undefined || tier === "default") return undefined;
  const { resolveModelChain } = await import("../index.js");
  if (resolveModelChain(tier, cwd).length > 0) return undefined;
  return (
    `tier '${tier}' 를 모델로 풀 수 없습니다 — 작동 컨텍스트 \`## 모델 프로파일\` 의 이름이나 provider:model 을 주세요. ` +
    "(조용히 기본 모델로 돌리지 않습니다.)"
  );
};
