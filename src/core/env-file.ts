// src/core/env-file.ts
/**
 * **홈 `.env` 에 키를 안전하게 쓴다** — 한 곳 (2026-08-27).
 *
 * ★여기 모인 규칙은 전부 **사고에서 나온 것**이다. `claude-auth` 를 만들면서 같은 걸 두 벌
 *  짓지 않으려고 `upsertCodexTokens` 안에 있던 판단을 그대로 끌어냈다 — 베끼면 다음 사고 때
 *  한쪽만 고쳐진다([[feedback_hand_maintained_lists]]).
 *
 *  ① **읽기 실패를 "부재" 로 오인하지 않는다.** ENOENT 만 새로 작성이다. 일시적 EBUSY·
 *     업데이트 중 파일 교체 레이스를 부재로 읽으면 `body=""` 가 되어 **기존 키가 전부
 *     사라진다**(TELEGRAM_BOT_TOKEN·HTTP_BRIDGE_TOKEN …). 그럴 땐 파일을 건드리지 않는다.
 *  ② **원자적 write** — temp 에 쓰고 rename. 재작성 도중 죽어도 기존 `.env` 가 truncate
 *     되지 않는다.
 *  ③ **0600 유지** — mode 미지정이면 tmp 가 0644 로 생기고 rename 이 그 퍼미션을 가져간다.
 *     사용자가 `chmod 600` 해도 다음 갱신 때 0644 로 되돌아가는 루프였다.
 *  ④ **in-memory 를 먼저** 갱신한다 — 파일 write 성패와 무관하게 현재 프로세스가 새 값을
 *     즉시 쓴다.
 */
import fs from "node:fs/promises";
import { homeEnvPath } from "./load-env.js";

/**
 * 여러 키를 한 번에 upsert. 반환값은 **쓴 파일 경로**(호출자가 사용자에게 보여준다).
 *
 * 파일을 못 고친 경우에도 `process.env` 는 갱신되고 경로를 그대로 돌려준다 — 실패를
 * 삼키지 않되(위 ① 로그) 호출 흐름을 끊지도 않는다.
 */
export const upsertHomeEnvVars = async (
  updates: Record<string, string>,
): Promise<string> => {
  const keys = Object.keys(updates);
  for (const k of keys) process.env[k] = updates[k]; // ④
  const envPath = homeEnvPath();

  let body = "";
  try {
    body = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // ① clobber 방지 — 부재가 아니면 파일 갱신을 건너뛴다.
      console.error(
        `env-file: .env 읽기 실패(${String(err)}) at ${envPath} — ` +
          `기존 .env clobber 방지 위해 파일 갱신 skip (process.env 는 갱신됨).`,
      );
      return envPath;
    }
  }

  const seen = new Set<string>();
  const next = (body === "" ? [] : body.split("\n")).map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    const key = m?.[1];
    if (key !== undefined && updates[key] !== undefined) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const k of keys) if (!seen.has(k)) next.push(`${k}=${updates[k]}`);

  const out = next.join("\n");
  const finalBody = out.endsWith("\n") ? out : `${out}\n`;
  const tmp = `${envPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, finalBody, { encoding: "utf8", mode: 0o600 }); // ②③
  await fs.rename(tmp, envPath);
  await fs.chmod(envPath, 0o600).catch(() => {}); // 구 설치본 치유
  return envPath;
};
