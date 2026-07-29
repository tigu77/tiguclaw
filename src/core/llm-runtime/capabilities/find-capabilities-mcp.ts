/**
 * find_capabilities MCP — 빌트인/플러그인 MCP 능력층의 조회 표면 (P1).
 *
 * 진실 소스: `_workspace/capability-awareness_architect_contract.md` §3.
 *
 * 배경(§0 재확인) — 빌트인 MCP 도구는 depth 0 턴마다 이미 모델 컨텍스트에 스키마로
 * 들어간다. 진짜 갭은 "안 보였다"가 아니라 "간접 의도(예: '외부 앱이 나를 호출')를
 * 눈앞의 자기 도구로 매핑하지 못했다"는 추론 갭(P0 sysprompt 넛지가 직접 처방) +
 * "빌트인/플러그인 MCP 능력층엔 스킬/에이전트 같은 enumeration 표면이 없다"는
 * 조회 갭(본 파일이 처방). find_skills/find_agents 동형 — 3번째 인스턴스라 추상화
 * 임계 미달(각자 복제가 정직, 메타 원칙 "단순함").
 *
 * 소스 오브 트루스 — 하이브리드 교집합(§3b):
 *  1. live active 세트: 어댑터가 이번 턴 *실제 빌드한* MCP 서버 맵/배열에서 파생한
 *     활성 서버명 집합(게이트-aware, 데이터-파생). 병렬 static 리스트 금지 —
 *     조건(depth/workerDepth/toolsNone/클로저-유무)을 복제하지 않고 결과 맵의 keys 를
 *     그대로 읽어 드리프트를 원천 차단(엔드포인트 사고류 재발 불가).
 *  2. static 카탈로그(BUILTIN_CAPABILITY_CATALOG, 아래): 빌트인 코어 능력만
 *     {summary, whenToUse, tools}. 여기가 "간접 의도 매핑"을 직접 고치는 층.
 *
 * 교집합 규칙:
 *  - active ∩ 카탈로그 有 → 카탈로그의 rich summary+whenToUse.
 *  - active ∩ 카탈로그 無 (= 플러그인, 예: router 가 넘기는 extraMcpServers —
 *    scheduler·file-watch 등) → 그 서버 `listTools()` description 에서
 *    data-파생(source:"plugin"). **카탈로그에 플러그인 이름을 박지 않는다 →
 *    §0 단방향 불변식 준수.** extraMcpServers 에 없는 active-only 이름(= 사용자가
 *    `add_mcp_server` 로 연결한 외부 MCP)은 `list_mcp_servers` 로 유도하는 일반
 *    설명으로 대체(listTools 재연결 비용 회피 — mcp-admin 이 이미 그 조회를 전담).
 *  - 카탈로그 有 ∩ active 無 → `query` 로 명시 조회됐을 때만(또는 요약 모드에서도)
 *    `available:false` + 습득 라우팅 안내로 노출(가용한 척 광고 금지).
 *
 * 3어댑터 parity(§3c) — 단일 팩토리를 세 어댑터가 각자의 active-name 집합(+
 * extraMcpServers, 세 어댑터 동일 shape `Record<string, McpSdkServerConfigWithInstance>`)
 * 만 넘겨 호출한다. 본문(카탈로그 교집합·직렬화·습득 안내)은 이 파일 1벌뿐이라
 * parity by construction(분기 자체가 불가능). 서브에이전트 비대칭(claude=native Task,
 * codex/openai=spawn_agent)은 `agent-registry.ts` `invocationHint` 선례대로
 * `subagentInvocationHint` 문구 파라미터로만 흡수 — MCP 능력 집합 자체(spawn_agent
 * 도구)는 세 어댑터 모두 depth0 등록이라 완전 대칭.
 *
 * 등록 게이트: find_skills/find_agents 와 동일 — depth 무관(서브도 자기인지 필요) +
 * `!toolsNone`(lean 은 조회 자체가 불요, 도구 0). 부트스트랩 순환 없음(§3d) —
 * activeNames 는 각 어댑터가 자신의 MCP 맵/배열 빌드를 마친 뒤 파생해 주입하고,
 * find_capabilities 자신은 그 목록에 없다(스스로 이미 쓰는 중이라 자기 언급 불요).
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { adaptClaudeMcpServer } from "../adapters/_mcp-bridge.js";

/** 정규형 반환 shape (contract §3a) — 어댑터 무관 동일. */
export interface CapabilityHit {
  /** 능력 그룹/서버명 (예: "endpoints", "workers", 플러그인이면 그 서버명). */
  name: string;
  /** "무엇을 하는가" 한 줄 — 의미 브리지. */
  summary: string;
  /** "언제 이걸 쓰나" — 간접 의도 매핑 힌트(카탈로그 항목만 지정). */
  whenToUse?: string;
  /** 이 능력이 노출하는 도구명. */
  tools: string[];
  /** 이번 턴 실제 등록 여부(게이트-aware). */
  available: boolean;
  source: "builtin" | "plugin";
}

interface BuiltinCapabilityMeta {
  summary: string;
  whenToUse: string;
  tools: string[];
}

/**
 * 빌트인 코어 능력 카탈로그 — `src/core/llm-runtime/capabilities/` (+ `memory-mcp.ts`)
 * 안의 실제 in-process MCP 서버만. **플러그인 이름(schedule·watch 등) 절대 하드코딩
 * 금지 — §0 단방향 불변식.** 각 항목의 name 은 세 어댑터가 실제로 등록하는 MCP 서버
 * 키(leanMcpServers 객체 키 / bridge name)와 정확히 일치해야 active 교집합이 성립.
 */
const BUILTIN_CAPABILITY_CATALOG: Record<string, BuiltinCapabilityMeta> = {
  memory: {
    summary: "장기 기억(SQLite) 저장·검색·수정·삭제 — 룰·선호·사실·통찰·관측 신호.",
    whenToUse:
      "사용자가 기억할 만한 사실·선호·규칙을 말했거나, 저장해둔 메모리를 다시 확인·정정·삭제해야 할 때.",
    tools: [
      "read_memory",
      "add_memory",
      "update_memory",
      "delete_memory",
      "list_installed_plugins",
    ],
  },
  skills: {
    summary: "발견된 스킬(SKILL.md) 본문 로드·검색.",
    whenToUse:
      "특정 하네스·작업 절차를 스킬로 실행하고 싶거나, 스킬 인덱스에 안 보이는 스킬을 찾을 때.",
    tools: ["invoke_skill", "find_skills"],
  },
  agents: {
    summary: "서브에이전트 위임 — 하위 작업을 별도 에이전트에 맡기거나 다른 프로젝트로 병렬 위임.",
    whenToUse: "하위 작업을 위임하거나, 현재 작업 폴더가 아닌 다른 프로젝트로 작업을 보낼 때.",
    tools: ["spawn_agent", "find_agents"],
  },
  workers: {
    summary: "긴 작업을 백그라운드로 발사·조회·**추가 지시**·취소(비차단, 대시보드에 노출).",
    whenToUse:
      "지금 응답을 끝내지 않고 오래 걸리는 작업(빌드·대량 처리 등)을 뒤에서 계속 돌리고 싶을 때.",
    tools: ["run_in_background", "list_workers", "list_all_workers", "steer_worker", "cancel_worker"],
  },
  endpoints: {
    summary: "커스텀 HTTP 엔드포인트 등록·조회·삭제 — 외부에서 나를 호출.",
    whenToUse:
      "외부 앱이 나를 호출하거나 웹훅을 수신해야 할 때(예: 'GitHub 웹훅 받게 해줘'). 파일 감시 같은 우회책 대신 이 도구부터 확인.",
    tools: ["register_endpoint", "list_endpoints", "delete_endpoint"],
  },
  commands: {
    summary: "커스텀 슬래시 명령 등록·조회·삭제.",
    whenToUse: "사용자가 자주 쓰는 요청을 짧은 /명령으로 만들고 싶을 때.",
    tools: ["register_command", "list_commands", "delete_command"],
  },
  "mcp-admin": {
    summary: "외부 MCP 서버 연결 등록·조회·삭제.",
    whenToUse:
      "새 외부 도구/서비스를 MCP 서버로 연결해 내 도구로 쓰고 싶을 때, 또는 이미 연결된 외부 MCP 목록을 확인할 때.",
    tools: ["add_mcp_server", "list_mcp_servers", "remove_mcp_server"],
  },
  "update-self": {
    summary: "자가 업데이트(git pull + typecheck 게이트 + 실패 시 롤백 + 재시작).",
    whenToUse: "'업데이트해줘' 처럼 스스로 최신화하라는 요청을 받았을 때.",
    tools: ["update_self"],
  },
  maintenance: {
    summary: "런타임 저장소(대화 이력·메모리·매니저 잡·관측 이벤트) 구조적 건강 점검. 읽기전용.",
    whenToUse: "사용자가 '상태 괜찮아?', '용량 어때', '정리 필요해?' 처럼 자기 상태를 물을 때.",
    tools: ["maintenance_status"],
  },
  "send-file": {
    summary: "현재 채널로 파일·첨부를 네이티브 전송(멱등).",
    whenToUse:
      "만든 파일이나 이미지를 사용자에게 직접 전송해야 할 때(채널이 전송을 지원하는 턴에서만 활성).",
    tools: ["send_file"],
  },
  "prompt-options": {
    summary: "객관식 선택지를 사용자에게 제시.",
    whenToUse:
      "여러 옵션 중 사용자가 클릭/선택하게 하고 싶을 때(채널이 렌더를 지원하는 턴에서만 활성).",
    tools: ["prompt_options"],
  },
  "reply-intent": {
    summary: "이번 응답을 트리거 메시지의 직접 답글로 마킹.",
    whenToUse: "여러 화제가 섞여 있어 어느 메시지에 답하는지 명확히 해야 할 때.",
    tools: ["reply_to_current_message"],
  },
  projects: {
    summary: "폴더를 프로젝트로 등록·조회·갱신 — PROJECT.md 기반, 대시보드에 노출.",
    whenToUse:
      "작업 폴더를 프로젝트로 등록하거나, 등록된 프로젝트 목록·그 폴더 전용 에이전트/스킬을 확인할 때.",
    tools: [
      "project_register",
      "project_update",
      "project_list",
      "project_forget",
      "project_capabilities",
    ],
  },
  todo: {
    summary:
      "작업 진행 체크리스트 관리(Claude Code TodoWrite 대응 — codex/openai 전용, claude 는 SDK 빌트인 TodoWrite 사용).",
    whenToUse: "여러 단계짜리 작업의 진행 상황을 사용자에게 투명하게 보여주고 싶을 때.",
    tools: ["update_todos"],
  },
  "file-ops": {
    summary:
      "파일 읽기/쓰기/편집/검색 + Bash 실행(codex/openai 전용 — claude 는 SDK 빌트인 Read/Write/Edit/Bash/Glob/Grep/WebFetch 사용, 이 서버명으로는 안 보임).",
    whenToUse: "코드/파일 작업, 셸 명령 실행이 필요할 때.",
    tools: [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "BashOutput",
      "KillShell",
      "WebFetch",
    ],
  },
};

/** agent-registry.ts DEFAULT_AGENT_INVOCATION_HINT 답습(비export 라 로컬 복제 — 3번째
 * 인스턴스 아님, find_capabilities 전용 디폴트). codex/openai 는 이 디폴트 그대로,
 * claude 는 호출부에서 Task 병기 문구로 override(agentIndex 와 동일 패턴). */
const DEFAULT_SUBAGENT_INVOCATION_HINT =
  "`spawn_agent({name, prompt})` 도구로 위임하세요";

const ACQUISITION_FOOTER =
  "\n\n---\n필요한 능력이 이번 턴에 없다면 습득을 고려하세요 — 새 스킬·서브에이전트는 `harness:harness`, 외부 도구 연결은 `add_mcp_server`, 외부 앱이 나를 호출하게는 `register_endpoint`. 습득 실행 전 위험하면 사용자 승인.";

const okText = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

const serializeHit = (h: CapabilityHit): string => {
  const toolsStr = h.tools.length > 0 ? ` (도구: ${h.tools.join(", ")})` : "";
  const availMark = h.available ? "" : " [이번 턴 비활성]";
  const whenStr = h.whenToUse !== undefined ? `\n    용도: ${h.whenToUse}` : "";
  return `- **${h.name}**${availMark} — ${h.summary}${toolsStr}${whenStr}`;
};

/**
 * find_capabilities MCP server 팩토리 (claude/codex/openai 공통, §3c 단일 팩토리).
 *
 *  - activeNames: 이 어댑터가 *이번 턴 실제로 빌드한* MCP 서버 맵/배열에서 파생한
 *    활성 서버명(게이트-aware). 자기 자신(find-capabilities)은 제외해도 무방(§3d).
 *  - subagentInvocationHint: "agents" 카탈로그 항목의 whenToUse 에 덧붙는 위임 도구
 *    안내. claude 호출부만 override(Task 병기), codex/openai 는 디폴트(spawn_agent).
 *  - extraMcpServers: router 가 주입하는 plugin MCP(scheduler·file-watch 등,
 *    `RegionASdkInput.extraMcpServers` — 세 어댑터 동일 shape). active 이지만 카탈로그에
 *    없는 이름이 여기 있으면 그 서버 `listTools()` description 에서 data-파생 요약을
 *    on-demand 로 만든다(호출 시점에만 bridge+listTools, 상시 비용 0). 카탈로그無∩
 *    extraMcpServers無(= 사용자가 `add_mcp_server` 로 연결한 외부 MCP)는 재연결 비용
 *    회피 위해 `list_mcp_servers` 로 유도하는 일반 설명만.
 */
export const createFindCapabilitiesMcpServer = (
  activeNames: ReadonlyArray<string>,
  subagentInvocationHint: string = DEFAULT_SUBAGENT_INVOCATION_HINT,
  extraMcpServers: Record<string, McpSdkServerConfigWithInstance> = {},
): McpSdkServerConfigWithInstance => {
  const findCapabilitiesTool = tool(
    "find_capabilities",
    "지금 이 턴에 실제로 쓸 수 있는 빌트인/플러그인 능력(엔드포인트·매니저·프로젝트·외부 MCP 관리·자가업데이트·슬래시명령·스케줄 등)을 조회합니다. 사용자의 간접 의도를 자기 도구로 매핑할 때, 또는 필요한 능력이 없어 습득 경로를 찾을 때 사용하세요. query 생략 시 전체 그룹 요약, query 지정 시 이름/설명/도구명 키워드 매칭.",
    { query: z.string().optional() },
    async (args) => {
      try {
        const activeSet = new Set(activeNames);
        const catalogNames = new Set(Object.keys(BUILTIN_CAPABILITY_CATALOG));

        const catalogHits: CapabilityHit[] = Object.entries(
          BUILTIN_CAPABILITY_CATALOG,
        ).map(([name, meta]) => ({
          name,
          summary: meta.summary,
          whenToUse:
            name === "agents"
              ? `${meta.whenToUse} ${subagentInvocationHint}.`
              : meta.whenToUse,
          tools: meta.tools,
          available: activeSet.has(name),
          source: "builtin" as const,
        }));

        // active 이지만 카탈로그에 없는 이름 = 플러그인(§0 — 코어 카탈로그엔 절대
        // 하드코딩하지 않음, 여기서 매 호출 data-파생).
        const pluginNames = [...activeSet].filter((n) => !catalogNames.has(n));
        const pluginHits: CapabilityHit[] = await Promise.all(
          pluginNames.map(async (name): Promise<CapabilityHit> => {
            const cfg = extraMcpServers[name];
            if (cfg === undefined) {
              // extraMcpServers 밖의 active 이름 = 사용자가 add_mcp_server 로 연결한
              // 외부 MCP. mcp-admin 이 이미 그 조회를 전담하므로 재연결 없이 유도만.
              return {
                name,
                summary: `외부 연결 MCP 서버(${name}) — 이번 턴 활성. \`list_mcp_servers\` 로 상세를 확인하세요.`,
                tools: [],
                available: true,
                source: "plugin",
              };
            }
            try {
              const bridge = await adaptClaudeMcpServer(cfg, name);
              try {
                const toolsRaw = await bridge.listTools();
                const toolNames = toolsRaw.map((t) => (t as { name: string }).name);
                const descs = toolsRaw
                  .map((t) => (t as { description?: string }).description)
                  .filter((d): d is string => d !== undefined && d !== "");
                return {
                  name,
                  summary:
                    descs.length > 0
                      ? descs.join(" / ")
                      : `플러그인 능력(${name}) — 이번 턴 활성.`,
                  tools: toolNames,
                  available: true,
                  source: "plugin",
                };
              } finally {
                await bridge.close().catch(() => {});
              }
            } catch {
              // listTools 실패 — throw 0, 최소 정보로 degrade(존재는 알림).
              return {
                name,
                summary: `플러그인 능력(${name}) — 이번 턴 활성(상세 조회 실패).`,
                tools: [],
                available: true,
                source: "plugin",
              };
            }
          }),
        );

        let hits = [...catalogHits, ...pluginHits];
        const query = args.query?.trim();
        if (query !== undefined && query !== "") {
          // 토큰 단위 OR 매칭 — 모델은 "웹훅 외부호출 webhook endpoint" 처럼 다중어 쿼리를
          // 자연스레 보낸다. 통짜 부분문자열(query 전체가 한 필드에 그대로)로는 그런 쿼리가
          // 어느 능력에도 없어 0매칭이 된다(라이브서 확인). 어느 한 토큰이라도 걸리면 hit,
          // 매칭 토큰 수로 정렬해 관련도 높은 능력을 위로. (find_skills 도 동일 한계 — 별건.)
          const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "");
          const score = (h: CapabilityHit): number => {
            const hay =
              `${h.name} ${h.summary} ${h.whenToUse ?? ""} ${h.tools.join(" ")}`.toLowerCase();
            return terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
          };
          hits = hits
            .map((h) => ({ h, s: score(h) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.h);
          if (hits.length === 0) {
            return okText(`'${query}' 에 매칭되는 능력이 없습니다.${ACQUISITION_FOOTER}`);
          }
        }

        const needsFooter = hits.some((h) => !h.available);
        const body = hits.map(serializeHit).join("\n");
        return okText(`## 능력 조회\n\n${body}${needsFooter ? ACQUISITION_FOOTER : ""}`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return createSdkMcpServer({
    name: "find-capabilities",
    version: "1.0.0",
    tools: [findCapabilitiesTool],
  });
};
