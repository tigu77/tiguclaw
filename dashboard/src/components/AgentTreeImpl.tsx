"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Tree, NodeRendererProps } from "react-arborist";
import { AgentInfo } from "@/types";

// ──── 타입 ────────────────────────────────────────────────────────────────────
interface ArboristNode {
  id: string;
  name: string;
  children?: ArboristNode[];
  agent: AgentInfo;
}

// ──── 상수 ────────────────────────────────────────────────────────────────────
const TIER_ICON: Record<number, string> = {
  0: "👑",
  1: "🔷",
  2: "🔹",
  3: "🔸",
};

// ──── buildTree ───────────────────────────────────────────────────────────────
function buildTree(agents: AgentInfo[]): ArboristNode[] {
  const map = new Map<string, ArboristNode>();
  agents.forEach((a) =>
    map.set(a.name, { id: a.name, name: a.name, agent: a, children: [] })
  );

  const roots: ArboristNode[] = [];
  agents.forEach((a) => {
    const node = map.get(a.name)!;
    if (a.parent_agent && map.has(a.parent_agent)) {
      map.get(a.parent_agent)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });

  // children이 빈 배열이면 undefined로 (leaf 노드)
  const cleanup = (n: ArboristNode) => {
    if (n.children && n.children.length === 0) {
      delete n.children;
    } else if (n.children) {
      n.children.forEach(cleanup);
    }
  };
  roots.forEach(cleanup);

  return roots;
}

// ──── 상태 dot 색상 ──────────────────────────────────────────────────────────
function statusDotColor(current_status?: string): string {
  if (!current_status || current_status === "idle") return "#f59e0b"; // yellow
  if (current_status === "thinking") return "#60a5fa"; // blue
  if (current_status.startsWith("executing:")) return "#34d399"; // green
  if (current_status === "error") return "#f87171"; // red
  return "#6b7280";
}

function statusLabel(current_status?: string): string {
  if (!current_status || current_status === "idle") return "idle";
  if (current_status === "thinking") return "thinking…";
  if (current_status.startsWith("executing:")) {
    const tool = current_status.split(":").slice(1).join(":");
    return tool;
  }
  return current_status;
}

// ──── 상태 텍스트 색상 ───────────────────────────────────────────────────────
function statusTextColor(current_status?: string): string {
  if (!current_status || current_status === "idle") return "#f59e0b";
  if (current_status === "thinking") return "#60a5fa";
  if (current_status.startsWith("executing:")) return "#34d399";
  if (current_status === "error") return "#f87171";
  return "#9ca3af";
}

function statusShortLabel(current_status?: string): string {
  if (!current_status || current_status === "idle") return "idle";
  if (current_status === "thinking") return "thinking";
  if (current_status.startsWith("executing:")) return "실행중";
  if (current_status === "error") return "오류";
  return current_status.slice(0, 8);
}

// ──── 커스텀 노드 렌더러 ──────────────────────────────────────────────────────
interface NodeRendererExtraProps {
  selectedName?: string;
  onSelect?: (name: string) => void;
}

function NodeRenderer({
  node,
  style,
  dragHandle,
  selectedName,
  onSelect,
}: NodeRendererProps<ArboristNode> & NodeRendererExtraProps) {
  const [hovered, setHovered] = useState(false);
  const { agent } = node.data;
  const tier = agent.tier ?? agent.level ?? 2;
  const tierIcon = TIER_ICON[Math.min(tier, 3)] ?? "🔹";
  const isSelected = selectedName === agent.name;
  const hasChildren = node.children && node.children.length > 0;

  // 온라인 여부: status가 "dead"면 오프라인
  const isOnline = agent.status !== "dead";
  const dotColor = statusDotColor(agent.current_status);
  const label = statusLabel(agent.current_status);
  const statusColor = statusTextColor(agent.current_status);
  const shortStatus = statusShortLabel(agent.current_status);
  const displayName = agent.nickname ?? agent.name;

  return (
    <div
      ref={dragHandle}
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        gap: "5px",
        paddingRight: "6px",
        paddingTop: "2px",
        paddingBottom: "2px",
        cursor: "pointer",
        borderRadius: "6px",
        backgroundColor: isSelected
          ? "rgba(255,255,255,0.1)"
          : hovered
          ? "rgba(255,255,255,0.05)"
          : "transparent",
        outline: isSelected ? "1px solid rgba(255,255,255,0.18)" : "none",
        transition: "background-color 0.12s",
        userSelect: "none",
        opacity: isOnline ? 1 : 0.4,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSelect?.(agent.name)}
    >
      {/* 접기/펼치기 토글 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          node.toggle();
        }}
        style={{
          width: "16px",
          height: "16px",
          flexShrink: 0,
          background: "none",
          border: "none",
          color: "#6b7280",
          fontSize: "9px",
          cursor: hasChildren ? "pointer" : "default",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        }}
        tabIndex={-1}
      >
        {hasChildren ? (node.isOpen ? "▼" : "▶") : ""}
      </button>

      {/* 티어 아이콘 */}
      <span
        style={{ fontSize: "15px", flexShrink: 0, lineHeight: 1 }}
        title={`T${tier}`}
      >
        {tierIcon}
      </span>

      {/* 상태 dot */}
      <span
        style={{
          width: "9px",
          height: "9px",
          borderRadius: "50%",
          backgroundColor: dotColor,
          flexShrink: 0,
          boxShadow: `0 0 5px ${dotColor}`,
        }}
        title={label}
      />

      {/* 에이전트 이름 */}
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "14px",
          color: "#e5e7eb",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={agent.nickname ? `${agent.nickname} (${agent.name})` : agent.name}
      >
        {displayName}
      </span>

      {/* 오른쪽 배지 영역 */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
        {/* 팀 배지 — 항상 표시 */}
        {agent.team && (
          <span
            style={{
              fontSize: "10px",
              padding: "1px 5px",
              borderRadius: "3px",
              background: "rgba(139,92,246,0.18)",
              border: "1px solid rgba(139,92,246,0.3)",
              color: "#c4b5fd",
              fontFamily: "monospace",
              maxWidth: "70px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={agent.team}
          >
            {agent.team}
          </span>
        )}

        {/* 상태 텍스트 배지 */}
        <span
          style={{
            fontSize: "10px",
            padding: "1px 5px",
            borderRadius: "3px",
            background: "rgba(0,0,0,0.3)",
            border: `1px solid ${statusColor}40`,
            color: statusColor,
            fontFamily: "monospace",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title={label}
        >
          {shortStatus}
        </span>

        {/* Kill 버튼 (T0 제외, hover 시 표시) */}
        {tier > 0 && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Kill agent "${agent.name}"?`)) {
                fetch(`/api/agents/${encodeURIComponent(agent.name)}/kill`, {
                  method: "POST",
                }).catch(console.error);
              }
            }}
            style={{
              padding: "1px 5px",
              borderRadius: "3px",
              border: "1px solid rgba(239,68,68,0.5)",
              background: "rgba(239,68,68,0.12)",
              color: "#f87171",
              fontSize: "10px",
              cursor: "pointer",
              fontFamily: "monospace",
              flexShrink: 0,
            }}
            title={`Kill ${agent.name}`}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

// ──── AgentTreeImpl (메인) ────────────────────────────────────────────────────
interface AgentTreeImplProps {
  agents: AgentInfo[];
  selected?: string;
  onSelect?: (name: string) => void;
}

export default function AgentTreeImpl({
  agents,
  selected,
  onSelect,
}: AgentTreeImplProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 280, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerSize({ width, height });
        }
      }
    });
    ro.observe(el);

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setContainerSize({ width: rect.width, height: rect.height });
    }

    return () => ro.disconnect();
  }, []);

  const treeData = buildTree(agents);

  const renderNode = useCallback(
    (props: NodeRendererProps<ArboristNode>) => (
      <NodeRenderer
        {...props}
        selectedName={selected}
        onSelect={onSelect}
      />
    ),
    [selected, onSelect]
  );

  if (treeData.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          color: "#6b7280",
          fontSize: "12px",
          paddingTop: "32px",
        }}
      >
        에이전트 없음
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        height: "100%",
      }}
    >
      <Tree<ArboristNode>
        data={treeData}
        openByDefault={true}
        width={containerSize.width}
        height={containerSize.height}
        indent={16}
        rowHeight={40}
        overscanCount={8}
        disableDrag
        disableDrop
      >
        {renderNode}
      </Tree>
    </div>
  );
}
