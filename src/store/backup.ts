/**
 * DB 백업 — `VACUUM INTO` 로 하루 1벌, 최근 N벌만 보관.
 *
 * ★왜 필요했나 (2026-08-11): 이 DB 한 파일에 **기억·세션·대화가 전부** 있는데 백업이
 *  **하나도 없었다**. 크기·성능은 몇 년 뒤 문제지만 백업은 처음부터 문제다 — 없어진 뒤엔
 *  복구할 방법이 없다.
 *
 * ★`cp` 가 아니라 `VACUUM INTO` 인 이유: WAL 모드라 최신 내용이 `-wal` 에 따로 있다.
 *  파일만 복사하면 **깨지거나 옛 상태**가 나온다. `VACUUM INTO` 는 돌고 있는 데몬을 멈추지
 *  않고 락 없이 일관된 사본을 만들고, 조각 모음까지 돼 원본보다 작다.
 *
 * ★조치가 여기 사는 이유 (health.ts 설계 원칙): "자동 조치는 **그 기능을 소유한 쪽**이
 *  한다 — 관측자가 조용히 행위자가 되면 안 된다." 자가 진단은 *백업이 없다*를 **알아채는**
 *  일만 하고, 실제로 뜨는 건 DB 를 소유한 여기다. self-growth 는 시계만 빌려준다.
 *
 * 통보 정책 (사용자 확정 2026-08-11): **성공은 침묵**(로그만) · 실패는 보고 · 첫 실행 1회 안내.
 *  매일 성공 알림은 배경 소음이 되고, 그러면 진짜 신호가 묻힌다. 상태는 `/status` 로 본다.
 */
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { getPaths } from "../core/paths.js";
import { getDb } from "./sessions.js";

/** 보관 벌수 — 하루 증가가 원본의 1% 안팎이라 7벌이어도 원본 크기 정도. */
const KEEP = 7;
/** 이 간격보다 최근 것이 있으면 건너뛴다(시계가 1시간마다 도니 하루 1벌로 수렴). */
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

const backupDir = (): string => path.join(getPaths().data, "backup");

export interface BackupInfo {
  /** 가장 최근 백업 시각(ms). 없으면 null. */
  readonly latestAt: number | null;
  readonly count: number;
  readonly totalBytes: number;
}

/** `backup/` 안의 `tiguclaw-*.db` 를 최신순으로. 폴더가 없으면 빈 배열. */
const listBackups = (): { file: string; mtime: number; size: number }[] => {
  try {
    return fs
      .readdirSync(backupDir())
      .filter((f) => /^tiguclaw-.*\.db$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(backupDir(), f));
        return { file: f, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return []; // 폴더 없음 = 아직 한 번도 안 함.
  }
};

/** `/status`·자가 진단이 읽는 현재 상태. 부수효과 0. */
export const backupInfo = (): BackupInfo => {
  const all = listBackups();
  return {
    latestAt: all[0]?.mtime ?? null,
    count: all.length,
    totalBytes: all.reduce((n, b) => n + b.size, 0),
  };
};

/**
 * 필요하면 백업을 뜬다. 이미 최근 것이 있으면 **아무것도 안 한다**(빈 결과).
 *
 * never-throw — 백업 실패가 데몬을 무르지 않는다. 실패는 반환값으로 알린다(호출부가 보고).
 */
export type BackupResult =
  | { ran: false }
  | { ran: true; file: string; bytes: number; first: boolean }
  | { ran: true; error: string };

/**
 * 이 결과를 **사용자에게 알릴 것인가** — 알린다면 무슨 문장인가. `null` = 침묵.
 *
 * ★순수 함수로 뽑은 이유: "성공은 조용히" 는 **행동 규칙**인데, 호출부에 인라인으로 두면
 *  검사가 소스를 훑는 수밖에 없고 그건 뚫린다(실제로 뚫렸다 — 성공 경로 뒤에 보고를 한 줄
 *  끼워 넣었더니 정규식이 못 봤다). 판정을 여기 두면 회귀가 **실행해서** 지킨다.
 *
 * 정책(사용자 확정 2026-08-11): 실패는 알린다 · **첫 벌만** 안내한다 · 그 뒤 성공은 침묵.
 *  매일 성공 알림은 배경 소음이 되고, 그러면 진짜 신호가 묻힌다.
 */
export const backupNotice = (r: BackupResult): string | null => {
  if (!r.ran) return null; // 아직 때가 아님 — 아무 일도 안 했다.
  if ("error" in r) return `데이터 백업에 실패했습니다 — ${r.error.slice(0, 120)}`;
  if (r.first) {
    return "오늘부터 데이터를 매일 한 벌씩 백업합니다(최근 7벌 보관, `<home>/data/backup/`). 앞으로는 조용히 돌고, 실패할 때만 알려드립니다.";
  }
  return null; // ★성공 = 침묵.
};

/**
 * 백업을 켤 것인가 — `settings.json` 의 `backup.enabled`. **기본 켜짐.**
 *
 * ★기본을 켬으로 둔 이유: 이건 안 하고 있다가 필요할 때 없으면 끝나는 종류다.
 *  파일 하나 추가라 되돌리기 쉽고 최악이 디스크 몇십 MB — 사용자가 세운 자가조치 기준
 *  ("되돌릴 수 있거나 최악이 사소하면 자동")에 정확히 든다. 끄고 싶으면 이 키로 끈다.
 *  ★매 턴 fresh 로 읽으므로 재시작이 필요 없다.
 */
export const backupEnabled = (): boolean => {
  try {
    const raw = JSON.parse(readFileSync(getPaths().settings, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return true;
    const b = (raw as Record<string, unknown>).backup;
    if (b === null || typeof b !== "object" || Array.isArray(b)) return true;
    return (b as Record<string, unknown>).enabled !== false; // 명시 false 만 끔.
  } catch {
    return true; // 설정 없음·파싱 실패 = 기본 동작(켬).
  }
};

export const runBackupIfDue = (
  now: number = Date.now(),
): BackupResult => {
  try {
    if (!backupEnabled()) return { ran: false };
    const existing = listBackups();
    if (existing[0] !== undefined && now - existing[0].mtime < MIN_INTERVAL_MS) {
      return { ran: false };
    }
    fs.mkdirSync(backupDir(), { recursive: true });
    const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const target = path.join(backupDir(), `tiguclaw-${stamp}.db`);
    // ★SQLite 가 대상 파일을 직접 만든다 — 이미 있으면 실패하므로 미리 만들지 않는다.
    getDb()
      .prepare(`VACUUM INTO ?`)
      .run(target);
    const bytes = fs.statSync(target).size;

    // 오래된 것부터 정리 — 보관은 최신 KEEP 벌.
    for (const old of listBackups().slice(KEEP)) {
      try {
        fs.rmSync(path.join(backupDir(), old.file), { force: true });
      } catch {
        /* 한 벌 못 지워도 백업 자체는 성공이다 */
      }
    }
    return { ran: true, file: path.basename(target), bytes, first: existing.length === 0 };
  } catch (e) {
    return { ran: true, error: e instanceof Error ? e.message : String(e) };
  }
};
