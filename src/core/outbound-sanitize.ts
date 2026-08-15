/**
 * Outbound sanitizer — 모델 응답에서 *내부 컨텍스트 마커가 echo 된 경우* 제거.
 *
 * OpenClaw `stripInternalRuntimeScaffolding` 패턴 답습
 * (E:/work/test/openclaw `src/infra/outbound/sanitize-text.ts:105`).
 * 다만 우리가 *실제 생성하는* 마커만 잡는다 — `<system-reminder>`(`memory.ts`의
 * `assembleUserPrompt` 가 user 채널에 감싸는 태그, f922a94+) + `<previous_response>`
 * (Anthropic 권장 conversation context wrap, 향후 도입 대비). OpenClaw-specific
 * 마커(`<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`, `UNTRUSTED_CHILD_RESULT`,
 * `prompt-data`, `untrusted-text` 등)는 우리 생성 0 이라 잡지 않음.
 *
 * 방어 의도: sysprompt(`_shared-sysprompt.ts` "입력 컨텍스트 채널" 섹션)가
 * 첫 방어선, sanitize 가 두 번째(defense in depth). codex 같이 sysprompt 가이드를
 * 못 따르고 자기 input 의 <system-reminder> 태그를 echo 한 모델이라도 사용자
 * 화면엔 안 새게 한다.
 *
 * 한계: codex 의 *태그를 안 echo 하고 내용을 풀어 설명하는* 케이스(예: "SYSTEM.md
 * 는 ... AGENT.md 는 ...")는 못 잡는다 — 텍스트가 정상 응답과 구분 불가. 그건
 * sysprompt + 모델 선택의 문제(`REGION_A_MODELS` 순서, `/model` 슬래시).
 */

const INTERNAL_TAGS = ["system-reminder", "previous_response"] as const;
const INTERNAL_TAG_PATTERN = INTERNAL_TAGS.join("|");

// 짝 맞는 블록: <system-reminder>...</system-reminder>. 백레퍼런스(`\\1`)로 정확
// 매칭 — 다른 태그와 교차 안 됨. `i` 대소문자 무관, `g` 전체.
const BLOCK_RE = new RegExp(
  `<\\s*(${INTERNAL_TAG_PATTERN})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`,
  "gi",
);
// 셀프-클로징: <system-reminder/> 같은 변종.
const SELF_CLOSING_RE = new RegExp(
  `<\\s*(?:${INTERNAL_TAG_PATTERN})\\b[^>]*\\/\\s*>`,
  "gi",
);
// 짝 안 맞고 남은 단일 태그 (열거나 닫기 한쪽만). 모델이 잘못 echo 했을 때 청소.
const BARE_TAG_RE = new RegExp(
  `<\\s*\\/?\\s*(?:${INTERNAL_TAG_PATTERN})\\b[^>]*>`,
  "gi",
);

/**
 * 응답 문자열에서 내부 마커 블록·태그를 제거. 블록 → 셀프-클로징 → 남은 단일
 * 태그 순으로 청소 (블록 먼저 잡아야 그 안 콘텐츠까지 같이 사라짐).
 */
export const stripInternalRuntimeScaffolding = (text: string): string => {
  return text
    .replace(BLOCK_RE, "")
    .replace(SELF_CLOSING_RE, "")
    .replace(BARE_TAG_RE, "");
};

// ───────────────────────────────────────────────────────────────────────────
// redactSecrets — 에러 경로 출구 위생 (보안 P0). architect contract 2026-06-02.
//
// stripInternalRuntimeScaffolding 과 같은 "사용자 채널로 나가기 직전 출구 위생"
// 이지만 협력 관계(중복 아님): 전자는 정상 응답의 내부 마커 echo 제거, 후자는
// *에러 경로에서만* 시크릿 마스킹. **자동 합성 안 함** — 호출자(daemon catch)가
// errorDetail(e) 결과에 명시 호출. 정상 응답에 redact 를 거는 것은 불필요(시크릿
// 없음)이며 오탐으로 정상 텍스트 훼손 위험.
//
// 2층 방어 (defense-in-depth):
//  1층 — process.env 실제 값 매칭(주방어): 우리 소유 비밀을 형태 무관 제거.
//        토큰 패턴을 몰라도 잡힘 (URL/JSON/헤더 어디로 새도 값으로 매칭).
//  2층 — 알려진 토큰 패턴 정규식(보조): env 미등록/회전된 토큰 보강.
//
// 순수 함수 — 입력 string in, string out, 부작용 0. 무매칭이면 원본 그대로.
// ───────────────────────────────────────────────────────────────────────────

/**
 * **env 키 이름이 비밀을 담는가** — 이 판정의 유일한 정본.
 *
 * 화이트리스트가 아니라 판정이다(신규 시크릿 env 가 생겨도 수정 불필요).
 * `*_PORT`·`*_ALLOWED_USER_IDS`·`REGION_A_MODELS` 등은 미매칭.
 *
 * ★export 인 이유(2026-08-01 감사): 같은 판정이 `external-mcp.ts` 에 **사본**으로 있었고,
 *  그 사본에만 `CREDENTIAL` 이 추가돼 **이미 어긋나 있었다** — 외부 MCP 자식에게는 안
 *  넘어가는데 로그에는 평문으로 남는 상태였다. 더 얄궂은 건 사본 쪽 주석이 "두 곳에 같은
 *  판정이 생기지 않게 의미를 맞춰 둔다" 고 **동기화를 주장**하고 있었다는 것이다.
 *  말이 실제를 보증하지 못하므로, 사본을 없애고 여기 하나만 남긴다.
 *
 *  통일 방향은 **엄격한 쪽**이다. `GOOGLE_APPLICATION_CREDENTIALS` 처럼 값이 파일 경로인
 *  것까지 로그에서 가려지는 불편이 생기지만, 지금 막고 있는 것을 푸는 쪽으로 맞출 수는 없다.
 *  이 모듈은 아무것도 import 하지 않는 말단이라 순환 참조 없이 어디서든 가져다 쓸 수 있다.
 */
export const SECRET_KEY_NAME_RE =
  /KEY|TOKEN|SECRET|REFRESH|PASSWORD|OAUTH|CREDENTIAL/i;
// 값 길이 가드 — 짧은 값(빈/타임스탬프 아닌 짧은 값)이 본문을 광범위 오염시키는
// 오탐 방지. 오탐<누락 우선이나 8자 미만은 의미있는 비밀 아님으로 판정.
const SECRET_MIN_VALUE_LEN = 8;

// 정규식 메타문자 이스케이프 — env 값을 리터럴로 안전 치환.
const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 2층 — 알려진 토큰 형태 패턴. 각각 [REDACTED] 치환. (긴 것부터 적용해 부분 잠식 방지)
const TOKEN_PATTERNS: { re: RegExp; replace: string }[] = [
  // Anthropic — sk-ant-... (sk- 보다 먼저, 더 구체적).
  { re: /sk-ant-[A-Za-z0-9._-]+/g, replace: "[REDACTED]" },
  // OpenAI/Anthropic 류 — sk-...
  { re: /sk-[A-Za-z0-9._-]+/g, replace: "[REDACTED]" },
  // JWT (codex OAuth access/id 토큰) — eyJ...header.payload.sig
  { re: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, replace: "[REDACTED]" },
  // Telegram bot 토큰 — 123456:AAaa...
  { re: /\d{6,}:[A-Za-z0-9_-]{30,}/g, replace: "[REDACTED]" },
  // Authorization: Bearer <token> — 토큰 부분만 마스킹, Bearer 라벨 보존(진단성).
  //
  // ★문자 클래스를 **닫는다** (2026-08-15). 종전 `\S+` 는 "공백 아닌 것"을 끝까지 삼켜서
  //  토큰 **뒤에 붙은 것까지 지웠다**. 직렬화된 JSON 에선 토큰 다음이 `\"}` 라 공백이
  //  없고, 그래서 **JSON 의 꼬리째** 사라졌다 — 윈도우 DB 에 파싱 불가 payload 3건이
  //  그렇게 생겼다(`Bearer [REDACTED]` 에서 문자열이 끊긴 채 끝난다).
  //  ★DB 보다 채널 출력이 더 위험하다: 이건 아웃바운드 살균기라, 답변에 `Bearer …` 가
  //  섞이면 **그 뒤 문장이 조용히 사라진다.** 다른 패턴들은 전부 클래스가 닫혀 있었고
  //  이것 하나만 열려 있었다.
  //  토큰에 쓰이는 문자만 받는다(base64url + JWT 점 + 흔한 패딩). `"`·`\`·`}`·`,` 에서 멈춘다.
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]+/g, replace: "Bearer [REDACTED]" },
];

export const redactSecrets = (text: string): string => {
  if (text === "") return text;
  let out = text;

  // 1층 — process.env 재수집(호출 시점 — 토큰 회전 대비, 모듈 로드 시 캡처 금지).
  // 값 기준 매칭이므로 길이 내림차순 정렬: 긴 시크릿 먼저 치환해 짧은 값이 긴 값의
  // 부분 문자열일 때의 부분 잠식 방지.
  const secretValues: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!SECRET_KEY_NAME_RE.test(key)) continue;
    if (value.length < SECRET_MIN_VALUE_LEN) continue;
    secretValues.push({ key, value });
  }
  secretValues.sort((a, b) => b.value.length - a.value.length);
  for (const { key, value } of secretValues) {
    out = out.replace(new RegExp(escapeRegExp(value), "g"), `[REDACTED:${key}]`);
  }

  // 2층 — 알려진 토큰 패턴 보강.
  for (const { re, replace } of TOKEN_PATTERNS) {
    out = out.replace(re, replace);
  }

  return out;
};
