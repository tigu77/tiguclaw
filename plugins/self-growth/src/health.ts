/**
 * 자가 진단 스윕 (2026-07-26) — "티구클로가 자기 이상을 스스로 알아채고 먼저 보고한다".
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
import { listSchedules } from "../../../src/store/schedules.js";
import { listEvents } from "../../../src/store/events.js";
import { getRecentChatLog } from "../../../src/store/chat-log.js";

/** 스윕 1건 — 사람이 읽는 한 줄 요약 + 필요 시 상세. */
export interface HealthFinding {
  /** 지표 종류(로그·이벤트 분류용). */
  kind: "schedule_failure" | "turn_errors" | "repetition";
  /** 사용자에게 그대로 보여줄 한 줄. */
  summary: string;
}

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

  // ② 턴 실패 급증 — 평소 0~1건이라 3건 이상이면 어댑터·백엔드 이상 신호.
  try {
    const errs = listEvents({ types: ["llm.turn_error"], sinceTs, limit: 200 });
    if (errs.length >= TURN_ERROR_THRESHOLD) {
      out.push({
        kind: "turn_errors",
        summary: `턴 실패가 ${errs.length}건 발생했습니다(최근). 어댑터·백엔드 이상일 수 있습니다.`,
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
