"use client";

import { useState } from "react";
import { AgentInfo } from "@/types";

// 티어별 스타일 (T0=골드, T1=블루, T2=그레이, T3=퍼플)
const TIER_STYLE: Record<number, { borderColor: string; dot: string }> = {
  0: { borderColor: "#f59e0b", dot: "🔵" }, // T0: amber/gold
  1: { borderColor: "#3b82f6", dot: "🟢" }, // T1: blue
  2: { borderColor: "#9ca3af", dot: "🟡" }, // T2: gray
  3: { borderColor: "#8b5cf6", dot: "🟠" }, // T3: purple
};

const INDENT_PX = 20; // depth당 인덴트 (px)

// ──── StatusBadge ────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status?: string }) {
  const s = status ?? "idle";
  if (s === "thinking") {
    return <span className="text-xs text-blue-400 font-mono">💭 thinking…</span>;
  }
  if (s.startsWith("executing:")) {
    const tool = s.split(":").slice(1).join(":");
    return <span className="text-xs text-yellow-400 font-mono">🔧 {tool}</span>;
  }
  return <span className="text-xs text-gray-500 font-mono">● idle</span>;
}

// ──── Tree types ──────────────────────────────────────────────────────────────
interface TreeNode {
  agent: AgentInfo;
  children: TreeNode[];
}

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

// ──── AgentTreeNode (재귀 렌더링) ─────────────────────────────────────────────
// 인덴트는 중첩 컨테이너(borderLeft wrapper)로 처리.
// depth prop 없이 showConnector로 루트 여부만 구분.
interface AgentTreeNodeProps {
  node: TreeNode;
  isLast: boolean;
  showConnector?: boolean; // false = 루트 (connector 숨김)
  selected?: string;
  onSelect?: (name: string) => void;
}

function AgentTreeNode({
  node,
  isLast,
  showConnector = true,
  selected,
  onSelect,
}: AgentTreeNodeProps) {
  const { agent, children } = node;
  const [collapsed, setCollapsed] = useState(false);
  const tier = agent.tier ?? agent.level ?? 1;
  const style = TIER_STYLE[Math.min(tier, 3)] ?? TIER_STYLE[2];
  const isSelected = selected === agent.name;
  const hasChildren = children.length > 0;

  return (
    <div>
      {/* ── 노드 행 ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-0.5">
        {/* 접기/펼치기 */}
        <div className="w-4 flex-shrink-0 flex items-center justify-center">
          {hasChildren && (
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors leading-none"
              title={collapsed ? "펼치기" : "접기"}
            >
              {collapsed ? "▶" : "▼"}
            </button>
          )}
        </div>

        {/* 트리 연결선 */}
        {showConnector && (
          <span
            className="font-mono text-xs select-none flex-shrink-0"
            style={{ minWidth: "1.4rem", color: "rgba(156, 163, 175, 0.55)" }}
          >
            {isLast ? "└─" : "├─"}
          </span>
        )}

        {/* 노드 버튼 — 티어별 border-left */}
        <button
          onClick={() => onSelect?.(agent.name)}
          style={{
            borderLeft: `3px solid ${style.borderColor}`,
            backgroundColor: isSelected
              ? "rgba(255,255,255,0.12)"
              : undefined,
          }}
          className={`group flex-1 flex items-center gap-2 pl-2 pr-2 py-1 rounded-r-md transition-colors text-left min-w-0 ${
            isSelected ? "ring-1 ring-white/20" : "hover:bg-white/[0.06]"
          }`}
        >
          <span className="text-sm leading-none flex-shrink-0">{style.dot}</span>
          <span className="font-mono text-sm text-white truncate flex-1">
            {agent.nickname
              ? `${agent.nickname} (${agent.name})`
              : agent.name}
          </span>
          <span className="flex-shrink-0">
            <StatusBadge status={agent.current_status} />
          </span>
          <span className="text-[10px] text-gray-700 group-hover:text-gray-500 transition-colors flex-shrink-0">
            →
          </span>
        </button>
      </div>

      {/* ── 자식 노드들: 중첩 컨테이너가 인덴트 + 수직선 담당 ─────────────── */}
      {!collapsed && hasChildren && (
        <div
          style={{
            marginLeft: `${INDENT_PX}px`,
            borderLeft: "1px solid rgba(107, 114, 128, 0.22)",
            paddingLeft: "6px",
          }}
        >
          {children.map((child, i) => (
            <AgentTreeNode
              key={child.agent.name}
              node={child}
              isLast={i === children.length - 1}
              showConnector={true}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ──── TeamSection ─────────────────────────────────────────────────────────────
interface TeamSectionProps {
  teamName: string;
  nodes: TreeNode[];
  selected?: string;
  onSelect?: (name: string) => void;
}

function TeamSection({ teamName, nodes, selected, onSelect }: TeamSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-1">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-2 py-1 rounded-md hover:bg-white/5 transition-colors text-left"
      >
        <span className="text-sm select-none">{collapsed ? "▶" : "▼"}</span>
        <span className="text-base leading-none flex-shrink-0">📦</span>
        <span className="font-mono text-sm text-gray-300 truncate flex-1">
          {teamName}
        </span>
        <span className="text-xs text-gray-500 flex-shrink-0">{nodes.length}</span>
      </button>

      {!collapsed && (
        <div
          style={{
            marginLeft: `${INDENT_PX}px`,
            borderLeft: "1px solid rgba(107, 114, 128, 0.22)",
            paddingLeft: "6px",
          }}
        >
          {nodes.map((node, i) => (
            <AgentTreeNode
              key={node.agent.name}
              node={node}
              isLast={i === nodes.length - 1}
              showConnector={true}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ──── AgentTree (메인) ────────────────────────────────────────────────────────
interface AgentTreeProps {
  agents: AgentInfo[];
  selected?: string;
  onSelect?: (name: string) => void;
}

export default function AgentTree({ agents, selected, onSelect }: AgentTreeProps) {
  const roots = buildTree(agents);

  if (roots.length === 0) {
    return (
      <div className="text-gray-600 text-xs text-center py-8">
        에이전트 없음
      </div>
    );
  }

  const teamMap = new Map<string, TreeNode[]>();
  const noTeamRoots: TreeNode[] = [];

  for (const root of roots) {
    const team = root.agent.team;
    if (team && team.trim() !== "") {
      if (!teamMap.has(team)) teamMap.set(team, []);
      teamMap.get(team)!.push(root);
    } else {
      noTeamRoots.push(root);
    }
  }

  const hasTeams = teamMap.size > 0;

  // 팀 없음 → 단순 트리
  if (!hasTeams) {
    return (
      <div className="flex flex-col gap-0.5">
        {roots.map((root, i) => (
          <AgentTreeNode
            key={root.agent.name}
            node={root}
            isLast={i === roots.length - 1}
            showConnector={false}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  const sortedTeams = Array.from(teamMap.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className="flex flex-col gap-0.5">
      {/* 팀 없는 루트들 */}
      {noTeamRoots.map((root, i) => (
        <AgentTreeNode
          key={root.agent.name}
          node={root}
          isLast={i === noTeamRoots.length - 1 && sortedTeams.length === 0}
          showConnector={false}
          selected={selected}
          onSelect={onSelect}
        />
      ))}

      {/* 팀 섹션들 */}
      {sortedTeams.map(([teamName, nodes]) => (
        <TeamSection
          key={teamName}
          teamName={teamName}
          nodes={nodes}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
