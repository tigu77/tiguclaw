/**
 * **한도(rate-limit) 판정 · 쿨다운 시간 파싱 — 단일 진실 소스** (2026-07-30).
 *
 * ★왜 리프 모듈인가: 같은 휴리스틱이 **3곳에 사본**으로 있었고(llm-runtime facade ·
 *  `src/index.ts` 사용자 안내 · `core/worker-jobs.ts` 매니저 통지) 주석엔 "진실 통일"이라
 *  적혀 있었지만 사실이 아니었다. claude 의 `You've hit your limit · resets 2:20am` 을
 *  facade 만 인식해서, 사용자에겐 원문 덤프가 나가고 매니저 통지는 **"잠시 후 다시
 *  시켜주세요"**(실제론 수 시간 계정 한도)를 냈다.
 *
 *  그래서 한 곳으로 모으는데, facade(`llm-runtime/index.ts`)에 두면
 *  `worker-jobs → llm-runtime → … → worker-registry → worker-jobs` **순환**이 생긴다.
 *  의존 0인 리프로 빼서 세 곳이 모두 여기만 import 한다.
 */

export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // 10분
export const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7일 상한(비정상 값 방어, 실측 다일 한도는 통과)

export const isRateLimited = (errStr: string): boolean =>
  // ★claude 문구 추가 (2026-07-30 라이브): claude SDK 는 "You've hit your limit · resets
  //  2:20am (Asia/Seoul)" 로 말한다 — 위 어느 패턴에도 안 걸려 **쿨다운이 등록되지 않았고**
  //  죽은 백엔드를 매 턴 다시 때렸다(윈도우 로그 00:39·00:40·00:43). 그 사이 codex 도 흔들려
  //  "모든 어댑터 실패"가 반복됐다.
  /usage_limit_reached|rate[-_ ]?limit|too many requests|\bquota\b|\b429\b|hit your (usage )?limit|usage limit/i.test(
    errStr,
  );

/**
 * **모델 과부하 판정** (2026-08-12) — 한도(계정 축)와 **다른 축**의 실패다.
 *
 * ★왜 나누나: 같은 "실패"라도 **누가 죽었는지**가 다르고, 그래서 대책이 다르다.
 *  - 한도(`isRateLimited`) = **계정**이 막혔다 → 그 provider 전체를 쉬어야 한다.
 *  - 과부하(여기)        = **그 모델**이 막혔다 → 풀의 **다른 모델**로 옮기면 즉시 산다.
 *  실측(2026-08-11 회사 PC): `server_is_overloaded` 39건이 전부 `model=gpt-5.6-sol`
 *  하나였다 — 계정이 막힌 것이었다면 형제 모델도 같이 죽었을 것이다.
 *  ★이 판정은 **분류·보고 전용**이다(자가 점검 문구·실패 분류). 2026-08-13 사용자 결정으로
 *   이걸 근거로 모델을 쉬게 하거나 회전시키지 않는다 — 답하는 모델이 조용히 바뀌면
 *   "이 모델을 쓸 때 어떤가" 를 알 수 없게 된다.
 *
 * ★"오래 걸린다"는 여기 안 들어온다 (사용자 2026-08-12): 판정 근거는 **백엔드가 실패라고
 *  말한 응답**뿐이고, 경과 시간은 재료가 아니다. 느린 것은 실패가 아니다.
 */
export const isModelOverloaded = (errStr: string): boolean =>
  /server_is_overloaded|servers are currently overloaded|overloaded_error/i.test(errStr);

export const parseCooldownMs = (errStr: string): number | null => {
  const m =
    errStr.match(/"resets_in_seconds"\s*:\s*(\d+)/) ||
    errStr.match(/retry[-_ ]?after["'\s:=]+(\d+)/i);
  if (m !== null) {
    const sec = Number(m[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, MAX_COOLDOWN_MS);
  }
  return parseResetsAtMs(errStr);
};

/**
 * **벽시계 해제 시각 파싱** — claude SDK 는 초가 아니라 `resets 2:20am (Asia/Seoul)` 로 말한다.
 *
 * 위 초 단위 파서가 못 읽어 DEFAULT(10분)로 강등되거나 아예 쿨다운이 안 걸렸다. 다음 도래
 * 시각까지의 ms 로 환산한다(이미 지난 시각이면 내일 그 시각).
 *
 * ★타임존: 메시지가 TZ 이름을 주지만 우리는 **로컬 시간으로 해석**한다. 데몬과 계정 TZ 가
 *  다르면 몇 시간 어긋날 수 있는데, 그 방향은 안전하다 — 짧으면 재시도 한 번 더일 뿐이고,
 *  길어도 `cooldownRemainingMs` 의 **2시간 주기 탐침**이 실제로 다시 시도한다(6일 공백 사고
 *  대응으로 이미 들어가 있다). 즉 이 파싱이 틀려도 백엔드를 영구히 놀리지 않는다.
 */
const parseResetsAtMs = (errStr: string): number | null => {
  const m = errStr.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m === null) return null;
  let hour = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const mer = (m[3] ?? "").toLowerCase();
  if (!Number.isFinite(hour) || hour < 1 || hour > 12 || min > 59) return null;
  if (mer === "pm" && hour !== 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  const now = new Date();
  const at = new Date(now);
  at.setHours(hour, min, 0, 0);
  // ★같은 분 안의 재시도를 하루로 밀지 않는다 (2026-07-30 검토 지적).
  //  백엔드는 리셋 시각을 **분 단위로 잘라** 말한다("2:20am"). 실제 리셋이 02:20:47 인데
  //  02:20:10 에 재시도하면 여전히 한도 에러 + 같은 문구가 온다. 그때 "이미 지났으니 내일"
  //  로 계산하면 **1,439분(≈24h)** 쿨다운이 걸리고, 2시간 주기 탐침까지 겹쳐 리셋 직후
  //  최대 2시간 그 백엔드를 놀린다("6일 공백" 의 축소판). 경계 근처면 기본값(10분)에 맡긴다.
  const RESET_EDGE_MS = 10 * 60 * 1000;
  if (at.getTime() <= now.getTime() && now.getTime() - at.getTime() < RESET_EDGE_MS) {
    return null; // 호출자가 DEFAULT_COOLDOWN_MS(10분)로 강등 → 곧 다시 시도.
  }
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1); // 충분히 지났으면 내일.
  const ms = at.getTime() - now.getTime();
  return ms > 0 ? Math.min(ms, MAX_COOLDOWN_MS) : null;
};

/**
 * 한도 리셋 시점을 **사람이 읽는 문장**으로 — 여기가 정의점이다 (2026-08-14).
 *
 * ★사고: 윈도우 인스턴스가 `약 8118분 후 리셋됩니다` 를 출력했다(사용자 신고).
 *  **읽을 수 없는 숫자**다 — 8,118분이 5.6일이라는 걸 암산하라는 뜻이고, 그러면
 *  "언제 다시 시도하나" 라는 이 문장의 유일한 목적이 무너진다. 분은 한 시간 안쪽에서만
 *  쓸모 있다.
 *
 * ★그리고 같은 판단이 **두 곳**에 각자 적혀 있었다(`index.ts` 의 채널 응답, `worker-jobs`
 *  의 매니저 통지) — 한쪽만 고치면 다른 쪽이 늙는다. 오늘만 같은 부류로 두 번 겪었다.
 *
 * 규칙: 한 시간 안이면 분, 하루 안이면 시각, 그 밖이면 **날짜+시각**. 어느 쪽이든
 * **절대 시각을 먼저** 말하고 상대 시간을 괄호로 보탠다("언제" 가 묻는 것이므로).
 */
export const formatResetAt = (
  ms: number,
  now: number = Date.now(),
): string => {
  const at = new Date(now + ms);
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `약 ${min}분 후`;
  // ★로케일 API 를 안 쓴다 — 같은 코드가 맥·윈도우·리눅스에서 도는데 `toLocaleTimeString`
  //  은 ICU 에 따라 "오전 3:14"·"AM 3:14"·"3:14 AM" 로 갈린다(실측: 맥에서 "AM 3:14").
  //  사용자에게 나가는 문장이 플랫폼마다 다르면 그 자체가 결함이다. 직접 조립한다.
  const h24 = at.getHours();
  const ampm = h24 < 12 ? "오전" : "오후";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const hhmm = `${ampm} ${h12}시 ${String(at.getMinutes()).padStart(2, "0")}분`;
  const sameDay = at.toDateString() === new Date(now).toDateString();
  if (sameDay) return `오늘 ${hhmm}쯤 (약 ${Math.round(min / 60)}시간 후)`;
  const days = ms / 86_400_000;
  const rel = days < 2 ? `약 ${Math.round(min / 60)}시간 후` : `약 ${days.toFixed(1)}일 후`;
  return `${at.getMonth() + 1}월 ${at.getDate()}일 ${hhmm}쯤 (${rel})`;
};
