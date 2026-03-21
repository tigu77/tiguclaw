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
}

export default function AgentCard({ agent }: AgentCardProps) {
  const icon = ROLE_ICONS[agent.role] ?? "❓";
  const label = ROLE_LABELS[agent.role] ?? agent.role;

  const currentStatus = agent.current_status ?? "idle";
  const isThinking = currentStatus === "thinking";
  const isExecuting = currentStatus.startsWith("executing:");
  const toolName = isExecuting ? currentStatus.split(":").slice(1).join(":") : "";

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors border border-white/10">
      <span className="text-xl leading-none">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-mono text-white truncate">{agent.name}</div>
        <div className="text-xs text-gray-400">{label} • Lv.{agent.level}</div>
        {(isThinking || isExecuting) && (
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            {isExecuting ? `🔧 ${toolName} 실행 중` : "💭 생각 중..."}
          </div>
        )}
      </div>
      <div className="flex-shrink-0">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            agent.status === "active"
              ? "bg-green-400 shadow-[0_0_6px_#4ade80]"
              : agent.status === "dead"
              ? "bg-red-500"
              : "bg-yellow-400"
          }`}
        />
      </div>
    </div>
  );
}
