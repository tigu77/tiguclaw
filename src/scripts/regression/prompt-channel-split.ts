/**
 * 회귀: **안정 조각은 시스템 채널, 휘발 조각만 user 채널** (2026-07-30).
 *
 * 사고(실측): 조립 프리픽스 48.8KB 전부가 input 배열의 **맨 끝**(현재 턴)에 실려 있었다.
 * 프리픽스 캐시는 앞에서만 매칭하므로 구조적으로 캐시 불가 — codex `cachedTokens` 가
 * 거의 모든 턴 정확히 3,456(= instructions 뿐)이었고 단일턴 적중률 11.7%. "압축
 * 따라잡기가 끝나면 오른다"는 예측은 틀렸다(36.7% → 37.0%, 분자·분모가 함께 줄어
 * 비율이 원리적으로 안 움직였다).
 *
 * 그래서 안 변하는 조각(SYSTEM.md·AGENT.md·스킬/에이전트 인덱스·모델 프로파일 ≈76%)만
 * 시스템 채널로 올렸다. 되돌아가기 쉬운 변경이라(슬롯 하나의 channel 한 글자) 그물을 건다.
 *  - 순수: 슬롯이 제 채널에 가고, 어느 쪽에도 **중복 적재되지 않는다**(중복=이중 과금).
 *  - 배선: 세 어댑터가 실제로 그 값을 시스템 채널 필드에 넣는다 — 순수 함수만 보면
 *    호출부를 지워도 초록이다(_wiring.ts 참조).
 */
import {
  composeSystemChannel,
  splitSystemContext,
} from "../../core/prompt-assembly.js";
import { formatSkillIndex } from "../../core/llm-runtime/capabilities/skill-registry.js";
import { recordSkillInvocation } from "../../store/skill-usage.js";
import { sourceHas } from "./_wiring.js";
import {
  assert,
  assertIsolated,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

/** 슬롯마다 유일 마커 — 어느 채널로 갔는지 문자열 검색으로 판정한다. */
const MARK = {
  system: "@@SYSTEM_MD@@",
  env: "@@ENV@@",
  agent: "@@AGENT_MD@@",
  agentWarn: "@@AGENT_WARN@@",
  convoContext: "@@CONVO@@",
  memoryIndex: "@@MEM_INDEX@@",
  memorySnippet: "@@MEM_SNIPPET@@",
  skillIndex: "@@SKILLS@@",
  agentIndex: "@@AGENTS@@",
  modelProfiles: "@@PROFILES@@",
  foreignDelta: "@@FOREIGN@@",
} as const;

/** 입력 필드가 아니라 슬롯 테이블이 직접 만드는 조각 — 마커도 실제 본문에서 딴다. */
const PATH_HINT_MARK = "당신의 AGENT.md 실제 경로";

/** 시스템 채널에 있어야 하는 것 = 턴 사이에 안 변하는 것. */
const STABLE = [
  MARK.system,
  PATH_HINT_MARK,
  MARK.agent,
  MARK.agentWarn,
  MARK.skillIndex,
  MARK.agentIndex,
  MARK.modelProfiles,
];
/** user `<system-reminder>` 에 남아야 하는 것 = 턴마다 변하는 것. */
const VOLATILE = [
  MARK.env,
  MARK.convoContext,
  MARK.memoryIndex,
  MARK.memorySnippet,
  MARK.foreignDelta,
];

export const check: RegressionCheck = {
  name: "prompt-channel-split",
  guards:
    "조립 프리픽스가 통째로 user 턴 끝에 실려 프리픽스 캐시가 구조적으로 불가하던 것(적중률 11.7%)",
  run: async (): Promise<Assertion[]> => {
    // ★타입이 강제한다 — `SystemContextInput` 에 슬롯이 추가되면 이 리터럴이 컴파일
    //  에러가 나서, 새 조각을 그물 밖에 두고 지나갈 수 없다.
    const full = {
      system: MARK.system,
      env: MARK.env,
      agent: MARK.agent,
      agentWarn: MARK.agentWarn,
      convoContext: MARK.convoContext,
      memoryIndex: MARK.memoryIndex,
      memorySnippet: MARK.memorySnippet,
      skillIndex: MARK.skillIndex,
      agentIndex: MARK.agentIndex,
      modelProfiles: MARK.modelProfiles,
      foreignDelta: MARK.foreignDelta,
    };
    const { stable, volatileParts } = splitSystemContext(full);
    const volatile = volatileParts.join("\n\n");

    const misplacedStable = STABLE.filter((m) => !stable.includes(m));
    const misplacedVolatile = VOLATILE.filter((m) => !volatile.includes(m));
    // 중복 적재 = 두 채널에 같은 조각이 다 실림(토큰 이중 과금 + 캐시 이득 상쇄).
    const duplicated = [...STABLE, ...VOLATILE].filter(
      (m) => stable.includes(m) && volatile.includes(m),
    );

    const out: Assertion[] = [
      assert(
        "★안정 조각(SYSTEM.md·AGENT.md·스킬/에이전트 인덱스·프로파일)이 시스템 채널로 간다",
        misplacedStable.length === 0,
        misplacedStable.length === 0 ? `${STABLE.length}개 전부` : `누락 ${misplacedStable.join(",")}`,
      ),
      assert(
        "★휘발 조각(env·대화 컨텍스트·메모리·foreign delta)은 user 채널에 남는다",
        misplacedVolatile.length === 0,
        misplacedVolatile.length === 0
          ? `${VOLATILE.length}개 전부`
          : `누락 ${misplacedVolatile.join(",")}`,
      ),
      assert(
        "어느 조각도 두 채널에 중복 적재되지 않는다(이중 과금)",
        duplicated.length === 0,
        duplicated.length === 0 ? "중복 0" : `중복 ${duplicated.join(",")}`,
      ),
      // ★분류 누락 방지 — 슬롯을 추가하면서 STABLE/VOLATILE 갱신을 잊으면 위 두 단언은
      //  그 조각을 **아예 안 본다**(손으로 관리하는 목록의 전형적 구멍). 총수를 강제해
      //  "고치지 않으면 빨간불" 로 만든다. 어느 채널이 옳은지는 사람이 정하되, 정하지
      //  않고 지나가는 건 막는다.
      assert(
        "모든 슬롯이 둘 중 한 채널로 분류돼 있다(새 조각이 그물 밖에 남지 않는다)",
        STABLE.length + VOLATILE.length === Object.keys(full).length + 1,
        `분류 ${STABLE.length + VOLATILE.length} vs 슬롯 ${Object.keys(full).length + 1}(=입력 ${Object.keys(full).length} + agentPathHint)`,
      ),
    ];

    // ★블록 *안*의 순서도 캐시 성질이다 — 프리픽스는 앞에서만 매칭하므로 "가장 안 변하는
    //  것이 앞". 특히 AGENT.md(비서가 수시로 Edit)가 스킬·에이전트 인덱스보다 앞에 오면
    //  한 줄 수정이 뒤따르는 28KB 를 통째로 무효화한다. 소속만 검사하면 재배열이 그냥 통과한다.
    const at = (m: string): number => stable.indexOf(m);
    out.push(
      assert(
        "★안정 블록 안에서 SYSTEM.md 가 맨 앞, AGENT.md 3인방이 꼬리",
        at(MARK.system) < at(MARK.skillIndex) &&
          at(MARK.skillIndex) < at(MARK.agentIndex) &&
          at(MARK.agentIndex) < at(MARK.modelProfiles) &&
          at(MARK.modelProfiles) < at(MARK.agent) &&
          at(MARK.agent) < at(MARK.agentWarn),
        `system=${at(MARK.system)} skill=${at(MARK.skillIndex)} agentIdx=${at(MARK.agentIndex)} profiles=${at(MARK.modelProfiles)} agent=${at(MARK.agent)} warn=${at(MARK.agentWarn)}`,
      ),
    );

    // 빈 슬롯(depth≥1 의 agentIndex/modelProfiles, leanMemory 의 메모리 등)은 양쪽에서 제거.
    const lean = splitSystemContext({
      system: MARK.system,
      env: "",
      agent: MARK.agent,
      agentWarn: "",
      convoContext: "",
      memoryIndex: "",
      memorySnippet: "",
      skillIndex: MARK.skillIndex,
      agentIndex: "",
      modelProfiles: "",
    });
    out.push(
      assert(
        "빈 슬롯은 양쪽에서 제거된다(빈 줄만 남는 헤더 0)",
        lean.volatileParts.length === 0 &&
          !lean.stable.includes("\n\n\n") &&
          lean.stable.includes(MARK.skillIndex),
        `user ${lean.volatileParts.length}파트 / system ${lean.stable.length}자`,
      ),
    );

    // 조립 규약 — 빈 안정 조각에 구분자만 덧붙는 일이 없다(lean child 경로).
    out.push(
      assert(
        "안정 조각이 없으면 sysprompt 그대로(빈 구분자 0)",
        composeSystemChannel("SYS", "") === "SYS" &&
          composeSystemChannel("SYS", "X") === "SYS\n\nX",
        JSON.stringify(composeSystemChannel("SYS", "")),
      ),
    );

    // ★배선 — 세 어댑터가 실제로 시스템 채널에 꽂는다. 순수 함수만 보면 호출부를 지워도 초록.
    //  ★게이트웨이 override 가드 2개(`!== undefined` = 스캐폴딩 조립 스킵, `??` = 시스템
    //   채널 대체)를 **명시로 요구**한다. 이게 없으면 중립 앱 호출에 SYSTEM.md·AGENT.md·
    //   메모리가 새는데, 순수 함수 단언으로는 그 회귀가 잡히지 않는다(도달 불가 경로라서).
    const OVERRIDE_GUARDS: RegExp[] = [
      /input\.systemPromptOverride !== undefined/,
      /input\.systemPromptOverride \?\?/,
    ];
    const wirings: Array<[string, string, RegExp[]]> = [
      [
        "codex",
        "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
        [
          /splitSystemContext\(\{/,
          /composeSystemChannel\(/,
          /^\s+instructions,$/m,
          /assembleUserPrompt\(volatileParts, userTurnParts\)/,
          ...OVERRIDE_GUARDS,
        ],
      ],
      [
        "claude",
        "../../core/llm-runtime/adapters/claude-agent-sdk.ts",
        [
          /splitSystemContext\(\{/,
          /composeSystemChannel\(SYSTEM_PROMPT, stableContext\)/,
          /systemPrompt: systemChannel,/,
          /assembleUserPrompt\(volatileParts, userTurnParts\)/,
          ...OVERRIDE_GUARDS,
        ],
      ],
      [
        "openai",
        "../../core/llm-runtime/adapters/openai-agents-sdk.ts",
        [
          /splitSystemContext\(\{/,
          /composeSystemChannel\(SYSTEM_PROMPT, stableContext\)/,
          /^\s+instructions,$/m,
          /assembleUserPrompt\(volatileParts, userTurnParts\)/,
          ...OVERRIDE_GUARDS,
        ],
      ],
    ];
    for (const [name, rel, patterns] of wirings) {
      const { ok, missing } = await sourceHas(rel, patterns);
      out.push(
        assert(
          `★${name} 어댑터가 안정 조각을 시스템 채널에 배선한다`,
          ok,
          ok ? `${patterns.length}개 배선 확인` : `누락 ${missing.join(" ")}`,
        ),
      );
    }

    // ★"안정"이 말뿐이면 이 커밋의 이득은 0 이다 — 스킬 인덱스는 캡(40)을 넘는 순간
    //  사용빈도순으로 재정렬되던 자리라, invoke_skill 한 번이 다음 턴 프리픽스를 바꿔
    //  30KB 캐시를 통째로 깨뜨렸다. 빈도는 *선정*에만 쓰고 표시는 discover 순서여야 한다.
    //  배치 단언은 전부 초록인 채로 이게 깨질 수 있으므로 별도 그물이 필요하다.
    assertIsolated(); // skill_usage 행을 쓰므로 라이브 홈 오염 방지.
    const many = Array.from({ length: 45 }, (_, i) => ({
      name: `regr-skill-${String(i).padStart(2, "0")}`,
      description: "회귀용",
      source: "user" as const,
      path: `/tmp/regr/${i}`,
    }));
    const before = formatSkillIndex(many as never);
    // ★상위 40 **안**의 스킬을 쓴다 — 선정 집합은 그대로 두고 랭킹만 흔드는 게
    //  종전에 렌더 순서를 바꾸던 실제 시나리오다(캡 밖 스킬을 쓰면 집합이 진짜로
    //  바뀌므로 문자열이 달라지는 게 맞다 — 그건 회귀가 아니다).
    recordSkillInvocation("regr-skill-39", 1);
    recordSkillInvocation("regr-skill-39", 2);
    recordSkillInvocation("regr-skill-00", 3);
    const after = formatSkillIndex(many as never);
    out.push(
      assert(
        "★캡 초과 스킬 인덱스가 사용빈도로 재정렬되지 않는다(안정 = 바이트 동일)",
        before === after && before.includes("regr-skill-00"),
        before === after ? `${before.length}자 불변` : "사용 1회에 프리픽스가 바뀜",
      ),
    );
    return out;
  },
};
