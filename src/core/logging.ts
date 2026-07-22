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
 *   구조화 로그·전송은 실수요 시 후속.
 *
 * ★자정 롤오버 (2026-07-22): 파일명은 *이벤트 발생 날짜* 기준. 예전엔 부팅 시점 날짜로
 *   1회 결정했는데(dev tsx watch 잦은 리로드 = 사실상 일별 가정), built 런타임이 launchd 로
 *   며칠씩 연속 구동하면서 그 가정이 깨졌다: 어젯밤 부팅해 밤새 돈 데몬이 새벽 이벤트를
 *   전날짜 파일에 써서, "오늘 새벽 실패"를 오늘짜 로그에서 찾으면 텅 비어 진단이 헷갈렸다
 *   (실제 07-22 02:22 위키 전송실패가 daemon-2026-07-21.log 에 묻힘). 이제 매 write 마다
 *   로컬 날짜가 바뀌면 스트림을 새 daemon-<오늘>.log 로 롤오버한다 → 이벤트가 항상 발생
 *   날짜 파일에 남는다.
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

  let logsDir: string;
  // 아래 openStream 이 try 안에서 이들을 반드시 할당(실패 시 return null) — TS 는 클로저
  // 경유 할당을 추적 못 하므로 definite assignment(!)로 명시.
  let stream!: WriteStream;
  let logFile!: string;
  let streamDate!: string;
  const openStream = (date: string): void => {
    logFile = path.join(logsDir, `daemon-${date}.log`);
    stream = createWriteStream(logFile, { flags: "a" });
    streamDate = date;
    // 스트림 비동기 에러(디스크 풀 등)가 unhandled 로 데몬을 죽이지 않게 흡수.
    stream.on("error", () => {
      /* 관측 손실 감수 — 데몬 생존 우선 */
    });
  };
  try {
    logsDir = path.join(resolveHome(), "logs");
    mkdirSync(logsDir, { recursive: true });
    openStream(localDate(new Date()));
  } catch {
    // 로그 파일 준비 실패 → 원래 console 그대로(패치 안 함). 데몬 정상 진행.
    return null;
  }

  // 날짜가 바뀌었으면 새 daemon-<오늘>.log 로 롤오버(자정 넘겨 연속 구동해도 이벤트가
  // 발생 날짜 파일에 남게). 실패해도 기존 스트림 유지 — 관측 손실 ≪ 데몬 다운.
  const currentStream = (now: Date): WriteStream => {
    const today = localDate(now);
    if (today !== streamDate) {
      try {
        const old = stream;
        const prevDate = streamDate;
        openStream(today);
        old.write(`===== log continues in daemon-${today}.log (date rollover) =====\n`);
        old.end();
        stream.write(
          `\n===== daemon log rollover ${localStamp(now)} (pid ${process.pid}, from daemon-${prevDate}.log) =====\n`,
        );
      } catch {
        /* 롤오버 실패 — 기존 스트림 유지 */
      }
    }
    return stream;
  };

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
        const now = new Date();
        currentStream(now).write(`[${localStamp(now)}] [${level}] ${format(...args)}\n`);
      } catch {
        /* 미러 실패 — 무시 (원래 출력은 이미 됨) */
      }
    };
  }

  return logFile;
};
