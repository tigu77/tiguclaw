/**
 * 오디오 전사 provider 최소 계약 (config-driven transcription, 2026-07-18).
 *
 * 진실 소스: `_workspace/transcription_architect_contract.md` §2.
 *
 * 계약은 **단일 메서드**로 최소화(Q6). 스트리밍·타임스탬프·화자분리 등은 지금 불필요 → 미포함.
 * impl 은 openai(HTTP multipart)·local(CLI spawn) 2종이고, 둘 다 이 인터페이스 뒤에 숨는다 →
 * `runRegionA` seam(enrichTranscripts)은 impl 을 if 로 분기하지 않는다(LLM-agnostic 대칭).
 */
export interface TranscribeInput {
  /** <home>/data/attachments/... 절대경로 (Attachment.path). */
  filePath: string;
  /** IANA MIME (예 "audio/ogg" | "audio/mpeg" | "audio/mp4"). */
  mimeType: string;
  /** 언어 힌트("ko"). 미지정 = provider 자동감지. */
  language?: string;
}

export interface TranscriptionProvider {
  /**
   * 성공 = 전사 텍스트. 실패 = throw (호출자 enrichTranscripts 가 graceful 처리).
   * boundary(network/spawn)에서만 던진다 — 상위 seam 이 첨부 단위로 격리한다.
   */
  transcribe(input: TranscribeInput): Promise<string>;
  /** 캐시(sidecar) 정합용 식별 — {provider,model} 일치 시 재사용. */
  readonly id: { provider: string; model: string };
}
