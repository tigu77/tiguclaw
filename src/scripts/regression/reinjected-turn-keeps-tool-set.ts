/**
 * 회귀: **합성 턴(매니저 완료·점검 재주입)도 그 스레드의 사용자 턴과 같은 도구 목록을 받는다** (2026-09-27, 윈도우 돌쇠 로그).
 *
 * ★사고: 세 어댑터 모두 파일 전송·선택지 도구를 **콜백이 있을 때만** 등록한다. 재주입 턴은 두 콜백이 비어, 같은 세션에서
 *  사용자 턴(67개)과 재주입 턴(65·66개)이 번갈아 오면 도구 목록이 흔들렸고, 도구 정의가 이력보다 앞이라 그때마다
 *  **이력 전체가 캐시를 못 탔다**(턴당 2만~6.7만 토큰, 지시문 지문은 동일).
 * ★첫 수정(항상 둘 다 채움)은 CLI(선택지만 받음)에서 불일치를 반대로 남겼다(아스트라 검토). 기준 = **그 스레드의 사용자
 *  턴이 실제로 받은 모양** — `turn-action-shape.ts`, 라우터가 적용한다.
 *
 * ① 실경로: router → 어댑터가 조립한 도구 정의(이름·내용·순서)를 모델 호출 없이 비교(자식 프로세스, 전용 홈).
 * ② 모듈: 모양을 모르는 스레드는 손대지 않고, 진짜 콜백(egress 선택지)은 덮지 않는다.
 * ③ 도구 응답: «이 턴에선 불가» 는 재시도를 권하지 않고, 일시 실패는 여전히 권한다.
 */
import { fileURLToPath } from "node:url";
import { createSendFileMcpServer } from "../../core/llm-runtime/capabilities/send-file-mcp.js";
import { createPromptOptionsMcpServer } from "../../core/llm-runtime/capabilities/prompt-options-mcp.js";
import { __resetTurnActionShapesForTest, turnActionsFor } from "../../core/turn-action-shape.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assert, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

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
  guards: "합성 턴이 파일 전송·선택지 도구를 사용자 턴과 다르게 받아 도구 목록이 흔들리고 이력 캐시가 깨지던 것 · 미지원 채널(CLI)에 없는 도구를 더 노출하던 것",
  run: async (): Promise<Assertion[]> => {
    // ① 실경로 — 전용 홈(공유 홈엔 다른 검사가 남긴 모델 설정이 있을 수 있다)
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(`${tmpdir()}/tiguclaw-regression-reinjected-tools-`);
    const child = await spawnWithin(90_000, "재주입 도구 목록 실경로", ["--import", "tsx", fileURLToPath(new URL("./_reinjected-tools-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: home } })
      .finally(() => rmSync(home, { recursive: true, force: true }));
    const line = child.out.split(/\r?\n/).find((l) => l.startsWith("TOOLS_RESULT "));
    const R = (line === undefined ? {} : JSON.parse(line.slice("TOOLS_RESULT ".length))) as Record<string, unknown>;

    // ② 모듈 — 모양 모름 · 진짜 콜백 보존 · 사용자 턴 그대로
    __resetTurnActionShapesForTest();
    const realOptions: IncomingMessage["presentOptions"] = async () => ({ ok: true });
    const realSend: IncomingMessage["sendAttachment"] = async () => ({ ok: true });
    const unknown = turnActionsFor("regr:m-unknown", { synthetic: true });
    const userOut = turnActionsFor("regr:m-both", { synthetic: false, sendAttachment: realSend, presentOptions: realOptions });
    const egress = turnActionsFor("regr:m-both", { synthetic: true, presentOptions: realOptions });
    const filled = turnActionsFor("regr:m-both", { synthetic: true });

    // ③ 도구 응답
    const sendText = filled.sendAttachment !== undefined ? await callSend(filled.sendAttachment) : "";
    const optText = filled.presentOptions !== undefined ? await callOptions(filled.presentOptions) : "";
    const transient = await callSend(async () => ({ ok: false, error: "네트워크 끊김" }));
    return [
      assert("재현 조건: 실경로 자식이 일곱 턴을 돌았다", Array.isArray(R.sizes) && (R.sizes as number[]).every((n) => n > 0) && R.error === "", { R, err: child.err.slice(-200) }),
      assert("★두 도구를 받는 스레드: 합성 턴의 도구 정의가 사용자 턴과 **바이트까지 같다**(이름·내용·순서)", R.bothEqual === true && R.bothHasSend === true, R),
      assert("★선택지만 받는 스레드(CLI 형태): 합성 턴도 같고, 사용자 턴에 없는 send_file 을 **더 노출하지 않는다**", R.cliEqual === true && R.cliSynthHasSend === false && R.cliHasOptions === true, R),
      assert("★세션 정규화(텔레그램 → 세션 id): 재주입 턴도 같은 도구 정의 — 모양은 정규화된 세션 id 로 맞춘다", R.normEqual === true, R),
      assert("모양을 모르는 스레드(재시작 직후 등)의 합성 턴은 채우지 않는다", R.unknownHasSend === false && unknown.sendAttachment === undefined && unknown.presentOptions === undefined, { R, unknown: Object.keys(unknown) }),
      assert("★사용자 턴의 콜백은 그대로 간다 · 합성 턴의 **진짜** 콜백(egress 선택지)은 덮지 않는다",
        userOut.sendAttachment === realSend && userOut.presentOptions === realOptions && egress.presentOptions === realOptions && egress.sendAttachment !== undefined,
        { user: Object.keys(userOut), egressReal: egress.presentOptions === realOptions }),
      assert("★send_file 은 «이 턴에선 불가 — 다시 부르지 말고 경로를 텍스트로» 라고 답한다(재시도 권유 아님)",
        sendText.includes("다시 호출하지 말고") && !sendText.includes("재시도"), sendText.slice(0, 120)),
      assert("★prompt_options 도 «다시 부르지 말고 텍스트로» 라고 답한다", optText.includes("다시 호출하지 말고") && !optText.includes("재시도"), optText.slice(0, 120)),
      assert("반대 방향: 일시 실패(표식 없음)는 여전히 재시도를 권한다", transient.includes("재시도") && !transient.includes("다시 호출하지 말고"), transient.slice(0, 120)),
    ];
  },
};
