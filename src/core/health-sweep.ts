/**
 * 자가 진단 스윕 (2026-07-26) — "티구클로가 자기 이상을 스스로 알아채고 먼저 보고한다".
 *
 * ★코어로 이관 (2026-08-12, 사용자: "기본적인 부분은 코어에 들어가는게 맞아").
 *  종전엔 `plugins/self-growth/` 에 살았다. 소유는 갈라놨지만 **시동이 플러그인에** 있어서,
 *  그 플러그인이 안 뜨면(로더는 로드 실패를 **조용히 skip** 한다) 자기 진단도 DB 백업도
 *  같이 멎고 아무도 그 사실을 모른다 — 데이터 안전이 "성장" 기능의 부수효과였다.
 *  자기 상태를 보는 것은 성장이 아니라 **운영**이므로 코어가 소유한다.
 *  덤: 회귀가 `src/` 에서 `plugins/` 를 넘겨다보던 역방향 참조도 같이 사라진다.
 *
 * ★동기(실사고): 오늘 발견한 문제들은 **전부 데이터가 이미 있었는데 아무도 안 봐서** 방치됐다.
 *  - codex 가 한 답변에 같은 서두를 22번 반복 — 몇 주간, **사용자가** 발견
 *  - 아침 스케줄 알림 2건이 502 로 미도달 — 8시간, 헬스체크하다 발견
 *  즉 티구클로는 "고칠 능력"은 있는데 **"자기 이상을 알아채는 능력"** 이 없었다. 이 모듈이
 *  그 갭을 닫는다 — 새 수집 없이 **기존 DB(schedules·events·chat_log)만 훑는다**.
 *
 * 설계 원칙:
 *  - **읽기 전용**. 진단만 하고 조치는 안 한다(보고까지가 이 모듈 몫). 자동 조치가 있는
 *    영역은 **그 기능을 소유한 쪽**이 한다 — 예: 전달 실패 자동 재전송은 scheduler runner
 *    (내용·목적지를 이미 손에 쥔 쪽이라 DB 역추적도, 플러그인 간 결합도 필요 없다). 여기서
 *    남의 도메인에 손대면 관측자가 조용히 행위자가 된다.
 *  - 자동 조치가 성공하면 그 건은 `last_status` 가 ok 로 정정돼 **이 스윕에 안 잡힌다** →
 *    중복 통보 0. 즉 스윕은 "아직 복구되지 않은 것" 만 사용자에게 밀어 올린다.
 *  - **증분**: `sinceTs` 이후 *발생한* 것만 본다 → 같은 문제를 매 시간 재보고하지 않는다
 *    (별도 dedup 상태 불요). 정상이면 **아무것도 반환하지 않는다**(빈 배열 = 침묵).
 *  - **보수적 임계**: 오탐이 잦으면 사용자가 무시하게 돼 없느니만 못하다. 확실한 것만.
 *  - never-throw: 한 지표가 깨져도 나머지는 나온다(데몬·maintenance 무영향).
 */
import { listSchedules } from "../store/schedules.js";
import { listEvents } from "../store/events.js";
import { getRecentChatLog } from "../store/chat-log.js";
import { backupInfo } from "../store/backup.js";
import { listMemoriesForIndex } from "../store/memory.js";
// 실패 분류는 런타임과 **같은 판정**을 쓴다 — 여기서 정규식을 또 만들면 두 곳이 갈린다.
import { isModelOverloaded, isRateLimited } from "./llm-runtime/rate-limit.js";
import { MEMORY_INDEX_CAP_BYTES } from "./prompt-assembly.js";

/** 스윕 1건 — 사람이 읽는 한 줄 요약 + 필요 시 상세. */
export interface HealthFinding {
  /** 지표 종류(로그·이벤트 분류용). */
  kind: "schedule_failure" | "turn_errors" | "repetition" | "backup_stale" | "memory_index_truncated";
  /** 사용자에게 그대로 보여줄 한 줄. */
  summary: string;
}

/**
 * ★자원 축 보고 간격 — 상태형 지표는 **증분이 아니다.**
 *  다른 검사는 `sinceTs` 이후 *발생분* 만 봐서 자동으로 중복이 없는데, "백업이 없다"·
 *  "인덱스가 잘린다"는 **고쳐질 때까지 계속 참**이라 매 스윕(시간당) 뜬다. 그러면 정확히
 *  이 스윕이 피하려던 배경 소음이 된다. 그래서 여기만 하루 1회로 묶는다.
 */
const RESOURCE_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 상태형 지표 — 고쳐질 때까지 계속 참이라 하루 1회로 묶는 대상. */
const RESOURCE_KINDS = new Set(["backup_stale", "memory_index_truncated"]);

/**
 * 마지막으로 **상태형 지표를 보고한 시각** — 재시작을 넘어서 기억한다.
 *
 * ★종전엔 모듈 변수(`let lastResourceReportTs = 0`)였다. 그러면 **재시작마다 0 으로
 *  되돌아가** 하루 1회 억제가 통째로 풀린다. 실측(2026-08-19 사용자 로그): 부팅 5회에
 *  같은 통지 5회 — 사용자가 "재시작할 때마다 계속 나오는 게 맞아?" 라고 물어봤다.
 *  억제 장치는 **있었는데 돌지 않았다**(이 레포가 반복해서 겪은 형상).
 *
 * ★새 저장소를 만들지 않는다 — `self-maintenance` 가 이미 발견마다
 *  `self_growth.health.finding` 이벤트를 남기므로 **그게 곧 기록**이다. 쿨다운 테이블은
 *  쓰지 않는다: 거긴 어댑터 전용이고(`/status` 가 "쿨다운 중인 모델" 로 보여준다) 건강
 *  통지를 섞으면 그 화면이 오염된다.
 *
 * ★한계(정직하게): `events` 는 바운드 테이블이라 이 이벤트가 잘리면 억제도 풀린다.
 *  그때의 실패 방향은 **한 번 더 알리는 것**이지 침묵이 아니다 — 이 지표에선 그쪽이 맞다.
 */
const lastResourceReportTs = (): number => {
  try {
    for (const e of listEvents({ types: ["self_growth.health.finding"], limit: 50 })) {
      const p = JSON.parse(e.payload) as { findings?: Array<{ kind?: string }> };
      if ((p.findings ?? []).some((f) => f.kind !== undefined && RESOURCE_KINDS.has(f.kind))) {
        return e.ts;
      }
    }
  } catch {
    /* 조회 실패 = 기록 없음으로 본다(한 번 더 알린다) */
  }
  return 0;
};

// 보수적 임계 — 넘으면 "확실히 이상"인 값만.
const TURN_ERROR_THRESHOLD = 3; // 창 안 턴 실패 3건 이상 = 이상(평소 0~1건)
const REPEAT_PARAGRAPH_THRESHOLD = 5; // 한 답변에 같은 앞머리 산문 문단 5개 이상 = 반복 이상

// ★반복 판정 재조정(2026-07-27) — 초판(앞머리 25자·최소 10자·코드펜스 미제외)은 실데이터에서
//  **오탐만 냈다**. dev corpus 5,418건(transcripts+chat_log) 실측: 발화 5건 전부 9k~14k자
//  정상 장문(같은 코드블록·유사 구조가 겹친 것)이고, 진짜 반복 사례는 0건이었다.
//  근본 원인 = 세는 대상이 틀렸다. "같은 25자로 시작하는 무언가"는 코드블록·리스트·표에서
//  자연히 반복된다. 우리가 잡으려는 건 **산문이 통째로 되풀이되는 것**(대화 재구성 결함).
//  그래서 임계(5)는 그대로 두고 *무엇을 세는지*를 바꾼다:
//    ① 코드펜스 제거  ② 리스트·표·헤딩 문단 제외  ③ 최소 40자 산문만  ④ 앞머리 60자 비교
//  실측 결과 정상 corpus 최대 반복 2(임계 5까지 마진 2.5배·발화 0건), 재현한 실사례 형상
//  (150자×22 동일 / tail 갈림 / 70자 짧은 문단)은 전부 rep=22 로 탐지.
//  ★최소 길이를 80자로 잡았다가 한국어 70자 문단 사례를 통째로 놓치는 것을 실측에서 발견 —
//   한국어는 정보 밀도가 높아 80자면 이미 긴 문단이다. 40자로 낮춰 재검증했다.
const REPEAT_HEAD_CHARS = 60; // 문단 앞머리 비교 길이(25 → 60: 우연 일치 차단)
const REPEAT_MIN_PARAGRAPH = 40; // 이보다 짧은 조각은 판정 대상 아님(한 줄 응답·라벨 등)
/** 리스트·표·헤딩·인용 = 구조적으로 같은 시작이 반복되는 게 정상인 문단. */
const STRUCTURAL_HEAD = /^[|#>*\-]|^\d+[.)]/;

/**
 * 한 답변 안에서 **같은 서두의 산문 문단**이 최대 몇 개 겹치는지.
 * 코드블록·리스트·표는 세지 않는다(정상적으로 반복되는 형식이라 신호가 아니라 잡음).
 * 검증 스크립트가 직접 호출하므로 export — 순수 함수(입출력만, 부수효과 0).
 */
export const maxParagraphRepeat = (text: string): number => {
  const parts = String(text)
    .replace(/```[\s\S]*?```/g, "\n\n") // ① 코드펜스 제거
    .split(/\n\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= REPEAT_MIN_PARAGRAPH && !STRUCTURAL_HEAD.test(p)) // ②③
    .map((p) => p.slice(0, REPEAT_HEAD_CHARS)); // ④
  if (parts.length < 2) return 0;
  const counts = new Map<string, number>();
  let max = 0;
  for (const p of parts) {
    const n = (counts.get(p) ?? 0) + 1;
    counts.set(p, n);
    if (n > max) max = n;
  }
  return max;
};

/** turn_error payload(JSON 문자열) → 객체. 파싱 실패는 빈 객체(never-throw 원칙). */
const parseTurnError = (raw: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * **이미 제 손으로 처리된 실패인가** — 세지 않을 것들. (2026-08-12)
 *
 * ① 데몬 재시작 중단: 실패가 아니라 재시작이고, 중단 통지가 이미 따로 나간다.
 * ② 사용량 한도: 쿨다운 **진입 시점에** 채널 통지가 이미 나간다(상태 전이 1회). 여기서
 *    또 세면 같은 일을 두 번 말하고, 그 두 번째는 원인도 안 적혀 있어 소음만 된다.
 *
 * 순수 함수 — 회귀가 그대로 실행해 지킨다(소스 훑기 아님).
 */
export const isSelfHandled = (rawPayload: string): boolean => {
  const p = parseTurnError(rawPayload);
  if (str(p.reason) === "daemon-restart") return true;
  const detail = `${str(p.message)} ${str(p.error)}`;
  return isRateLimited(detail);
};

/**
 * 실패들을 **원인·모델·스레드 종류**로 접어 한 줄로. (2026-08-12)
 *
 * ★알림에 근거를 싣는 이유: 종전 문구("어댑터·백엔드 이상일 수 있습니다")는 받는 사람이
 *  로그를 받아 분류해야만 뜻을 알 수 있었다 — 알림이 일을 만들었다. 어느 모델이 무슨
 *  이유로 몇 번인지가 있으면 대개 그 한 줄에서 판단이 끝난다.
 * ★배경 스레드(서브에이전트·매니저)를 따로 표시한다: 내 대화가 멀쩡한데 뒤에서 도는 잡이
 *  흔들린 것과, 내 대화가 죽은 것은 **다른 사건**이다(실측 08-11: 39건 중 34건이 서브에이전트).
 */
export const describeTurnErrors = (rawPayloads: string[]): string => {
  const byCause = new Map<string, number>();
  let background = 0;
  for (const raw of rawPayloads) {
    const p = parseTurnError(raw);
    const thread = str(p.threadKey);
    // ★외부 호출(엔드포인트·게이트웨이)도 '내 대화'가 아니다 (2026-08-12) — 게이트웨이 턴이
    //  이제 turn 이벤트를 내므로, 안 가르면 앱 호출 실패가 "내 대화가 죽었다"로 보고된다.
    if (
      thread.startsWith("agent:") ||
      thread.startsWith("worker:") ||
      thread.startsWith("endpoint:") ||
      thread.startsWith("gateway:")
    ) {
      background += 1;
    }
    const detail = `${str(p.message)} ${str(p.error)}`;
    const cause = isModelOverloaded(detail)
      ? "과부하"
      : /timeout|시간|abort/i.test(detail)
        ? "중단·타임아웃"
        : "실패";
    const who = str(p.model) !== "" ? `${str(p.adapter)}/${str(p.model)}` : str(p.adapter);
    const label = `${who === "" ? "미상" : who} ${cause}`;
    byCause.set(label, (byCause.get(label) ?? 0) + 1);
  }
  const top = [...byCause.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, n]) => `${label} ${n}건`)
    .join(" · ");
  const where =
    background === 0
      ? "내 대화"
      : background === rawPayloads.length
        ? "전부 배경·외부 호출(서브에이전트·매니저·엔드포인트·게이트웨이)"
        : `배경·외부 호출 ${background}건 포함`;
  return `${top} (${where}).`;
};

/**
 * `sinceTs` 이후 발생분만 훑어 이상 징후를 반환. 정상이면 `[]`.
 * 조회·계산 실패는 그 지표만 건너뛴다(부분 결과라도 보고하는 게 침묵보다 낫다).
 */
export const runHealthSweep = (sinceTs: number): HealthFinding[] => {
  const out: HealthFinding[] = [];

  // ① 스케줄 실패 — 발화는 됐으나 실행/전달이 실패한 것. 사용자가 받았어야 할 알림이
  //    유실된 상태라 가장 중요(오늘 아침 리포트 2건 실사고).
  try {
    for (const s of listSchedules()) {
      const firedAt = typeof s.lastFiredAt === "number" ? s.lastFiredAt : 0;
      if (s.lastStatus !== "error" || firedAt <= sinceTs) continue;
      const reason = String(s.lastError ?? "").slice(0, 90);
      out.push({
        kind: "schedule_failure",
        summary: `스케줄 '${s.label}' 실패 — ${reason || "사유 미상"} (내용은 대화 기록에 남아 있을 수 있습니다)`,
      });
    }
  } catch {
    /* 이 지표만 스킵 */
  }

  // ★자원·데이터 축 (2026-08-11) — 종전엔 **행동 이상만** 봤다(턴 실패·반복·스케줄).
  //  DB 가 커지든 백업이 없든 기억 절반이 안 실리든 **아무도 안 알려줬다.** 조용히 썩는
  //  것을 안 조용하게 만드는 게 이 스윕의 일이므로 여기가 제자리다.
  //  ★읽기 전용 원칙 유지 — 백업을 **뜨는** 건 DB 를 소유한 store/backup.ts 다.

  // ★기록(이벤트)을 시계로 쓴다 — 재시작해도 억제가 유지된다. 보고 시각은 여기서
  //  따로 안 적는다: 실제로 보고가 나가면 self-maintenance 가 이벤트를 남기고, 그게
  //  다음 판정의 기준이 된다(같은 사실을 두 곳에 적지 않는다).
  if (Date.now() - lastResourceReportTs() >= RESOURCE_REPORT_INTERVAL_MS) {

  // ③ 백업이 없거나 오래됐다 — 크기·성능과 무관하게 가장 급하다(복구 불가 축).
  try {
    const b = backupInfo();
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    if (b.latestAt === null) {
      out.push({
        kind: "backup_stale",
        summary:
          "데이터 백업이 한 번도 없습니다. 기억·세션·대화가 이 DB 한 파일에 있어, 없어지면 되돌릴 방법이 없습니다.",
      });
    } else if (Date.now() - b.latestAt > STALE_MS) {
      const days = Math.floor((Date.now() - b.latestAt) / 86_400_000);
      out.push({
        kind: "backup_stale",
        summary: `백업이 ${days}일째 갱신되지 않았습니다(자동 백업이 멈춘 것 같습니다).`,
      });
    }
  } catch {
    /* 이 지표만 스킵 */
  }

  // ④ 매 턴 실리는 기억 인덱스가 잘린다 — 잘린 만큼은 **그 턴에 없는 것**이다.
  //  ★조용한 실패의 전형: 문장은 멀쩡한데 안 실려서 안 지켜진다(2026-08-10 실사고).
  try {
    const r = listMemoriesForIndex(MEMORY_INDEX_CAP_BYTES);
    if (r.truncated > 0) {
      out.push({
        kind: "memory_index_truncated",
        summary: `기억 ${r.total}건 중 ${r.truncated}건이 매 턴 프롬프트에 안 실립니다(상한 초과). 덜 쓰이는 것부터 잘리지만, 상한을 올리거나 안 쓰는 기억을 정리할 때입니다.`,
      });
    }
  } catch {
    /* 이 지표만 스킵 */
  }
  }

  // ② 턴 실패 급증 — 평소 0~1건이라 3건 이상이면 어댑터·백엔드 이상 신호.
  //
  // ★세는 대상을 골라내고, 근거를 실어 보낸다 (2026-08-12, 사용자 지적: "이상한 소음").
  //  종전엔 `llm.turn_error` 를 **평평하게** 세어 "턴 실패 N건 — 어댑터·백엔드 이상일 수
  //  있습니다" 만 보냈다. 그래서 세 가지가 한꺼번에 틀어졌다:
  //   ①데몬 재시작으로 중단된 턴이 "어댑터 이상"으로 둔갑(라벨이 틀림 — 그건 재시작이고
  //     자기 통지 경로가 따로 있다)
  //   ②사용량 한도가 이상으로 집계(실측 돌쇠 78건 중 67건) — 한도는 진입 시점에 이미
  //     쿨다운 통지가 나가므로 여기서 또 말하면 같은 일을 두 번 말하는 것이다
  //   ③어느 어댑터·어느 모델·무슨 오류인지가 없어서, 알림을 받을 때마다 사람이 로그를
  //     받아 분류해야 했다(실제로 그렇게 진단했다 — 알림이 일을 만들었다)
  //  ★"오래 걸림" 은 여기 없다 — 실패로 세는 것은 백엔드가 실패라고 말한 것뿐이다.
  try {
    const errs = listEvents({ types: ["llm.turn_error"], sinceTs, limit: 200 });
    const actionable = errs.filter((e) => !isSelfHandled(e.payload));
    if (actionable.length >= TURN_ERROR_THRESHOLD) {
      out.push({
        kind: "turn_errors",
        summary: `턴 실패 ${actionable.length}건 — ${describeTurnErrors(actionable.map((e) => e.payload))}`,
      });
    }
  } catch {
    /* 이 지표만 스킵 */
  }

  // ③ 답변 반복 — 한 답변 안에서 같은 서두가 여러 번 반복되는 품질 저하.
  //    ★codex 자기발화 미재주입 버그(2026-07-26)가 정확히 이 모양이었다(22문단). 그때는
  //    사용자가 발견했지만, 이제 이 지표가 먼저 잡는다.
  try {
    for (const r of getRecentChatLog({ limit: 40 })) {
      if (r.role !== "assistant" || typeof r.ts !== "number" || r.ts <= sinceTs) continue;
      const repeat = maxParagraphRepeat(r.text ?? "");
      if (repeat >= REPEAT_PARAGRAPH_THRESHOLD) {
        out.push({
          kind: "repetition",
          summary: `답변 하나에 같은 문단이 ${repeat}번 반복됐습니다 — 어댑터 이상(대화 재구성 결함) 가능성.`,
        });
        break; // 같은 창에서 여러 건이어도 1회만 보고(노이즈 억제).
      }
    }
  } catch {
    /* 이 지표만 스킵 */
  }

  return out;
};
