// src/auth/permissions.ts
/**
 * 단일 권한 정책 — 채널 무관.
 * 사용자 결정 (2026-05-04): 모든 채널 동일 차단 리스트.
 * 새 채널이 생겨도 이 파일은 변경 0.
 *
 * 차단 기제: SDK 의 `Options.disallowedTools` 가 CLI 의 alwaysDenyRules 로 매핑되어
 * `permissionMode: 'bypassPermissions'` 단락보다 먼저 deny 처리됨 (스파이크 §b 참조).
 * 즉 bypass 모드 + 차단 리스트 조합으로 V1 allow/deny 가 성립.
 */

/**
 * 절대 사용 금지 도구. 사용자도 비서도 의도해서는 안 되는 행위만.
 * 회색지대(Bash 위험 명령 등)는 LLM 능동 평가(시스템 프롬프트)에 위임.
 *
 * V1: 빈 배열. 인프라(파일·상수·SDK 옵션 통합)만 깔고 진입점은 없음
 * (Phase 3 default 풀 인프라 패턴과 동일). 추가가 필요해지면 한 줄 push.
 * 추가는 docs/decisions/ 또는 architect contract 갱신을 거친다.
 */
export const DISALLOWED_TOOLS: readonly string[] = [];

/**
 * 절대 사용 금지 URL. WebFetch (V5.9+) 진입점.
 *
 * V5.9: 빈 배열로 진입 — V5.7 의 `DISALLOWED_TOOLS` 패턴 답습.
 *   인프라(상수·import·pre-check) 만 깔고 진입점은 없음. 정책 진실 소스 1개 박기.
 * 매칭 기제: 현재는 정확 매칭만 (`url === banned`). 와일드카드/패턴 차단은 V5.11+.
 */
export const DISALLOWED_URLS: readonly string[] = [];
