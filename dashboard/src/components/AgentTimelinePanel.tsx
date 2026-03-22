"use client";

import { useEffect, useState } from "react";
import { TimelineEvent } from "@/types";

// ─── 이벤트 표시 헬퍼 ────────────────────────────────────────────────────────

function eventIcon(type: string): string {
  switch (type) {
    case "spawn":     return "🟢";
    case "kill":      return "🔴";
    case "comm":      return "💬";
    case "thinking":  return "🧠";
    case "executing": return "🔧";
    case "idle":      return "⚪";
    default:          return "❔";
  }
}

function eventDescription(event: TimelineEvent): string {
  switch (event.event_type) {
    case "spawn":     return "spawn";
    case "kill":      return "종료";
    case "comm": {
      const preview = event.message
        ? event.message.length > 60
          ? event.message.slice(0, 60) + "…"
          : event.message
        : "";
      if (event.from_agent === event.agent_name) {
        return `→ ${event.to_agent ?? "?"}: ${preview}`;
      }
      return `← ${event.from_agent ?? "?"}: ${preview}`;
    }
    case "thinking":  return "thinking...";
    case "executing": return `🔧 ${event.tool ?? "?"} 실행 중`;
    case "idle":      return "idle";
    default:          return event.event_type;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// ─── AgentTimelinePanel ──────────────────────────────────────────────────────

interface AgentTimelinePanelProps {
  agentName: string;
  /** WS로 수신된 전체 타임라인 이벤트 (이 에이전트 관련 것만 필터링) */
  allTimelineEvents: TimelineEvent[];
  apiBase: string;
  onClose: () => void;
}

export default function AgentTimelinePanel({
  agentName,
  allTimelineEvents,
  apiBase,
  onClose,
}: AgentTimelinePanelProps) {
  const [initialEvents, setInitialEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);

  // 최초 로드 — REST API에서 에이전트 타임라인 가져오기
  useEffect(() => {
    setLoading(true);
    fetch(`${apiBase}/api/agents/${encodeURIComponent(agentName)}/timeline`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: TimelineEvent[]) => {
        setInitialEvents(data);
      })
      .catch(() => {
        setInitialEvents([]);
      })
      .finally(() => setLoading(false));
  }, [agentName, apiBase]);

  // WS 실시간 이벤트 중 이 에이전트 관련 것만 필터링 (초기 로드 이후 신규)
  const wsEvents = allTimelineEvents.filter(
    (e) =>
      e.id < 0 && // 음수 ID = 로컬 임시 (WS 수신)
      (e.agent_name === agentName ||
        e.from_agent === agentName ||
        e.to_agent === agentName)
  );

  // 합산: WS 최신 + REST 이력 (WS가 위에)
  const combined = [...wsEvents, ...initialEvents];

  return (
    <div className="flex flex-col h-full">
      {/* 패널 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <div>
          <div className="text-sm font-bold text-white font-mono">{agentName}</div>
          <div className="text-xs text-gray-500">에이전트 타임라인</div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white transition-colors text-lg leading-none"
          title="닫기"
        >
          ✕
        </button>
      </div>

      {/* 이벤트 리스트 */}
      <div
        className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-0"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
      >
        {loading ? (
          <div className="text-gray-600 text-xs text-center py-8 animate-pulse">로딩 중...</div>
        ) : combined.length === 0 ? (
          <div className="text-gray-600 text-xs text-center py-8">이벤트 없음</div>
        ) : (
          combined.map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-white/5 transition-colors text-xs font-mono"
            >
              <span className="text-gray-500 flex-shrink-0 w-16 pt-0.5">
                {formatTime(event.timestamp)}
              </span>
              <span className="flex-shrink-0 text-sm leading-none pt-0.5">
                {eventIcon(event.event_type)}
              </span>
              <span className="text-gray-300 flex-1 min-w-0 truncate pt-0.5">
                {eventDescription(event)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
