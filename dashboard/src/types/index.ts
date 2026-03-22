export interface AgentInfo {
  name: string;
  /** 로컬 별칭 — 같은 spec(name)으로 여러 인스턴스 구분용 (선택사항) */
  nickname?: string;
  tier: number; // 0=T0(슈퍼마스터), 1=T1(책임자), 2=T2(전문가)
  /** @deprecated level → tier로 통일됨. 하위호환용 */
  level?: number;
  channel_type: string;
  persistent: boolean;
  status?: "active" | "idle" | "dead";
  /** 현재 실행 상태: "idle" | "thinking" | "executing:tool명" */
  current_status?: string;
  /** 부모 에이전트 이름 (L0는 없음) */
  parent_agent?: string;
  /** 소속 팀 이름 (선택사항) */
  team?: string;
  /** 툴 접근 수준 ("full" | "limited" | ...) */
  clearance?: string;
}

export type LogEntryType =
  | "spawn"
  | "kill"
  | "comm"
  | "heartbeat"
  | "cost"
  | "thinking"
  | "executing"
  | "idle";

export interface LogEntry {
  id: string;
  time: string;
  type: LogEntryType;
  text: string;
}

/** 날짜별 JSONL 로그에서 파싱된 이벤트 (REST API /api/logs 응답) */
export interface ApiLogEvent {
  type: string;
  data?: Record<string, unknown>;
  /** 로그 파일에 저장된 timestamp (ISO string or ms) */
  ts?: string | number;
}

/** 타임라인 이벤트 (백엔드 REST API + WS 실시간) */
export interface TimelineEvent {
  id: number;
  event_type: string; // "spawn" | "kill" | "comm" | "thinking" | "executing" | "idle"
  agent_name: string;
  from_agent?: string;
  to_agent?: string;
  message?: string;
  tool?: string;
  /** Unix milliseconds */
  timestamp: number;
}

// WebSocket 이벤트 타입
export type WsEventType =
  | "AgentSpawned"
  | "AgentKilled"
  | "AgentComm"
  | "AgentStatus"
  | "AgentThinking"
  | "AgentExecuting"
  | "AgentIdle"
  | "Heartbeat";

export interface WsEvent {
  type: WsEventType;
  data?: Record<string, unknown>;     // serde tag+content 방식: {"type":"...", "data":{...}}
  payload?: Record<string, unknown>;  // 하위 호환
}
