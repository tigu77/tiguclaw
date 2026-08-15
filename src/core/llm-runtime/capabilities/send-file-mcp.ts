/**
 * 영역 A — 네이티브 멱등 아웃바운드 파일전송 in-process MCP server (factory).
 *
 * 진실 소스 / 패턴 동형:
 *  - `reply-intent-mcp.ts` (per-turn factory + onCalled 클로저 — *역방향* 패턴).
 *    reply-intent 가 채널 raw(reply_parameters) 를 추상 의도로 마킹하듯,
 *    send_file 은 채널 raw(telegram sendDocument) 를 추상 도구로 노출한다.
 *  - `todo-mcp.ts` (tool() 의 Zod 인자 스키마 정의 패턴 — path/caption 인자).
 *
 * 한 줄:
 *  비서가 agentic loop 중 `send_file(path, caption?)` 를 호출하면, router 가 채널
 *  원본(IncomingMessage.sendAttachment)에서 주입한 전송 클로저로 *1회* 전송한다.
 *  토큰/Bot API raw 는 채널 어댑터 안에만 — 도구는 절대경로+caption 만 다룬다.
 *
 * 멱등 (★핵심 — 중복 전송 차단):
 *  - codex agentic 루프가 한 턴에 같은 전송을 2~3회 재호출하는 회귀를 차단.
 *  - per-turn `sentPaths` Set(어댑터 함수 지역 변수)에 전송한 절대경로를 기록.
 *    이미 있으면 *실제 전송 없이* 중복 안내만 반환.
 *  - 모듈 전역 가변 상태 0 — 동시 turn 마다 별 Set → 교차 오염 0 (reply-intent
 *    per-turn flag 와 동형, Node 단일 스레드 + 함수 프레임 격리).
 *
 * 채널 미지원 (cli·http-bridge):
 *  - sendAttachment === undefined → 전송 시도 없이 "이 채널 미지원, 경로 텍스트
 *    안내" graceful 반환. 양 어댑터(claude/codex) 동일 동작 (LLM-agnostic parity).
 */
import { createOurMcpServer } from "./_our-mcp.js";
import { z } from "zod";
import {
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { IncomingMessage } from "../../../channels/types.js";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

/**
 * send-file MCP server factory — 채널 전송 클로저(sendAttachment)와 per-turn
 * dedup Set(sentPaths)을 클로저로 받는다. 도구 `send_file(path, caption?)`.
 *
 * 양 어댑터(claude=mcpServers map / codex=adaptClaudeMcpServer bridge)가 동형으로
 * 사용 → parity (원칙 1·2). sendAttachment 가 undefined 인 turn(스케줄러 등 비채널)
 * 에는 어댑터가 아예 등록하지 않거나, 등록되더라도 도구가 미지원 안내로 닫는다.
 */
export const createSendFileMcpServer = (
  sendAttachment: IncomingMessage["sendAttachment"],
  sentPaths: Set<string>,
): McpSdkServerConfigWithInstance =>
  createOurMcpServer({
    name: "send-file",
    version: "1.0.0",
    tools: [
      tool(
        "send_file",
        "사용자에게 파일을 보낼 때 사용합니다. 절대경로를 지정하세요. 한 파일당 1회만 호출하세요(중복 방지 내장 — 같은 경로 재호출 시 실제 전송 없이 차단). Bash/curl 로 텔레그램 API 를 직접 호출하지 말고 이 도구를 사용하세요.",
        {
          path: z
            .string()
            .min(1)
            .describe("전송할 파일의 절대경로."),
          caption: z
            .string()
            .optional()
            .describe("파일과 함께 보낼 설명(선택)."),
        },
        async (args) => {
          // 채널 미지원(cli 등) — 전송 시도 없이 graceful 안내. (telegram=sendDocument,
          // http-bridge/대시보드=attachments 다운로드 카드로 지원. cli 는 sendAttachment 미정의.)
          if (sendAttachment === undefined) {
            return okText(
              "이 채널은 파일 전송을 지원하지 않습니다. 사용자에게 파일 절대경로를 텍스트로 안내하세요.",
            );
          }
          // ★멱등 — 이번 turn 에 이미 보낸 경로면 실제 전송 안 함 (중복 차단).
          if (sentPaths.has(args.path)) {
            return okText(
              "이미 이 턴에 전송했습니다(중복 방지). 다시 호출하지 마세요.",
            );
          }
          const r = await sendAttachment(
            args.path,
            args.caption !== undefined ? { caption: args.caption } : undefined,
          );
          // ★전송 *성공* 시에만 dedup 기록 — 실패한 전송이 같은 턴 재시도를 막지
          // 않도록 (실패=미기록→즉시 재시도 허용, 성공=기록→중복 전송 차단). 단일
          // turn 은 도구 호출이 순차라 첫 await 종료 후에만 재호출 가능 = race 없음.
          // (구버전은 시도 전 기록 → 첫 전송 실패가 dedup 을 오염시켜 같은 턴 재시도를
          //  전부 "이미 전송" 으로 막는 버그. 2026-06-24 수정.)
          if (r.ok) sentPaths.add(args.path);
          return okText(
            r.ok
              ? `전송 완료: ${args.path}`
              : `전송 실패: ${r.error}. 일시적 오류일 수 있으니 같은 경로로 다시 호출해 즉시 재시도할 수 있습니다(중복방지에 안 막힙니다). 반복 실패하면 그제서야 경로를 텍스트로 안내하세요.`,
          );
        },
      ),
    ],
  });
