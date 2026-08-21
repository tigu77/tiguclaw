/**
 * 오늘 로그 파일의 **상태 조회 + 비우기** — 채널 무관 판정 (2026-08-21).
 *
 * ★**왜 필요한가 (실사고).** 사용자가 로그 파일을 휴지통으로 옮겼는데 그 뒤로 로그가
 *  안 쌓였다. macOS 휴지통은 삭제가 아니라 **이름 바꾸기**라 파일 실체(inode)가 남고,
 *  데몬은 부팅 때 연 스트림으로 **휴지통 안의 그 파일에 계속 쓴다**. `logs/` 엔 아무것도
 *  안 생기고, 데몬은 멀쩡히 도니 **아무 신호도 없다**. 사용자가 물어보기 전엔 모른다.
 *
 * ★**그래서 이 모듈은 지우지 않는다 — 비운다(truncate).** 경로도 inode 도 그대로 두고
 *  내용만 0으로 만든다. 그러면 데몬 fd 가 계속 유효하다. "삭제/이동"을 이 기능에서
 *  아예 제공하지 않는 것이 요점이다 — 손으로 하면 밟는 함정을 버튼이 되풀이하면 안 된다.
 *
 * ★**truncate 가 안전한 근거(실증함, 가정 아님).** 데몬 스트림은 `flags:"a"`(O_APPEND)라
 *  매 write 가 파일 끝으로 seek 한다. 비운 뒤 쓰면 offset 0 부터 이어진다 —
 *  NUL 로 채워진 sparse 파일이 생기지 않는다(임시 파일로 재현 확인: NUL 0바이트).
 *  일반 스트림(비-append)이었다면 이 판단이 반대였을 것이라 근거를 남긴다.
 *
 * ★로그는 이 레포에서 **1차 진단면**이다(원격 불가 인스턴스는 로그가 전부다). 그래서
 *  조회가 비우기와 **같은 모듈에** 있다 — 크기와 마지막 기록을 보고 나서 비우게 하려는 것.
 *  볼 수 없는 것을 지우는 버튼은 만들지 않는다.
 */
import { readdirSync, statSync, truncateSync } from "node:fs";
import path from "node:path";
import { resolveHome } from "./paths.js";

/** `logging.ts` 와 **같은 규칙**으로 오늘 날짜 파일명을 만든다(둘이 갈리면 엉뚱한 걸 비운다). */
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface LogFileStatus {
  /** 오늘 로그 파일 절대경로. */
  path: string;
  /** 파일이 실제로 있나. 없으면 아래 값들은 0/null. */
  exists: boolean;
  bytes: number;
  /** 마지막 기록 시각(epoch ms). 없으면 null. */
  lastWriteTs: number | null;
  /** `logs/` 안의 다른 날짜 파일 개수 — "오늘 것만 비운다"를 사용자가 알 수 있게. */
  otherDays: number;
}

export const todayLogPath = (now: Date = new Date()): string =>
  path.join(resolveHome(), "logs", `daemon-${localDate(now)}.log`);

/** 조회 — 실패는 throw 하지 않는다(관측이 데몬을 죽이지 않는다). */
export const readLogFileStatus = (now: Date = new Date()): LogFileStatus => {
  const p = todayLogPath(now);
  let bytes = 0;
  let lastWriteTs: number | null = null;
  let exists = false;
  try {
    const st = statSync(p);
    exists = true;
    bytes = st.size;
    lastWriteTs = Math.round(st.mtimeMs);
  } catch {
    /* 없으면 exists=false — 정상 상태다(부팅 전·비운 직후 등) */
  }
  let otherDays = 0;
  try {
    const dir = path.dirname(p);
    const me = path.basename(p);
    otherDays = readdirSync(dir).filter(
      (f) => f.startsWith("daemon-") && f.endsWith(".log") && f !== me,
    ).length;
  } catch {
    /* logs 디렉터리 자체가 없으면 0 */
  }
  return { path: p, exists, bytes, lastWriteTs, otherDays };
};

export interface LogClearResult {
  ok: boolean;
  /** 비우기 전 크기 — 사용자에게 "얼마를 비웠는지" 보여준다. */
  clearedBytes: number;
  error?: string;
}

/**
 * 오늘 로그를 **비운다**(파일은 남는다).
 *
 * ★`unlink` 도 `rename` 도 하지 않는다 — 그게 이 기능이 존재하는 이유인 그 함정이다.
 */
export const clearTodayLog = (now: Date = new Date()): LogClearResult => {
  const before = readLogFileStatus(now);
  if (!before.exists) return { ok: true, clearedBytes: 0 };
  try {
    truncateSync(before.path, 0);
    return { ok: true, clearedBytes: before.bytes };
  } catch (e) {
    return {
      ok: false,
      clearedBytes: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};
