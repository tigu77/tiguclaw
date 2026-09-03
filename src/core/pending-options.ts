/**
 * **직전에 제시한 선택지** — 사용자가 보기를 누르면 다음 턴에 그 «질문» 을 같이 준다.
 *
 * ★왜 필요한가 (2026-09-03 사용자 신고, 회사돌쇠 실사례). 비서가 `prompt_options` 로
 *  *"이 근본 수정안을 구현하고 검증할까요?"* 를 묻고 [수정 진행 / 원인 확인만] 을 냈다.
 *  사용자가 **원인 확인만** 을 눌렀는데 비서가 *"확인할 문제나 증상을 알려주세요"* 라고
 *  답했다 — **자기가 방금 한 질문을 몰랐다.**
 *
 * ★기제: 선택은 **다음 턴**에 도착하는데, 채널은 **고른 값만** 보낸다
 *  (대시보드 `sendChatMessage(value)` · 텔레그램 `ctx.reply(value)`). 그리고 codex 이력은
 *  턴 사이에 `{role, content}` **텍스트만** 나르므로 `function_call`(질문이 든 인자)도
 *  `function_call_output`(도구 반환)도 **남지 않는다.** 즉 모델이 보는 것은:
 *
 *      assistant: …진단… 현재는 원인만 확인했고 소스는 수정하지 않았습니다.
 *      user:      원인 확인만
 *
 *  자기 마지막 문장이 이미 «원인만 확인했다» 인데 «원인 확인만» 이 오니 **답이 아니라 새
 *  지시**로 읽힌다. 그래서 «무엇을 확인할까요» 가 나온다.
 *
 * ★고칠 자리를 **채널이 아니라 여기**로 잡은 이유: 채널을 고치면 세 곳(대시보드·텔레그램·
 *  CLI)을 손대야 하고 **사용자가 보는 자기 메시지도 바뀐다.** 여기 두면 채널 수정 0,
 *  화면 변화 0이고, 매 턴 fresh 로 조립되는 대화 컨텍스트에 실려 **이력 보존과 무관하게**
 *  닿는다([[feedback_simple_composable_no_duplication]] 「이음매에서 새면 이음매를 없애라」).
 *
 * ★**한 턴만 산다.** 읽으면 지운다 — 안 그러면 옛 질문이 계속 따라다니며 새 대화를 오염시킨다
 *  (이 레포가 캡 있는 자리에 도달해야 할 것을 두어 데인 것과 반대 방향의 같은 병).
 */

interface PendingOption {
  readonly question: string;
  readonly options: readonly string[];
  readonly at: number;
}

/** threadKey → 직전 질문. 프로세스 안에서만 산다(재시작하면 사라진다 — 그게 맞다). */
const PENDING = new Map<string, PendingOption>();

/**
 * 이 값이 지나면 «직전» 이 아니다 — 30분.
 * ★사용자가 선택지를 띄워놓고 한참 뒤 **다른 이야기**를 시작할 수 있다. 그때까지 옛 질문을
 *  물고 있으면 그게 오염이다. 눌러서 오는 경우는 보통 몇 초~몇 분이다.
 */
const PENDING_TTL_MS = 30 * 60_000;

/** 선택지를 **렌더한 직후** 기록한다(렌더 실패면 부르지 않는다 — 사용자가 못 본 질문이다). */
export const rememberPendingOptions = (
  threadKey: string,
  question: string,
  options: readonly string[],
  now: number = Date.now(),
): void => {
  if (threadKey === "" || question.trim() === "") return;
  PENDING.set(threadKey, { question, options: [...options], at: now });
};

/**
 * 직전 질문을 **꺼내면서 지운다**(한 턴만 산다). 없거나 낡았으면 `undefined`.
 * 순수하게 유지하려고 `now` 를 주입받는다 — 검사가 시계를 흔들 수 있게.
 */
export const takePendingOptions = (
  threadKey: string,
  now: number = Date.now(),
): PendingOption | undefined => {
  const p = PENDING.get(threadKey);
  if (p === undefined) return undefined;
  PENDING.delete(threadKey);
  return now - p.at > PENDING_TTL_MS ? undefined : p;
};

/** 대화 컨텍스트 한 줄로. 없으면 "". */
export const pendingOptionsLine = (
  threadKey: string,
  now: number = Date.now(),
): string => {
  const p = takePendingOptions(threadKey, now);
  if (p === undefined) return "";
  const opts = p.options.length > 0 ? ` (보기: ${p.options.join(" · ")})` : "";
  return (
    `- ★직전에 네가 물은 것: 「${p.question}」${opts}\n` +
    `  이번 사용자 메시지가 그 보기 중 하나라면 **새 지시가 아니라 그 질문의 답**이다 — ` +
    `무엇에 대한 답인지 다시 묻지 말고 이어서 하라.`
  );
};

/** 검사용 — 레지스트리를 비운다. */
export const clearPendingOptions = (): void => {
  PENDING.clear();
};
