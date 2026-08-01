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
import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { resolveHome } from "./paths.js";
import { redactSecrets } from "./outbound-sanitize.js";

const pad = (n: number): string => String(n).padStart(2, "0");

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const localStamp = (d: Date): string =>
  `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

let initialized = false;

/** 지금 열려 있는 로그 파일 — `logFatal` 의 동기 append 대상(롤오버 시 갱신). */
let currentLogPath: string | null = null;

/**
 * **치명 종료 직전 로그 — 반드시 파일에 착지시킨다** (2026-07-31 전체검토 P0).
 *
 * ★왜 별도 경로인가: `console.*` 미러는 `createWriteStream` 에 **비동기 큐잉**된다.
 *  크래시 핸들러는 한 줄 찍고 곧바로 `process.exit(1)` 하므로, 앞선 write 가 하나라도
 *  in-flight 면 큐가 통째로 버려진다. 실측: 연속 20줄 중 **1줄만** 착지, 실제
 *  `initFileLogging()` 재현에서 **직전 줄은 남고 크래시 줄만 사라졌다**.
 *  결과: 데몬이 crash-fast 로 재기동됐는데 `<home>/logs/daemon-<날짜>.log` 에 원인이 없다.
 *  `/logs` 도 그 파일만 읽으므로 비서·사용자 모두 이유를 못 본다.
 *  macOS 는 launchd stderr 가 동기라 `launchd.err.log` 에 남지만 아무도 그걸 안 보고,
 *  **윈도우는 리디렉션 자체가 없어 어디에도 안 남는다**(원격 접속 불가 인스턴스).
 *
 * `appendFileSync` 는 반환 시점에 fd 에 쓰인 게 보장된다. 크래시 경로는 드물어(7월 0건)
 * 동기 비용이 문제되지 않는다 — 평시 경로는 그대로 비동기 스트림을 쓴다.
 */
export const logFatal = (...args: unknown[]): void => {
  const line = `[${localStamp(new Date())}] [fatal] ${redactSecrets(format(...args))}\n`;
  // stderr 먼저 — 파일 쓰기가 실패해도 최소한 콘솔·launchd 에는 남는다.
  try {
    process.stderr.write(line);
  } catch {
    /* ignore */
  }
  try {
    if (currentLogPath !== null) appendFileSync(currentLogPath, line);
  } catch {
    /* 파일 쓰기 실패는 종료를 막지 않는다 */
  }
};


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
    currentLogPath = logFile; // logFatal(동기 append)의 대상 — 롤오버도 따라간다.
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
      // ★소독을 **터미널 경로에도** 건다 (2026-07-31 3차 검토, A4d).
      //  이전에는 `original(...args)` 로 원문을 그대로 흘렸다. 그런데 데몬의 stdout/stderr 는
      //  launchd 가 받아 같은 `logs/` 폴더의 `launchd.out.log`·`launchd.err.log` 로 **파일에
      //  쌓인다** — 즉 "파일 미러만 소독" 은 소독이 아니었다(실측: 과거 234건을 손으로 스크럽).
      //  아래 주석이 "모든 모듈이 자동으로 덮인다" 고 말하는데 절반만 참이었다.
      //  한 번 만들어 두 경로가 같은 문자열을 쓴다 — 두 번 포맷하지 않는다.
      const line = ((): string => {
        try {
          return redactSecrets(format(...args));
        } catch {
          // 소독이 실패하면 원문을 흘리지 않는다 — 유출은 비가역, 로그 한 줄은 아니다.
          return "[logging] 소독 실패 — 원문 생략(시크릿 유출 방지)";
        }
      })();
      // 원래 동작(터미널) 먼저 — 미러 실패가 정상 출력을 막지 않게.
      original(line);
      try {
        const now = new Date();
        // ★파일에 쓰기 **직전**에 소독한다 (2026-07-31 전체검토 P0).
        //  왜 여기냐: 모든 `console.*` 이 디스크로 가는 **단일 관문**이다. 호출부를 열거해
        //  고치면 새 호출부가 생길 때마다 또 샌다(손으로 관리하는 목록). 관문에서 걸면
        //  현재·미래의 모든 모듈이 자동으로 덮인다.
        //  실사고: grammy `HttpError` 의 own property `error`(내부 FetchError)의 message 가
        //  `request to https://api.telegram.org/bot<TOKEN>/... failed` 라서,
        //  `console.error("...", e)` 의 util.inspect 가 **현재 유효한 봇 토큰**을 평문으로
        //  찍었다 — 실측 234회 이상(launchd.err.log 포함). 로그는 이 프로젝트의 1차
        //  진단면이라 사람이 복사·붙여넣는 게 정상 절차이고, 그 순간 봇 전권이 넘어간다.
        //  비용 실측: 줄당 50µs(길이 무관). 하루 ~1.3만 줄 = 0.65s/일 — 수용 가능.
        //  남은 갭(정직하게): node 가 uncaughtException 스택을 **console 을 거치지 않고**
        //  직접 stderr 로 찍는 경로는 여기로 안 온다 — 그건 `logFatal` 이 따로 받는다.
        currentStream(now).write(`[${localStamp(now)}] [${level}] ${line}\n`);
      } catch {
        /* 미러 실패 — 무시 (원래 출력은 이미 됨) */
      }
    };
  }

  // ★node 프로세스 경고를 `[error]` 에서 끌어낸다 (2026-08-01 A4c 형제).
  //  node 기본 리스너는 `process.emitWarning` 을 stderr 로 보내고, 그게 우리 미러에서
  //  `[error]` 로 찍혔다 — 12일치 실측 **527줄**(에러 로그의 두 번째 큰 덩어리)이
  //  전부 전이 의존성의 `punycode` DeprecationWarning 하나였다. 경고는 경고지 에러가 아니고,
  //  같은 경고가 매 부팅 반복되면 배경 소음이 돼 **진짜 사고를 덮는다**.
  //  버리지는 않는다 — `MaxListenersExceededWarning` 처럼 진짜 신호인 경고가 있다.
  //  레벨을 `warn` 으로 내리고, **부팅당 같은 경고는 한 번만** 남긴다(반복은 센다).
  const warnSeen = new Map<string, number>();
  process.removeAllListeners("warning"); // 기본(stderr 직행) 리스너 교체.
  process.on("warning", (w: Error) => {
    const key = `${w.name}: ${w.message}`;
    const n = (warnSeen.get(key) ?? 0) + 1;
    warnSeen.set(key, n);
    if (n === 1) console.warn(`[node-warning] ${key}`);
    else if (n === 10 || n % 100 === 0) {
      // 반복 자체가 신호일 때만 다시 말한다(누수 의심 등) — 수치를 실어서.
      console.warn(`[node-warning] ${w.name} 반복 ${n}회 — ${w.message.slice(0, 80)}`);
    }
  });

  return logFile;
};
