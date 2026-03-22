"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { LogEntry, LogEntryType } from "@/types";

const TYPE_STYLES: Record<LogEntryType, string> = {
  spawn: "text-green-400",
  kill: "text-red-400",
  comm: "text-blue-400",
  heartbeat: "text-gray-500",
  cost: "text-yellow-400",
  thinking: "text-purple-400",
  executing: "text-orange-400",
  idle: "text-teal-400",
};

/** 백엔드 JSON 이벤트 → LogEntry 변환 */
function apiEventToLog(event: Record<string, unknown>): LogEntry | null {
  const type = event["type"] as string;
  const data = (event["data"] ?? {}) as Record<string, unknown>;
  const id = Math.random().toString(36).slice(2, 9);

  // 타임스탬프 파싱 (없으면 현재 시간)
  let time = new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });

  switch (type) {
    case "AgentSpawned":
      return { id, time, type: "spawn", text: `🟢 spawn: ${data["name"] ?? "?"}` };
    case "AgentKilled":
      return { id, time, type: "kill", text: `🔴 kill: ${data["name"] ?? "?"}` };
    case "AgentComm": {
      const preview = String(data["message"] ?? "").slice(0, 60);
      return { id, time, type: "comm", text: `📨 comm: ${data["from"] ?? "?"} → ${data["to"] ?? "?"} (${preview})` };
    }
    case "AgentThinking":
      return { id, time, type: "thinking", text: `💭 thinking: ${data["name"] ?? "?"}` };
    case "AgentExecuting":
      return { id, time, type: "executing", text: `🔧 executing: ${data["name"] ?? "?"} → ${data["tool"] ?? "?"}` };
    case "AgentIdle":
      return { id, time, type: "idle", text: `✅ idle: ${data["name"] ?? "?"}` };
    default:
      return null;
  }
}

interface LogStreamProps {
  logs: LogEntry[];
  apiBase?: string;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function LogStream({ logs: wsLogs, apiBase }: LogStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 날짜 선택 상태 ("today" | "yesterday" | "custom")
  const [dateMode, setDateMode] = useState<"today" | "yesterday" | "custom">("today");
  const [customDate, setCustomDate] = useState<string>(todayStr());
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  // 파일 기반 로그 (API)
  const [fileLogs, setFileLogs] = useState<LogEntry[]>([]);
  const [fileLoading, setFileLoading] = useState(false);

  // 선택된 날짜 계산
  const selectedDate = dateMode === "today"
    ? todayStr()
    : dateMode === "yesterday"
    ? yesterdayStr()
    : customDate;

  const isToday = selectedDate === todayStr();

  // 날짜 목록 로드
  useEffect(() => {
    if (!apiBase) return;
    fetch(`${apiBase}/api/logs/dates`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((dates: string[]) => setAvailableDates(dates))
      .catch(() => {});
  }, [apiBase]);

  // 파일 기반 로그 로드
  const loadFileLogs = useCallback((date: string) => {
    if (!apiBase) return;
    setFileLoading(true);
    fetch(`${apiBase}/api/logs?date=${date}&limit=500`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((events: Record<string, unknown>[]) => {
        const parsed = events.flatMap((e) => {
          const entry = apiEventToLog(e);
          return entry ? [entry] : [];
        });
        setFileLogs(parsed);
      })
      .catch(() => setFileLogs([]))
      .finally(() => setFileLoading(false));
  }, [apiBase]);

  // 날짜 변경 시 로드
  useEffect(() => {
    loadFileLogs(selectedDate);
  }, [selectedDate, loadFileLogs]);

  // 오늘이면 WS 실시간 로그도 합산
  const combinedLogs: LogEntry[] = isToday
    ? [...fileLogs, ...wsLogs.filter((w) => !fileLogs.some((f) => f.id === w.id))]
    : fileLogs;

  // 자동 스크롤 (사용자가 위로 스크롤하지 않은 경우만)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [combinedLogs]);

  return (
    <div className="flex flex-col h-full gap-2">
      {/* 날짜 선택기 */}
      <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
        <div className="flex rounded-md overflow-hidden border border-white/10 text-xs">
          {(["today", "yesterday"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setDateMode(mode)}
              className={`px-2.5 py-1 transition-colors ${
                dateMode === mode
                  ? "bg-white/20 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {mode === "today" ? "오늘" : "어제"}
            </button>
          ))}
          <button
            onClick={() => setDateMode("custom")}
            className={`px-2.5 py-1 transition-colors ${
              dateMode === "custom"
                ? "bg-white/20 text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            날짜 선택
          </button>
        </div>

        {dateMode === "custom" && (
          <select
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-gray-300 focus:outline-none"
          >
            {availableDates.length === 0 && (
              <option value={todayStr()}>{todayStr()}</option>
            )}
            {availableDates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}

        <span className="text-xs text-gray-600 font-mono ml-auto">
          {fileLoading ? "로딩 중..." : `${combinedLogs.length}개`}
        </span>
      </div>

      {/* 로그 스트림 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5 pr-1 min-h-0"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#374151 transparent" }}
      >
        {combinedLogs.length === 0 && !fileLoading && (
          <div className="text-gray-600 text-center py-8">
            {isToday ? "이벤트 대기 중..." : `${selectedDate} 로그 없음`}
          </div>
        )}
        {combinedLogs.map((log) => (
          <div key={log.id} className="flex items-start gap-2 py-0.5 hover:bg-white/5 rounded px-1 transition-colors">
            <span className="text-gray-600 flex-shrink-0 tabular-nums">{log.time}</span>
            <span className={`${TYPE_STYLES[log.type] ?? "text-gray-400"} flex-1 break-all`}>
              {log.text}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
