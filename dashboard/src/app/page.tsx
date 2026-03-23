"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useDashboard } from "@/hooks/useDashboard";
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

const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 500;
const DEFAULT_PANEL_WIDTH = 256;
const PANEL_WIDTH_KEY = "agentPanelWidth";

export default function DashboardPage() {
  const { agents, logs, connected, timelineEvents, agentIdleCount } = useDashboard(WS_URL);
  const [activeTab, setActiveTab] = useState<Tab>("agents");
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [teamFilter, setTeamFilter] = useState<string>("전체");
  const [lastMessageMap, setLastMessageMap] = useState<Record<string, string>>({});

  // 리사이즈 패널 너비
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const saved = localStorage.getItem(PANEL_WIDTH_KEY);
    if (saved) {
      const n = parseInt(saved, 10);
      if (!isNaN(n) && n >= MIN_PANEL_WIDTH && n <= MAX_PANEL_WIDTH) return n;
    }
    return DEFAULT_PANEL_WIDTH;
  });
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

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

  useEffect(() => {
    if (agentIdleCount > 0) fetchLastMessages();
  }, [agentIdleCount, fetchLastMessages]);

  // 리사이즈 핸들러
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = ev.clientX - resizeStartX.current;
      const newWidth = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, resizeStartWidth.current + delta)
      );
      setPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      setPanelWidth((w) => {
        localStorage.setItem(PANEL_WIDTH_KEY, String(w));
        return w;
      });
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [panelWidth]);

  const handleAgentClick = (name: string) => {
    setSelectedAgent((prev) => (prev === name ? null : name));
  };

  return (
    <div className="flex h-screen" style={{ background: "#0a0a0a" }}>
      {/* 왼쪽 사이드바 — 데스크탑만 */}
      <div className="hidden md:flex">
        <Sidebar
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
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
            <div className="flex h-full gap-0">
              {/* 에이전트 트리 패널 (리사이즈 가능) */}
              <div
                className="flex flex-col gap-2 flex-shrink-0"
                style={{ width: `${panelWidth}px` }}
              >
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                    에이전트 군단
                  </h2>
                  <span className="text-xs text-gray-500 font-mono">{filteredAgents.length}개</span>
                </div>

                {/* 팀 필터 탭 */}
                {teams.length > 1 && (
                  <div
                    className="flex overflow-x-auto"
                    style={{
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                      scrollbarWidth: "none",
                      gap: 0,
                    }}
                  >
                    {teams.map((team) => {
                      const isActive = teamFilter === team;
                      return (
                        <button
                          key={team}
                          onClick={() => setTeamFilter(team)}
                          style={{
                            flexShrink: 0,
                            fontSize: "11px",
                            padding: "5px 10px",
                            fontFamily: "monospace",
                            background: "transparent",
                            border: "none",
                            borderBottom: isActive
                              ? "2px solid #a78bfa"
                              : "2px solid transparent",
                            color: isActive ? "#c4b5fd" : "#6b7280",
                            cursor: "pointer",
                            transition: "color 0.12s, border-color 0.12s",
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => {
                            if (!isActive) (e.currentTarget as HTMLElement).style.color = "#d1d5db";
                          }}
                          onMouseLeave={(e) => {
                            if (!isActive) (e.currentTarget as HTMLElement).style.color = "#6b7280";
                          }}
                        >
                          {team === "전체" ? "전체" : team}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div
                  className="flex flex-col gap-1.5 overflow-y-auto flex-1"
                  style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
                >
                  <AgentTree
                    agents={filteredAgents}
                    selected={selectedAgent ?? undefined}
                    onSelect={(name) => handleAgentClick(name)}
                  />
                </div>
              </div>

              {/* 리사이즈 핸들 */}
              <div
                onMouseDown={handleResizeMouseDown}
                style={{
                  width: "6px",
                  flexShrink: 0,
                  cursor: "col-resize",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 2px",
                  borderRadius: "3px",
                  transition: "background 0.12s",
                }}
                className="hover:bg-white/10 active:bg-white/20"
                title="드래그해서 패널 너비 조절"
              >
                <div
                  style={{
                    width: "2px",
                    height: "40px",
                    borderRadius: "1px",
                    background: "rgba(255,255,255,0.12)",
                  }}
                />
              </div>

              {/* 에이전트 타임라인 패널 or 실시간 로그 */}
              {selectedAgent ? (
                <div className="flex-1 min-h-0 min-w-0 rounded-xl border border-white/10 bg-white/5 overflow-hidden ml-2">
                  <AgentTimelinePanel
                    agentName={selectedAgent}
                    agentInfo={agents.find((a) => a.name === selectedAgent)}
                    allTimelineEvents={timelineEvents}
                    apiBase={API_BASE}
                    onClose={() => setSelectedAgent(null)}
                  />
                </div>
              ) : (
                <div className="hidden md:flex flex-col flex-1 min-h-0 gap-2 ml-2">
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
