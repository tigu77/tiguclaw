"use client";

import { useEffect, useState, useCallback } from "react";

export interface ConversationSummary {
  id: string;
  agent_name: string;
  message_count: number;
  last_message: string;
  last_message_role: string;
  updated_at: number;
}

interface ConversationListProps {
  onSelect: (id: string, agentName: string) => void;
  selectedId: string | null;
  apiBase: string;
}

function formatTime(unixSecs: number): string {
  if (!unixSecs) return "-";
  const d = new Date(unixSecs * 1000);
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function ConversationList({ onSelect, selectedId, apiBase }: ConversationListProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/conversations`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConversations(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로드 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 30_000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        대화 이력 로딩 중...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <span className="text-red-400 text-sm">⚠ {error}</span>
        <button
          onClick={fetchConversations}
          className="text-xs text-gray-400 hover:text-white border border-white/10 px-3 py-1 rounded-lg transition-colors"
        >
          재시도
        </button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        대화 이력 없음
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-1 overflow-y-auto"
      style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
    >
      {conversations.map((conv) => {
        const isSelected = conv.id === selectedId;
        return (
          <button
            key={conv.id}
            onClick={() => onSelect(conv.id, conv.agent_name)}
            className={`flex flex-col gap-1 px-3 py-2.5 rounded-lg border text-left transition-colors ${
              isSelected
                ? "border-blue-500/50 bg-blue-500/10"
                : "border-white/10 bg-white/5 hover:bg-white/10"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-mono text-white truncate">
                정태님 <span className="text-gray-500">↔</span> {conv.agent_name}
              </span>
              <span className="text-xs text-gray-500 flex-shrink-0 font-mono">
                {formatTime(conv.updated_at)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">
                {conv.message_count}개 메시지
              </span>
              {conv.last_message && (
                <>
                  <span className="text-gray-600">·</span>
                  <span className="text-xs text-gray-400 truncate max-w-[200px]">
                    {conv.last_message_role === "user" ? "👤 정태님" : `🤖 ${conv.agent_name}`}:{" "}
                    {conv.last_message.slice(0, 50)}
                    {conv.last_message.length > 50 ? "…" : ""}
                  </span>
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
