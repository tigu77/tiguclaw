"use client";

import { AgentInfo } from "@/types";

// 레벨별 색상 (이모지 + 텍스트)
const LEVEL_DOT: Record<number, string> = {
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

// AgentInfo[] → 트리 구조 변환
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
  const dot = LEVEL_DOT[agent.level] ?? "⚪";
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

        {/* 이름 */}
        <span className="font-mono text-sm text-white truncate flex-1">
          {agent.name}
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
