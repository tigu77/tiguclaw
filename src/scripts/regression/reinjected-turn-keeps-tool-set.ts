/**
 * 회귀: **매니저 완료 재주입 턴도 사용자 턴과 같은 도구 목록을 받는다** (2026-09-27, 윈도우 돌쇠 로그).
 *
 * ★사고: 세 어댑터 모두 파일 전송·선택지 도구를 **콜백이 있을 때만** 등록한다. 재주입 턴은 `reply` 만 다시 만들고
 *  두 콜백을 비워, 같은 세션에서 사용자 턴(67개)과 재주입 턴(65·66개)이 번갈아 오면 도구 목록이 흔들렸다. 도구
 *  정의는 이력보다 앞이라 그때마다 **이력 전체가 캐시를 못 탔다**(턴당 2만~6.7만 토큰, 지시문 지문은 동일).
 * 처방: 재주입 턴이 두 자리를 «이 턴에선 불가» 로 채운다 — 어댑터 게이트(`!== undefined`)는 그대로라 세 LLM 에 같이 선다.
 *
 * 실제 생산부(`onWorkerComplete`)를 돌려 메인 핸들러가 받는 메시지를 본다. 모델 호출 0. 점검 재주입은
 * `job-checkin-reports`(자식)가 같은 성질을 본다.
 */
import { initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import { __resetJobsForTest, onWorkerComplete, registerJob, registerWorkerHandler } from "../../core/worker-jobs.js";
import { createSendFileMcpServer } from "../../core/llm-runtime/capabilities/send-file-mcp.js";
import { createPromptOptionsMcpServer } from "../../core/llm-runtime/capabilities/prompt-options-mcp.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

interface ToolReg { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const toolOf = (srv: unknown, name: string): ToolReg => {
  const t = (srv as { instance: { _registeredTools: Record<string, ToolReg> } }).instance._registeredTools[name];
  if (t === undefined) throw new Error(`도구 ${name} 없음`);
  return t;
};
const callSend = async (cb: IncomingMessage["sendAttachment"]) =>
  textOf(await toolOf(createSendFileMcpServer(cb, new Set()), "send_file").handler({ path: "/tmp/report.md" }, {}));
const callOptions = async (cb: IncomingMessage["presentOptions"]) =>
  textOf(await toolOf(createPromptOptionsMcpServer(cb, new Set(), "regr:reinjected-tools"), "prompt_options").handler(
    { question: "어느 쪽?", options: [{ label: "가" }, { label: "나" }] }, {}));

export const check: RegressionCheck = {
  name: "reinjected-turn-keeps-tool-set",
  guards: "매니저 완료 재주입 턴이 파일 전송·선택지 도구를 빠뜨려 도구 목록이 사용자 턴과 갈리고, 그때마다 이력 전체가 캐시를 못 타던 것",
  run: async (): Promise<Assertion[]> => {
    initEventBus();
    __resetJobsForTest();
    const CH = "regr-reinjected-tools";
    registerChannelOutbound(CH, { deliver: async () => {}, defaultOutboundTarget: async () => "regr-target" });
    let got: IncomingMessage | undefined;
    registerWorkerHandler(async (msg) => { got = msg; await msg.reply("답"); });
    const jobId = registerJob({ label: "회귀용 잡", task: "아무 일", threadKey: `${CH}:1`, channel: CH, channelUserId: "u" });
    await onWorkerComplete(jobId, { result: "결과물" });

    const sendText = got?.sendAttachment !== undefined ? await callSend(got.sendAttachment) : "";
    const optText = got?.presentOptions !== undefined ? await callOptions(got.presentOptions) : "";
    // 반대 방향 — 일시 실패(표식 없음)는 여전히 재시도를 권한다(표식이 모든 실패를 «불가» 로 바꾸면 안 된다).
    const transient = await callSend(async () => ({ ok: false, error: "네트워크 끊김" }));
    return [
      assert("재현 조건: 재주입이 메인 핸들러에 닿았다", got !== undefined && got.synthetic === true, got === undefined ? "미도달" : `synthetic=${String(got.synthetic)}`),
      assert("★재주입 턴에 파일 전송·선택지 자리가 **둘 다** 있다(= 어댑터가 사용자 턴과 같은 도구 목록을 등록)",
        typeof got?.sendAttachment === "function" && typeof got?.presentOptions === "function",
        { sendAttachment: typeof got?.sendAttachment, presentOptions: typeof got?.presentOptions }),
      assert("★send_file 은 «이 턴에선 불가 — 다시 부르지 말고 경로를 텍스트로» 라고 답한다(재시도 권유 아님)",
        sendText.includes("다시 호출하지 말고") && !sendText.includes("재시도"), sendText.slice(0, 120)),
      assert("★prompt_options 도 «다시 부르지 말고 텍스트로» 라고 답한다",
        optText.includes("다시 호출하지 말고") && !optText.includes("재시도"), optText.slice(0, 120)),
      assert("반대 방향: 일시 실패(표식 없음)는 여전히 재시도를 권한다", transient.includes("재시도") && !transient.includes("다시 호출하지 말고"), transient.slice(0, 120)),
    ];
  },
};
