/**
 * 외부 MCP 서버 등록 도구 — add_mcp_server / list_mcp_servers / remove_mcp_server.
 * `<home>/mcp.json` 에 표준 MCP config 를 upsert/제거(external-mcp.ts). 이 도구는 파일만.
 *
 * ★**연결 시점 — 세 어댑터 모두 «다음 턴»** (2026-10-16 설정 핫 반영).
 *   - claude: 매 턴 `readExternalMcpServers(cwd)` 를 다시 읽어 SDK `options.mcpServers` 로 넘긴다.
 *   - codex·openai: 연결을 받을 때마다 `external-mcp.ts` 가 설정 파일을 다시 읽어 서버 단위로 맞춘다
 *     (새 것 연결 · 같은 것 재사용 · 바뀐 것 교체 · 빠진 것 은퇴 · 끊긴 것 재연결).
 *   종전(08-21~10-15)엔 codex·openai 가 프로세스당 1회(전역)·첫 위임 1회(프로젝트) 연결이라 «안 보이면 재시작» 을
 *   가르쳤다. 이제 안 보이면 재시작이 아니라 **연결 실패**다 — 로그를 보게 한다.
 *
 * 진실 소스 ADR: docs/decisions/2026-07-07-external-mcp-dynamic-connect.md §1b.
 *
 * ★보안(Q6): MCP 추가 = 임의 프로세스 spawn + 그 서버 도구 노출 = Bash급 위험. 도구 설명에
 * 명시하고, 비서는 SYSTEM.md(파괴적=명시승인) 대로 add 전 사용자 확인해야 한다(soft-gate,
 * 하드 훅 아님). 3어댑터 동일 등록(#2) — depth0 게이트는 어댑터가.
 */
import { coreMcpServer } from "./_core-server.js";
import path from "node:path";
import { listProjects } from "../../../store/projects.js";
import { getPaths } from "../../paths.js";
import { z } from "zod";
import {
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  upsertExternalMcpServer,
  removeExternalMcpServer,
  readExternalMcpServers,
  describeExternalMcpConfig,
  isProjectMcpCwd,
  type ExternalMcpConfig,
} from "../../external-mcp.js";
import { onDemand } from "../tool-load-policy.js";

const okText = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

/**
 * @param turnCwd 그 턴의 작업 폴더 — `path` 인자가 상대 경로일 때의 기준. ★종전엔 `path.resolve(인자)` 라 **데몬 process.cwd()** 기준이어서
 *  «이 프로젝트에 MCP 붙여 줘(path=".")» 가 설치 폴더의 `.mcp.json` 에 썼다(2026-10-09 적대 검토). 없으면 홈(file-ops 와 같은 기본).
 */
export const createMcpAdminMcpServer = (turnCwd?: string): McpSdkServerConfigWithInstance =>
  coreMcpServer({
    name: "mcp-admin",
    version: "1.0.0",
    tools: onDemand([
      tool(
        "add_mcp_server",
        "외부 MCP 서버를 등록합니다. path 미지정=전역(<home>/mcp.json, 어디서나) / path 지정=그 프로젝트 폴더 전용(<path>/.mcp.json, 그 프로젝트에 위임할 때만 도구 노출). stdio 는 command(+args,env), sse 는 url. **다음 턴부터 붙습니다 — 재시작은 필요 없습니다**(프로젝트 전용은 그 프로젝트에 위임하는 턴에). 다음 턴에도 그 서버의 도구가 안 보이면 연결이 실패한 것입니다 — 데몬 로그의 `external-mcp: … 연결 실패` 로 원인을 확인하세요. ★**특정 프로젝트에서만 의미 있는 서버는 반드시 path 를 지정하세요 — 전역에 넣지 마세요.** 판정: 그 서버가 특정 폴더·앱·저장소를 전제하면(예: 에디터 연동, 그 레포의 코드 색인) 프로젝트 전용입니다. 전역은 *어느 대화에서나 쓸 수 있는 것*만(예: 범용 검색). 전역에 잘못 넣으면 무관한 대화에도 도구가 실려 판단이 흐려지고, 그 앱이 안 떠 있는 기계에서는 **연결 실패가 계속 반복**됩니다(실사례 있음). 애매하면 사용자에게 물어보고, 기본은 프로젝트 전용입니다. ⚠️ 이 도구는 임의 명령(command)을 실행하고 그 서버의 도구를 당신에게 노출합니다 — Bash 급 위험이므로, 사용자가 명시적으로 요청/승인하지 않았으면 실행 전 반드시 확인하세요.",
        {
          name: z.string().min(1),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          url: z.string().optional(),
          path: z.string().optional(),
        },
        async (args) => {
          let config: ExternalMcpConfig;
          if (args.url !== undefined && args.url.trim() !== "") {
            config = { type: "sse", url: args.url.trim() };
          } else if (args.command !== undefined && args.command.trim() !== "") {
            config = {
              command: args.command.trim(),
              ...(args.args !== undefined ? { args: args.args } : {}),
              ...(args.env !== undefined ? { env: args.env } : {}),
            };
          } else {
            return errText(
              "command(stdio) 또는 url(sse) 중 하나는 필요합니다.",
            );
          }
          const projectPath =
            args.path !== undefined && args.path.trim() !== ""
              ? path.resolve(turnCwd ?? getPaths().home, args.path.trim())
              : undefined;
          // ★전역 등록 가드 (2026-08-07 사용자 지정: "프로젝트 레벨 전용 MCP 를 전역에 추가하면
          //  안 돼"). 실사고: 회사 PC 에 Unity MCP 가 **전역+프로젝트 양쪽**에 등록돼, 전역판이
          //  매 부팅 `연결 실패 — skip` 을 냈다. Unity 와 무관한 대화에도 딸려 붙는다 = 오염.
          //
          //  ★이름 목록이 아니라 **판정**이다: command·args 가 **등록된 프로젝트 폴더 안**을
          //  가리키는데 path 를 안 줬으면, 그건 그 프로젝트 전용이다. 새 서버가 생겨도 목록을
          //  고칠 필요가 없다. 판정을 못 하는 경우(범용 명령·URL)는 통과시킨다 — 오탐 0.
          if (projectPath === undefined) {
            const refs = [
              ...(args.command !== undefined ? [args.command] : []),
              ...(args.args ?? []),
            ].join(" ");
            let owning: string | undefined;
            try {
              for (const pr of listProjects()) {
                const dir = path.resolve(pr.path);
                if (dir !== "" && refs.includes(dir)) { owning = dir; break; }
              }
            } catch {
              /* 프로젝트 목록 조회 실패 — 가드 생략(등록을 막지 않는다) */
            }
            if (owning !== undefined) {
              return errText(
                `'${args.name}' 은 등록된 프로젝트 폴더(${owning})를 가리키는데 전역으로 등록하려 했습니다.\n` +
                  `프로젝트 전용으로 넣으세요: path="${owning}" 를 함께 지정하면 그 프로젝트에 위임할 때만 도구가 실립니다.\n` +
                  `전역은 어느 대화에서나 쓸 수 있는 서버만 — 전역에 넣으면 무관한 대화에도 실리고, 그 앱이 없는 기계에선 연결 실패가 계속 반복됩니다.`,
              );
            }
          }
          try {
            await upsertExternalMcpServer(args.name, config, projectPath);
            return okText(
              `외부 MCP 서버 '${args.name}' 등록됨 (${describeExternalMcpConfig(args.name, config)}) — ` +
                `${projectPath ? `프로젝트 전용 (${projectPath}/.mcp.json)` : "전역 (<home>/mcp.json)"}. ` +
                // ★신뢰된(등록된) 프로젝트 폴더가 아니면 세 어댑터 모두 그 .mcp.json 을 읽지 않는다(남의 레포의 command 실행 방지,
                //  project-trust) — «다음 턴부터 붙는다» 고 하면 거짓이 된다(적대 검토 F6).
                (projectPath !== undefined && !isProjectMcpCwd(projectPath)
                  ? `★이 폴더는 등록된 프로젝트가 아니라 아직 붙지 않습니다 — 사용자에게 묻고 project_register 로 등록하면 그 프로젝트에 위임하는 턴부터 붙습니다.`
                  : projectPath !== undefined
                    ? `★그 프로젝트에 위임하는 턴부터 그 서버의 도구가 붙습니다(재시작 불필요).`
                    : `★다음 턴부터 그 서버의 도구가 붙습니다(재시작 불필요).`),
            );
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "list_mcp_servers",
        "등록된 외부 MCP 서버 목록을 반환합니다. path 미지정=전역(<home>/mcp.json)만 / path 지정=전역+그 프로젝트(<path>/.mcp.json) 병합. 이건 **등록 목록**이지 연결 상태가 아닙니다 — 실제 연결은 데몬 로그에서 확인합니다.",
        { path: z.string().optional() },
        async (args) => {
          try {
            const cwd =
              args.path !== undefined && args.path.trim() !== ""
                ? path.resolve(turnCwd ?? getPaths().home, args.path.trim())
                : undefined;
            const servers = await readExternalMcpServers(cwd);
            const names = Object.keys(servers);
            if (names.length === 0) {
              return okText("등록된 외부 MCP 서버가 없습니다.");
            }
            const lines = names.map(
              (n) => `- ${describeExternalMcpConfig(n, servers[n]!)}`,
            );
            return okText(
              `등록된 외부 MCP 서버 ${names.length}개${cwd ? ` (전역+프로젝트 ${cwd})` : " (전역)"}:\n${lines.join("\n")}`,
            );
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "remove_mcp_server",
        "등록된 외부 MCP 서버를 제거합니다. path 미지정=전역(<home>/mcp.json) / path 지정=그 프로젝트(<path>/.mcp.json)에서 삭제. 다음 턴부터 그 서버의 도구가 빠집니다(이미 돌고 있는 턴이 쓰던 연결은 그 턴이 끝난 뒤 닫힙니다).",
        { name: z.string().min(1), path: z.string().optional() },
        async (args) => {
          try {
            const projectPath =
              args.path !== undefined && args.path.trim() !== ""
                ? path.resolve(turnCwd ?? getPaths().home, args.path.trim())
                : undefined;
            const had = await removeExternalMcpServer(args.name, projectPath);
            return okText(
              had
                ? `외부 MCP 서버 '${args.name}' 제거됨(등록 해제). 다음 턴부터 그 서버의 도구가 빠집니다.`
                : `'${args.name}' 은(는) 등록돼 있지 않습니다.`,
            );
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    ]),
  });
