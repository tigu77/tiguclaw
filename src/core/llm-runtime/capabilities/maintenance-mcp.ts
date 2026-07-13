/**
 * 영역 A/B 공통 — 런타임 유지보수 detect in-process MCP server (factory).
 *
 * 진실 소스 / 패턴 동형:
 *  - `update-self-mcp.ts` / `find-capabilities-mcp.ts` — per-turn factory + 3어댑터
 *    동형 등록(parity). `runMaintenanceScan`(core/maintenance.ts) 위험 로직 0(순수
 *    read-only 집계) → 이 파일은 *호출 + 사람말 렌더*만(update-self 의 "위험 로직은
 *    runSelfUpdate 안에" 원칙의 detect 판, 여기는 애초에 위험이 없다).
 *  - architect contract `_workspace/runtime-maintenance_architect_contract.md` §3.1.
 *
 * 게이트: 읽기전용·저위험 = find_skills/find_capabilities 류 정책(depth·workerDepth
 * 무관, lean(toolsNone) 만 게이트) — update_self(파괴적 재시작 동반)의 depth0&&workerDepth0
 * 하드 게이트와 다르다(계약서 §3.1 "비파괴·자유·읽기전용").
 *
 * context 위생: on-demand 호출만 — 매 턴 프롬프트 주입 0(도구 설명만 카탈로그에 상주).
 */
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { runMaintenanceScan, type MaintenanceReport } from "../../maintenance.js";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
};

const axisLabel: Record<string, string> = {
  "hot-bounded": "핫·바운드",
  "cold-preserve": "콜드·보존",
  volatile: "휘발성·파생",
};

/**
 * MaintenanceReport → 사람말 마크다운. "구조적으로 건강 ✅"이 주 메시지 — attention
 * 항목이 있을 때만 그 항목을 강조(dev 스킬 daemon-efficiency-audit 판정 함정 이식:
 * 콜드=크다≠문제, 대시보드/도구가 오판하지 않도록 각 store note 를 그대로 노출).
 */
const renderReport = (r: MaintenanceReport): string => {
  const lines: string[] = [];
  lines.push(
    r.overall === "healthy"
      ? "구조적으로 건강해요 ✅ (핫 경로 전부 바운드, 콜드 레코드는 보존 원칙대로 무한 누적 — 정상)"
      : "⚠️ 주의가 필요한 항목이 있어요 (아래 attention 표시 참조)",
  );
  lines.push("");
  lines.push(
    `DB ${fmtBytes(r.dbBytes)} / WAL ${fmtBytes(r.walBytes)} (SQLite 자율 체크포인트 — 손 안 댐)`,
  );
  lines.push("");
  for (const s of r.stores) {
    const badge =
      s.status === "attention" ? "⚠️ attention" : s.status === "n/a" ? "ℹ️ 정보" : "✅ healthy";
    const boundText = s.bound === null ? "무한(보존)" : s.bound.toLocaleString();
    lines.push(
      `- **${s.store}** [${axisLabel[s.axis] ?? s.axis}] ${badge} — ${s.count.toLocaleString()} / ${boundText}`,
    );
    lines.push(`  ${s.note}`);
  }
  if (r.proposals.length > 0) {
    lines.push("");
    lines.push(`정리 제안 ${r.proposals.length}건 있음(미리보기 필요 — P1 범위 밖, 아직 미구현).`);
  }
  return lines.join("\n");
};

/**
 * maintenance MCP server factory — 인자 없음(읽기전용, 클로저 상태 불요). 도구
 * `maintenance_status` 호출 시 `runMaintenanceScan()` 을 실행해 사람말로 렌더.
 * 위험 로직 0 — 아무것도 바꾸지 않는다(파괴적 삭제 도구는 P1 에 없음).
 */
export const createMaintenanceMcpServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "maintenance",
    version: "1.0.0",
    tools: [
      tool(
        "maintenance_status",
        "tiguclaw 런타임 저장소(대화 이력·메모리·워커 잡·관측 이벤트 등)가 구조적으로 건강한지 점검합니다. 읽기전용 — 아무것도 삭제·변경하지 않습니다. 사용자가 '상태 괜찮아?', '용량 어때', '정리 필요해?' 처럼 물을 때 사용하세요.",
        {},
        async () => {
          const report = runMaintenanceScan();
          return okText(renderReport(report));
        },
      ),
    ],
  });
