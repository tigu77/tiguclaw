/**
 * 회귀: **openai 어댑터를 불러오면 SDK 실행 추적이 꺼진다** (2026-10-06).
 *
 * 사고: `@openai/agents` 는 추적이 기본 «켜짐» 이고, 프로세스 환경의 `OPENAI_API_KEY` 로 매 턴 추적을 **입력·출력 내용까지**
 * `api.openai.com/v1/traces/ingest` 에 올린다 — 그 턴이 OpenRouter·Google·Ollama 로 돌았어도. 키가 없으면 대신
 * «No API key provided for OpenAI tracing exporter» 가 매 턴 로그에 찍혔다(정태님 «이런건 정리해야지» — 6월부터 21일치).
 * 우리는 그 추적을 쓰지 않는다.
 *
 * 등급: **동작** — 실제 어댑터 모듈을 불러온 뒤 전역 추적 공급자가 새 추적을 만드는지 본다(만들면 내보내기까지 간다).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "openai-sdk-tracing-off",
  guards:
    "openai 어댑터 턴의 실행 추적(대화 내용 포함)이 OPENAI_API_KEY 만 있으면 OpenAI 로 올라가고, 키가 없으면 매 턴 경고가 로그에 찍히던 것",
  run: async (): Promise<Assertion[]> => {
    // 전제: SDK 자체가 끄는 조건(테스트 환경 · 환경 변수)이면 이 검사는 아무것도 증명하지 못한다 — 그 사실을 드러낸다.
    const vacuous = process.env.NODE_ENV === "test" || /^(1|true)$/i.test(process.env.OPENAI_AGENTS_DISABLE_TRACING ?? "");
    await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
    const { getGlobalTraceProvider, NoopTrace } = await import("@openai/agents");
    const trace = getGlobalTraceProvider().createTrace({ name: "regression-probe" });
    return [
      assert(
        "★어댑터를 불러온 뒤 SDK 는 추적을 만들지 않는다(내보낼 것도 없다)",
        !vacuous && trace instanceof NoopTrace,
        vacuous ? "전제 무효 — NODE_ENV=test 또는 OPENAI_AGENTS_DISABLE_TRACING 이 이미 끈다" : `추적=${trace.constructor.name}`,
      ),
    ];
  },
};
