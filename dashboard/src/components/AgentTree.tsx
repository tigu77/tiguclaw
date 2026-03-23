"use client";

import dynamic from "next/dynamic";
import { AgentInfo } from "@/types";

// react-arborist는 window를 직접 접근하므로 SSR 비활성화
const AgentTreeImpl = dynamic(() => import("./AgentTreeImpl"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        textAlign: "center",
        color: "#6b7280",
        fontSize: "12px",
        paddingTop: "32px",
      }}
    >
      트리 로딩 중…
    </div>
  ),
});

interface AgentTreeProps {
  agents: AgentInfo[];
  selected?: string;
  onSelect?: (name: string) => void;
}

export default function AgentTree({ agents, selected, onSelect }: AgentTreeProps) {
  return (
    <AgentTreeImpl agents={agents} selected={selected} onSelect={onSelect} />
  );
}
