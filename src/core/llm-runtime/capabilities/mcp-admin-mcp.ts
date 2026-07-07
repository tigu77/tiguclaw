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
        "외부 MCP 서버를 등록합니다(<home>/mcp.json 에 저장). stdio 는 command(+args,env), sse 는 url. **등록 후 재시작해야 실제로 연결됩니다.** ⚠️ 이 도구는 임의 명령(command)을 실행하고 그 서버의 도구를 당신에게 노출합니다 — Bash 급 위험이므로, 사용자가 명시적으로 요청/승인하지 않았으면 실행 전 반드시 확인하세요.",
        {
          name: z.string().min(1),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          url: z.string().optional(),
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
          try {
            await upsertExternalMcpServer(args.name, config);
            return okText(
              `외부 MCP 서버 '${args.name}' 등록됨 (${describeExternalMcpConfig(args.name, config)}). ` +
                `★재시작해야 연결됩니다 — 사용자에게 재시작할지 물어보세요.`,
            );
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "list_mcp_servers",
        "등록된 외부 MCP 서버 목록을 반환합니다(<home>/mcp.json). 실제 연결 여부는 재시작 후 로그로 확인.",
        {},
        async () => {
          try {
            const servers = await readExternalMcpServers();
            const names = Object.keys(servers);
            if (names.length === 0) {
              return okText("등록된 외부 MCP 서버가 없습니다.");
            }
            const lines = names.map(
              (n) => `- ${describeExternalMcpConfig(n, servers[n]!)}`,
            );
            return okText(
              `등록된 외부 MCP 서버 ${names.length}개:\n${lines.join("\n")}`,
            );
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "remove_mcp_server",
        "등록된 외부 MCP 서버를 제거합니다(<home>/mcp.json 에서 삭제). 재시작하면 연결이 끊깁니다.",
        { name: z.string().min(1) },
        async (args) => {
          try {
            const had = await removeExternalMcpServer(args.name);
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
