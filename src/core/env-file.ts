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
import { noteSelfEnvWrite, trackSelfEnvWrite } from "./credential-env.js";

/**
 * 여러 키를 한 번에 upsert. 반환값은 **쓴 파일 경로**(호출자가 사용자에게 보여준다).
 *
 * 파일을 못 고친 경우에도 `process.env` 는 갱신되고 경로를 그대로 돌려준다 — 실패를
 * 삼키지 않되(위 ① 로그) 호출 흐름을 끊지도 않는다.
 */
/**
 * ⑤ **같은 프로세스의 저장은 한 줄로 선다** (2026-10-01 적대 검토 — 실측 3회 결정적). 종전엔 두 저장(대시보드 토큰 저장 + codex
 *  토큰 갱신)이 겹치면 둘 다 같은 옛 본문을 읽고 같은 임시 파일(`.tmp-<pid>`)에 써서, 한쪽은 rename 에서 던지고 다른 쪽은 성공이라
 *  답했는데 **방금 저장한 토큰 줄이 파일에 없었다**(재시작 뒤 401). 앞 저장이 끝나야 다음 저장이 읽는다 · 임시 이름은 저장마다 다르다.
 *  ★다른 프로세스(터미널 `claude-auth` + 데몬)가 겹치는 경우는 이 줄로 못 막는다 — 임시 이름이 달라 파일이 깨지진 않지만 늦게 쓴
 *   쪽이 먼저 쓴 키를 모를 수 있다.
 */
let writeChain: Promise<unknown> = Promise.resolve();

export const upsertHomeEnvVars = (
  updates: Record<string, string>,
): Promise<string> => {
  for (const k of Object.keys(updates)) process.env[k] = updates[k]; // ④ — 줄 서기 전에, 즉시
  const run = trackSelfEnvWrite(writeChain.then(() => writeHomeEnvVars(updates))); // 쓰는 동안 턴 입구가 파일을 «바깥 변경» 으로 안 읽게
  writeChain = run.catch(() => {}); // 앞 저장의 실패가 뒤 저장을 막지 않는다(실패는 그 호출자에게 그대로 간다)
  return run;
};

const writeHomeEnvVars = async (updates: Record<string, string>): Promise<string> => {
  const keys = Object.keys(updates);
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
  const tmp = `${envPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  // ★실패하면 임시 파일을 지운다 — 이름이 저장마다 달라(동시 저장 대비) 남은 것이 쌓이고, 하나하나가 **모든 토큰을 담은 사본**이다
  //  (적대 검토: rename 을 EPERM 으로 세 번 실패시키니 세 개가 남았다 — 윈도우 백신·인덱서가 잡고 있으면 실제로 난다).
  try {
    await fs.writeFile(tmp, finalBody, { encoding: "utf8", mode: 0o600 }); // ②③
    await fs.rename(tmp, envPath);
    noteSelfEnvWrite(finalBody); // 감시가 이 상태를 바깥 변경으로 오인하지 않게(뒤 저장이 실패해 파일이 메모리보다 옛 값일 때)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  await fs.chmod(envPath, 0o600).catch(() => {}); // 구 설치본 치유
  return envPath;
};
