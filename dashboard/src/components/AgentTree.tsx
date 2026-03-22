"use client";

import { useState } from "react";
import { AgentInfo } from "@/types";

// 레벨별 색상 (이모지 + 텍스트)
const TIER_DOT: Record<number, string> = {
  0: "🔵",
  1: "🟢",
  2: "🟡",
  3: "🟠",
};

// 상태 표시 헬퍼
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

// 트리 노드 타입
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

// 단일 노드 렌더링 (재귀)
interface AgentTreeNodeProps {
  node: TreeNode;
  depth: number;
  isLast: boolean;
  prefix: string;
  selected?: string;
  onSelect?: (name: string) => void;
}

function AgentTreeNode({
  node,
  depth,
  isLast,
  prefix,
  selected,
  onSelect,
}: AgentTreeNodeProps) {
  const { agent, children } = node;
  const dot = TIER_DOT[agent.tier ?? agent.level ?? 1] ?? "⚪";
  const connector = isLast ? "└─" : "├─";
  const childPrefix = prefix + (isLast ? "   " : "│  ");
  const isSelected = selected === agent.name;

  return (
    <div>
      {/* 현재 노드 행 */}
      <button
        onClick={() => onSelect?.(agent.name)}
        className={`w-full flex items-center gap-2 px-2 py-1 rounded-md transition-colors text-left group ${
          isSelected
            ? "bg-white/15 ring-1 ring-white/20"
            : "hover:bg-white/8"
        }`}
      >
        {/* 트리 들여쓰기 + 연결선 */}
        {depth > 0 && (
          <span
            className="font-mono text-gray-600 text-xs select-none flex-shrink-0"
            style={{ letterSpacing: "-0.02em" }}
          >
            {prefix}
            {connector}
          </span>
        )}

        {/* 레벨 도트 */}
        <span className="text-base leading-none flex-shrink-0">{dot}</span>

        {/* 이름 (nickname 있으면 "nickname (name)" 형태) */}
        <span className="font-mono text-sm text-white truncate flex-1">
          {agent.nickname ? `${agent.nickname} (${agent.name})` : agent.name}
        </span>

        {/* 상태 */}
        <span className="flex-shrink-0">
          <StatusBadge status={agent.current_status} />
        </span>

        {/* 타임라인 힌트 */}
        <span className="text-[10px] text-gray-700 group-hover:text-gray-500 transition-colors flex-shrink-0">
          →
        </span>
      </button>

      {/* 자식 노드들 */}
      {children.map((child, i) => (
        <AgentTreeNode
          key={child.agent.name}
          node={child}
          depth={depth + 1}
          isLast={i === children.length - 1}
          prefix={childPrefix}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// 팀 섹션 노드 (접기/펼치기)
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
      {/* 팀 헤더 */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-2 py-1 rounded-md hover:bg-white/5 transition-colors text-left"
      >
        <span className="text-sm select-none">{collapsed ? "▶" : "▼"}</span>
        <span className="text-base leading-none flex-shrink-0">📦</span>
        <span className="font-mono text-sm text-gray-300 truncate flex-1">
          {teamName}
        </span>
        <span className="text-xs text-gray-500 flex-shrink-0">
          {nodes.length}
        </span>
      </button>

      {/* 팀 에이전트 목록 */}
      {!collapsed && (
        <div className="ml-2">
          {nodes.map((node, i) => (
            <AgentTreeNode
              key={node.agent.name}
              node={node}
              depth={1}
              isLast={i === nodes.length - 1}
              prefix=""
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 메인 AgentTree 컴포넌트
interface AgentTreeProps {
  agents: AgentInfo[];
  selected?: string;
  onSelect?: (name: string) => void;
}

export default function AgentTree({ agents, selected, onSelect }: AgentTreeProps) {
  const roots = buildTree(agents);

  if (roots.length === 0) {
    return (
      <div className="text-gray-600 text-xs text-center py-8">에이전트 없음</div>
    );
  }

  // 팀이 있는 에이전트와 없는 에이전트 분리 (roots 레벨만, 하위 자식은 기존 트리 구조 유지)
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

  // 팀이 하나도 없으면 기존 트리 렌더링
  if (!hasTeams) {
    return (
      <div className="flex flex-col gap-0.5">
        {roots.map((root, i) => (
          <AgentTreeNode
            key={root.agent.name}
            node={root}
            depth={0}
            isLast={i === roots.length - 1}
            prefix=""
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  // 팀 섹션 + 팀 없음 섹션 혼합 렌더링
  const sortedTeams = Array.from(teamMap.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-0.5">
      {/* 팀 없는 에이전트 (최상위 먼저) */}
      {noTeamRoots.map((root, i) => (
        <AgentTreeNode
          key={root.agent.name}
          node={root}
          depth={0}
          isLast={i === noTeamRoots.length - 1 && sortedTeams.length === 0}
          prefix=""
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
