"use client";

import { useEffect, useState } from "react";
import { AgentInfo, TimelineEvent } from "@/types";
import { ConversationSummary } from "@/components/ConversationList";
import ConversationDetail from "@/components/ConversationDetail";

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

function formatConvTime(unixSecs: number): string {
  if (!unixSecs) return "-";
  const now = Date.now();
  const diffMs = now - unixSecs * 1000;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffHour < 24) return `${diffHour}시간 전`;
  if (diffDay < 30) return `${diffDay}일 전`;
  const d = new Date(unixSecs * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ─── 에이전트 정보 카드 ───────────────────────────────────────────────────────

const TIER_LABEL: Record<number, string> = {
  0: "T0 · 총괄",
  1: "T1 · 책임자",
  2: "T2 · 전문가",
  3: "T3 · 실무",
};

function statusDot(status?: string): { dot: string; label: string } {
  const s = status ?? "idle";
  if (s === "thinking")
    return { dot: "🔵", label: "thinking" };
  if (s.startsWith("executing:"))
    return { dot: "🟡", label: `executing: ${s.split(":").slice(1).join(":")}` };
  return { dot: "⚪", label: "idle" };
}

// ─── 탭 타입 ─────────────────────────────────────────────────────────────────

type PanelTab = "info" | "logs" | "conversations";

// ─── AgentTimelinePanel ──────────────────────────────────────────────────────

interface AgentTimelinePanelProps {
  agentName: string;
  agentInfo?: AgentInfo;
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
  const [activeTab, setActiveTab] = useState<PanelTab>("info");
  const [initialEvents, setInitialEvents] = useState<TimelineEvent[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [convsLoading, setConvsLoading] = useState(false);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);

  // 최초 로드 — REST API에서 에이전트 타임라인 가져오기
  useEffect(() => {
    setLogsLoading(true);
    fetch(`${apiBase}/api/agents/${encodeURIComponent(agentName)}/timeline`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: TimelineEvent[]) => setInitialEvents(data))
      .catch(() => setInitialEvents([]))
      .finally(() => setLogsLoading(false));
  }, [agentName, apiBase]);

  // 대화 탭 선택 시 conversations 로드
  useEffect(() => {
    if (activeTab !== "conversations") return;
    setConvsLoading(true);
    setSelectedConvId(null);
    fetch(`${apiBase}/api/conversations`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: ConversationSummary[]) => {
        const filtered = data.filter((c) => c.agent_name === agentName);
        filtered.sort((a, b) => b.updated_at - a.updated_at);
        setConversations(filtered);
      })
      .catch(() => setConversations([]))
      .finally(() => setConvsLoading(false));
  }, [activeTab, agentName, apiBase]);

  // WS 실시간 이벤트 중 이 에이전트 관련 것만 필터링
  const wsEvents = allTimelineEvents.filter(
    (e) =>
      e.id < 0 &&
      (e.agent_name === agentName ||
        e.from_agent === agentName ||
        e.to_agent === agentName)
  );

  const combined = [...wsEvents, ...initialEvents];

  // Kill 핸들러
  const handleKill = () => {
    const displayName = agentInfo?.nickname ?? agentName;
    if (!confirm(`"${displayName}" 에이전트를 종료하시겠습니까?`)) return;
    fetch(`${apiBase}/api/agents/${encodeURIComponent(agentName)}/kill`, {
      method: "POST",
    }).catch(console.error);
  };

  const tier = agentInfo?.tier ?? agentInfo?.level ?? 1;
  const { dot, label: statusLabel } = statusDot(agentInfo?.current_status);
  const tierLabel = TIER_LABEL[tier] ?? `T${tier}`;

  const tabs: { id: PanelTab; label: string }[] = [
    { id: "info", label: "정보" },
    { id: "logs", label: "로그" },
    { id: "conversations", label: "대화" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* 패널 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <div>
          <div className="text-sm font-bold text-white font-mono">
            {agentInfo?.nickname ?? agentName}
          </div>
          {agentInfo?.nickname && (
            <div className="text-xs text-gray-500 font-mono">({agentName})</div>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white transition-colors text-lg leading-none"
          title="닫기"
        >
          ✕
        </button>
      </div>

      {/* 탭 네비게이션 */}
      <div
        className="flex flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                fontSize: "12px",
                padding: "8px 0",
                fontFamily: "monospace",
                background: "transparent",
                border: "none",
                borderBottom: isActive
                  ? "2px solid #a78bfa"
                  : "2px solid transparent",
                color: isActive ? "#c4b5fd" : "#6b7280",
                cursor: "pointer",
                transition: "color 0.12s, border-color 0.12s",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 탭 콘텐츠 */}
      <div className="flex-1 min-h-0 overflow-hidden">

        {/* ── 정보 탭 ── */}
        {activeTab === "info" && (
          <div
            className="h-full overflow-y-auto p-3"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
          >
            {agentInfo ? (
              <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 flex flex-col gap-2 text-xs font-mono">
                {/* 이름 */}
                <div className="text-sm font-bold text-white">
                  {agentInfo.nickname ?? agentInfo.name}
                </div>
                {agentInfo.nickname && (
                  <div className="text-xs text-gray-500">({agentInfo.name})</div>
                )}
                <div className="border-t border-white/10" />
                {/* 속성 목록 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-400">
                  <span className="text-gray-600">티어</span>
                  <span className="text-gray-200">{tierLabel}</span>

                  <span className="text-gray-600">팀</span>
                  <span className="text-gray-200">{agentInfo.team ?? "—"}</span>

                  <span className="text-gray-600">채널</span>
                  <span className="text-gray-200">{agentInfo.channel_type}</span>

                  <span className="text-gray-600">상태</span>
                  <span className="text-gray-200">
                    {dot} {statusLabel}
                  </span>

                  <span className="text-gray-600">clearance</span>
                  <span className="text-gray-200">{agentInfo.clearance ?? "full"}</span>
                </div>

                {/* 에이전트 종료 버튼 — T0 제외 */}
                {tier > 0 && (
                  <>
                    <div className="border-t border-white/10 mt-1" />
                    <button
                      onClick={handleKill}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "6px",
                        border: "1px solid rgba(239,68,68,0.5)",
                        background: "rgba(239,68,68,0.1)",
                        color: "#f87171",
                        fontSize: "12px",
                        cursor: "pointer",
                        fontFamily: "monospace",
                        fontWeight: "bold",
                        transition: "background 0.12s, border-color 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.2)";
                        (e.currentTarget as HTMLElement).style.borderColor = "rgba(239,68,68,0.8)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.1)";
                        (e.currentTarget as HTMLElement).style.borderColor = "rgba(239,68,68,0.5)";
                      }}
                    >
                      ⛔ 에이전트 종료
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="text-gray-600 text-xs text-center py-8">에이전트 정보 없음</div>
            )}
          </div>
        )}

        {/* ── 로그 탭 ── */}
        {activeTab === "logs" && (
          <div
            className="h-full overflow-y-auto p-3 flex flex-col gap-0"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
          >
            {logsLoading ? (
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
        )}

        {/* ── 대화 탭 ── */}
        {activeTab === "conversations" && (
          <div className="flex h-full">
            {/* 대화 목록 */}
            <div
              className={`flex flex-col overflow-y-auto p-2 gap-2 flex-shrink-0 ${
                selectedConvId ? "w-48 border-r border-white/10" : "flex-1"
              }`}
              style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
            >
              {convsLoading ? (
                <div className="text-gray-600 text-xs text-center py-8 animate-pulse">로딩 중...</div>
              ) : conversations.length === 0 ? (
                <div className="text-gray-600 text-xs text-center py-8">대화 없음</div>
              ) : (
                conversations.map((conv) => {
                  const isSelected = conv.id === selectedConvId;
                  return (
                    <button
                      key={conv.id}
                      onClick={() => setSelectedConvId(isSelected ? null : conv.id)}
                      className={`flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border text-left transition-all duration-150 ${
                        isSelected
                          ? "border-blue-500/60 bg-blue-500/15"
                          : "border-white/10 bg-white/5 hover:bg-white/10"
                      }`}
                    >
                      {/* 상단: 아이콘 + initiator + 상대 시간 */}
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-sm font-medium text-gray-200 truncate">
                          {conv.initiator === "user" ? "👤 정태님" : `🤖 ${conv.initiator}`}
                        </span>
                        <span className="text-[10px] text-gray-500 flex-shrink-0">
                          {formatConvTime(conv.updated_at)}
                        </span>
                      </div>
                      {/* 중단: 메시지 수 pill */}
                      <div>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/10 text-[10px] text-gray-400">
                          💬 {conv.message_count}개 메시지
                        </span>
                      </div>
                      {/* 하단: last_message 미리보기 */}
                      {conv.last_message && (
                        <div className="text-[11px] text-gray-500 italic truncate">
                          &ldquo;{conv.last_message.slice(0, 35)}{conv.last_message.length > 35 ? "…" : ""}&rdquo;
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* 대화 상세 */}
            {selectedConvId && (
              <div className="flex-1 min-w-0 overflow-hidden">
                <ConversationDetail
                  chatId={selectedConvId}
                  agentName={agentName}
                  agentStatus={agentInfo?.current_status}
                  onClose={() => setSelectedConvId(null)}
                  apiBase={apiBase}
                  refreshTrigger={0}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
