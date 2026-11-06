// src/core/secret-file.ts
/**
 * **비밀 파일을 «본인만 읽는» 권한으로 만든다** — 한 곳 (2026-11-05).
 *
 * POSIX 는 생성 mode 0600 이면 끝이지만, Windows 에서 Node 의 mode·chmod 는 쓰기 비트만 바꾸고 DACL 은 그대로다
 *  (Node fs 문서: «on Windows only the write permission can be changed»). 그래서 `.env` 같은 파일이 **상위 폴더의 상속 ACL**
 *  을 그대로 받았다(v7 MARTIN-H: 실행 계정이 아닌 SID 에 ReadData 상속 — docs/decisions/2026-11-05-v082-windows-v7-full-failures.md).
 *
 * 순서가 계약이다: ①빈 파일을 배타 생성 → ②권한을 확립 → ③그다음에 내용. 권한을 못 세우면 내용을 쓰지 않고 그 파일을 지운다
 *  (상속 권한으로 «그래도 쓰기» 는 이번 결함 그 자체다).
 * ★정리 책임은 **생성에 성공한 쪽만** 진다 — 배타 생성이 실패(EEXIST)했으면 그 경로의 파일은 우리 것이 아니다.
 * ★Windows 의 남는 한계: ①과 ② 사이(빈 파일) 다른 주체가 핸들을 미리 열어 쥐고 있으면 접근 검사는 열 때라 막지 못한다 —
 *  상속 읽기권을 가진 능동 공격자 전제이고, 이 모듈이 없애는 것은 «비밀이 상속 권한으로 남는» 수동 노출이다.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import crypto from "node:crypto";

type Exec = (file: string, args: string[]) => Promise<string>;
export interface SecretFileOptions {
  /** 시험 전용 — Windows 분기를 다른 OS 에서 합성으로 돌린다. */
  platform?: NodeJS.Platform;
  exec?: Exec;
}

// 쉘을 띄우지 않는다 — 경로는 argv 원소 하나로 간다(Node 가 CreateProcess 규칙대로 인용). 문자열 명령 조립 0.
const execNoShell: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const SID = /^S-1-\d+(-\d+)+$/;
/** 실행기별 캐시 — 적중하면 프로세스를 띄우지 않는다(띄워 놓고 버리면 그 실패가 처리되지 않은 rejection 으로 데몬을 죽인다). 실패는 캐시하지 않는다. */
const sidCache = new WeakMap<Exec, Promise<string>>();
/** 프로세스 토큰 사용자 SID — 허용 주체의 정본(파일 소유자가 아니라: 승격 관리자는 소유자가 Administrators 가 된다). */
const currentUserSid = (exec: Exec): Promise<string> => {
  const hit = sidCache.get(exec);
  if (hit !== undefined) return hit;
  const read = exec("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then((out) => {
    const sid = out.trim().split(",").pop()?.replace(/^"|"$/g, "") ?? "";
    if (!SID.test(sid)) throw new Error("secret-file: could not read the current user SID");
    return sid;
  });
  sidCache.set(exec, read);
  read.catch(() => { if (sidCache.get(exec) === read) sidCache.delete(exec); }); // 실패는 호출자가 받는다 — 여기선 캐시만 비운다
  return read;
};

/** 파일 하나의 권한을 «현재 사용자·SYSTEM·Administrators 만, 상속 없음» 으로 세운다. POSIX 는 0600. */
export const restrictToCurrentUser = async (file: string, opts: SecretFileOptions = {}): Promise<void> => {
  if ((opts.platform ?? process.platform) !== "win32") {
    await fs.chmod(file, 0o600);
    return;
  }
  const exec = opts.exec ?? execNoShell;
  const sid = await currentUserSid(exec);
  // /reset = 명시 ACE 를 버리고 상속분만 남긴다 · /inheritance:r = 상속분 제거 · /grant:r = 이 셋만 명시 허용 → 정확히 셋.
  await exec("icacls.exe", [file, "/reset"]);
  await exec("icacls.exe", [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"]);
};

/** 새 파일을 배타 생성 → 권한 확립 → 내용. 생성 뒤 실패면 그 파일을 지우고 던진다(생성 실패면 아무것도 안 지운다). */
export const writePrivateFile = async (file: string, content: string, opts: SecretFileOptions = {}): Promise<void> => {
  await fs.writeFile(file, "", { flag: "wx", mode: 0o600 });
  try {
    await restrictToCurrentUser(file, opts);
    await fs.writeFile(file, content, { encoding: "utf8", flag: "r+" });
  } catch (e) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw e;
  }
};

/** 같은 폴더의 임시 파일에 비밀을 쓰고 원자 교체한다. 교체가 실패하면 임시 파일(비밀 사본)을 지우고 던진다 — 기존 파일은 그대로. */
export const replacePrivateFile = async (dest: string, content: string, opts: SecretFileOptions = {}): Promise<void> => {
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  await writePrivateFile(tmp, content, opts);
  try {
    await fs.rename(tmp, dest); // 같은 볼륨 이동은 권한을 유지한다(KB310316) — 확립한 DACL 이 그대로 최종 파일의 것이 된다
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
};
