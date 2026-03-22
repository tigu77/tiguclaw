"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AgentInfo, LogEntry, LogEntryType, TimelineEvent, WsEvent } from "@/types";

const MAX_LOGS = 100;
const MAX_TIMELINE = 500;
const RECONNECT_DELAY_MS = 3000;

let _tlCounter = 0;
function makeTlId(): number {
  return --_tlCounter; // 음수 임시 ID (DB 저장 전 프론트 로컬 ID)
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function nowTime(): string {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function parseEvent(evt: WsEvent): { agentPatch?: Partial<AgentInfo> & { name: string }; log: LogEntry } | null {
  // 백엔드: serde tag+content → {"type":"...", "data":{...}}
  const p = (evt.data ?? evt.payload ?? {}) as Record<string, string | number | boolean>;
  switch (evt.type) {
    case "AgentSpawned":
      return {
        agentPatch: {
          name: String(p.name ?? "unknown"),
          tier: Number(p.tier ?? p.level ?? 1),
          channel_type: String(p.channel_type ?? ""),
          persistent: Boolean(p.persistent ?? false),
          status: "active",
        },
        log: {
          id: makeId(),
          time: nowTime(),
          type: "spawn",
          text: `🟢 spawn: ${p.name}`,
        },
      };

    case "AgentKilled":
      return {
        agentPatch: { name: String(p.name ?? ""), status: "dead" },
        log: {
          id: makeId(),
          time: nowTime(),
          type: "kill",
          text: `🔴 kill: ${p.name}`,
        },
      };

    case "AgentComm":
      return {
        log: {
          id: makeId(),
          time: nowTime(),
          type: "comm",
          text: `[${p.from ?? "?"}→${p.to ?? "?"}] ${p.message ?? ""}`,
        },
      };

    case "AgentStatus":
      return {
        log: {
          id: makeId(),
          time: nowTime(),
          type: "comm",
          text: `📊 에이전트 목록 수신 (${((evt.data ?? evt.payload ?? {}) as { agents?: unknown[] }).agents?.length ?? 0}개)`,
        },
      };

    case "Heartbeat":
      return null;

    default:
      return null;
  }
}

/** WsEvent → TimelineEvent 변환 (저장용 로컬 임시 이벤트) */
function wsToTimeline(evt: WsEvent): TimelineEvent | null {
  const p = (evt.data ?? evt.payload ?? {}) as Record<string, string | number | boolean>;
  const now = Date.now();

  switch (evt.type) {
    case "AgentSpawned":
      return {
        id: makeTlId(),
        event_type: "spawn",
        agent_name: String(p.name ?? ""),
        timestamp: now,
      };
    case "AgentKilled":
      return {
        id: makeTlId(),
        event_type: "kill",
        agent_name: String(p.name ?? ""),
        timestamp: now,
      };
    case "AgentComm":
      return {
        id: makeTlId(),
        event_type: "comm",
        agent_name: String(p.from ?? ""),
        from_agent: String(p.from ?? ""),
        to_agent: String(p.to ?? ""),
        message: String(p.message ?? ""),
        timestamp: now,
      };
    case "AgentThinking":
      return {
        id: makeTlId(),
        event_type: "thinking",
        agent_name: String(p.name ?? ""),
        timestamp: now,
      };
    case "AgentExecuting":
      return {
        id: makeTlId(),
        event_type: "executing",
        agent_name: String(p.name ?? ""),
        tool: String(p.tool ?? ""),
        timestamp: now,
      };
    case "AgentIdle":
      return {
        id: makeTlId(),
        event_type: "idle",
        agent_name: String(p.name ?? ""),
        timestamp: now,
      };
    default:
      return null;
  }
}

export function useDashboard(wsUrl: string) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [agentIdleCount, setAgentIdleCount] = useState(0);

  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // heartbeat 타이머 리셋 — 45초 내 heartbeat 없으면 연결 끊김으로 처리
  const resetHeartbeatTimer = useCallback(() => {
    if (heartbeatTimer.current) clearTimeout(heartbeatTimer.current);
    heartbeatTimer.current = setTimeout(() => {
      if (mountedRef.current) setConnected(false);
    }, 45_000);
  }, []);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }, []);

  const addTimelineEvent = useCallback((event: TimelineEvent) => {
    setTimelineEvents((prev) => {
      const next = [event, ...prev]; // 최신이 맨 앞
      return next.length > MAX_TIMELINE ? next.slice(0, MAX_TIMELINE) : next;
    });
  }, []);

  const patchAgent = useCallback((patch: Partial<AgentInfo> & { name: string }) => {
    setAgents((prev) => {
      const idx = prev.findIndex((a) => a.name === patch.name);
      if (idx === -1) {
        return [
          ...prev,
          {
            name: patch.name,
            tier: patch.tier ?? patch.level ?? 1,
            channel_type: patch.channel_type ?? "",
            persistent: patch.persistent ?? false,
            status: patch.status ?? "active",
          },
        ];
      }
      const updated = [...prev];
      updated[idx] = { ...updated[idx], ...patch };
      if (patch.status === "dead") {
        return updated.filter((a) => a.status !== "dead");
      }
      return updated;
    });
  }, []);

  // 초기 타임라인 로드
  const loadInitialTimeline = useCallback(() => {
    const apiBase = wsUrl.replace(/^ws/, "http").replace("/ws", "");
    fetch(`${apiBase}/api/timeline`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: TimelineEvent[]) => {
        if (mountedRef.current) {
          setTimelineEvents(data); // 이미 timestamp DESC 정렬
        }
      })
      .catch(() => {/* 조용히 무시 */});
  }, [wsUrl]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      resetHeartbeatTimer();
      addLog({ id: makeId(), time: nowTime(), type: "heartbeat", text: "✅ WebSocket 연결됨" });
      loadInitialTimeline();
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(event.data) as WsEvent;

        resetHeartbeatTimer();

        if (data.type === "Heartbeat") return;

        // AgentStatus — 전체 목록 스냅샷
        if (data.type === "AgentStatus") {
          const d = (data.data ?? data.payload ?? {}) as { agents?: AgentInfo[] };
          if (Array.isArray(d.agents)) {
            setAgents(d.agents.map(a => ({ ...a, status: "active" as const })));
          }
          return;
        }

        // AgentThinking
        if (data.type === "AgentThinking") {
          const d = (data.data ?? data.payload ?? {}) as { name?: string };
          if (d.name) {
            patchAgent({ name: d.name, current_status: "thinking" });
            addLog({ id: makeId(), time: nowTime(), type: "thinking" as LogEntryType, text: `💭 thinking: ${d.name}` });
          }
          const tl = wsToTimeline(data);
          if (tl) addTimelineEvent(tl);
          return;
        }

        // AgentExecuting
        if (data.type === "AgentExecuting") {
          const d = (data.data ?? data.payload ?? {}) as { name?: string; tool?: string };
          if (d.name) {
            patchAgent({ name: d.name, current_status: `executing:${d.tool ?? ""}` });
            addLog({ id: makeId(), time: nowTime(), type: "executing" as LogEntryType, text: `🔧 executing: ${d.name} → ${d.tool ?? "?"}` });
          }
          const tl = wsToTimeline(data);
          if (tl) addTimelineEvent(tl);
          return;
        }

        // AgentIdle
        if (data.type === "AgentIdle") {
          const d = (data.data ?? data.payload ?? {}) as { name?: string };
          if (d.name) {
            patchAgent({ name: d.name, current_status: "idle" });
            addLog({ id: makeId(), time: nowTime(), type: "idle" as LogEntryType, text: `✅ idle: ${d.name}` });
          }
          setAgentIdleCount((c) => c + 1);
          const tl = wsToTimeline(data);
          if (tl) addTimelineEvent(tl);
          return;
        }

        const result = parseEvent(data);
        if (result) {
          if (result.agentPatch) patchAgent(result.agentPatch);
          addLog(result.log);
        }

        // 타임라인에도 추가
        const tl = wsToTimeline(data);
        if (tl) addTimelineEvent(tl);

      } catch {
        // 파싱 오류 무시
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      addLog({ id: makeId(), time: nowTime(), type: "heartbeat", text: "🔌 연결 끊김, 재연결 중..." });
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [wsUrl, addLog, patchAgent, addTimelineEvent, loadInitialTimeline, resetHeartbeatTimer]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (heartbeatTimer.current) clearTimeout(heartbeatTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { agents, logs, connected, timelineEvents, agentIdleCount };
}
