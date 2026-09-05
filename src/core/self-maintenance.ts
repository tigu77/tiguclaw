/**
 * **자기 보전 루프 — 코어 소유 시계** (2026-08-12).
 *
 * ★왜 코어인가 (사용자: "기본적인 부분은 코어에 들어가는게 맞아"):
 *  DB 백업과 자기 진단은 `store/backup.ts`·`health-sweep.ts` 가 로직을 갖고 있었는데
 *  **부르는 시계가 `plugins/self-growth` 에 있었다.** 플러그인 로더는 로드 실패를
 *  **조용히 skip** 하고(`core/plugins/loader.ts`), `plugins/` 는 typecheck 밖이라
 *  구문 오류 하나가 모든 게이트를 통과해 부팅 때만 죽는다(v0.3.1 실사고). 즉
 *  **성장 기능이 안 뜨면 백업과 자가 진단이 함께 조용히 멎는 구조**였다 —
 *  데이터 안전이 부가 기능의 부수효과로 걸려 있었다.
 *
 * 경계는 그대로 지킨다:
 *  - **조치는 기능 소유자가** 한다 — 백업을 뜨는 건 DB 를 아는 `store/backup.ts`,
 *    진단 판정은 `health-sweep.ts`. 여기는 **언제 부를지**와 **어떻게 알릴지**만 안다.
 *  - self-growth 는 성장 고유의 일(제안·회고·지침·TTL·실패 학습)만 남는다. 이 모듈은
 *    그 플러그인을 import 하지 않는다(§0 단방향 불변식 유지).
 *
 * 통보 정책(기존 그대로 이식):
 *  - 정상은 **침묵**. 발견이 있을 때만 2겹(EventBus + 기본 outbound 채널)으로 보고.
 *  - 백업 성공은 침묵(로그만), 실패·첫 벌만 말한다 — `backupNotice` 가 정한다.
 */
import { getEventBus, type EventBus, type EventBusEvent } from "./eventbus.js";
import { ownerPushChannel } from "./channel-outbound.js";
import { deliverOutbound } from "./outbound.js";
import { runBackupIfDue, backupNotice } from "../store/backup.js";
import { runHealthSweep, type HealthFinding } from "./health-sweep.js";
import { refreshModelCatalog } from "./llm-runtime/model-catalog.js";

/** 주기 — 백스톱. 이벤트가 없어도 이 간격으로 한 번은 본다. */
const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1시간
/**
 * 이벤트로 깨울 때의 최소 간격 — 짧은 창에 실패가 몰려도 스윕은 한 번만.
 * 스윕 자체가 증분이라 중복 보고는 안 되지만, DB 조회가 그만큼 반복되는 건 낭비다.
 */
const EVENT_WAKE_MIN_INTERVAL_MS = 30 * 1000;

let timer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
/** 증분 기준 — 부팅 시각으로 시작한다(과거분 재보고 0). */
let lastSweepTs = Date.now();

/** 발견을 2겹으로 보고(EventBus + 기본 채널). 빈 배열이면 침묵. */
const reportFindings = (bus: EventBus | null, findings: HealthFinding[]): void => {
  if (findings.length === 0) return;
  for (const f of findings) {
    console.log(`self-maintenance: health — ${f.kind}: ${f.summary}`);
  }
  if (bus !== null) {
    try {
      bus.publish({
        type: "self_growth.health.finding",
        ts: Date.now(),
        // 이벤트 타입·payload 는 그대로 둔다 — 대시보드·회귀 등 기존 소비자를 깨지 않는다.
        payload: { findings },
      });
    } catch (e) {
      console.error(
        `self-maintenance: 발견 발행 실패 — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const lines = findings.map((f) => `• ${f.summary}`).join("\n");
  // ★채널 이름을 코어가 부르지 않는다 (2026-09-05 구조 감사) — 종전엔 `"telegram"` 고정이라
  //  그 채널이 없는 설치에선 이 알림이 어디에도 안 갔다. 「보낼 수 있고 주소를 아는」 채널을
  //  능력으로 고른다. 없으면 로그로 닫는다 — 그것도 사실이니 조용히 넘어가지 않는다.
  const pushTo = ownerPushChannel();
  if (pushTo === null) {
    console.warn(
      `self-maintenance: 이상 ${findings.length}건을 알릴 채널이 없습니다(발송 가능·기본 주소 있는 채널 0) — ${lines}`,
    );
    return;
  }
  void deliverOutbound({
    channel: pushTo,
    target: null, // 채널 기본 대상(소유자) — 좌표 하드코딩 0.
    text: `🩺 자가 점검에서 이상을 발견했습니다.\n\n${lines}`,
    label: "self-maintenance:health",
    notice: true, // 인프라 통지 — 비서 발화 아님.
  }).catch(() => {
    /* 발송 실패해도 위 EventBus 통보는 남는다(2겹 보고) */
  });
};

/** DB 백업 — **시계만 빌려준다.** 실제로 뜨는 건 DB 를 소유한 store/backup.ts. */
const runBackup = (bus: EventBus | null): void => {
  try {
    const r = runBackupIfDue();
    if (!r.ran) return;
    if ("error" in r) console.error(`self-maintenance: DB 백업 실패 — ${r.error}`);
    else
      console.log(
        `self-maintenance: DB 백업 ${r.file} (${((r.bytes ?? 0) / 1048576).toFixed(1)}MB)`,
      );
    // 알릴지 말지는 store 의 `backupNotice` 가 정한다(순수 함수 = 회귀가 실행해 지킨다).
    const notice = backupNotice(r);
    if (notice !== null) reportFindings(bus, [{ kind: "backup_stale", summary: notice }]);
  } catch (e) {
    console.error(
      `self-maintenance: 백업 단계 실패 — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

/**
 * 한 틱 — 백업 + 진단. **never-throw**(데몬을 죽이지 않는다).
 * export: 회귀가 시계를 기다리지 않고 이 함수를 직접 돌려 동작을 확인한다.
 */
export const runSelfMaintenanceTick = (bus: EventBus | null = null): void => {
  runBackup(bus);
  try {
    const since = lastSweepTs;
    lastSweepTs = Date.now();
    reportFindings(bus, runHealthSweep(since));
  } catch (e) {
    console.error(
      `self-maintenance: 진단 스윕 실패 — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // ★모델 카탈로그 갱신 (2026-08-13) — **새 타이머를 만들지 않는다.** 이미 도는 시계에
  //  얹는다(부팅 즉시 + 매시). 조회는 비동기지만 틱은 동기 계약이라 **기다리지 않는다** —
  //  결과는 캐시로 들어가고, 그 전까지는 정적 표가 답한다(회귀 0).
  //  never-throw: 여기서 던지면 백업·진단이 아니라 **모델 이름 하나** 때문에 시계가 죽는다.
  void refreshModelCatalog().catch((e: unknown) => {
    console.warn(
      `self-maintenance: 모델 카탈로그 갱신 실패 — ${e instanceof Error ? e.message : String(e)}`,
    );
  });
};

/** 이벤트로 깨우기 — 디바운스. 주기 틱은 백스톱으로 남는다. */
const wakeDebounced = (bus: EventBus): void => {
  if (Date.now() - lastSweepTs < EVENT_WAKE_MIN_INTERVAL_MS) return;
  runSelfMaintenanceTick(bus);
};

/**
 * 부팅 시 1회 호출 — 즉시 한 틱 + 주기 틱 + 실패 이벤트로 깨우기.
 *
 * ★실패 이벤트를 듣는 이유: 주기(1시간)만으론 유실 알림을 최대 한 시간 뒤에야 본다.
 *  전달 실패는 사용자가 **받았어야 할 것을 못 받은** 상태라 지연이 그대로 손해다.
 */
export const startSelfMaintenance = (bus: EventBus = getEventBus()): void => {
  if (timer !== null) return; // 멱등 — 중복 시작 방지.
  runSelfMaintenanceTick(bus);
  timer = setInterval(() => {
    runSelfMaintenanceTick(bus);
  }, TICK_INTERVAL_MS);
  timer.unref?.();
  unsubscribe = bus.subscribe((event: EventBusEvent) => {
    if (event.type === "llm.turn_error") {
      wakeDebounced(bus);
      return;
    }
    if (event.type === "scheduler.error") {
      // ★재전송이 예약된 건은 무시 — 아직 확정된 유실이 아니다. 여기서 알리면 5분 뒤
      //  복구될 건을 "실패했다"고 먼저 떠드는 꼴이다(자동 조치와 통보가 서로를 밟음).
      const p = event.payload as { willRetry?: unknown } | null;
      if (p !== null && typeof p === "object" && p.willRetry === true) return;
      wakeDebounced(bus);
    }
  });
  console.log(
    "self-maintenance: started — DB 백업 + 자가 진단(주기 1시간 + 실패 이벤트). " +
      "플러그인과 무관하게 코어가 돌린다.",
  );
};

/** 종료 — 타이머·구독 정리(누수 0). */
export const stopSelfMaintenance = (): void => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (unsubscribe !== null) {
    try {
      unsubscribe();
    } catch {
      /* 구독 해제 실패가 종료를 막지 않는다 */
    }
    unsubscribe = null;
  }
};
