/**
 * 런타임 유지보수 — detect 전용 순수 함수 (P1, 읽기전용).
 *
 * 진실 소스: `_workspace/runtime-maintenance_architect_contract.md` §3.1 · ADR
 * `docs/decisions/2026-07-12-runtime-maintenance-hotpath.md`. 철학:
 * `.claude/memory/project_hotpath_bound_preserve_record.md`(★정리≠삭제 — 효율=핫경로
 * 바운드(비파괴), 보존=콜드 레코드 절대 안 지움).
 *
 * ★위험 로직 0(핵심 불변식): 이 파일은 SELECT count + 파일 stat + 정책 registry 조인만
 * 한다 — 아무것도 안 바꾼다(파괴적 삭제 도구는 P1 범위 아님, 애초에 여기 없음). update-self
 * 의 "위험 로직은 runSelfUpdate 안에 캡슐화" 원칙의 detect 판(더 단순 — 애초에 위험이 없음).
 *
 * §0 단방향 불변식: 정책(어느 store 를 어느 캡과 비교하는지)은 이 한 모듈에 **데이터**로
 * 선언한다(architect contract §2 "선언형 store-policy registry"). 코어가 코어 store 스키마를
 * 아는 것은 §0(코어→플러그인 참조 금지) 위반이 아니다 — 여기서 참조하는 건 전부 코어 store
 * (events/worker_jobs/memories/transcripts, 전부 store/sessions.ts 스키마)뿐이다.
 * self-growth 자동메모리 관측은 "growth" *이름 패턴*(데이터)만 쓰고 어떤 플러그인 모듈도
 * import 하지 않는다(countMemoriesByNamePattern 은 제네릭 유틸).
 *
 * MCP 도구(`maintenance-mcp.ts`)·http-bridge(`GET /maintenance`, P3 이후)·스케줄 auto 가
 * 이 *동일 함수*를 공유(collectInventory 동형, 중복 구현 금지).
 */
import fs from "node:fs";
import path from "node:path";
import { getPaths } from "./paths.js";
import { RETENTION_KEEP } from "./event-persist.js";
import { MEMORY_INDEX_CAP_BYTES } from "./prompt-assembly.js";
import { eventsTotalBound, countEvents } from "../store/events.js";
import { countWorkerJobs } from "../store/worker-jobs.js";
import { TERMINAL_WORKER_JOB_KEEP } from "./worker-jobs.js";
import {
  countMemories,
  countMemoriesByNamePattern,
  countTranscripts,
  listMemoriesForIndex,
} from "../store/memory.js";

export interface StoreHealth {
  store: string;
  axis: "hot-bounded" | "cold-preserve" | "volatile";
  /** 행수(or 파일수) — 축·store 에 따라 "전체" 또는 "터미널만" 등 의미가 다를 수 있음(note 참조). */
  count: number;
  /** 캡/리텐션(바운드) — null 이면 보존(무한이 설계상 정상, "정보만"). */
  bound: number | null;
  status: "healthy" | "attention" | "n/a";
  /** 사람말 한 줄 — 콜드=무한이 정상임을 명시(대시보드/도구가 "크다=문제" 오판 안 하도록). */
  note: string;
}

/** P4(파괴적 제안) 게이트용 타입 — P1 에선 항상 빈 배열(도구·로직 미구현, 계약서 §3.2b). */
export interface CleanupProposal {
  id: string;
  target: string;
  axis: "volatile" | "user-explicit";
  wouldRemove: number;
  sample: string[];
  freesBytes: number;
}

export interface MaintenanceReport {
  generatedAt: number;
  overall: "healthy" | "attention";
  dbBytes: number;
  walBytes: number;
  stores: StoreHealth[];
  /** P1 에선 항상 [] — 파괴적 제안 게이트는 P4 이후(실수요 시). */
  proposals: CleanupProposal[];
}

/**
 * attention 판정 — events/worker_jobs 는 *이미 bounded-by-construction*(prune 이 매
 * insert/터미널 전이마다 발화)이라 정상 steady-state 자체가 항상 cap 언저리(예: events 는
 * PRUNE_EVERY=256건마다 배치 정리라 [keepLast, keepLast+256] 사이를 정상 오간다). "cap 에
 * 가깝다"를 attention 으로 잡으면 정상 상태가 상시 경고로 오판된다(§7 detect 오판 리스크).
 * 그래서 여기 threshold 는 "근접"이 아니라 **"prune 메커니즘이 고장났다"는 신호** —
 * cap 을 큰 배수(기본 1.5배)로 넘어야만 attention. 정상 운영에선 절대 안 넘는다.
 */
const boundedStatus = (
  count: number,
  bound: number,
  overshootFactor = 1.5,
): "healthy" | "attention" =>
  count > bound * overshootFactor ? "attention" : "healthy";

/** 파일 크기 — 없으면(아직 미생성 등) 0. 읽기전용(존재 확인만), throw 금지. */
const safeStatBytes = (filePath: string): number => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

/**
 * 메모리 인덱스 실제 바이트(전체 memories 를 캡 없이 라인화했을 때 크기) — 매 턴
 * 프롬프트에 실제 주입되는 값(`formatMemoryIndex`)은 `listMemoriesForIndex(cap)` 으로
 * 이미 캡에서 truncate 되어 **hot 경로는 항상 bounded-by-construction**이다. 여기서는
 * "캡이 없다면 몇 바이트였을지"를 관측용으로만 계산(콜드 총량 참고, 판정에는 안 씀).
 */
const totalMemoryIndexBytes = (): number => {
  const { lines } = listMemoriesForIndex(Number.MAX_SAFE_INTEGER);
  return lines.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8") + 1, 0);
};

/**
 * 런타임 유지보수 상태 스캔 — 순수 읽기전용. `maintenance_status` MCP 도구·(향후)
 * http-bridge `/maintenance`·스케줄 auto 가 공유하는 단일 집계 함수.
 *
 * 값의 대부분은 §1(dev DB 재검증)이 이미 정리한 "핫 경로는 구조적으로 건강" 서술을
 * 배포 인스턴스에서도 재현하는 것 — 크다≠문제(콜드=보존이 정상)를 note 로 항상 명시한다.
 */
export const runMaintenanceScan = (): MaintenanceReport => {
  const generatedAt = Date.now();
  const { data } = getPaths();
  const dbBytes = safeStatBytes(path.join(data, "tiguclaw.db"));
  const walBytes = safeStatBytes(path.join(data, "tiguclaw.db-wal"));

  const stores: StoreHealth[] = [];

  // events — 휘발성/파생(관측). RETENTION_KEEP prune 이 매 256건마다 발화(이미 됨).
  const eventsCount = countEvents();
  stores.push({
    store: "events",
    axis: "volatile",
    count: eventsCount,
    // ★실제 상한 공식(희귀 몫 + 고volume 타입별 몫) — RETENTION_KEEP 단독은 여유 0 이라
    //  고volume 종류가 하나 늘면 즉시 영구 attention 오경보가 난다(2026-07-30 원칙 검토).
    bound: eventsTotalBound(RETENTION_KEEP),
    status: boundedStatus(eventsCount, eventsTotalBound(RETENTION_KEEP)),
    note: `관측 이벤트(감사·메트릭) — 최근 ${RETENTION_KEEP.toLocaleString()}건만 보존, 초과분은 주기적으로 자동 정리(파생 데이터, 삭제 안전).`,
  });

  // 메모리 인덱스 — 콜드는 유저 자산(전부 보존), 핫(매 턴 프롬프트 주입)은 캡
  // truncate 로 이미 bounded-by-construction. 여기 count=전체 메모리 건수·note 에
  // "캡 넘으면 자동 요약/절단(정상)"을 명시 — 크다=문제 오해 방지(§7 detect 오판 완화).
  const memoriesTotal = countMemories();
  const memoryIndexBytes = totalMemoryIndexBytes();
  stores.push({
    store: "memory-index",
    axis: "hot-bounded",
    count: memoryIndexBytes,
    bound: MEMORY_INDEX_CAP_BYTES,
    status: "healthy", // 캡 초과는 read-time truncate 로 이미 처리(bounded-by-construction).
    note:
      memoryIndexBytes > MEMORY_INDEX_CAP_BYTES
        ? `전체 메모리 ${memoriesTotal}건 = 인덱스 ${memoryIndexBytes}B(캡 ${MEMORY_INDEX_CAP_BYTES}B 초과) — 매 턴 프롬프트엔 캡만큼만 주입되고 나머지는 find_memory 로 검색(정상 동작, 잘림 아님).`
        : `전체 메모리 ${memoriesTotal}건, 인덱스 ${memoryIndexBytes}B (캡 ${MEMORY_INDEX_CAP_BYTES}B 이내).`,
  });

  // worker_jobs — 파생 메타(런타임 진실은 in-memory Map). 터미널 잡만 캡(P1 신규,
  // core/worker-jobs.ts pruneTerminalJobsSafe 가 터미널 전이마다 발화). running 은
  // 캡과 무관하게 항상 보존.
  const { total: workerJobsTotal, terminal: workerJobsTerminal } = countWorkerJobs();
  stores.push({
    store: "worker_jobs",
    axis: "volatile",
    count: workerJobsTerminal,
    bound: TERMINAL_WORKER_JOB_KEEP,
    status: boundedStatus(workerJobsTerminal, TERMINAL_WORKER_JOB_KEEP),
    note: `재시작 생존용 메타 미러(전체 ${workerJobsTotal}건, running 은 캡 제외·항상 보존). 완료/실패/취소된 터미널 잡만 최근 ${TERMINAL_WORKER_JOB_KEEP.toLocaleString()}건 보존.`,
  });

  // transcripts — 콜드 보존(감사·검색). 무한이 설계상 정상(§ 콜드 티어링은 P2 선택 후속).
  const transcriptsCount = countTranscripts();
  stores.push({
    store: "transcripts",
    axis: "cold-preserve",
    count: transcriptsCount,
    bound: null,
    status: "n/a",
    note: `대화 전문 감사·검색 원본 — 무한 누적이 정상(보존 원칙, 자동 삭제 없음). 핫 경로는 요약/윈도잉으로 이미 바운드.`,
  });

  // self-growth 자동메모리 — 콜드 보존(비서 학습 기록). '%growth%' 이름 패턴은 데이터로만
  // 취급(어떤 플러그인 모듈도 import 안 함, §0). 쓰기시점 통합(예방)은 P2, 여기선 관측만.
  const selfGrowthCount = countMemoriesByNamePattern("%growth%");
  stores.push({
    store: "self-growth-memories",
    axis: "cold-preserve",
    count: selfGrowthCount,
    bound: null,
    status: "n/a",
    note: `비서 학습 기록(실패 메모 등) — 무한 누적이 설계상 정상이나 재사용 안 되는 일회성 기록이 쌓일 수 있음(관측만, 자동 삭제 없음).`,
  });

  const overall: MaintenanceReport["overall"] = stores.some(
    (s) => s.status === "attention",
  )
    ? "attention"
    : "healthy";

  return {
    generatedAt,
    overall,
    dbBytes,
    walBytes,
    stores,
    proposals: [], // P1 — 파괴적 제안 게이트 미구현(계약서 §3.2b, P4).
  };
};
