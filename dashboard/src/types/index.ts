export interface AgentInfo {
  name: string;
  role: string; // "supermaster" | "master" | "mini" | "worker"
  level: number;
  channel_type: string;
  persistent: boolean;
  status?: "active" | "idle" | "dead";
  /** 현재 실행 상태: "idle" | "thinking" | "executing:tool명" */
  current_status?: string;
}

export interface LogEntry {
  id: string;
  time: string;
  type: "spawn" | "kill" | "comm" | "heartbeat" | "cost";
  text: string;
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
