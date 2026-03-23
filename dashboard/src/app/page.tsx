"use client";

import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "@/hooks/useDashboard";
import AgentCard from "@/components/AgentCard";
import AgentTree from "@/components/AgentTree";
import AgentTimelinePanel from "@/components/AgentTimelinePanel";
import LogStream from "@/components/LogStream";
import ConversationList, { ConversationSummary } from "@/components/ConversationList";
import ConversationDetail from "@/components/ConversationDetail";
import Sidebar, { Tab } from "@/components/Sidebar";

// 접속한 호스트 기준으로 WS URL 동적 생성 (포트 통일 — server.js가 /ws를 3002로 proxy)
const WS_URL =
  typeof window !== "undefined"
    ? `ws://${window.location.host}/ws`
    : "ws://localhost:3000/ws";

const API_BASE =
  typeof window !== "undefined"
    ? `http://${window.location.host}`
    : "http://localhost:3000";

const BOTTOM_NAV: { id: Tab; icon: string; label: string }[] = [
  { id: "agents", icon: "🤖", label: "에이전트" },
  { id: "conversations", icon: "💬", label: "대화" },
  { id: "logs", icon: "📋", label: "로그" },
];

export default function DashboardPage() {
  const { agents, logs, connected, timelineEvents, agentIdleCount } = useDashboard(WS_URL);
  const [activeTab, setActiveTab] = useState<Tab>("agents");
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [agentViewMode, setAgentViewMode] = useState<"list" | "tree">("list");
  const [teamFilter, setTeamFilter] = useState<string>("전체");
  const [lastMessageMap, setLastMessageMap] = useState<Record<string, string>>({});

  // 팀 목록 동적 수집
  const teams = ["전체", ...Array.from(new Set(agents.map((a) => a.team).filter(Boolean) as string[])).sort()];

  // 팀 필터 적용
  const filteredAgents = teamFilter === "전체"
    ? agents
    : agents.filter((a) => a.team === teamFilter);

  // conversations 데이터 주기적으로 fetch → agentName별 마지막 user 메시지 맵 생성
  const fetchLastMessages = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/conversations`);
      if (!res.ok) return;
      const data: ConversationSummary[] = await res.json();
      // 각 에이전트의 최신 user 메시지만 추출 (updated_at 기준 최신 1개)
      const map: Record<string, string> = {};
      const sorted = [...data].sort((a, b) => b.updated_at - a.updated_at);
      for (const conv of sorted) {
        if (!map[conv.agent_name] && conv.last_message_role === "user" && conv.last_message) {
          map[conv.agent_name] = conv.last_message;
        }
      }
      setLastMessageMap(map);
    } catch {
      // 조용히 무시
    }
  }, []);

  useEffect(() => {
    fetchLastMessages();
    const timer = setInterval(fetchLastMessages, 30_000);
    return () => clearInterval(timer);
  }, [fetchLastMessages]);

  // agentIdleCount 변경 시 (에이전트가 작업 완료) 메시지 갱신
  useEffect(() => {
    if (agentIdleCount > 0) fetchLastMessages();
  }, [agentIdleCount, fetchLastMessages]);

  const handleAgentClick = (name: string) => {
    setSelectedAgent((prev) => (prev === name ? null : name));
  };

  const handleKillAgent = useCallback(async (name: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const data = await res.json() as { ok: boolean; name?: string; error?: string };
      if (!data.ok) {
        alert(`종료 실패: ${data.error ?? "알 수 없는 오류"}`);
      } else {
        // 종료된 에이전트가 선택된 상태면 패널 닫기
        setSelectedAgent((prev) => (prev === name ? null : prev));
      }
    } catch {
      alert("종료 요청 중 오류가 발생했습니다.");
    }
  }, []);

  return (
    <div className="flex h-screen" style={{ background: "#0a0a0a" }}>
      {/* 왼쪽 사이드바 — 데스크탑만 */}
      <div className="hidden md:flex">
        <Sidebar
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
            // 타임라인 탭 이동 시 에이전트 패널 닫기
            if (tab !== "agents") setSelectedAgent(null);
          }}
          connected={connected}
          agentCount={agents.length}
        />
      </div>

      {/* 오른쪽 메인 콘텐츠 */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {/* 모바일 헤더 */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5">
          <div className="flex items-center gap-2">
            <span className="text-xl">🐯</span>
            <span className="text-sm font-bold text-white">tiguclaw</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                connected
                  ? "bg-green-400 shadow-[0_0_6px_#4ade80]"
                  : "bg-red-500 shadow-[0_0_6px_#f87171]"
              }`}
            />
            <span className={`text-xs font-mono ${connected ? "text-green-400" : "text-red-400"}`}>
              {connected ? "연결됨" : "연결 끊김"}
            </span>
          </div>
        </header>

        {/* 콘텐츠 영역 */}
        <div className="flex-1 min-h-0 p-4 overflow-hidden">

          {/* 🤖 에이전트 */}
          {activeTab === "agents" && (
            <div className="flex h-full gap-4">
              {/* 에이전트 목록 */}
              <div className="flex flex-col gap-2 flex-shrink-0 w-64">
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                    에이전트 군단
                  </h2>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 font-mono">{filteredAgents.length}개</span>
                    {/* 리스트 / 트리 토글 */}
                    <div className="flex rounded-md overflow-hidden border border-white/10 text-[11px]">
                      <button
                        onClick={() => setAgentViewMode("list")}
                        className={`px-2 py-0.5 transition-colors ${
                          agentViewMode === "list"
                            ? "bg-white/20 text-white"
                            : "text-gray-500 hover:text-gray-300"
                        }`}
                        title="리스트 뷰"
                      >
                        🔲
                      </button>
                      <button
                        onClick={() => setAgentViewMode("tree")}
                        className={`px-2 py-0.5 transition-colors ${
                          agentViewMode === "tree"
                            ? "bg-white/20 text-white"
                            : "text-gray-500 hover:text-gray-300"
                        }`}
                        title="트리 뷰"
                      >
                        🌲
                      </button>
                    </div>
                  </div>
                </div>

                {/* 팀 필터 버튼 */}
                {teams.length > 1 && (
                  <div className="flex flex-wrap gap-1 px-1">
                    {teams.map((team) => (
                      <button
                        key={team}
                        onClick={() => setTeamFilter(team)}
                        className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                          teamFilter === team
                            ? "bg-purple-500/30 border-purple-400/50 text-purple-300"
                            : "border-white/10 text-gray-500 hover:text-gray-300 hover:border-white/20"
                        }`}
                      >
                        {team === "전체" ? "전체" : `📦 ${team}`}
                      </button>
                    ))}
                  </div>
                )}

                <div
                  className="flex flex-col gap-1.5 overflow-y-auto flex-1"
                  style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
                >
                  {agentViewMode === "tree" ? (
                    <AgentTree
                      agents={filteredAgents}
                      selected={selectedAgent ?? undefined}
                      onSelect={(name) => handleAgentClick(name)}
                    />
                  ) : filteredAgents.length === 0 ? (
                    <div className="text-gray-600 text-xs text-center py-8">에이전트 없음</div>
                  ) : (
                    filteredAgents.map((agent) => (
                      <AgentCard
                        key={agent.name}
                        agent={agent}
                        selected={selectedAgent === agent.name}
                        onClick={() => handleAgentClick(agent.name)}
                        lastMessage={lastMessageMap[agent.name]}
                        onKill={handleKillAgent}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* 에이전트 타임라인 패널 (클릭 시 표시) */}
              {selectedAgent ? (
                <div className="flex-1 min-h-0 min-w-0 rounded-xl border border-white/10 bg-white/5 overflow-hidden">
                  <AgentTimelinePanel
                    agentName={selectedAgent}
                    agentInfo={agents.find((a) => a.name === selectedAgent)}
                    allTimelineEvents={timelineEvents}
                    apiBase={API_BASE}
                    onClose={() => setSelectedAgent(null)}
                  />
                </div>
              ) : (
                /* 에이전트 선택 전 — 실시간 로그 표시 (데스크탑) */
                <div className="hidden md:flex flex-col flex-1 min-h-0 gap-2">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                      실시간 로그
                    </h2>
                    <span className="text-xs text-gray-500 font-mono">{logs.length}/100</span>
                  </div>
                  <div className="flex-1 min-h-0 rounded-xl border border-white/10 bg-white/5 p-3 flex flex-col">
                    <LogStream logs={logs} apiBase={API_BASE} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 💬 대화 */}
          {activeTab === "conversations" && (
            <div className="flex h-full gap-4">
              <div
                className={`flex flex-col gap-2 ${
                  selectedConvId ? "w-72 flex-shrink-0" : "flex-1"
                }`}
              >
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                    대화 이력
                  </h2>
                </div>
                <div className="flex-1 min-h-0 rounded-xl border border-white/10 bg-white/5 p-3 overflow-hidden">
                  <ConversationList
                    onSelect={(id, agentName) => { setSelectedConvId(id); setSelectedAgentName(agentName); }}
                    selectedId={selectedConvId}
                    apiBase={API_BASE}
                  />
                </div>
              </div>
              {selectedConvId && (
                <div className="flex-1 min-h-0 min-w-0">
                  <ConversationDetail
                    chatId={selectedConvId}
                    agentName={selectedAgentName}
                    agentStatus={agents.find(a => a.name === selectedAgentName)?.current_status}
                    onClose={() => setSelectedConvId(null)}
                    apiBase={API_BASE}
                    refreshTrigger={agentIdleCount}
                  />
                </div>
              )}
            </div>
          )}

          {/* 📋 로그 */}
          {activeTab === "logs" && (
            <div className="flex flex-col h-full gap-2">
              <div className="flex items-center px-1">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                  이벤트 로그
                </h2>
              </div>
              <div className="flex-1 flex flex-col min-h-0 rounded-xl border border-white/10 bg-white/5 p-3">
                <LogStream logs={logs} apiBase={API_BASE} />
              </div>
            </div>
          )}
        </div>

        {/* 모바일 하단 탭바 */}
        <nav className="md:hidden flex border-t border-white/10 bg-white/5">
          {BOTTOM_NAV.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
                  isActive ? "text-white" : "text-gray-500"
                }`}
              >
                <span className="text-lg leading-none">{item.icon}</span>
                <span>{item.label}</span>
                {isActive && (
                  <span className="absolute bottom-0 w-8 h-0.5 bg-white rounded-full" />
                )}
              </button>
            );
          })}
        </nav>
      </main>
    </div>
  );
}
