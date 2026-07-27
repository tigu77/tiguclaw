/**
 * 라우터 — 입력 메시지를 LLM 런타임으로 dispatch.
 *
 * 진실 소스: `_workspace/region_unification_architect_contract.md` (결정 1·2).
 * V8 영역 통합: 영역 A/B 구분·prefix·분류 전부 폐기. 단일 파이프라인 pass-through.
 * 깊은 사고는 prefix 가 아니라 비서가 부리는 능력(서브에이전트 모델 지정 경로).
 */
import type { IncomingMessage } from "../channels/types.js";
import type { SteeringChannel } from "./steering.js";
import {
  clearSessionModelOverride,
  getSessionModelOverride,
  getSessionModelProfile,
  setSessionChannelMeta,
  SESSION_STORAGE_CHANNEL,
} from "../store/sessions.js";
import { resolveSessionId } from "./threadkey.js";
import { runClaude } from "./claude.js";
import { parseModelSpecList } from "./llm-runtime/index.js";
import { resolveProfileChain } from "./settings.js";
import { getRegisteredMcpServers } from "./mcp-registry.js";

export interface RouteOutput {
  text: string;
  /**
   * 이 턴에 **실제로 응답한 모델**(어댑터가 보고하면). 요청한 프로파일이 아니라 결과다 —
   * 폴백·쿨다운으로 갈리므로 관측·표시는 이 값을 써야 한다(2026-07-27).
   * 미보고 어댑터는 생략(거짓값 금지).
   */
  model?: string;
  /**
   * LLM 런타임 output 에서 그대로 전달 — 이 turn 응답을 트리거 메시지 직접 답글로 마킹.
   */
  replyToTrigger?: boolean;
  /**
   * 세션 모델 override 가 런타임에 거부되어 자동 폴백했음을 호출자에게 통과.
   * (고지 문구는 이미 text 에 facade 가 덧붙였음 — 이 필드는 관측/메타 용.)
   */
  modelOverrideRejected?: { requested: string; fellBackTo: string };
}

export const route = async (
  msg: IncomingMessage,
  // 2층 턴 타임아웃 신호 (additive, 2026-06-17). 핸들러가 턴당 AbortController 의
  // signal 을 운반 → runRegionA(input.abortSignal) → 어댑터가 1층 idle AC 와 OR 결합.
  // 미전달(스케줄러 등 비채널 turn) = undefined = 현행 1층-only 동작 그대로(회귀 0, TT-I7).
  // router 는 신호를 *소비하지 않고 그대로 운반만* 한다(router 순수성 유지).
  //
  // toolPolicy (additive, 2026-06-18, custom-endpoints contract §7-3): 이 턴에 적용할
  // 도구 정책. 커스텀 HTTP 엔드포인트(restricted=mode:none)가 무인 full-turn 의 blast
  // radius 를 가두기 위해 주입한다. abortSignal 운반과 완전 동형 — router 는 값을
  // *소비/해석하지 않고* runClaude input.toolPolicy 로 그대로 운반만 한다(router 순수성).
  // 미전달(채널·스케줄러 등 기존 호출자) = undefined = 전체 도구 = 현행 동작(회귀 0).
  opts?: {
    abortSignal?: AbortSignal;
    toolPolicy?: { mode: "none" } | { mode: "allow"; names: string[] };
    // mid-turn steering (additive, 2026-07-16, ADR 2026-07-16-midturn-steering §5). 핸들러가
    // turn 별 SteeringChannel 을 만들어 운반 → runClaude input.steering 으로 그대로 전달(router
    // 순수성 — 소비/해석 0, abortSignal·toolPolicy 운반과 동형). 미전달(STEERING_ENABLED off·
    // 스케줄러·워커 등) = undefined = 어댑터 미주입 = 현행 동작(회귀 0).
    steering?: SteeringChannel;
    // ── 채널/세션 분리 (ADR 2026-07-15 §D1/§D2/§D3) — 웨이브2b(daemon 채널)가 채운다 ──
    // 채널이 자기 정체성을 threadKey 에 인코딩하던 것을 코어 resolver 단일 정의점으로 대체.
    //
    // ★계약(웨이브2b): 실제 채널(telegram/cli/대시보드/http)은 이 `session` 을 넣어
    //   route() 에 인입을 세션으로 정규화하라고 지시한다. 넣으면 route() 는:
    //     1) sessionId = resolveSessionId(msg.channel, channelAddress, explicitSessionId)
    //        - 셀렉터 없는 채널(telegram·cli·http default): explicitSessionId 생략
    //          → DEFAULT_SESSION_ID(기본 세션). 대시보드: 활성 탭 세션 id 를 explicitSessionId
    //          로 전달 → 그대로 통과.
    //     2) 세션-정체성(resume/context/summaries/model override)을 (SESSION_STORAGE_CHANNEL,
    //        sessionId) 로 read/write — 인입 채널이 아니라 **세션의 함수(canonical 상수)** 로
    //        키잉해야 기존 dashboard 기본 세션의 resume/transcripts 를 계승(파편화 0).
    //     3) 표시·감사(activity·delta·chat_log·outbound)는 msg.channel(실채널) 유지 +
    //        setSessionChannelMeta 로 last_channel/target 캡처(비동기 outbound 기본 목적지).
    //   ★큐 정합: 웨이브2b 는 enqueueThreadTurn(직렬 큐)·inflightTurns(/stop)가 sessionId
    //     단독 키로 돌도록, route() 호출 **전에** msg.threadKey = sessionId 로 세팅해야 한다
    //     (resolveSessionId 는 순수·멱등이라 채널·route 가 같은 sessionId 를 본다).
    //
    // ★미전달(스케줄러·워커·서브에이전트·file-watch·엔드포인트·웨이브2b 이전 채널) →
    //   현행 동작: msg.threadKey 를 세션 id 로, msg.channel 로 세션-정체성 저장(회귀 0).
    //   §0 단방향: route() 는 채널명으로 분기하지 않는다 — 셀렉터 유무는 호출부가
    //   explicitSessionId 전달 여부로 표현하고, canonical 상수는 store 소유.
    session?: {
      /** 세션 셀렉터가 있는 채널(대시보드 활성 탭)이 명시한 세션 id. 없으면 DEFAULT. */
      explicitSessionId?: string;
      /** 배달 좌표(telegram chatId, http threadKey). resolver (b)확장점 + 메타 캡처·outbound. */
      channelAddress?: string;
    };
  },
): Promise<RouteOutput> => {
  // 세션 정체성 정규화 (opt-in) — 위 계약 참조. 미전달이면 현행 passthrough(회귀 0).
  const normalize = opts?.session !== undefined;
  const channelAddress = opts?.session?.channelAddress ?? msg.channelAddress;
  const sessionId = normalize
    ? resolveSessionId(
        msg.channel,
        channelAddress,
        opts?.session?.explicitSessionId,
      )
    : msg.threadKey;
  // 세션-정체성 저장 채널 — 정규화 시 canonical 상수(세션의 함수), 아니면 인입 채널(현행).
  const sessionChannel = normalize ? SESSION_STORAGE_CHANNEL : msg.channel;
  // 세션 모델 override (`/model <provider:model[,provider:model...]>` 로 설정) 조회.
  // 콤마 멀티스펙 풀 지원(2026-06-02) — 단일에서 풀로 확장.
  // 있으면 풀(여러 spec)로 runClaude 에 주입 → resolveModelSpecs 가 opts.specs 우선
  // → env 폴백 무시. runPool 이 풀 순서대로 시도(첫 성공 반환) → 풀 내 폴백은 이미 됨.
  // 빈 풀(유효 0) → specs 미주입 → 기존 동작(REGION_A_MODELS env 풀) 그대로.
  // override 풀 *전체*가 모델거부로 소진되면 facade 가 env 풀로 1회 폴백 +
  // modelOverrideRejected 신호 → 아래에서 깨진 override DB clear (의미 불변).
  // canonical 저장(`/model` 핸들러) 덕에 parseModelSpecList 는 항상 성공이나, DB 에
  // 구버전 무효 문자열이 남아있을 가능성 대비 빈 풀 가드 유지(env 폴백).
  // 세션-정체성 키 = (sessionChannel, sessionId) — override 조회도 canonical 키로.
  const overrideRaw = getSessionModelOverride(sessionChannel, sessionId);
  let overridePool =
    overrideRaw !== null ? parseModelSpecList(overrideRaw) : [];
  // ── 세션 모델 *프로파일* override (대시보드 드롭다운, 2026-07-19, ADR
  //    _workspace/model-dropdown_architect_contract.md §2). raw `/model` override 가
  //    **없을 때만**(precedence: raw override > 세션 프로파일 > 전역 default) 진입 →
  //    위 raw 경로는 바이트 불변(회귀 0). 저장값은 프로파일 *이름*(constraint 3);
  //    해석은 코어(resolveProfileChain, constraint 1). 미지/댕글링 이름 → 빈 chain →
  //    specs 미주입 → resolveModelSpecs 가 전역 default 프로파일로 자연 폴백(constraint 2).
  //    chain[0](자기 pool)만 사용 = 메인 턴 resolveModelSpecs 와 동일 semantic.
  let appliedProfile: string | null = null; // route 로그·관측용(QA anchor).
  if (overridePool.length === 0) {
    const profileName = getSessionModelProfile(sessionChannel, sessionId);
    if (profileName !== null) {
      const chain = resolveProfileChain(profileName, process.cwd());
      if (chain.length > 0) {
        const pool = parseModelSpecList(chain[0].join(","), process.cwd());
        if (pool.length > 0) {
          overridePool = pool;
          appliedProfile = profileName;
        }
      }
    }
  }

  const out = await runClaude(
    {
      text: msg.text,
      // 세션 id — 정규화 시 resolveSessionId 결과(채널 무관), 아니면 현행 threadKey.
      // 어댑터·런타임의 세션-정체성/활동 좌표가 이 값을 세션 단위 키로 본다.
      threadKey: sessionId,
      // 실채널(표시·감사·outbound·prompt 좌표) — 정체성/표시 2분리(§D3).
      channel: msg.channel,
      // 세션-정체성 저장 채널(canonical) — 정규화 시에만 실어보냄. 미지정 → 어댑터가
      // channel 폴백(회귀 0). 어댑터의 getSession/loadThreadHistory/saveSession 등이 이 값을 봄.
      ...(normalize ? { sessionChannel } : {}),
      // 배달 좌표 캡처 — notifyDestFromCoords 가 세션 id 파싱 대신 우선 사용(§D3).
      ...(channelAddress !== undefined ? { channelAddress } : {}),
      attachments: msg.attachments,
      sendAttachment: msg.sendAttachment,
      // 축1(2026-06-25) — 선택지 제시 클로저를 sendAttachment 와 동일 경로로 운반.
      presentOptions: msg.presentOptions,
      extraMcpServers: getRegisteredMcpServers(),
      // 2층 턴 타임아웃 — 핸들러가 만든 turn signal 을 어댑터까지 운반. 미전달 시
      // undefined → 어댑터가 idle AC 만 link → 1층-only(회귀 0, TT-I7).
      abortSignal: opts?.abortSignal,
      // 도구 정책 운반(custom-endpoints §7-3) — 미전달 시 undefined = 전체 도구(회귀 0).
      toolPolicy: opts?.toolPolicy,
      // mid-turn steering 소스 운반(ADR 2026-07-16 §4/§5) — 미전달 시 undefined = 어댑터
      // 미주입 = 현행(회귀 0). P0 = 운반만; 어댑터 소비는 P1.
      steering: opts?.steering,
    },
    overridePool.length > 0 ? { specs: overridePool } : undefined,
  );

  // 세션의 마지막 인입 채널+주소 캡처(§D3) — 비동기 outbound(워커 완료·능동발신) 기본 목적지.
  // saveSession(runClaude 내부 persistOutput)이 세션 행을 만든 *직후* 이므로 UPDATE-only 성립.
  // 정규화 인입만 캡처(실채널=msg.channel, 주소=channelAddress). 세션 id 파싱 의존 대체(§1.3).
  // 행 없음(응답 실패로 saveSession 미실행)이면 UPDATE no-op(false) — 폴백 보존, 회귀 0.
  if (normalize) {
    try {
      setSessionChannelMeta({
        channel: sessionChannel,
        threadKey: sessionId,
        lastChannel: msg.channel,
        lastChannelTarget: channelAddress ?? null,
      });
    } catch (e) {
      // 메타 캡처 실패는 턴을 절대 못 죽인다(관측/편의 메타일 뿐).
      console.error("route: setSessionChannelMeta failed:", e);
    }
  }
  // override 가 런타임에 거부되어 폴백한 경우 — 깨진 override 를 DB 에서 제거해
  // 다음 turn 정상화 (매 turn 경고 반복 방지). DB 쓰기는 router 경유(facade 는 순수).
  // 사용자가 다시 `/model` 로 지정하기 전까지는 env 풀(기본)로 동작.
  if (out.modelOverrideRejected !== undefined) {
    clearSessionModelOverride(sessionChannel, sessionId);
    console.warn(
      `route: model override '${out.modelOverrideRejected.requested}' rejected → ` +
        `cleared (fell back to '${out.modelOverrideRejected.fellBackTo}') ` +
        `channel=${msg.channel} session=${sessionId}`,
    );
  }
  // route 로그 정렬(§1) — 실채널 + 세션 id. 정규화로 인입 채널≠세션-정체성 채널일 때
  // "via" 로 캡처 좌표를 남겨 감사(대시보드가 "텔레그램 경유" 를 알게)에 정합.
  console.log(
    `route channel=${msg.channel} session=${sessionId}` +
      (normalize && sessionChannel !== msg.channel
        ? ` store=${sessionChannel}`
        : "") +
      (channelAddress !== undefined ? ` addr=${channelAddress}` : "") +
      (overrideRaw !== null ? ` model_override=${overrideRaw}` : "") +
      (appliedProfile !== null ? ` model_profile=${appliedProfile}` : ""),
  );
  return {
    text: out.text,
    replyToTrigger: out.replyToTrigger,
    modelOverrideRejected: out.modelOverrideRejected,
    ...(typeof out.model === "string" && out.model !== "" ? { model: out.model } : {}),
  };
};
