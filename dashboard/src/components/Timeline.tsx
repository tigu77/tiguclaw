"use client";

import { useMemo, useState } from "react";
import { AgentInfo, TimelineEvent } from "@/types";

// ─── 에이전트 색상 팔레트 ────────────────────────────────────────────────────

const AGENT_COLORS = [
  "bg-blue-500/20 border-blue-500/40 text-blue-300",
  "bg-purple-500/20 border-purple-500/40 text-purple-300",
  "bg-emerald-500/20 border-emerald-500/40 text-emerald-300",
  "bg-orange-500/20 border-orange-500/40 text-orange-300",
  "bg-pink-500/20 border-pink-500/40 text-pink-300",
  "bg-cyan-500/20 border-cyan-500/40 text-cyan-300",
  "bg-yellow-500/20 border-yellow-500/40 text-yellow-300",
  "bg-red-500/20 border-red-500/40 text-red-300",
];

const AGENT_DOT_COLORS = [
  "bg-blue-400",
  "bg-purple-400",
  "bg-emerald-400",
  "bg-orange-400",
  "bg-pink-400",
  "bg-cyan-400",
  "bg-yellow-400",
  "bg-red-400",
];

function useAgentColorMap(events: TimelineEvent[]) {
  return useMemo(() => {
    const map = new Map<string, number>();
    for (const e of events) {
      const name = e.agent_name || e.from_agent || "";
      if (name && !map.has(name)) {
        map.set(name, map.size % AGENT_COLORS.length);
      }
    }
    return map;
  }, [events]);
}

// ─── 이벤트 타입별 아이콘 + 라벨 ────────────────────────────────────────────

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

function eventLabel(event: TimelineEvent): string {
  switch (event.event_type) {
    case "spawn":     return "spawn";
    case "kill":      return "종료";
    case "comm": {
      const preview = event.message
        ? event.message.length > 40
          ? event.message.slice(0, 40) + "…"
          : event.message
        : "";
      return `→ ${event.to_agent ?? "?"} ${preview ? `"${preview}"` : ""}`;
    }
    case "thinking":  return "thinking...";
    case "executing": return `${event.tool ?? "?"} 실행 중`;
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

// ─── TimelineRow ─────────────────────────────────────────────────────────────

interface TimelineRowProps {
  event: TimelineEvent;
  colorIdx: number;
}

function TimelineRow({ event, colorIdx }: TimelineRowProps) {
  const dotColor = AGENT_DOT_COLORS[colorIdx % AGENT_DOT_COLORS.length];
  const tagColor = AGENT_COLORS[colorIdx % AGENT_COLORS.length];

  return (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-white/5 transition-colors text-xs font-mono">
      {/* 시간 */}
      <span className="text-gray-500 flex-shrink-0 w-16 pt-0.5">
        {formatTime(event.timestamp)}
      </span>

      {/* 이벤트 아이콘 */}
      <span className="flex-shrink-0 text-sm leading-none pt-0.5">
        {eventIcon(event.event_type)}
      </span>

      {/* 에이전트 이름 태그 */}
      <span
        className={`flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] ${tagColor}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        {event.agent_name || event.from_agent || "?"}
      </span>

      {/* 이벤트 라벨 */}
      <span className="text-gray-300 flex-1 min-w-0 truncate pt-0.5">
        {eventLabel(event)}
      </span>
    </div>
  );
}

// ─── Timeline 메인 컴포넌트 ──────────────────────────────────────────────────

interface TimelineProps {
  events: TimelineEvent[];
  agents: AgentInfo[];
}

export default function Timeline({ events, agents }: TimelineProps) {
  const [filterAgent, setFilterAgent] = useState<string>("");
  const colorMap = useAgentColorMap(events);

  // 에이전트 이름 목록 (필터 드롭다운용)
  const agentNames = useMemo(() => {
    const names = new Set<string>();
    for (const e of events) {
      if (e.agent_name) names.add(e.agent_name);
      if (e.from_agent) names.add(e.from_agent);
    }
    // 현재 살아있는 에이전트도 포함
    for (const a of agents) names.add(a.name);
    return Array.from(names).sort();
  }, [events, agents]);

  // 필터 적용
  const filtered = useMemo(() => {
    if (!filterAgent) return events;
    return events.filter(
      (e) => e.agent_name === filterAgent || e.from_agent === filterAgent || e.to_agent === filterAgent
    );
  }, [events, filterAgent]);

  return (
    <div className="flex flex-col h-full gap-2">
      {/* 헤더 + 필터 */}
      <div className="flex items-center gap-3 px-1 flex-shrink-0">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest flex-1">
          전체 타임라인
        </h2>
        <span className="text-xs text-gray-500 font-mono">{filtered.length}개</span>

        {/* 에이전트 필터 */}
        <select
          value={filterAgent}
          onChange={(e) => setFilterAgent(e.target.value)}
          className="text-xs bg-white/10 text-gray-300 border border-white/20 rounded px-2 py-1 outline-none focus:border-white/40"
        >
          <option value="">전체 에이전트</option>
          {agentNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {/* 타임라인 리스트 */}
      <div
        className="flex-1 min-h-0 rounded-xl border border-white/10 bg-white/5 p-2 overflow-y-auto flex flex-col gap-0"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
      >
        {filtered.length === 0 ? (
          <div className="text-gray-600 text-xs text-center py-8">이벤트 없음</div>
        ) : (
          filtered.map((event) => {
            const name = event.agent_name || event.from_agent || "";
            const colorIdx = colorMap.get(name) ?? 0;
            return (
              <TimelineRow key={event.id} event={event} colorIdx={colorIdx} />
            );
          })
        )}
      </div>
    </div>
  );
}
