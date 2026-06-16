/**
 * 파일 로깅 — console.* 미러링 (2026-06-11).
 *
 * 문제: 데몬을 `npm run dev`(tsx watch) 로 띄우면 stdout/stderr 가 터미널로만 가고
 *   파일에 안 남는다. handler 에러는 (a) transcripts 미저장(에러 경로는 route 밖),
 *   (b) EventBus 미publish, (c) 로그 터미널뿐 → 3중 증발 → 사후 진단 불가.
 *
 * 해결: console.log/info/warn/error/debug 를 *패치* 해 원래 동작(터미널 출력) +
 *   `<home>/logs/daemon-<날짜>.log` 파일 append 를 둘 다 수행. 기존 수백 개 console.*
 *   호출(부팅·plugin-loader·route·handler 스택)을 **코드 변경 0** 으로 전부 캡처.
 *   = "언제나 확인 가능한 로그" (외부에서 Read/Grep 으로 아무 때나 조회).
 *
 * 견고성: 파일 준비/쓰기 실패가 데몬·console 자체를 죽이면 안 됨 → 전부 try/catch,
 *   실패 시 조용히 원래 console 만 동작 (관측 손실 ≪ 데몬 다운). stream error 도 흡수.
 *
 * 단순성(YAGNI): 로깅 라이브러리(pino/winston) 미도입 — fs append + util.format 표준만.
 *   구조화 로그·전송·midnight 자동 rotation 은 실수요 시 후속. 파일명은 부팅 시점 날짜
 *   1회 결정(재시작/리로드마다 갱신 — dev tsx watch 는 잦은 리로드라 사실상 일별).
 *
 * 보안: 로그는 운영자 로컬(`<home>/logs`, .gitignore 의 `*.log`+홈 디렉터리로 비추적).
 *   console 과 동일 신뢰 경계 → 별도 redact 안 함(진단 fidelity 보존, 채널 발송만 redact).
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { resolveHome } from "./paths.js";

const pad = (n: number): string => String(n).padStart(2, "0");

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const localStamp = (d: Date): string =>
  `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

let initialized = false;

/**
 * console.* 를 파일 미러링으로 패치. 부팅 최상단(첫 console.log 전)에서 1회 호출.
 * 멱등 — 두 번째 호출은 무시. 반환: 활성화된 로그 파일 경로(실패 시 null).
 */
export const initFileLogging = (): string | null => {
  if (initialized) return null;
  initialized = true;

  let stream: WriteStream;
  let logFile: string;
  try {
    const logsDir = path.join(resolveHome(), "logs");
    mkdirSync(logsDir, { recursive: true });
    logFile = path.join(logsDir, `daemon-${localDate(new Date())}.log`);
    stream = createWriteStream(logFile, { flags: "a" });
    // 스트림 비동기 에러(디스크 풀 등)가 unhandled 로 데몬을 죽이지 않게 흡수.
    stream.on("error", () => {
      /* 관측 손실 감수 — 데몬 생존 우선 */
    });
  } catch {
    // 로그 파일 준비 실패 → 원래 console 그대로(패치 안 함). 데몬 정상 진행.
    return null;
  }

  // 부팅 구분선 — 재시작마다 경계 가시화 (어느 부팅의 로그인지).
  try {
    stream.write(
      `\n===== daemon boot ${localStamp(new Date())} (pid ${process.pid}) =====\n`,
    );
  } catch {
    /* ignore */
  }

  const levels: Array<["log" | "info" | "warn" | "error" | "debug", typeof console.log]> = [
    ["log", console.log],
    ["info", console.info],
    ["warn", console.warn],
    ["error", console.error],
    ["debug", console.debug],
  ];

  for (const [level, original] of levels) {
    console[level] = (...args: unknown[]): void => {
      // 원래 동작(터미널) 먼저 — 미러 실패가 정상 출력을 막지 않게.
      original(...args);
      try {
        stream.write(`[${localStamp(new Date())}] [${level}] ${format(...args)}\n`);
      } catch {
        /* 미러 실패 — 무시 (원래 출력은 이미 됨) */
      }
    };
  }

  return logFile;
};
