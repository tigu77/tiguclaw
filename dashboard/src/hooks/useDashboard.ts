"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AgentInfo, LogEntry, WsEvent } from "@/types";

const MAX_LOGS = 100;
const RECONNECT_DELAY_MS = 3000;

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
          role: String(p.role ?? "worker"),
          level: Number(p.level ?? 0),
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
      // data.agents = AgentStatusInfo[] 배열
      return {
        log: {
          id: makeId(),
          time: nowTime(),
          type: "comm",
          text: `📊 에이전트 목록 수신 (${((evt.data ?? evt.payload ?? {}) as { agents?: unknown[] }).agents?.length ?? 0}개)`,
        },
      };

    case "Heartbeat":
      // 로그에 표시하지 않음 — 연결 상태는 상단 상태바에서만 표시
      return null;

    default:
      return null;
  }
}

export function useDashboard(wsUrl: string) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [totalCost, setTotalCost] = useState(0);

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

  const patchAgent = useCallback((patch: Partial<AgentInfo> & { name: string }) => {
    setAgents((prev) => {
      const idx = prev.findIndex((a) => a.name === patch.name);
      if (idx === -1) {
        // 새 에이전트
        return [
          ...prev,
          {
            name: patch.name,
            role: patch.role ?? "worker",
            level: patch.level ?? 0,
            channel_type: patch.channel_type ?? "",
            persistent: patch.persistent ?? false,
            status: patch.status ?? "active",
          },
        ];
      }
      const updated = [...prev];
      updated[idx] = { ...updated[idx], ...patch };
      // 죽은 에이전트는 목록에서 제거
      if (patch.status === "dead") {
        return updated.filter((a) => a.status !== "dead");
      }
      return updated;
    });
  }, []);

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
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(event.data) as WsEvent;

        // 모든 메시지 수신 시 heartbeat 타이머 리셋
        resetHeartbeatTimer();

        // Heartbeat — 로그 없음, 타이머만 리셋
        if (data.type === "Heartbeat") return;

        // AgentStatus — 전체 목록 스냅샷
        if (data.type === "AgentStatus") {
          const d = (data.data ?? data.payload ?? {}) as { agents?: AgentInfo[] };
          if (Array.isArray(d.agents)) {
            setAgents(d.agents.map(a => ({ ...a, status: "active" as const })));
          }
        }

        // AgentThinking — LLM 호출 중
        if (data.type === "AgentThinking") {
          const d = (data.data ?? data.payload ?? {}) as { name?: string };
          if (d.name) {
            patchAgent({ name: d.name, current_status: "thinking" });
          }
          return;
        }

        // AgentExecuting — 툴 실행 중
        if (data.type === "AgentExecuting") {
          const d = (data.data ?? data.payload ?? {}) as { name?: string; tool?: string };
          if (d.name) {
            patchAgent({ name: d.name, current_status: `executing:${d.tool ?? ""}` });
          }
          return;
        }

        // AgentIdle — 대기 상태
        if (data.type === "AgentIdle") {
          const d = (data.data ?? data.payload ?? {}) as { name?: string };
          if (d.name) {
            patchAgent({ name: d.name, current_status: "idle" });
          }
          return;
        }

        // 비용 이벤트
        if (((data.data ?? data.payload) as Record<string, unknown>)?.cost !== undefined) {
          const cost = Number(((data.data ?? data.payload) as Record<string, unknown>).cost ?? 0);
          setTotalCost((prev) => prev + cost);
          addLog({
            id: makeId(),
            time: nowTime(),
            type: "cost",
            text: `💰 비용 +$${cost.toFixed(4)}`,
          });
          return;
        }

        const result = parseEvent(data);
        if (!result) return;

        if (result.agentPatch) patchAgent(result.agentPatch);
        addLog(result.log);
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
  }, [wsUrl, addLog, patchAgent]);

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

  return { agents, logs, connected, totalCost };
}
