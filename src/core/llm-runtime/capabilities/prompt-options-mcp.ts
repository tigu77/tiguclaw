/**
 * 영역 A — 객관식 선택지 제시(축1) in-process MCP server (factory).
 *
 * 진실 소스 / 패턴 동형:
 *  - `send-file-mcp.ts` 와 **완전 동형**(per-turn factory + 채널 클로저 주입 +
 *    미지원 graceful + per-turn dedup). send_file 이 채널 raw(telegram sendDocument)를
 *    추상 도구로 노출하듯, prompt_options 는 채널 raw(inline keyboard / 대시보드 버튼)를
 *    추상 도구로 노출한다.
 *  - ADR `2026-06-25-dashboard-chat-cc-parity.md` §2 (축1) + §10 contract 씨앗.
 *
 * 한 줄:
 *  비서가 agentic loop 중 `prompt_options(question, options[])` 를 호출하면, router 가
 *  채널 원본(IncomingMessage.presentOptions)에서 주입한 렌더 클로저로 선택지를 *1회*
 *  렌더한다. inline keyboard·버튼 raw 는 채널 어댑터 안에만 — 도구는 추상 의도
 *  (질문 + 보기 label/value)만 다룬다(LLM-agnostic).
 *
 * ★비차단 (핵심 — hung 턴 0):
 *  - 도구는 선택지를 *렌더/전송*하고 즉시 반환한다. 사용자 선택을 await 하지 않는다.
 *  - 사용자가 보기를 누르면 그 value 가 *사용자의 다음 인바운드 메시지*로 도착한다
 *    (텔레그램 callback → POST / 대시보드 버튼 → POST /messages 동형). 멀티턴 자연 표현.
 *  - 답을 받아야 하면 LLM 은 이 호출 뒤 턴을 마치고 다음 사용자 메시지에서 이어간다.
 *    (도구 description 이 이 의미를 LLM 에 명시 — 블로킹 대기 메커니즘 0, a05c368 교훈.)
 *
 * 멱등 (send_file 답습 — 중복 렌더 차단):
 *  - codex agentic 루프가 한 턴에 같은 질문을 2~3회 재호출하는 회귀를 차단.
 *  - per-turn `askedQuestions` Set(어댑터 함수 지역 변수)에 렌더한 question 을 기록.
 *    이미 있으면 *실제 렌더 없이* 중복 안내만 반환. 모듈 전역 가변 상태 0 (turn 격리).
 *
 * 채널 미지원 (cli·http-bridge·대시보드 미구현 등):
 *  - presentOptions === undefined → 렌더 시도 없이 "선택지 UI 미지원 — 질문과 보기를
 *    텍스트로 제시하라" graceful 반환. 양 어댑터(claude/codex) 동일 동작 (parity).
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { IncomingMessage } from "../../../channels/types.js";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

/**
 * prompt-options MCP server factory — 채널 렌더 클로저(presentOptions)와 per-turn
 * dedup Set(askedQuestions)을 클로저로 받는다. 도구 `prompt_options(question, options[])`.
 *
 * 양 어댑터(claude=mcpServers map / codex·openai=adaptClaudeMcpServer bridge)가 동형으로
 * 사용 → parity (원칙 1·2). presentOptions 가 undefined 인 turn(비채널·미지원 채널)에는
 * 도구가 미지원 안내(텍스트 제시 유도)로 닫는다.
 */
export const createPromptOptionsMcpServer = (
  presentOptions: IncomingMessage["presentOptions"],
  askedQuestions: Set<string>,
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "prompt-options",
    version: "1.0.0",
    tools: [
      tool(
        "prompt_options",
        "사용자에게 객관식 선택지를 제시할 때 사용합니다. 사용자가 보기를 누르면 그 값이 *사용자의 다음 메시지*로 도착합니다(비차단 — 이 도구는 답을 기다리지 않습니다). 답을 받아야 하면 이 호출 뒤 턴을 마치세요. 같은 질문을 중복 호출하지 마세요(중복 방지 내장). Bash/curl 로 텔레그램 키보드 API 를 직접 호출하지 말고 이 도구를 사용하세요.",
        {
          question: z
            .string()
            .min(1)
            .describe("사용자에게 묻는 질문(보기 위에 표시)."),
          options: z
            .array(
              z.object({
                label: z
                  .string()
                  .min(1)
                  .describe("사용자에게 보이는 보기 텍스트(버튼 라벨)."),
                value: z
                  .string()
                  .optional()
                  .describe(
                    "사용자가 이 보기를 고르면 다음 메시지로 도착할 값. 미지정 시 label 사용.",
                  ),
              }),
            )
            .min(2)
            .describe("제시할 보기 목록(2개 이상)."),
          note: z
            .string()
            .optional()
            .describe("보기 아래 보조 설명(선택)."),
        },
        async (args) => {
          // 채널 미지원(cli·http-bridge 미구현 등) — 렌더 없이 graceful 안내.
          if (presentOptions === undefined) {
            return okText(
              "이 채널은 선택지 UI 를 지원하지 않습니다. 질문과 보기를 텍스트(번호 목록 등)로 사용자에게 직접 제시하세요.",
            );
          }
          // ★멱등 — 이번 turn 에 이미 렌더한 질문이면 실제 렌더 안 함 (중복 차단).
          if (askedQuestions.has(args.question)) {
            return okText(
              "이미 이 턴에 같은 질문의 선택지를 제시했습니다(중복 방지). 다시 호출하지 말고 사용자의 다음 응답을 기다리려면 턴을 마치세요.",
            );
          }
          // value 미지정 시 label 을 value 로 정규화 (도구 인자 정규화 — 채널엔 완성형만).
          const normalized = args.options.map((o) => ({
            label: o.label,
            value: o.value !== undefined ? o.value : o.label,
          }));
          const r = await presentOptions(
            args.question,
            normalized,
            args.note !== undefined ? { note: args.note } : undefined,
          );
          // ★렌더 *성공* 시에만 dedup 기록 — 실패한 렌더가 같은 턴 재시도를 막지 않도록
          //  (실패=미기록→즉시 재시도 허용, 성공=기록→중복 렌더 차단). send_file 동형.
          if (r.ok) askedQuestions.add(args.question);
          return r.ok
            ? okText(
                "선택지를 제시했습니다. 사용자가 보기를 누르면 그 값이 다음 메시지로 도착합니다. 지금은 답을 기다리지 말고, 사용자 응답이 필요하면 이 턴을 마치세요.",
              )
            : okText(
                `선택지 제시 실패: ${r.error}. 일시적 오류일 수 있으니 다시 호출해 재시도할 수 있습니다(중복방지에 안 막힙니다). 반복 실패하면 그제서야 질문과 보기를 텍스트로 제시하세요.`,
              );
        },
      ),
    ],
  });
