/**
 * local 전사 impl — 설정된 CLI(command+args) spawn. {file}/{language} 플레이스홀더 치환.
 *
 * 결과 회수 = stdout(기본) 또는 지정 outputFile 읽기. 코어는 whisper.cpp 특수 규약(WAV 16k·ffmpeg
 * 변환 등)을 하드코딩하지 않는다 — command/args 전체가 config(크로스플랫폼도 사용자 몫). ENOENT
 * (바이너리 부재)·비정상 종료·timeout → throw → 상위 enrichTranscripts 가 graceful fallback(§4).
 * contract `_workspace/transcription_architect_contract.md` §2 impl B. 신규 npm 의존 0(child_process).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { TranscribeInput, TranscriptionProvider } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const subst = (s: string, input: TranscribeInput): string =>
  s.replace(/\{file\}/g, input.filePath).replace(/\{language\}/g, input.language ?? "");

export const createLocalTranscriptionProvider = (
  cfg: { command?: string; args?: string[]; timeoutMs?: number; outputFile?: string },
): TranscriptionProvider => {
  const command = cfg.command ?? "";
  const argsTpl = cfg.args ?? ["{file}"];
  const timeoutMs =
    cfg.timeoutMs !== undefined && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  return {
    id: { provider: "local", model: command },
    async transcribe(input: TranscribeInput): Promise<string> {
      if (command === "") throw new Error("transcription local: command 미설정");
      const args = argsTpl.map((a) => subst(a, input));
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`transcription local: timeout ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
          err += d.toString();
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e); // ENOENT(바이너리 부재) 등
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(`transcription local: exit ${code} ${err.slice(0, 200)}`));
        });
      });
      if (cfg.outputFile !== undefined && cfg.outputFile !== "") {
        return (await readFile(subst(cfg.outputFile, input), "utf8")).trim();
      }
      return stdout.trim();
    },
  };
};
