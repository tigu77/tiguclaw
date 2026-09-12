/**
 * openai 어댑터의 **Agent 조립** — 돌려서 잴 수 있는 자리 (2026-09-12, 외부 사냥 H1·H2).
 *
 * ── 왜 꺼냈나 ─────────────────────────────────────────────────────────────────────
 *
 * 조립이 `runOpenAi` 안 인라인이었다. 그래서 그물이 **모양으로밖에** 못 쟀고, 사냥이 그 축으로
 * 둘을 뚫었다(둘 다 스위트 3,268건 **초록**):
 *
 *     H1  openaiSpeedSettings(input.speed, conn.baseURL)  →  (…, undefined)
 *         ⇒ compat 백엔드(ollama·gemini)에도 `service_tier` 가 실려 나간다. 그런데 화면은
 *           «이 provider 는 안 읽음» 이라고 말한다 — 요청과 화면이 정확히 어긋난다.
 *         ⇒ AST 검사가 **첫 인자만** 봤다(claude 쪽엔 있던 인자 개수 검사가 여기엔 없었다).
 *
 *     H2  Object.keys(modelSettings).length > 0  →  > 99
 *         ⇒ «빠름» 이 한 번도 안 나간다. 형제 `reasoning` 도 같이 죽는다(같은 객체다).
 *         ⇒ 검사가 스프레드 **조건식 안에 낱말이 있는지**만 봤다. 조건이 영원히 거짓이어도
 *           문자열은 그대로다.
 *
 * ★둘 다 «술어가 엉성해서» 가 아니라 **모양으로 재서** 뚫렸다. 그래서 술어를 더 얹지 않고
 *  **자리를 옮긴다** — 형제 `adapterInputFor`(2026-09-12 #3)·`createFastModeReporter` 와 같은 수다.
 * ★여기서 멈추지 않고 **`Agent` 인스턴스까지** 만든다. 옵션 객체만 돌려주면 «그 옵션이 정말
 *  SDK 로 가는가» 라는 마지막 한 뼘이 다시 모양 판정이 된다. 생성까지 하면 회귀가
 *  `agent.modelSettings` 를 **읽어서** 확인한다(실측: SDK 가 그 자리에 그대로 보관한다).
 *
 * ── ★기본값을 지우지 않는다 (같은 날 발견, 자초) ──────────────────────────────────
 *
 * agents SDK 는 `modelSettings` 를 **넘기는 순간 자기 기본값을 통째로 버린다**
 * (`agent.js`: `config.modelSettings ?? getInitialModelSettingsForAgentModel(model)`).
 * 실측:
 *
 *     생략        → { reasoning: { effort: "low" }, text: { verbosity: "low" } }
 *     { } 를 넘김 → { }                                   ← 기본이 사라진다
 *
 * 그래서 «빠름» 만 켠 턴이 **모델별 기본 추론 강도·verbosity 를 조용히 잃고** 있었다(2026-09-12
 * N6 이 만든 자초다). 그리고 그 전부터 — 강도를 넘길 때마다 `text.verbosity` 기본이 같은
 * 방식으로 날아가고 있었다(2026-08-15 부터).
 *
 * ★고침은 **벤더 값을 베이스로 깔고 우리 것을 얹는 것**이다. 기본값을 우리가 흉내 내 적지
 *  않는다 — 그건 손 목록이고 벤더가 바꾸는 날 갈린다([[feedback_hand_maintained_lists]]).
 *  SDK 가 `getDefaultModelSettings` 를 export 하므로 **정확한 값이 이미 있다.**
 * ★우리가 정한 게 **하나도 없으면 여전히 생략한다** — 종전과 바이트 동일(회귀 0).
 */
import { Agent, getDefaultModelSettings } from "@openai/agents";
import { openaiSpeedSettings } from "./_openai-speed.js";

/** 이 조립이 읽는 것만 받는다 — 전체 `RegionASdkInput` 을 끌고 오면 검사가 턴을 지어야 한다. */
export interface OpenAiAgentArgs {
  name: string;
  instructions: string;
  /** 모델 **이름**(문자열). compat 경로에서도 이름은 문자열이다 — 벤더 기본값 조회에 쓴다. */
  model: string;
  /** `Agent.model` 에 실제로 꽂히는 것 — 정품은 이름 문자열, compat 은 Model 인스턴스. */
  modelArg: unknown;
  mcpServers: readonly unknown[];
  /** 턴 입력 중 **이 조립이 읽는 것**. `conn` 과 짝으로 받아야 «어느 연결인가» 가 여기서 갈린다. */
  input: { readonly speed?: string | undefined };
  /** provider 연결. ★`baseURL` 만 떼어 받지 않는다 — 그러면 H1 이 호출부로 도망간다. */
  conn: { readonly baseURL?: string | undefined };
  /** 풀 원소 > 전역 > 카탈로그로 이미 해석된 강도. 없으면 벤더 기본이 산다. */
  reasoningEffort: string | undefined;
  externalTools: readonly unknown[];
  externalToolNames: readonly string[];
}

/**
 * 이 턴이 SDK 에 넘길 `modelSettings` — **우리가 정한 게 없으면 `undefined`**(= 키 생략).
 *
 * 별도 export 인 이유: 회귀가 «생략» 과 «빈 객체» 를 갈라 재야 하는데, `Agent` 를 통해 보면
 * 둘 다 관측은 되지만 그 구분이 벤더 기본값 유무로 **간접**으로만 드러난다. 여기선 직접 본다.
 */
export const openAiModelSettings = (
  args: Pick<OpenAiAgentArgs, "model" | "input" | "conn" | "reasoningEffort">,
): Record<string, unknown> | undefined => {
  const ours = {
    // 유효값 판정은 API 에 맡긴다(codex·claude 와 같은 규칙) — 우리가 흉내 낸 목록은
    // 벤더가 새 등급을 내놓을 때 멀쩡한 값을 막는다.
    ...(args.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: args.reasoningEffort } }),
    // «빠름» — claude·codex 와 같은 중립 신호를 이 백엔드의 낱말로. compat 은 제외된다.
    ...openaiSpeedSettings(args.input.speed, args.conn.baseURL),
  };
  if (Object.keys(ours).length === 0) return undefined;
  return { ...getDefaultModelSettings(args.model), ...ours };
};

/** 이 턴의 `Agent` — 조립·생성을 한 자리에 둔다(옵션만 돌려주면 마지막 한 뼘이 다시 사각이다). */
export const createOpenAiAgent = (args: OpenAiAgentArgs): Agent => {
  const modelSettings = openAiModelSettings(args);
  return new Agent({
    name: args.name,
    instructions: args.instructions,
    model: args.modelArg as never,
    mcpServers: args.mcpServers as never,
    ...(modelSettings === undefined ? {} : { modelSettings }),
    // externalTools 패스스루(§2.3) — 미지정/빈 배열이면 두 필드 모두 생략(스프레드 {} =
    // 현행과 바이트 동일 Agent 구성, 회귀 0). toolsNone 게이팅과 무관 — mcpServers 축과
    // 별개 필드라 tiguclaw 도구가 꺼져도 앱 함수는 그대로 노출된다(ADR §Decision-1 3항).
    ...(args.externalTools.length > 0
      ? {
          tools: args.externalTools as never,
          toolUseBehavior: { stopAtToolNames: [...args.externalToolNames] },
        }
      : {}),
  });
};
