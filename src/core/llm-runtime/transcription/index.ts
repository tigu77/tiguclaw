/**
 * 전사 팩토리 + `enrichTranscripts` seam.
 *
 * `resolveTranscriptionProvider(cwd)`: settings `transcription` → provider | null(disabled/미지 provider).
 *   미설정(키 자체 없음) = 기본 openai 시도(contract §3 "기본 openai"). enabled:false 만 명시적 끔.
 * `enrichTranscripts(atts, cwd)`: audio/voice 첨부에 `transcript` 를 채운다 — 개별 try/catch·sidecar
 *   캐시·bytes 상한 가드·never-throw. runRegionA 진입 1회 호출(chain 루프 전, contract §1).
 * contract `_workspace/transcription_architect_contract.md` §1/§4/§5/§8.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Attachment } from "../../../channels/types.js";
import { loadTranscriptionConfig } from "../../settings.js";
import { createOpenAiTranscriptionProvider } from "./openai-provider.js";
import { createLocalTranscriptionProvider } from "./local-provider.js";
import type { TranscriptionProvider } from "./types.js";

// openai 한도(25MB)·긴 음성 폭주 방어(contract §9). 초과 = 전사 스킵 → path-reference 폴백.
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

export const resolveTranscriptionProvider = (
  cwd?: string,
): { provider: TranscriptionProvider; language?: string } | null => {
  const cfg = loadTranscriptionConfig(cwd) ?? { enabled: true, provider: "openai" };
  if (cfg.enabled === false) return null;
  const providerName = cfg.provider ?? "openai";
  if (providerName === "local") {
    return { provider: createLocalTranscriptionProvider(cfg.local ?? {}), language: cfg.language };
  }
  if (providerName === "openai") {
    return {
      provider: createOpenAiTranscriptionProvider(cfg.openai ?? {}, cwd),
      language: cfg.language,
    };
  }
  return null; // 미지 provider → graceful 스킵(path-reference 폴백)
};

const sidecarPath = (attPath: string): string => `${attPath}.transcript.json`;

const readSidecar = async (
  attPath: string,
  id: TranscriptionProvider["id"],
): Promise<string | null> => {
  try {
    const j = JSON.parse(await readFile(sidecarPath(attPath), "utf8")) as {
      provider?: string;
      model?: string;
      text?: string;
    };
    if (j.provider === id.provider && j.model === id.model && typeof j.text === "string") {
      return j.text;
    }
  } catch {
    /* 없음/파싱실패 = 캐시 미스 */
  }
  return null;
};

const writeSidecar = async (
  attPath: string,
  id: TranscriptionProvider["id"],
  language: string | undefined,
  text: string,
): Promise<void> => {
  try {
    await writeFile(
      sidecarPath(attPath),
      JSON.stringify({ provider: id.provider, model: id.model, language: language ?? null, text }),
      "utf8",
    );
  } catch {
    /* 캐시 쓰기 실패는 무해(다음 턴 재전사) */
  }
};

export const enrichTranscripts = async (
  atts: Attachment[] | undefined,
  cwd?: string,
): Promise<void> => {
  if (atts === undefined || atts.length === 0) return;
  const targets = atts.filter((a) => a.kind === "audio" || a.kind === "voice");
  if (targets.length === 0) return;
  const resolved = resolveTranscriptionProvider(cwd);
  if (resolved === null) return; // 미설정/disabled/미지 → path-reference 폴백(회귀 0)
  const { provider, language } = resolved;
  for (const att of targets) {
    if (att.transcript !== undefined && att.transcript !== "") continue;
    if (att.bytes > MAX_TRANSCRIBE_BYTES) {
      console.warn(
        `[transcription] skip ${att.path} — ${att.bytes}B > ${MAX_TRANSCRIBE_BYTES}B 상한`,
      );
      continue;
    }
    try {
      const cached = await readSidecar(att.path, provider.id);
      if (cached !== null) {
        att.transcript = cached;
        continue;
      }
      const text = await provider.transcribe({
        filePath: att.path,
        mimeType: att.mimeType,
        language,
      });
      att.transcript = text;
      await writeSidecar(att.path, provider.id, language, text);
    } catch (e) {
      // 첨부 단위 격리 — 한 파일 실패가 턴/다른 첨부를 죽이지 않음. 프롬프트로는 안 샘(로그만).
      console.warn(
        `[transcription] ${att.path} 실패 — path-reference 폴백:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
};
