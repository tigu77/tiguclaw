/**
 * **상대가 우리 프롬프트를 조용히 잘랐나** (2026-08-31).
 *
 * ★사고(실측): 로컬 ollama 는 모델이 32,768 을 지원해도 **서버 기본 컨텍스트 4,096** 으로
 *  서빙한다. 우리 최소 턴은 26,548 토큰(새 설치, Groq 측정)이라 **85%가 버려진다.**
 *  그런데 실패 신호가 **하나도 없다** — HTTP 200, 에러 0, 답도 나온다. 다만 그 답에는
 *  헌법·메모리·스킬이 없다. 실측: 로컬 모델에게 *"지침에 적힌 네 이름"* 을 물으면 `모름`
 *  이라 하고, 같은 지침이 닿는 provider 는 *"저는 돌쇠입니다"* 라고 답한다.
 *  사용자는 이걸 **"이 모델이 멍청하다"** 로 읽는다 — 우리 능력이 통째로 빠졌는데.
 *
 * ★판정은 **우리가 보낸 바이트**와 **상대가 셌다는 토큰**의 대조 하나다. provider 이름을
 *  묻지 않는다(LLM 무관). 자르는 건 상대이고, 자른 것을 아는 유일한 방법은 그쪽이 돌려준
 *  숫자다.
 *
 * ★**오탐을 0으로 둔다.** 토큰/바이트 비율은 언어·토크나이저마다 다르므로 **가장 보수적인
 *  하한**(4바이트=1토큰)을 쓴다. 실측 비율은 약 2.18 바이트/토큰이므로 4는 그 두 배 가까이
 *  느슨하다 — 이 문턱을 넘었다면 "조금 다르게 셌다" 로는 설명이 안 된다.
 *  usage 미보고(`undefined`)면 **아무 말도 안 한다** — 모르는 것을 아는 척하지 않는다.
 */

/**
 * 보수 하한 — 4바이트=1토큰. 어떤 토크나이저에서도 과대추정이 아니다.
 *
 * ★**실측 비율은 2.18B/토큰**이다(새 설치 56.4KB → Groq 가 센 26,548토큰). 즉 4는 실측의
 *  약 1.8배 느슨하다. 종전 주석은 *"두 배 가까이"* 라고 썼는데 재고 쓴 수가 아니었다.
 */
const CONSERVATIVE_BYTES_PER_TOKEN = 4;

/**
 * 잘림 문턱 — 두 단계다 (2026-08-31, 적대 검토 P5).
 *
 * ★종전엔 `0.5` 하나였고, 하한(4B/토큰)과 곱해져 **실측 대비 3.67배** 느슨했다. 그래서
 *  `num_ctx=8192`(매우 흔한 설정)에서 **69% 가 버려지는데도 침묵**했다.
 * ★그렇다고 문턱을 실측에 붙이면 오탐이 난다 — 오탐은 상시 경고가 되고 상시 경고는
 *  아무도 안 본다([[feedback_gate_must_actually_run]]). 그래서 **둘로 나눈다**:
 *  확실한 구간은 단정하고, 애매한 구간은 *"잘렸을 수 있다"* 로 **등급을 낮춰** 말한다.
 *  모르는 걸 아는 척하지도, 아는 걸 숨기지도 않는다.
 */
const TRUNCATION_RATIO = 0.5;
/** 이 아래면 «잘렸을 수 있다»(확신 낮음). 실측 비율(2.18)에 더 가깝다. */
const SUSPECT_RATIO = 0.85;

export interface TruncationVerdict {
  /** 보낸 바이트로 계산한 **보수적 최소** 토큰 수. */
  readonly sentAtLeast: number;
  /** 상대가 처리했다고 말한 토큰 수. */
  readonly processed: number;
  /** `"확실"` = 단정해도 되는 구간 · `"의심"` = «잘렸을 수 있다» 로만 말한다. */
  readonly confidence: "확실" | "의심";
}

/**
 * 잘렸으면 판정, 아니면 `null`.
 *
 * @param sentBytes 우리가 실제로 보낸 텍스트 바이트(시스템 + user 채널).
 * @param inputTokens 상대가 보고한 입력 토큰. 미보고면 `undefined`.
 */
export const detectTruncation = (
  sentBytes: number,
  inputTokens: number | undefined,
): TruncationVerdict | null => {
  if (inputTokens === undefined || inputTokens <= 0 || sentBytes <= 0) return null;
  const sentAtLeast = Math.floor(sentBytes / CONSERVATIVE_BYTES_PER_TOKEN);
  if (inputTokens < sentAtLeast * TRUNCATION_RATIO) {
    return { sentAtLeast, processed: inputTokens, confidence: "확실" };
  }
  // ★애매 구간 — 단정하지 않고 «잘렸을 수 있다» 로 말한다. 침묵보다 낫다: 실측으로
  //  `num_ctx=8192` 에서 69% 유실이 이 구간에 있었다.
  if (inputTokens < sentAtLeast * SUSPECT_RATIO) {
    return { sentAtLeast, processed: inputTokens, confidence: "의심" };
  }
  return null;
};

/**
 * 사용자·로그가 함께 읽는 한 문장.
 *
 * ★수치를 싣는다 — [[feedback_logs_must_stand_alone]]: 증상만 말고 **판정 수치**를.
 *  원격 인스턴스에선 이 줄이 유일한 창이다.
 */
export const truncationNote = (v: TruncationVerdict, model: string): string =>
  `이 모델(${model})이 우리 프롬프트를 ${v.confidence === "확실" ? "**잘라냈습니다**" : "**잘라냈을 수 있습니다**"} — 최소 ${v.sentAtLeast.toLocaleString()}토큰을 ` +
  `보냈는데 ${v.processed.toLocaleString()}토큰만 처리했습니다. ` +
  `지침·메모리·능력 목록이 빠진 채 답했을 수 있습니다(에러는 안 납니다). ` +
  `모델의 컨텍스트 설정을 키우거나(로컬이면 ollama \`num_ctx\`) 더 큰 컨텍스트의 모델을 쓰세요.`;

/**
 * **부치기 전에** 안다 — 모델 컨텍스트를 아는 경우 (2026-08-31).
 *
 * ★위 `detectTruncation` 은 **사후**다(상대가 센 토큰이 와야 판정한다). 그런데 벤더가
 *  `/models` 에서 컨텍스트 길이를 알려주는 경우가 있고(실측: OpenRouter `context_length`,
 *  Groq `context_window` — google 은 안 준다), 그때는 **보내기 전에** 알 수 있다.
 *  usage 를 안 주는 provider 도 덮이고, 헛된 호출 한 번을 아낀다.
 *
 * ★같은 보수 하한을 쓴다 — 여기서 오탐이 나면 **멀쩡한 모델을 못 쓰게 막는 것처럼** 읽힌다
 *  (막지는 않는다. 우리는 말할 뿐이다).
 */
export const predictTruncation = (
  sentBytes: number,
  contextTokens: number | undefined,
): TruncationVerdict | null => {
  if (contextTokens === undefined || contextTokens <= 0 || sentBytes <= 0) return null;
  const sentAtLeast = Math.floor(sentBytes / CONSERVATIVE_BYTES_PER_TOKEN);
  // 답할 자리도 남아야 하므로 컨텍스트를 꽉 채우면 이미 잘린다.
  if (sentAtLeast <= contextTokens) return null;
  return { sentAtLeast, processed: contextTokens, confidence: "확실" };
};

/** 사전 경고 문구 — 사후와 달리 "잘렸다" 가 아니라 "잘릴 것" 이다. */
export const willTruncateNote = (v: TruncationVerdict, model: string): string =>
  `이 모델(${model})의 컨텍스트는 ${v.processed.toLocaleString()}토큰인데 우리 프롬프트는 ` +
  `최소 ${v.sentAtLeast.toLocaleString()}토큰입니다 — **지침·메모리·능력 목록이 잘려 나갑니다**(에러는 안 납니다). ` +
  `더 큰 컨텍스트의 모델을 쓰거나, 로컬이면 \`num_ctx\` 를 키우세요.`;
