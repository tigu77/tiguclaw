"use client";

import { useEffect, useState } from "react";
import { AgentInfo, TimelineEvent } from "@/types";

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

// ─── 에이전트 정보 카드 ───────────────────────────────────────────────────────

const LEVEL_LABEL: Record<number, string> = {
  0: "L0",
  1: "L1",
  2: "L2",
  3: "L3",
};

function statusDot(status?: string): { dot: string; label: string } {
  const s = status ?? "idle";
  if (s === "thinking")
    return { dot: "🔵", label: "thinking" };
  if (s.startsWith("executing:"))
    return { dot: "🟡", label: `executing: ${s.split(":").slice(1).join(":")}` };
  return { dot: "⚪", label: "idle" };
}

interface AgentInfoCardProps {
  agent: AgentInfo;
}

function AgentInfoCard({ agent }: AgentInfoCardProps) {
  const { dot, label } = statusDot(agent.current_status);
  const level = LEVEL_LABEL[agent.level] ?? `L${agent.level}`;

  return (
    <div className="mx-3 my-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 flex flex-col gap-1 text-xs font-mono">
      {/* 이름 */}
      <div className="text-sm font-bold text-white mb-0.5">
        {agent.nickname ?? agent.name}
      </div>
      {/* 구분선 */}
      <div className="border-t border-white/10 mb-0.5" />
      {/* 속성 목록 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-gray-400">
        <span className="text-gray-600">레벨</span>
        <span className="text-gray-200">{level}</span>

        <span className="text-gray-600">역할</span>
        <span className="text-gray-200">{agent.role}</span>

        <span className="text-gray-600">팀</span>
        <span className="text-gray-200">{agent.team ?? "—"}</span>

        <span className="text-gray-600">채널</span>
        <span className="text-gray-200">{agent.channel_type}</span>

        <span className="text-gray-600">상태</span>
        <span className="text-gray-200">
          {dot} {label}
        </span>

        <span className="text-gray-600">clearance</span>
        <span className="text-gray-200">{agent.clearance ?? "full"}</span>
      </div>
    </div>
  );
}

// ─── AgentTimelinePanel ──────────────────────────────────────────────────────

interface AgentTimelinePanelProps {
  agentName: string;
  /** 선택된 에이전트 전체 정보 (정보 카드 표시용) */
  agentInfo?: AgentInfo;
  /** WS로 수신된 전체 타임라인 이벤트 (이 에이전트 관련 것만 필터링) */
  allTimelineEvents: TimelineEvent[];
  apiBase: string;
  onClose: () => void;
}

export default function AgentTimelinePanel({
  agentName,
  agentInfo,
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

      {/* 에이전트 정보 카드 */}
      {agentInfo && <AgentInfoCard agent={agentInfo} />}

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
