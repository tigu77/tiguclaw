/**
 * «빠름» → OpenAI 낱말 번역 (2026-09-12, N6 parity).
 *
 * 왜 별도 모듈인가 — 형제 `fast-mode-view.ts` 와 같은 이유다. 어댑터 안 한 줄로 두면 검사가
 * **소스 대조밖에** 못 하는데, 이 레포는 바로 그 부류로 반복해 뚫렸다(2026-09-11~12 사냥
 * 16건 중 다수가 «모양으로 위치를 재던» 자리였다). 여기 두면 **돌려서** 잰다.
 *
 * ★공용 계약(`types.ts`)엔 `service_tier` 를 안 적는다 — 그건 OpenAI 말이고, 계약에 박으면
 *  다른 provider 를 붙일 때 남의 벤더 어휘를 쓰게 된다(`speed-tier-is-opt-in` 이 그 금지를
 *  검사로 갖고 있다). 번역은 **어댑터 쪽**인 이 파일에 산다.
 *
 * ── 왜 `baseURL` 로 가르나 ──────────────────────────────────────────────────────────
 *
 * 이 어댑터는 **다대일**이다 — `openai`·`ollama`·`google`·사용자 정의 provider 가 전부 여기로
 * 온다(`provider-registry.ts`). `service_tier` 는 **api.openai.com 의 낱말**이라, compat
 * 백엔드(ollama·gemini)에 실어 보내면 잘해야 무시되고 나쁘면 400 이다. 그리고 그쪽엔 애초에
 * «빠른 티어» 라는 대가 자체가 없다 — 없는 손잡이를 돌리는 셈이다.
 *
 * ★`baseURL === undefined` = 정품 OpenAI 엔드포인트다(`ProviderConn.baseURL` 주석이 그렇게
 *  못박는다). 사용자 정의 provider 라도 baseURL 을 안 적었으면 api.openai.com 으로 가므로
 *  이 판정이 provider **이름**보다 정확하다 — 이름으로 가르면 `myopenai` 같은 별칭이 새고,
 *  그건 2026-09-11 P1 에서 claude 쪽이 이미 당한 사고다.
 *
 * ★**화면도 같은 함수로 가른다**(`speedCostKeyFor` in `llm-runtime/index.ts`). 운반과 표시가
 *  각자 판정하면 반드시 갈리고, 갈린 방향이 «안 읽는다고 말하면서 돈은 나간다» 면 사용자는
 *  안심하고 켜 둔다. 그래서 규칙은 이 파일 **한 곳**에 산다.
 *
 * ── 안 잰 것 (2026-09-12) ─────────────────────────────────────────────────────────
 *
 * ★**라이브 호출로 확인하지 않았다.** 근거는 SDK 코드 경로 실측이다: agents SDK 의
 *  `_buildResponsesCreateRequest` 가 `modelSettings.providerData` 에서 전송 오버라이드
 *  (`extra_headers`·`extra_query`·`extra_body`)만 떼어내고 **나머지 키를 요청 본문에 그대로
 *  펼친다**(`...restOfProviderData`, node_modules 실측). 즉 `service_tier` 는 본문으로 간다.
 * ★**대가의 배수는 안 쟀다.** codex(크레딧 2.5배)·claude(단가 2배)와 달리 OpenAI 우선 처리는
 *  모델마다 값이 다르고 우리가 잰 적이 없다 — 그래서 `SPEED_TIER_COST` 에 숫자를 안 적고
 *  화면도 «배수 미측정» 이라고 말한다. 재고 나서 적어라(안 잰 수를 사용자 대면 문구에 쓰는
 *  것이 이 레포의 «단가 2배» 사고였다).
 */

/**
 * 이 연결이 «빠름» 을 실을 수 있는가 — **정품 OpenAI 엔드포인트일 때만**.
 *
 * @param baseURL `ProviderConn.baseURL`. `undefined` = api.openai.com.
 */
export const openaiCarriesSpeed = (baseURL: string | undefined): boolean =>
  baseURL === undefined;

/**
 * 중립 신호(`speed`) → 이 백엔드의 낱말. 안 켜는 경우엔 **키 자체가 없다**(`undefined` 를
 * 넘기면 SDK 가 «비우라» 로 읽을 수 있고, 그건 우리가 안 고른 동작이다).
 *
 * @param speed   풀 원소가 정한 중립 의도. `"fast"` 만 켠다(오타는 조용히 안 켜진다).
 * @param baseURL 이 턴이 실제로 말 거는 엔드포인트.
 */
export const openaiSpeedSettings = (
  speed: string | undefined,
  baseURL: string | undefined,
): { providerData?: { service_tier: "priority" } } =>
  speed === "fast" && openaiCarriesSpeed(baseURL)
    ? { providerData: { service_tier: "priority" } }
    : {};
