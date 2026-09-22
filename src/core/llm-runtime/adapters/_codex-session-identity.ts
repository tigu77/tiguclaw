import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** RFC UUIDv5. 도메인/seed는 영속 전송 계약이므로 임의 변경하지 않는다. */
export const deriveCodexSessionIdentity = (accountId: string, threadKey: string, namespace: string): string => {
  const seed = JSON.stringify(["tiguclaw:codex-session:v1", accountId, threadKey]);
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * 홈별 namespace + 계정 + 실제 threadKey로 파생한다. 부모 좌표로 환원하지 않는다.
 * JWT/모델/시각은 seed에 넣지 않는다. namespace는 토큰이 아닌 무작위 UUID다.
 * 원시 키/홈 경로를 헤더로 옮기지 않는다. 해시는 암호화가 아니다.
 * 불명확한 계정/대화, 저장 실패/손상/생성 경합 중 미완성 파일은 기존 전송으로 폴백.
 */
export const codexSessionIdentity = (accountId: unknown, threadKey: string, dataDir: string): string | undefined => {
  if (typeof accountId !== "string" || !accountId.trim() || !threadKey.trim()) return undefined;
  const file = join(dataDir, "codex-session-namespace");
  try {
    let namespace: string;
    try { namespace = readFileSync(file, "utf8").trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      mkdirSync(dataDir, { recursive: true });
      const candidate = randomUUID();
      try { writeFileSync(file, candidate + "\n", { flag: "wx", mode: 0o600 }); }
      catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      }
      // 경합해도 파일에 저장된 승자의 값만 쓴다. 로컬 candidate로 분기하지 않는다.
      namespace = readFileSync(file, "utf8").trim();
    }
    if (!UUID.test(namespace)) return undefined;
    return deriveCodexSessionIdentity(accountId, threadKey, namespace);
  } catch { return undefined; }
};
