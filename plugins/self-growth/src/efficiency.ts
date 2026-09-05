import { upsertReflection } from "./analysis.js";
import {
  addMemory,
  listMemories,
  archiveMemory,
  listColdMemoriesForArchive,
  resetArchivedMemoryAccess,
} from "../../../src/store/memory.js";
import {
  REFLECTION_TTL_DAYS,
  OBS_ARCHIVE_DAYS,
  OBS_ARCHIVE_PREFIX,
  SELF_NAMESPACE,
  WEEKLY_REVIEW_INTERVAL_MS,
} from "./constants.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPaths } from "../../../src/core/paths.js";

/**
 * V3 효율 관측 — turn_done 의 durationMs/토큰을 (adapter, model) 별로 누적 관측한다.
 * **관측 메모(비서가 읽는 신호)까지만** — 코어 라우팅 분기 절대 금지(원칙 2 하드게이트).
 * 토큰 필드는 자주 없음(openai) → "있을 때만" 합산, 0/거짓값 박지 않음.
 *
 * 순수 함수 — 누적 상태(EfficiencyAccumulator)는 호출자가 보유. 여기선 갱신만 반환.
 * 메모는 박지 않는다(효율은 신호 누적 → 주간 회고/명시 조회에서 소비). 효율 신호가
 * 또 다른 turn 을 낳지 않으므로 메타-재귀 0.
 */
export interface EfficiencyAccumulator {
  turns: number;
  totalDurationMs: number;
  // 토큰은 *보고된 턴만* 분모로 — 없는 턴은 분모에서 제외(정직한 미측정).
  tokenSampledTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export const emptyEfficiencyAccumulator = (): EfficiencyAccumulator => ({
  turns: 0,
  totalDurationMs: 0,
  tokenSampledTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
});

export const efficiencyKey = (adapter: string, model?: string): string =>
  `${adapter}|${model ?? "_"}`;

/**
 * 단일 turn_done 을 accumulator 에 반영. durationMs 양수일 때만 카운트.
 * 토큰은 양수(>0)일 때만 합산 — 0/음수/누락은 미측정으로 간주(생략, 거짓값 금지).
 */
export const accumulateEfficiency = (
  acc: EfficiencyAccumulator,
  sample: { durationMs?: number; inputTokens?: number; outputTokens?: number },
): EfficiencyAccumulator => {
  const next: EfficiencyAccumulator = { ...acc };
  if (typeof sample.durationMs === "number" && sample.durationMs > 0) {
    next.turns += 1;
    next.totalDurationMs += sample.durationMs;
  }
  const hasIn =
    typeof sample.inputTokens === "number" && sample.inputTokens > 0;
  const hasOut =
    typeof sample.outputTokens === "number" && sample.outputTokens > 0;
  if (hasIn || hasOut) {
    next.tokenSampledTurns += 1;
    if (hasIn) next.totalInputTokens += sample.inputTokens as number;
    if (hasOut) next.totalOutputTokens += sample.outputTokens as number;
  }
  return next;
};

/**
 * V2.2 사후 회고 — 지난 7일 동안 박힌 reflection 통계를 회고 메모로 박음.
 * 이미 7일 안에 회고 박힌 적 있으면 null (멱등). 강제 박기 = force=true.
 * 회고 name: `feedback_growth_weekly_review_<YYYY-MM-DD>`.
 */
/** 마지막으로 회고를 «돌아본» 시각 — 기록 여부와 무관하다(무내용은 인덱스에 안 넣는다). */
/**
 * «마지막으로 돌아본 시각» 을 담는 자리.
 *
 * ★**코어 공용 자리가 아니라 이 플러그인의 자리다** (2026-09-01, 2라운드 F14). 종전엔
 *  `<home>/data/` 에 뒀는데 거기는 SQLite 옆 코어 공용이다. 판정 3줄 중 하나가 안 섰다 —
 *  «지울 때 같이 지워지나» ❌. [[feedback_external_things_own_their_unit]].
 * ★그리고 `getPaths()` 가 이미 `commonPlugins` 를 준다 — 손으로 다시 조립하면 권위가
 *  두 곳이 된다(종전엔 `home` 에 `"data"` 를 직접 붙였다).
 */
const lastReviewFile = (): string =>
  path.join(getPaths().commonPlugins, "self-growth", "last-review");

const readLastReviewAt = (): number => {
  try {
    return Number.parseInt(readFileSync(lastReviewFile(), "utf8").trim(), 10) || 0;
  } catch {
    return 0; // 없으면 «본 적 없음» — 첫 틱에 한 번 돈다.
  }
};

const stampLastReviewAt = (at: number): void => {
  try {
    mkdirSync(path.dirname(lastReviewFile()), { recursive: true });
    writeFileSync(lastReviewFile(), String(at), "utf8");
  } catch (e) {
    // ★**조용히 넘어가면 안 된다** (2026-09-01, 2라운드 F13). 이 쓰기가 실패하면
    //  `readLastReviewAt()` 이 영원히 0 이라 가드가 **원리적으로 못 서고**, 주 1회이던
    //  회고가 매시(runWeeklyReview 는 1시간마다 불린다) 로그·기억 전량 스캔으로 돌아간다.
    //  게다가 신호가 있으면 회고 메모가 **날마다** 다시 박힌다 — 종전 주석의 «다음 틱에
    //  한 번 더» 는 실제로 «영원히» 였다. 로그가 1차 진단면이므로 한 줄은 남긴다.
    console.warn(
      `[self-growth] 회고 시각을 못 남겼습니다 (${lastReviewFile()}) — 가드가 서지 않아 ` +
        `매 틱 전량 스캔으로 돌아갑니다: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export const generateWeeklyReview = (
  force: boolean = false,
): {
  reviewName: string;
  segmentCount: number;
  driftCount: number;
  /** 실제로 메모리에 썼나 — 신호 0이면 안 쓴다. 호출부의 `…added` 이벤트가 이걸 본다. */
  written: boolean;
} | null => {
  const all = listMemories({ type: "feedback", limit: 10000 });
  const now = Date.now();
  const weekAgo = now - WEEKLY_REVIEW_INTERVAL_MS;

  // 멱등 — 최근 7일 안 회고 박힌 적 있으면 skip.
  // ★멱등 가드는 **메모리 존재**로 판정했다. 그런데 신호 0이면 이제 메모리를 안 만들므로
  //  가드가 **원리적으로 못 선다** — `runWeeklyReview` 는 1시간마다 불리니 조용한 인스턴스
  //  에서 주 1회이던 로그·전량 스캔이 **주 168회**가 된다(적대 검토 P2).
  //  [[feedback_logs_must_stand_alone]] 의 *"매 턴 같은 warn = 배경소음, 12일 묻혔다"* 와
  //  정면으로 부딪힌다.
  // ★고침: 판정 근거를 **메모리가 아니라 「마지막으로 돌아본 시각」** 으로 바꾼다. 썼든
  //  안 썼든 한 번 봤으면 7일간 안 본다 — 원래 의도가 *"주 1회 회고"* 이지 *"주 1회 기록"*
  //  이 아니었다. 시각은 캡 있는 인덱스가 아니라 **상태 파일**에 둔다(무내용을 인덱스에
  //  넣지 않는다는 이번 수정의 요지를 지킨다).
  if (!force && Date.now() - readLastReviewAt() < WEEKLY_REVIEW_INTERVAL_MS) return null;

  // 지난 7일 동안 생성된 reflection 통계.
  const segmentReflections = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_reflection_segment_`) &&
      m.updatedAt >= weekAgo,
  );
  const driftReflections = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_drift_`) &&
      m.updatedAt >= weekAgo,
  );

  const date = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
  const reviewName = `feedback_${SELF_NAMESPACE}_weekly_review_${date}`;

  const body = JSON.stringify(
    {
      review_period: `최근 7일 (${new Date(weekAgo).toISOString().slice(0, 10)} ~ ${date})`,
      segment_reflection_count: segmentReflections.length,
      segment_reflection_names: segmentReflections.map((m) => m.name),
      drift_reflection_count: driftReflections.length,
      drift_reflection_names: driftReflections.map((m) => m.name),
      total_memory_count: all.length,
      suggested_action:
        segmentReflections.length + driftReflections.length > 0
          ? "비서가 사용자에게 이번 주 reflection 정리 의향 명시 확인."
          : "이번 주 신호 0 — 정상 운영.",
    },
    null,
    2,
  );

  // ★**신호가 0이면 안 쓴다** (2026-08-31). 종전엔 무조건 썼고, 그래서 *"segment 0건,
  //  drift 0건"* 이라는 **무내용 회고가 매주 한 건씩 인덱스에 적립**됐다 — 실측 6건 중
  //  4건이 **읽힘 0**, 연 52건 페이스. 바운드가 없다.
  // ★인덱스는 캡이 있는 자리다. 거기에 아무도 안 읽는 항목이 매주 쌓이면 **읽혀야 할 것을
  //  밀어낸다**([[project_hotpath_bound_preserve_record]] 의 "캡 있는 자리" 그대로).
  //  스스로 `"이번 주 신호 0 — 정상 운영"` 이라고 적으면서 자리를 차지하는 건 앞뒤가 안 맞는다.
  // ★**기록을 지우는 게 아니다** — 애초에 만들지 않는 것이다. 신호가 있으면 그대로 쓴다.
  const hasSignal = segmentReflections.length + driftReflections.length > 0;
  if (hasSignal) {
    upsertReflection({
      name: reviewName,
      description: `이번 주 회고 — segment ${segmentReflections.length}건, drift ${driftReflections.length}건`,
      body,
    });
  }

  stampLastReviewAt(now); // ★썼든 안 썼든 «봤다» 를 남긴다 — 그게 이 가드의 기준이다.
  return {
    reviewName,
    segmentCount: segmentReflections.length,
    driftCount: driftReflections.length,
    // ★안 썼으면 안 썼다고 말한다 — 호출부가 `…added` 이벤트를 발행한다(계약 변경 →
    //  호출부 전수, [[feedback_scope_of_a_fix]]). 안 쓰고 "추가됨" 을 알리면 거짓말이다.
    written: hasSignal,
  };
};

/**
 * TTL 초과 회고 메모를 **아카이브**한다(삭제 아님·가역·검색 유지).
 *
 * ★2026-07-31: 원래 `deleteMemory` 로 물리 삭제였다(ADR 2026-05-23). 그 결정은
 * 유지보수 철학(2026-07-12 — **정리 ≠ 삭제**, 핫 워킹셋만 바운드하고 콜드 레코드는
 * 보존)보다 앞선 것이라 뒤집는다. 바로 아래 `archiveColdObservations` 가 이미 같은
 * 문제를 아카이브로 풀고 있었다(형제가 답을 들고 있었다).
 *
 * 멱등: `listMemories` 기본이 `archived_at IS NULL` 이라 아카이브분은 다음 실행에서
 * 재매칭되지 않는다 → 반환 카운트가 매 주기 반복되지 않는다.
 *
 * @returns 이번 실행에서 아카이브한 메모 수.
 */
export const archiveStaleReflections = (
  thresholdDays: number = REFLECTION_TTL_DAYS,
): number => {
  const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const all = listMemories({ type: "feedback", limit: 10000 });
  const targets = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_`) &&
      m.updatedAt <= cutoffMs,
  );
  let archived = 0;
  for (const m of targets) {
    try {
      if (archiveMemory(m.name) !== undefined) archived++;
    } catch {
      // 무시 — 다른 프로세스가 동시에 처리했을 수 있음.
    }
  }
  return archived;
};

/**
 * P2 (2026-07-18) — 콜드 관측 아카이브. `feedback-obs-*` 중 OBS_ARCHIVE_DAYS 일 미변경 +
 * access_count 0(한 번도 surfaced 안 됨)을 archive(삭제 아님·가역·FTS 검색 유지). 핫 인덱스
 * (always-on) 만 비우고 콜드 레코드는 보존([[project_hotpath_bound_preserve_record]]). access
 * 필터는 store SQL(listColdMemoriesForArchive)에 있어 자주 surfaced 되는 durable obs 는 남는다.
 * 아카이브 갯수 반환. maintenance interval 에서 cleanupStaleReflections 와 나란히 호출.
 */
export const archiveColdObservations = (
  thresholdDays: number = OBS_ARCHIVE_DAYS,
): number => {
  const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const names = listColdMemoriesForArchive(OBS_ARCHIVE_PREFIX, cutoffMs);
  let archived = 0;
  for (const name of names) {
    try {
      if (archiveMemory(name) !== undefined) archived++;
    } catch {
      // 무시 — 동시 아카이브/삭제 경합.
    }
  }
  return archived;
};

/**
 * **한 번 걷기** — 이미 인덱스에 실려 있는 옛 산출물을 내린다 (2026-09-05 재구성).
 *
 * 새 산출물은 `upsertReflection` 이 박자마자 내리지만, 그 전에 쌓인 것들은 그대로 남아
 * 있다. 실측(dev): 살아있는 성장 메모리 24건 = **3,568B** = 인덱스 원재료의 **16.5%**.
 * 삭제가 아니라 아카이브라 검색으로 계속 도달하고 되돌릴 수 있다(비파괴).
 *
 * ★멱등이다 — 이미 내려간 것은 UPDATE 가 no-op 이고, 매 부팅 돌아도 값이 같다.
 * ★사용자가 일부러 되올린 것(승격)은 **다시 안 내린다**: 승격은 `source: user` 로
 *  SELF_GROWTH.md 에 사는 것이지 메모리 인덱스로 올리는 게 아니다.
 */
/**
 * 이 스윕이 **이미 돌았나** — `last-review` 와 같은 자리·같은 방식의 표식 (2026-09-05).
 *
 * ★이름은 `…Once` 인데 **매 부팅 돌고 있었다**(생성자에서 호출). 그래서 사용자가 일부러
 *  되올린 제안이 **재시작 때마다 조용히 다시 내려갔다** — 바로 아래 주석이 *"승격은 다시
 *  안 내린다"* 고 약속하는 그 동작이다(적대 검토가 실행으로 잡았다).
 *  이건 백필(옛 산출물 정리)이라 정의상 한 번이면 끝이고, 그 뒤 인덱스에 올라와 있는
 *  성장 산출물은 **사람이 올린 것**뿐이다.
 */
const sweptMarkerFile = (): string =>
  path.join(getPaths().commonPlugins, "self-growth", "outputs-archived");

export const archiveGrowthOutputsOnce = (): number => {
  let n = 0;
  try {
    try {
      readFileSync(sweptMarkerFile(), "utf8");
      return 0; // 이미 돌았다 — 여기서 또 돌면 사용자 승격을 되돌린다.
    } catch {
      /* 표식 없음 = 첫 실행 */
    }
    let reset = 0;
    for (const m of listMemories({ limit: 10_000 })) {
      if (!m.name.startsWith(`feedback_${SELF_NAMESPACE}_`) && !m.name.startsWith(`${SELF_NAMESPACE}_`)) {
        continue;
      }
      if (archiveMemory(m.name) !== undefined) {
        n += 1;
        // ★부풀어 있던 접근 카운터를 되돌린다 — 그 값은 사람이 읽어서가 아니라
        //  자가성장이 자기 것을 `getMemory` 로 세던 버그(같은 날 고침)가 만든 것이다.
        //  안 되돌리면 `/status` 의 «미열람» 이 죽은 채로 남는다(실측: 46건 중 45건이
        //  «읽음» 으로 잡혀 «미열람 1» 이라고 답했다) — 인덱스에서 내리면서 도달을
        //  그 카운트에 맡겼는데, 그 카운트가 이미 망가져 있었다.
        if (resetArchivedMemoryAccess(m.name)) reset += 1;
      }
    }
    mkdirSync(path.dirname(sweptMarkerFile()), { recursive: true });
    writeFileSync(sweptMarkerFile(), String(Date.now()), "utf8");
    if (n > 0) {
      console.log(
        `self-growth: 성장 산출물 ${n}건을 인덱스에서 내렸습니다(검색·복원 가능) · 미열람 신호 복구 ${reset}건. 이 정리는 1회만 돕니다.`,
      );
    }
  } catch (e) {
    console.error(`self-growth: archiveGrowthOutputsOnce failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return n;
};
