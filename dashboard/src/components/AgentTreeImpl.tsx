"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Tree, NodeApi, NodeRendererProps } from "react-arborist";
import { AgentInfo } from "@/types";

// ──── 타입 ────────────────────────────────────────────────────────────────────
interface ArboristNode {
  id: string;
  name: string;
  children?: ArboristNode[];
  agent: AgentInfo;
}

// ──── 상수 ────────────────────────────────────────────────────────────────────
const TIER_COLOR: Record<number, string> = {
  0: "#f59e0b", // T0: amber/gold
  1: "#3b82f6", // T1: blue
  2: "#9ca3af", // T2: gray
  3: "#8b5cf6", // T3: purple
};

const TIER_LABEL: Record<number, string> = {
  0: "T0",
  1: "T1",
  2: "T2",
  3: "T3",
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

// ──── 상태 아이콘 ──────────────────────────────────────────────────────────────
function statusIcon(current_status?: string): string {
  if (!current_status || current_status === "idle") return "🟡";
  if (current_status === "thinking") return "💭";
  if (current_status.startsWith("executing:")) return "🟢";
  if (current_status === "error") return "🔴";
  return "🟡";
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

function statusColor(current_status?: string): string {
  if (!current_status || current_status === "idle") return "#6b7280";
  if (current_status === "thinking") return "#60a5fa";
  if (current_status.startsWith("executing:")) return "#34d399";
  if (current_status === "error") return "#f87171";
  return "#6b7280";
}

// ──── 커스텀 노드 렌더러 ──────────────────────────────────────────────────────
interface NodeRendererExtraProps {
  selectedName?: string;
  onSelect?: (name: string) => void;
  onKill?: (name: string) => void;
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
  const tierColor = TIER_COLOR[Math.min(tier, 3)] ?? TIER_COLOR[2];
  const tierLabel = TIER_LABEL[Math.min(tier, 3)] ?? "T?";
  const isSelected = selectedName === agent.name;
  const icon = statusIcon(agent.current_status);
  const label = statusLabel(agent.current_status);
  const sColor = statusColor(agent.current_status);
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div
      ref={dragHandle}
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        gap: "4px",
        paddingRight: "6px",
        cursor: "pointer",
        borderRadius: "4px",
        backgroundColor: isSelected
          ? "rgba(255,255,255,0.1)"
          : hovered
          ? "rgba(255,255,255,0.05)"
          : "transparent",
        outline: isSelected ? "1px solid rgba(255,255,255,0.18)" : "none",
        transition: "background-color 0.12s",
        userSelect: "none",
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

      {/* 티어 컬러바 + 라벨 */}
      <div
        style={{
          width: "3px",
          height: "22px",
          borderRadius: "2px",
          backgroundColor: tierColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: "9px",
          color: tierColor,
          fontFamily: "monospace",
          fontWeight: 700,
          flexShrink: 0,
          minWidth: "18px",
        }}
      >
        {tierLabel}
      </span>

      {/* 상태 아이콘 */}
      <span style={{ fontSize: "12px", flexShrink: 0 }}>{icon}</span>

      {/* 에이전트 이름 */}
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "13px",
          color: "#e5e7eb",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={agent.nickname ? `${agent.nickname} (${agent.name})` : agent.name}
      >
        {agent.nickname ? agent.nickname : agent.name}
      </span>

      {/* 상태 텍스트 */}
      <span
        style={{
          fontSize: "11px",
          color: sColor,
          fontFamily: "monospace",
          flexShrink: 0,
          maxWidth: "90px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          opacity: hovered || isSelected ? 1 : 0.6,
          transition: "opacity 0.12s",
        }}
        title={label}
      >
        {label}
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
            flexShrink: 0,
            padding: "1px 5px",
            borderRadius: "3px",
            border: "1px solid rgba(239,68,68,0.5)",
            background: "rgba(239,68,68,0.12)",
            color: "#f87171",
            fontSize: "10px",
            cursor: "pointer",
            fontFamily: "monospace",
          }}
          title={`Kill ${agent.name}`}
        >
          ✕
        </button>
      )}
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

    // 초기 크기
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
        rowHeight={30}
        overscanCount={8}
        disableDrag
        disableDrop
      >
        {renderNode}
      </Tree>
    </div>
  );
}
