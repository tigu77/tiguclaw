/**
 * 코어 능력 MCP 서버를 만드는 **한 통로** — 만들 때 그 도구 목록(이름·설명)을 기억한다 (2026-10-09 적대 검토 P3).
 *
 * ★왜 있나: `find_capabilities` 의 카탈로그가 **손 목록**이었다. 실제로 조립되는 코어 서버(session-tools·model-settings·
 *  home-widgets·tool-recall)가 카탈로그에 없어 «외부 연결 MCP · 도구 0개» 로 광고됐고, agents 항목엔 실제 도구
 *  (`wait_for_worker`·`read_worker_result`)가 빠져 있었고, «claude 는 SDK TodoWrite/Bash» 같은 낡은 문구가 남아 있었다.
 *  도구 목록은 **도구 정의가 정본**이다 — 서버를 만드는 순간 그 정의에서 읽어 둔다([[feedback_hand_maintained_lists]]).
 * ★이름별 «가장 최근에 만든» 목록이다. 어댑터는 턴마다 서버를 새로 만들고 `find_capabilities` 는 **그 직후** 만들어지므로
 *  (`createFindCapabilitiesMcpServer` 가 생성 시점에 떠 둔다) 같은 턴의 조립을 본다.
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

export interface CoreToolMeta {
  name: string;
  description: string;
}

const BUILT = new Map<string, CoreToolMeta[]>();

/** `createSdkMcpServer` 그대로 — 도구 목록만 곁에 적어 둔다. */
export const coreMcpServer = (opts: Parameters<typeof createSdkMcpServer>[0]): McpSdkServerConfigWithInstance => {
  BUILT.set(
    opts.name,
    (opts.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })),
  );
  return createSdkMcpServer(opts);
};

/** 그 이름의 코어 서버가 마지막으로 만들어질 때의 도구 목록 — 코어가 만든 적 없는 이름(플러그인·외부 MCP)이면 undefined. */
export const coreServerTools = (name: string): readonly CoreToolMeta[] | undefined => BUILT.get(name);
