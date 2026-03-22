"use client";

import { AgentInfo } from "@/types";

const ROLE_ICONS: Record<string, string> = {
  supermaster: "🌟",
  L0: "🌟",
  master: "⚡",
  L1: "⚡",
  mini: "🤖",
  L2: "🤖",
  worker: "🔧",
  L3: "🔧",
};

const ROLE_LABELS: Record<string, string> = {
  supermaster: "슈퍼마스터",
  L0: "슈퍼마스터",
  master: "마스터",
  L1: "마스터",
  mini: "미니",
  L2: "미니",
  worker: "워커",
};

interface AgentCardProps {
  agent: AgentInfo;
  selected?: boolean;
  onClick?: () => void;
}

export default function AgentCard({ agent, selected, onClick }: AgentCardProps) {
  const icon = ROLE_ICONS[agent.role] ?? "❓";
  const label = ROLE_LABELS[agent.role] ?? agent.role;

  const currentStatus = agent.current_status ?? "idle";
  const isThinking = currentStatus === "thinking";
  const isExecuting = currentStatus.startsWith("executing:");
  const toolName = isExecuting ? currentStatus.split(":").slice(1).join(":") : "";

  return (
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
        <div className="text-xs text-gray-400">{label}</div>
        {(isThinking || isExecuting) && (
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            {isExecuting ? `🔧 ${toolName} 실행 중` : "💭 생각 중..."}
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
  );
}
