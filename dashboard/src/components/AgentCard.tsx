"use client";

import { AgentInfo } from "@/types";

const TIER_ICONS: Record<number, string> = {
  0: "🌟",
  1: "⚡",
  2: "🤖",
  3: "🔧",
};

const TIER_LABELS: Record<number, string> = {
  0: "T0 · 총괄",
  1: "T1 · 책임자",
  2: "T2 · 전문가",
  3: "T3 · 실무",
};

interface AgentCardProps {
  agent: AgentInfo;
  selected?: boolean;
  onClick?: () => void;
  lastMessage?: string;
  onKill?: (name: string) => void;
}

export default function AgentCard({ agent, selected, onClick, lastMessage, onKill }: AgentCardProps) {
  const tier = agent.tier ?? agent.level ?? 1;
  const icon = TIER_ICONS[tier] ?? "❓";
  const label = TIER_LABELS[tier] ?? `T${tier}`;

  const currentStatus = agent.current_status ?? "idle";
  const isThinking = currentStatus === "thinking";
  const isExecuting = currentStatus.startsWith("executing:");
  const toolName = isExecuting ? currentStatus.split(":").slice(1).join(":") : "";

  // 슈퍼마스터(T0)는 kill 버튼 미표시
  const canKill = tier !== 0 && !!onKill;

  const handleKill = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onKill) return;
    const displayName = agent.nickname ?? agent.name;
    if (window.confirm(`"${displayName}"을(를) 종료하시겠습니까?`)) {
      onKill(agent.name);
    }
  };

  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors border text-left ${
          selected
            ? "bg-white/15 border-white/30 ring-1 ring-white/20"
            : "bg-white/5 hover:bg-white/10 border-white/10"
        }`}
      >
        <span className="text-xl leading-none">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-mono text-white truncate">
            {agent.nickname ?? agent.name}
          </div>
          {agent.nickname && (
            <div className="text-xs text-gray-500 font-mono truncate">({agent.name})</div>
          )}
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-xs text-gray-400">{label}</span>
            {agent.team && (
              <span className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">
                📦 {agent.team}
              </span>
            )}
          </div>
          {(isThinking || isExecuting) && (
            <div className="text-xs text-gray-400 mt-0.5 truncate">
              {isExecuting ? `🔧 ${toolName} 실행 중` : "💭 생각 중..."}
            </div>
          )}
          {lastMessage && !isThinking && !isExecuting && (
            <div className="text-xs text-gray-500 mt-0.5 truncate italic">
              {lastMessage.slice(0, 40)}{lastMessage.length > 40 ? "…" : ""}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              agent.status === "active"
                ? "bg-green-400 shadow-[0_0_6px_#4ade80]"
                : agent.status === "dead"
                ? "bg-red-500"
                : "bg-yellow-400"
            }`}
          />
          {onClick && (
            <span className="text-[10px] text-gray-600">타임라인 →</span>
          )}
        </div>
      </button>

      {/* Kill 버튼 — hover 시 표시, 슈퍼마스터(T0) 제외 */}
      {canKill && (
        <button
          onClick={handleKill}
          title={`${agent.nickname ?? agent.name} 종료`}
          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity
                     w-6 h-6 flex items-center justify-center rounded
                     text-red-400 hover:text-red-300 hover:bg-red-500/20
                     text-xs leading-none"
        >
          ✕
        </button>
      )}
    </div>
  );
}
