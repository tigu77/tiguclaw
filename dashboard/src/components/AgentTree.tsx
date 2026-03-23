"use client";

import { useState } from "react";
import { AgentInfo } from "@/types";

// ─── 상태 아이콘 ──────────────────────────────────────────────
function statusIcon(status?: string): string {
  const s = status ?? "idle";
  if (s === "thinking") return "🟡";
  if (s.startsWith("executing:")) return "🟢";
  if (s === "error") return "🔴";
  return "⏸";
}

// ─── 상태 배지 ────────────────────────────────────────────────
function StatusBadge({ status }: { status?: string }) {
  const s = status ?? "idle";
  if (s === "thinking") {
    return (
      <span style={{ color: "#d7ba7d", fontSize: 11, fontFamily: "monospace" }}>
        thinking…
      </span>
    );
  }
  if (s.startsWith("executing:")) {
    const tool = s.split(":").slice(1).join(":");
    return (
      <span style={{ color: "#4ec9b0", fontSize: 11, fontFamily: "monospace" }}>
        {tool}
      </span>
    );
  }
  return (
    <span style={{ color: "#555", fontSize: 11, fontFamily: "monospace" }}>
      idle
    </span>
  );
}

// ─── 트리 노드 타입 ───────────────────────────────────────────
interface TreeNode {
  agent: AgentInfo;
  children: TreeNode[];
}

// AgentInfo[] → 트리 구조 변환 (parent_agent 기준)
function buildTree(agents: AgentInfo[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  agents.forEach((a) => map.set(a.name, { agent: a, children: [] }));

  const roots: TreeNode[] = [];
  agents.forEach((a) => {
    const node = map.get(a.name)!;
    if (a.parent_agent && map.has(a.parent_agent)) {
      map.get(a.parent_agent)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

// ─── 단일 노드 렌더링 (재귀) ──────────────────────────────────
interface AgentTreeNodeProps {
  node: TreeNode;
  depth: number;
  selected?: string;
  onSelect?: (name: string) => void;
}

function AgentTreeNode({ node, depth, selected, onSelect }: AgentTreeNodeProps) {
  const { agent, children } = node;
  const [collapsed, setCollapsed] = useState(false);
  const isSelected = selected === agent.name;
  const hasChildren = children.length > 0;
  const icon = statusIcon(agent.current_status);

  // VS Code: 8px per depth level
  const indentPx = depth * 8;

  return (
    <div>
      {/* Row */}
      <div
        onClick={() => onSelect?.(agent.name)}
        style={{
          display: "flex",
          alignItems: "center",
          height: 22,
          cursor: "pointer",
          paddingLeft: indentPx,
          paddingRight: 8,
          backgroundColor: isSelected ? "#094771" : "transparent",
          userSelect: "none",
        }}
        className="vscode-tree-row"
      >
        {/* Chevron (자식 있을 때만) */}
        <span
          onClick={(e) => {
            if (hasChildren) {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }
          }}
          style={{
            width: 16,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "#ccc",
            transition: "transform 0.1s",
            transform: hasChildren && !collapsed ? "rotate(0deg)" : "rotate(-90deg)",
            opacity: hasChildren ? 1 : 0,
            pointerEvents: hasChildren ? "auto" : "none",
          }}
        >
          {/* ▼ chevron — rotate로 ▶ ↔ ▼ 전환 */}
          ▼
        </span>

        {/* Status icon */}
        <span style={{ fontSize: 12, flexShrink: 0, marginRight: 4 }}>
          {icon}
        </span>

        {/* Name */}
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            color: "#d4d4d4",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {agent.nickname ? `${agent.nickname} (${agent.name})` : agent.name}
        </span>

        {/* Status badge */}
        <span style={{ flexShrink: 0, marginLeft: 6 }}>
          <StatusBadge status={agent.current_status} />
        </span>
      </div>

      {/* 자식 — 수직 트리라인 */}
      {hasChildren && !collapsed && (
        <div
          style={{
            borderLeft: "1px solid #3c3c3c",
            marginLeft: indentPx + 8,   // chevron 중앙에 맞춤
          }}
        >
          {children.map((child) => (
            <AgentTreeNode
              key={child.agent.name}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 메인 AgentTree ───────────────────────────────────────────
interface AgentTreeProps {
  agents: AgentInfo[];
  selected?: string;
  onSelect?: (name: string) => void;
}

export default function AgentTree({ agents, selected, onSelect }: AgentTreeProps) {
  const roots = buildTree(agents);

  if (roots.length === 0) {
    return (
      <div
        style={{
          color: "#555",
          fontSize: 12,
          textAlign: "center",
          padding: "24px 0",
          fontFamily: "monospace",
        }}
      >
        에이전트 없음
      </div>
    );
  }

  return (
    <>
      {/* hover 스타일 — global injection */}
      <style>{`
        .vscode-tree-row:hover {
          background: rgba(255, 255, 255, 0.05) !important;
        }
      `}</style>
      <div style={{ fontFamily: "monospace" }}>
        {roots.map((root) => (
          <AgentTreeNode
            key={root.agent.name}
            node={root}
            depth={0}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    </>
  );
}
