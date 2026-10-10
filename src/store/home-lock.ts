// src/store/home-lock.ts
/**
 * **홈 하나에 데몬 하나** — 부팅 잠금 (2026-10-09 전체 적대 검토 P4).
 *
 * ★사고: 같은 홈으로 두 번째 데몬이 뜨면 막히지 않고 **반쯤 살았다** — 채널 start 실패는 로그 한 줄뿐이고,
 *  부팅 복구는 그대로 돌아 **A 가 돌리던 잡을 «재시작으로 중단» 으로 바꿔 통지**하고, 부팅 리퍼가 A 의 백그라운드
 *  셸·`/project run` 을 SIGKILL 하고, 스케줄이 두 번 발화하고, 텔레그램은 409 로 서로 끊었다. DB 를 여는 순간
 *  이미 늦다 — 그래서 `initStore` **앞**에서 막는다.
 *
 * 잠금 = `<home>/daemon.lock` 에 {pid, 프로세스 시작 시각, 시스템 부팅 시각}.
 *  - ★내용을 다 쓴 임시 파일을 `link` 로 건다(있으면 실패) — 동시에 뜬 둘 중 하나만 쥐고, **빈 잠금이 보이는 순간이 없다**.
 *    종전 `wx` 생성 → 기록 사이에 다른 부팅이 빈 파일을 «손상» 으로 보고 지워 둘 다 떴다(2026-10-10 아스트라 검토).
 *  - 이미 있으면 **살아 있는 같은 프로세스인가**를 본다: pid 생존(`kill(pid, 0)` — 윈도우도 같은 API)
 *    + 시작 시각 대조(PID 재사용 봉쇄). 재부팅 뒤면 pid 는 무조건 남의 것이다(부팅 시각이 다르다).
 *  - 죽었거나 남의 프로세스면 **회수**한다(크래시·SIGKILL·전원 상실 뒤 영영 못 뜨면 그게 더 큰 사고다).
 * ★확인할 수 없으면(ps/powershell 실패) **살아 있다고 본다** — 둘이 도는 것이 되돌릴 수 없는 쪽이다
 *  (잡 상태를 덮어쓰고 셸을 죽인다). 못 뜬 쪽은 감독자가 스로틀로 다시 시도한다.
 */
import { execFileSync } from "node:child_process";
import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_LOCK_FILE = "daemon.lock";

interface LockBody {
  pid: number;
  /** 그 프로세스의 시작 시각(ms) — PID 재사용 판정. */
  startedAt: number;
  /** 시스템 부팅 시각(ms) — 재부팅 전 잠금이면 pid 는 볼 것도 없이 남의 것이다. */
  bootAt: number;
}

/** 시각 대조 허용 오차 — `ps lstart` 가 초 단위라 넉넉히. */
const START_SKEW_MS = 3_000;
/** 부팅 시각은 `uptime` 반올림·NTP 보정으로 흔들린다 — 재부팅을 가르기엔 1분이면 충분하다. */
const BOOT_SKEW_MS = 60_000;
/**
 * 읽을 수 없는 잠금을 손상으로 볼 만큼 오래됐나. `link` 를 못 쓰는 파일시스템에선 `wx` 로 만들고 쓰므로 그 사이엔 빈 파일이 보인다 —
 * 막 생긴 것은 **쓰는 중**일 수 있어 지우지 않는다(거절하면 감독자가 곧 다시 띄운다).
 */
const CORRUPT_MIN_AGE_MS = 10_000;

/**
 * 잠금을 원자적으로 만든다 — 이미 있으면 `false`. 내용을 다 쓴 임시 파일을 hard link 로 거므로 다른 부팅이 **빈 잠금**을 볼 수 없다.
 * hard link 를 못 쓰는 파일시스템이면 `wx` 로 만든다(그때의 빈 순간은 위 `CORRUPT_MIN_AGE_MS` 가 덮는다).
 */
/** 회귀 검사용 — 잠금 경로가 생긴 **바로 그 순간**(내용 기록 전일 수 있다)에 부른다. 다른 부팅을 그 틈에 강제로 끼워 넣는다. */
export const homeLockTestHooks: { onCreated?: () => void } = {};

const createLock = (file: string, content: string): boolean => {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(tmp, content);
    linkSync(tmp, file);
    homeLockTestHooks.onCreated?.();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    // 그 밖의 실패(hard link 미지원 볼륨·백신이 쥔 임시 파일 등 — 윈도우에서 코드가 제각각이다)는 아래 `wx` 로 간다.
    //  종전처럼 목록에 없는 코드를 던지면 그 볼륨에선 부팅이 매번 죽는다(2026-10-10 재검토 F3).
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* 이미 없음 */
    }
  }
  try {
    const fd = openSync(file, "wx");
    homeLockTestHooks.onCreated?.();
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
};


const selfBody = (): LockBody => ({
  pid: process.pid,
  startedAt: Math.round(Date.now() - process.uptime() * 1000),
  bootAt: Math.round(Date.now() - os.uptime() * 1000),
});

/** pid 가 살아 있나 — 신호 0 은 보내지 않고 존재만 묻는다. EPERM = 남의 권한이지만 **존재한다**. */
export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** 그 pid 의 시작 시각(ms) — 못 알아내면 undefined(호출부가 «살아 있음» 으로 둔다). */
const processStartMs = (pid: number): number | undefined => {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        // ★`Get-Process …StartTime` 은 남의 세션·SYSTEM 프로세스면 접근 거부로 빈다 — CIM 의 CreationDate 는 비관리자도 읽힌다(재검토).
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
      ).trim();
      const t = Date.parse(out);
      return Number.isFinite(t) ? t : undefined;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
    const t = Date.parse(out); // "Thu Oct  9 12:34:56 2026" — 로컬 시각.
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
};

/** 잠금을 쥔 프로세스가 **지금도 그 프로세스로** 살아 있나. */
const holderIsLive = (b: LockBody): { live: boolean; why: string } => {
  if (b.pid === process.pid) return { live: false, why: "내 pid(재진입)" };
  const nowBoot = Date.now() - os.uptime() * 1000;
  if (Math.abs(nowBoot - b.bootAt) > BOOT_SKEW_MS) return { live: false, why: "재부팅 전 잠금" };
  if (!pidAlive(b.pid)) return { live: false, why: `pid ${b.pid} 없음` };
  // ★EPERM 만으로 «남의 프로세스» 라고 판정하지 않는다 — 샌드박스 안이거나(맥) 잠금을 쥔 데몬이 관리자 권한이면(윈도우) **같은 사용자의
  //  살아 있는 데몬**도 EPERM 이다(재확인 검토: 그렇게 회수해 데몬이 둘 떴다). 판정은 신호 권한과 무관하게 읽히는 **시작 시각**으로만 한다
  //  (윈도우는 CIM 이라 남의 세션 프로세스도 읽힌다 — PID 재사용이면 시각이 달라 회수된다).
  const st = processStartMs(b.pid);
  if (st === undefined) return { live: true, why: `pid ${b.pid} 생존 · 시작 시각 확인 불가(안전측: 살아 있음)` };
  if (Math.abs(st - b.startedAt) > START_SKEW_MS) {
    return { live: false, why: `pid ${b.pid} 는 다른 프로세스(시작 시각 차 ${Math.round(Math.abs(st - b.startedAt) / 1000)}초 — PID 재사용)` };
  }
  return { live: true, why: `pid ${b.pid} 생존 · 시작 시각 일치` };
};

const readBody = (file: string): { raw: string; body: LockBody | undefined } => {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
    const j = JSON.parse(raw) as Partial<LockBody>;
    if (typeof j.pid === "number" && typeof j.startedAt === "number" && typeof j.bootAt === "number") {
      return { raw, body: j as LockBody };
    }
  } catch {
    /* 없음·손상 — 아래에서 회수 대상 */
  }
  return { raw, body: undefined };
};

export type HomeLockResult =
  | { ok: true; reclaimed?: string }
  | { ok: false; holderPid: number; why: string };

/**
 * 홈 잠금을 쥔다. 다른 데몬이 이 홈을 쥐고 살아 있으면 `{ok:false}` — 호출부가 로그를 남기고 종료한다.
 * 쥐면 프로세스 종료 때 **내 잠금일 때만** 지운다(재기동한 다음 세대의 잠금을 지우지 않게).
 */
export const acquireHomeLock = (home: string): HomeLockResult => {
  const file = path.join(home, HOME_LOCK_FILE);
  let reclaimed: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createLock(file, JSON.stringify(selfBody()))) {
      process.on("exit", () => releaseHomeLock(home));
      return reclaimed === undefined ? { ok: true } : { ok: true, reclaimed };
    }
    const { raw, body } = readBody(file);
    if (body !== undefined) {
      const h = holderIsLive(body);
      if (h.live) return { ok: false, holderPid: body.pid, why: h.why };
      reclaimed = h.why;
    } else {
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(file).mtimeMs;
      } catch {
        continue; // 그 사이 사라졌다 — 다시 쥐러 간다
      }
      // 시계가 뒤로 가 mtime 이 미래면 «막 만든 것» 이 아니다 — 양쪽 다 10초 안일 때만 기다린다(재검토 F4).
      if (Math.abs(ageMs) < CORRUPT_MIN_AGE_MS) return { ok: false, holderPid: -1, why: "잠금을 막 만드는 중(읽을 수 없는 새 잠금)" };
      reclaimed = "잠금 파일 손상";
    }
    // ★지우기 직전에 다시 읽어 **같은 내용일 때만** 지운다 — 그 사이 다른 부팅이 새로 쥔 잠금을 지우지 않게.
    //  (다시 읽기와 지우기 사이의 아주 좁은 창은 남는다 — rename 으로 떼어 내는 방법은 되돌리는 사이에 제3자가 들어오는
    //   창을 새로 만들어 이득이 없었다. 2026-10-10)
    try {
      if (readFileSync(file, "utf8") === raw) unlinkSync(file);
    } catch {
      /* 이미 없음 — 다시 쥐러 간다 */
    }
  }
  const { body } = readBody(file);
  return { ok: false, holderPid: body?.pid ?? -1, why: "잠금 경합 — 다른 부팅이 동시에 쥐었다" };
};

/** 내 잠금이면 지운다(동기 — exit 훅에서 부른다). 남의 잠금은 건드리지 않는다. */
export const releaseHomeLock = (home: string): void => {
  const file = path.join(home, HOME_LOCK_FILE);
  try {
    const { body } = readBody(file);
    if (body?.pid === process.pid) unlinkSync(file);
  } catch {
    /* 종료 중 — 할 수 있는 게 없다 */
  }
};
