/**
 * openai 전사 impl — POST <baseURL>/audio/transcriptions (multipart).
 *
 * 기존 provider 연결(`resolveProviderConn`)로 baseURL/apiKey 재사용 → gpt-4o-transcribe·whisper-1
 * 은 model 문자열만 다른 *동일 엔드포인트*(impl 분기 0, config 데이터로 스왑). 신규 npm 의존 0
 * (native fetch/FormData/Blob). contract `_workspace/transcription_architect_contract.md` §2 impl A.
 * apiKey 미해석(env 부재)·비-2xx → throw → 상위 enrichTranscripts 가 graceful fallback(§4).
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { resolveProviderConn } from "../provider-registry.js";
import type { TranscribeInput, TranscriptionProvider } from "./types.js";

const DEFAULT_MODEL = "gpt-4o-transcribe"; // 현행 최고품질·다국어. whisper-1 은 config override.

export const createOpenAiTranscriptionProvider = (
  cfg: { provider?: string; model?: string },
  cwd?: string,
): TranscriptionProvider => {
  const providerName = cfg.provider ?? "openai";
  const model = cfg.model ?? DEFAULT_MODEL;
  return {
    id: { provider: `openai:${providerName}`, model },
    async transcribe(input: TranscribeInput): Promise<string> {
      const conn = resolveProviderConn(providerName, cwd);
      if (conn === null) {
        throw new Error(`transcription openai: provider "${providerName}" 미해석`);
      }
      if (conn.apiKey === undefined || conn.apiKey === "") {
        throw new Error(`transcription openai: apiKey 없음 (env ${conn.apiKeyEnv})`);
      }
      const base = (conn.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
      const bytes = await readFile(input.filePath);
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: input.mimeType }),
        basename(input.filePath),
      );
      form.append("model", model);
      form.append("response_format", "text"); // 본문이 곧 전사 텍스트(파싱 불필요).
      if (input.language !== undefined && input.language !== "") {
        form.append("language", input.language);
      }
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${conn.apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`transcription openai: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      return (await res.text()).trim();
    },
  };
};
