/**
 * «빠름» 런타임 상태 한 줄 — SDK 의 `fast_mode_state` 를 사람이 읽는 문장으로 (2026-09-11).
 *
 * 왜 있나: 프로파일에 «빠름» 을 적었는데 안 빨라지면 사용자는 원인을 알 길이 없다. 화면은
 * «적혔다» 만 보여주고 런타임 상태(`fast_mode_state` / `fast_mode_disabled_reason`)는
 * **로그에만** 있다. 즉 이 줄이 «빠름 켰는데 왜 안 빨라지죠» 의 유일한 답변 경로다.
 *
 * ★어댑터 안 한 줄이 아니라 **순수 모듈**인 이유(형제 `rate-limit-view.ts` 와 같다):
 *  어댑터 루프 안에 두면 검사가 소스 대조밖에 못 한다. 이 레포는 그 부류로 반복해 데었다
 *  (`if (false && …)` 한 글자에 뚫린 그물이 같은 주 안에 두 번). 접는 규칙은 **돌려서**
 *  재야 한다 — 그래서 판정(`parseFastMode`)과 접기·출력(`createFastModeReporter`)을 여기 둔다.
 *
 * ── 접는 규칙 (2026-09-11 적대 검토 N2·N3) ────────────────────────────────────────
 *
 * ★**거절은 접지 않는다.** 형제 rate-limit 은 `status !== "allowed" || signature !== last`
 *  로 거절을 항상 남긴다. 첫 판의 fast-mode 는 그 규칙을 **주석으로 인용해 놓고** 거절까지
 *  서명 하나로 묶어, 데몬 수명 내 딱 한 번만 찍었다. 며칠 뒤 사용자가 물으면 **그날 로그엔
 *  아무것도 없다** — 답변 경로가 하나뿐인데 그 하나가 비어 있는 형상이다.
 *  ★단 «항상» 을 이 스트림 모양에 정직하게 옮기면 **턴마다 한 번**이다. `fast_mode_state`
 *   는 한 턴에 system·result 로 **두 번 이상** 실려 오는데(실측), 그건 새 사실이 아니라
 *   같은 사실이다. 형제의 `rate_limit_event` 는 이벤트 1개 = 사실 1개라 그 구분이 없었다.
 *   턴마다 한 번이면 «그날 로그» 는 채우고 배경소음은 안 만든다
 *   ([[feedback_logs_must_stand_alone]] 「반복은 세라」).
 *
 * ★**허용(`on`)은 바뀔 때만.** 좋은 소식은 반복할 값이 없다.
 *
 * ★**서명은 모델까지 포함한다.** 첫 판은 모듈 스코프의 근거로 «`fast_mode_state` 는 계정
 *  전역 값이라 세션이 달라도 같은 답이 온다» 고 적었는데, **같은 블록이 `model_not_allowed`
 *  를 다뤘다** — 그건 계정이 아니라 **모델** 스코프 사유다(N3). 근거와 코드가 모순이면
 *  둘 중 하나가 틀린 것이고, 여기선 근거가 틀렸다. 서로 다른 모델의 두 세션이 겹치면 서명이
 *  튀어 매 메시지 찍히거나 한쪽 사유가 영영 가려진다. 그래서 접기는 **모델별로** 한다.
 */

/** 사유 → 처방. 증상만 적힌 로그는 한 번 더 묻게 만든다. */
const PRESCRIPTION: Readonly<Record<string, string>> = {
  extra_usage_disabled: " 계정에서 **추가 사용량**을 켜야 합니다.",
  model_not_allowed: " 이 모델은 빠름 티어를 지원하지 않습니다(Opus 5·4.8 만).",
};

export interface FastModeView {
  /** `off` | `cooldown` | `on` — SDK 가 준 그대로. 모르면 `null`. */
  readonly state: string | null;
  /** `fast_mode_disabled_reason`. 없으면 `null`(«막는 게 없다» 도 정보다). */
  readonly reason: string | null;
  /** 막는 게 **없는가**. `on` 만 허용이다 — `cooldown` 은 거절 쪽이다. */
  readonly allowed: boolean;
  /** 이 판정이 «누구의» 답인가 — 접기 범위. 계정이 아니라 **모델**이다. */
  readonly scope: string;
  /** 로그 한 줄. 할 말이 없으면 `null`(상태를 안 실어 보낸 메시지). */
  readonly line: string | null;
  /** 같은 값 반복을 접기 위한 서명 — 스코프·상태·사유. */
  readonly signature: string;
}

/**
 * SDK 메시지에서 «빠름» 상태를 읽는다.
 *
 * @param raw   `fast_mode_state` / `fast_mode_disabled_reason` 을 실을 수 있는 SDK 메시지.
 * @param model 이 턴이 **요청한** 모델(`input.model`). 턴 내내 고정이라 스코프 키로 맞다 —
 *              SDK 가 뒤늦게 알려주는 값을 쓰면 같은 턴의 두 메시지가 다른 키를 갖는다.
 */
export const parseFastMode = (raw: unknown, model: string | undefined): FastModeView => {
  const msg = (raw ?? {}) as Record<string, unknown>;
  const st = typeof msg.fast_mode_state === "string" ? msg.fast_mode_state : null;
  const reason =
    typeof msg.fast_mode_disabled_reason === "string" ? msg.fast_mode_disabled_reason : null;
  const scope = model !== undefined && model !== "" ? model : "(기본 모델)";
  const allowed = st === "on";

  const line =
    st === null
      ? null
      : allowed
        ? // ★«on» 은 «막는 게 없다» 이지 «이 턴이 빨랐다·2배로 청구됐다» 가 아니다
          //  (SDK: *"a request may still choose standard speed"*). 재지 않은 단언을 하지
          //  않는다(2026-09-11 적대 검토 N4). 배수도 안 적는다 — 계약(`SPEED_TIER_COST`)이
          //  «배수는 한 곳에» 라고 적어 뒀고 대가는 `/models` 가 말한다.
          `빠름 티어를 쓸 수 있는 상태입니다(model=${scope}, 막는 조건 없음).`
        : `안 켜짐(model=${scope} state=${st}${reason === null ? "" : ` 사유=${reason}`}) — ` +
          `프로파일엔 «빠름» 이 적혀 있지만 이 턴은 표준 속도로 돕니다.` +
          (reason === null ? "" : (PRESCRIPTION[reason] ?? ""));

  return {
    state: st,
    reason,
    allowed,
    scope,
    line,
    signature: `${scope}|${st ?? "-"}|${reason ?? "-"}`,
  };
};



/**
 * fast-mode 리포터 — **상태를 클로저에 가두고, 수명을 «데이터» 로 만든다.**
 *
 * ── 왜 이 모양인가 (2026-09-11, 외부 사냥 7건) ────────────────────────────────────
 *
 * 앞의 두 판은 로직을 순수 함수로 내렸는데도 **상태의 수명**이 어댑터의 «선언 위치» 에
 * 남아 있었다. 그래서 검사가 그 위치를 AST 로 재야 했고, 사냥꾼이 그 축으로 셋을 뚫었다:
 *
 *  - 게이트 생성을 **메시지 루프 안**으로 옮기면 턴 중복 접기가 풀려 도배된다.
 *  - `runClaude` 진입부에 **`fastModeSigByModel.clear()`** 한 줄이면 억제가 매 턴 풀린다.
 *  - 출력 주입구(`log` 인자)를 회귀가 쓰는 바람에 **제품 기본값이 죽어도** 안 보였다 —
 *    측정하려고 낸 구멍으로 측정 대상이 빠져나갔다.
 *
 * ★그래서 셋을 **구조로** 없앤다:
 *  1. `lastByScope` 는 이 클로저 안에만 산다 — 밖에서 `clear()` 할 손잡이가 **없다**.
 *  2. 턴 구분을 «게이트 객체의 수명» 이 아니라 **턴 토큰의 identity** 로 한다. 어댑터는
 *     자기가 받은 `input` 객체를 그대로 넘긴다 — **턴 키를 만드는 코드가 아예 없으므로**
 *     «게이트를 루프 안으로 옮기기» 같은 변이가 성립하지 않는다. 옮길 것이 없다.
 *     ★`input` 이 턴 경계와 정확히 일치한다(실측): 라우터는 어댑터를 부를 때마다 객체
 *      리터럴을 **새로** 만들고(`index.ts` 의 `callAdapter(spec.adapter, { … })`), 재시도
 *      루프는 `runClaude` **안**이라 같은 객체를 쓴다 = «재시도 포함 한 턴». 폴백으로 모델이
 *      바뀌면 새 객체인데, 그건 모델이 다르니 다른 스코프가 맞다.
 *     ★`WeakMap` 이라 턴이 끝나면 자동으로 사라진다 — 「턴 끝」 신호가 없어도 안 샌다.
 *  3. 출력은 `console.log` 를 **직접** 부른다. 주입구가 없으니 회귀도 제품과 **같은 경로**를
 *     지날 수밖에 없다(회귀는 `console.log` 자체를 가로챈다).
 *
 * ★남은 위치 의존 하나: 이 리포터를 **모듈 스코프에서 한 번** 만들어야 «허용은 바뀔 때만» 이
 *  성립한다. 턴마다 새로 만들면 허용 줄이 매 턴 나온다 — 다만 그건 **소음**이지 동작 사망이
 *  아니라(거절·사유는 그대로 남는다) 위험도가 낮다고 보고 여기까지로 둔다.
 *
 * @returns `(turnToken, msg, speed, model)` — 같은 토큰이면 같은 턴이다.
 */
export const createFastModeReporter = (): ((
  turnToken: object,
  msg: unknown,
  speed: string | undefined,
  model: string | undefined,
) => void) => {
  /** 모델 → 마지막으로 남긴 서명(데몬 수명). **밖에서 만질 수 없다.** */
  const lastByScope = new Map<string, string>();
  /** 턴 토큰 → 그 턴에 남긴 거절 서명(턴 수명). 동시 턴이 섞여도 객체가 다르니 갈린다. */
  const turnSigs = new WeakMap<object, string>();

  return (turnToken, msg, speed, model): void => {
    // 게이트 — 안 켠 턴은 침묵한다.
    if (speed !== "fast") return;
    const view = parseFastMode(msg, model);
    if (view.line === null) return;

    // 거절 = 턴마다 한 번(그날 로그에 남아야 한다) · 허용 = 바뀔 때만(좋은 소식은 반복 무가치).
    const fresh = view.allowed
      ? lastByScope.get(view.scope) !== view.signature
      : turnSigs.get(turnToken) !== view.signature;
    if (!fresh) return;

    lastByScope.set(view.scope, view.signature);
    turnSigs.set(turnToken, view.signature);

    // ★주입구를 두지 않는다 — 회귀는 `console.log` 자체를 가로챈다(제품과 같은 경로).
    console.log(`[fast-mode] ${view.line}`);
  };
};
