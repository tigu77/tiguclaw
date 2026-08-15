/**
 * 외부 MCP 서버 등록 도구 — add_mcp_server / list_mcp_servers / remove_mcp_server.
 * `<home>/mcp.json` 에 표준 MCP config 를 upsert/제거(external-mcp.ts). 연결은 어댑터가
 * 재시작 시 수행(claude=SDK 네이티브 / codex·openai=클라이언트 브리지). 이 도구는 파일만.
 *
 * 진실 소스 ADR: docs/decisions/2026-07-07-external-mcp-dynamic-connect.md §1b.
 *
 * ★보안(Q6): MCP 추가 = 임의 프로세스 spawn + 그 서버 도구 노출 = Bash급 위험. 도구 설명에
 * 명시하고, 비서는 SYSTEM.md(파괴적=명시승인) 대로 add 전 사용자 확인해야 한다(soft-gate,
 * 하드 훅 아님). 3어댑터 동일 등록(#2) — depth0 게이트는 어댑터가.
 */
import path from "node:path";
import { listProjects } from "../../../store/projects.js";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  upsertExternalMcpServer,
  removeExternalMcpServer,
  readExternalMcpServers,
  describeExternalMcpConfig,
  type ExternalMcpConfig,
} from "../../external-mcp.js";

const okText = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

export const createMcpAdminMcpServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "mcp-admin",
    version: "1.0.0",
    tools: [
      tool(
        "add_mcp_server",
        "외부 MCP 서버를 등록합니다. path 미지정=전역(<home>/mcp.json, 어디서나) / path 지정=그 프로젝트 폴더 전용(<path>/.mcp.json, 그 프로젝트에 위임할 때만 도구 노출). stdio 는 command(+args,env), sse 는 url. **등록 후 재시작해야 실제로 연결됩니다.** ★**특정 프로젝트에서만 의미 있는 서버는 반드시 path 를 지정하세요 — 전역에 넣지 마세요.** 판정: 그 서버가 특정 폴더·앱·저장소를 전제하면(예: 에디터 연동, 그 레포의 코드 색인) 프로젝트 전용입니다. 전역은 *어느 대화에서나 쓸 수 있는 것*만(예: 범용 검색). 전역에 잘못 넣으면 무관한 대화에도 도구가 실려 판단이 흐려지고, 그 앱이 안 떠 있는 기계에서는 **매 부팅 연결 실패**가 납니다(실사례 있음). 애매하면 사용자에게 물어보고, 기본은 프로젝트 전용입니다. ⚠️ 이 도구는 임의 명령(command)을 실행하고 그 서버의 도구를 당신에게 노출합니다 — Bash 급 위험이므로, 사용자가 명시적으로 요청/승인하지 않았으면 실행 전 반드시 확인하세요.",
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
              ? path.resolve(args.path.trim())
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
                  `전역은 어느 대화에서나 쓸 수 있는 서버만 — 전역에 넣으면 무관한 대화에도 실리고, 그 앱이 없는 기계에선 매 부팅 연결 실패가 납니다.`,
              );
            }
          }
          try {
            await upsertExternalMcpServer(args.name, config, projectPath);
            return okText(
              `외부 MCP 서버 '${args.name}' 등록됨 (${describeExternalMcpConfig(args.name, config)}) — ` +
                `${projectPath ? `프로젝트 전용 (${projectPath}/.mcp.json)` : "전역 (<home>/mcp.json)"}. ` +
                `★재시작해야 연결됩니다 — 사용자에게 재시작할지 물어보세요.`,
            );
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "list_mcp_servers",
        "등록된 외부 MCP 서버 목록을 반환합니다. path 미지정=전역(<home>/mcp.json)만 / path 지정=전역+그 프로젝트(<path>/.mcp.json) 병합. 실제 연결 여부는 재시작 후 로그로 확인.",
        { path: z.string().optional() },
        async (args) => {
          try {
            const cwd =
              args.path !== undefined && args.path.trim() !== ""
                ? path.resolve(args.path.trim())
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
        "등록된 외부 MCP 서버를 제거합니다. path 미지정=전역(<home>/mcp.json) / path 지정=그 프로젝트(<path>/.mcp.json)에서 삭제. 재시작하면 연결이 끊깁니다.",
        { name: z.string().min(1), path: z.string().optional() },
        async (args) => {
          try {
            const projectPath =
              args.path !== undefined && args.path.trim() !== ""
                ? path.resolve(args.path.trim())
                : undefined;
            const had = await removeExternalMcpServer(args.name, projectPath);
            return okText(
              had
                ? `외부 MCP 서버 '${args.name}' 제거됨. 재시작하면 연결이 끊깁니다.`
                : `'${args.name}' 은(는) 등록돼 있지 않습니다.`,
            );
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    ],
  });
