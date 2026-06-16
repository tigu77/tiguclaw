/**
 * 영역 A facade — V4.1 부터 어댑터 풀 (`runRegionA`) 위임 (2026-05-23).
 * 진실 소스: docs/decisions/2026-05-17-llm-agnostic-vision.md §3, §8 V2 + V4 풀 폴백.
 * plugin·channel 진입점 호환 — `runClaude` 이름 그대로 export.
 *
 * 동작 (2026-05-24 provider:model 통일):
 *  - `.env` 의 `REGION_A_MODELS` 가 `provider:model` 콤마 풀
 *    (예: "codex:gpt-5.5,anthropic:claude-opus-4-7"). provider 가 어댑터 결정.
 *  - 미설정 시 default = anthropic(claude, SDK 디폴트 모델)
 *  - 풀 모드에서 첫 모델 throw 면 다음 모델 자동 시도
 *
 * 의식된 미완 (V5+ 어댑터 인터페이스 통합 라운드에서 해결):
 *  - claude 어댑터 외 어댑터 응답 시 saveSession·jsonl 인덱싱 0
 *  - 즉 codex-oauth·openai 발화 시 세션 매핑 + transcript 인덱싱 입구 깨짐
 *  - Phase 2 세션 지속성 회귀 = claude 어댑터 시점에 한정 보존
 */
export { runRegionA as runClaude } from "./llm-runtime/index.js";
export type { ClaudeRunInput, ClaudeRunOutput } from "./llm-runtime/index.js";
