"use client";

import { useEffect, useRef } from "react";
import { LogEntry } from "@/types";

const TYPE_STYLES: Record<LogEntry["type"], string> = {
  spawn: "text-green-400",
  kill: "text-red-400",
  comm: "text-blue-400",
  heartbeat: "text-gray-400",
  cost: "text-yellow-400",
};

interface LogStreamProps {
  logs: LogEntry[];
}

export default function LogStream({ logs }: LogStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 자동 스크롤 (사용자가 위로 스크롤하지 않은 경우만)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5 pr-1"
      style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
    >
      {logs.length === 0 && (
        <div className="text-gray-600 text-center py-8">이벤트 대기 중...</div>
      )}
      {logs.map((log) => (
        <div key={log.id} className="flex items-start gap-2 py-0.5 hover:bg-white/5 rounded px-1 transition-colors">
          <span className="text-gray-600 flex-shrink-0 tabular-nums">{log.time}</span>
          <span className={`${TYPE_STYLES[log.type]} flex-1 break-all`}>{log.text}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
