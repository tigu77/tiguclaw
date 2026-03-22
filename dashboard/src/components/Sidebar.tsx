"use client";

export type Tab = "agents" | "conversations" | "logs" | "timeline";

interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  connected: boolean;
  agentCount: number;
}

const NAV_ITEMS: { id: Tab; icon: string; label: string }[] = [
  { id: "agents", icon: "🤖", label: "에이전트" },
  { id: "timeline", icon: "🕐", label: "타임라인" },
  { id: "conversations", icon: "💬", label: "대화" },
  { id: "logs", icon: "📋", label: "로그" },
];

export default function Sidebar({
  activeTab,
  onTabChange,
  connected,
  agentCount,
}: SidebarProps) {
  return (
    <aside className="flex flex-col w-56 flex-shrink-0 border-r border-white/10 bg-white/5">
      {/* 로고 */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
        <span className="text-2xl">🐯</span>
        <div>
          <div className="text-sm font-bold text-white tracking-tight">tiguclaw</div>
          <div className="text-xs text-gray-500">대시보드</div>
        </div>
      </div>

      {/* 네비게이션 */}
      <nav className="flex flex-col gap-1 px-3 py-4 flex-1">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
                isActive
                  ? "bg-white/10 text-white"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "agents" && agentCount > 0 && (
                <span className="ml-auto text-xs bg-white/10 text-gray-300 rounded-full px-1.5 py-0.5 font-mono">
                  {agentCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* 하단: 연결 상태 */}
      <div className="px-4 py-4 border-t border-white/10">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
              connected
                ? "bg-green-400 shadow-[0_0_6px_#4ade80]"
                : "bg-red-500 shadow-[0_0_6px_#f87171]"
            }`}
          />
          <span
            className={`text-xs font-mono ${connected ? "text-green-400" : "text-red-400"}`}
          >
            {connected ? "연결됨" : "연결 끊김"}
          </span>
        </div>
      </div>
    </aside>
  );
}
