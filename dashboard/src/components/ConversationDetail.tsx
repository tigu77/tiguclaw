"use client";

import { useEffect, useRef, useState } from "react";

interface MessageItem {
  role: string;
  content: string;
  timestamp: number;
}

interface ConversationDetailData {
  id: string;
  agent_name: string;
  messages: MessageItem[];
}

interface ConversationDetailProps {
  chatId: string;
  agentName: string;
  onClose: () => void;
  apiBase: string;
  refreshTrigger?: number;
}

function formatTs(unixSecs: number): string {
  if (!unixSecs) return "";
  const d = new Date(unixSecs * 1000);
  return d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function ConversationDetail({ chatId, agentName, onClose, apiBase, refreshTrigger }: ConversationDetailProps) {
  const [data, setData] = useState<ConversationDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchConversation = () => {
    fetch(`${apiBase}/api/conversations/${encodeURIComponent(chatId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: ConversationDetailData) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "로드 실패");
        setLoading(false);
      });
  };

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError(null);
    fetchConversation();
  }, [chatId]);

  // AgentIdle 이벤트 시 자동 갱신 (refreshTrigger 변경 감지)
  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    fetchConversation();
  }, [refreshTrigger]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput("");

    try {
      const res = await fetch(`${apiBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: agentName, message: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 즉시 user 메시지 UI에 추가
      setData(prev => prev ? {
        ...prev,
        messages: [...prev.messages, {
          role: "user",
          content: text,
          timestamp: Math.floor(Date.now() / 1000),
        }]
      } : prev);
    } catch (e) {
      console.error("sendMessage error:", e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full border border-white/10 rounded-xl bg-white/5 overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 bg-white/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base">💬</span>
          <span className="text-sm font-mono text-white truncate max-w-[200px]">{chatId}</span>
          {data && (
            <span className="text-xs text-gray-500 font-mono">({data.messages.length}개)</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-lg leading-none px-1 transition-colors"
          aria-label="닫기"
        >
          ×
        </button>
      </div>

      {/* 메시지 영역 */}
      <div
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
      >
        {loading && (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            로딩 중...
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full text-red-400 text-sm">
            ⚠ {error}
          </div>
        )}
        {data?.messages.map((msg, idx) => {
          const isUser = msg.role === "user";
          return (
            <div
              key={idx}
              className={`flex flex-col gap-0.5 ${isUser ? "items-end" : "items-start"}`}
            >
              <div
                className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm break-words ${
                  isUser
                    ? "bg-blue-600 text-white rounded-br-sm whitespace-pre-wrap"
                    : "bg-white/10 text-gray-100 rounded-bl-sm"
                }`}
              >
                {isUser ? (
                  msg.content
                ) : (
                  <div
                    className="prose-sm prose-invert"
                    dangerouslySetInnerHTML={{ __html: msg.content }}
                  />
                )}
              </div>
              {msg.timestamp > 0 && (
                <span className="text-xs text-gray-600 font-mono px-1">
                  {formatTs(msg.timestamp)}
                </span>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* 채팅 입력창 */}
      <div className="border-t border-white/10 p-3 flex gap-2 flex-shrink-0">
        <input
          className="flex-1 bg-white/5 rounded-lg px-3 py-2 text-sm text-white outline-none border border-white/10 focus:border-blue-500 transition-colors"
          placeholder="메시지 입력..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
          disabled={sending}
        />
        <button
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
          onClick={sendMessage}
          disabled={sending || !input.trim()}
        >
          {sending ? "..." : "전송"}
        </button>
      </div>
    </div>
  );
}
