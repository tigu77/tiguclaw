/**
 * 회귀: **선택지의 답이 «새 지시» 로 읽히지 않는다** (2026-09-03 사용자 신고, 실사례).
 *
 * ★사고: 비서가 `prompt_options` 로 *"이 근본 수정안을 구현하고 검증할까요?"* 를 묻고
 *  [수정 진행 / 원인 확인만] 을 냈다. 사용자가 **원인 확인만** 을 눌렀는데 비서가
 *  *"확인할 문제나 증상을 알려주세요"* 라고 답했다 — **자기가 방금 한 질문을 몰랐다.**
 *  사용자: *"바로 이전 맥락을 통해서 알 수 있는 부분 아닌가."*
 *
 * ★기제 (사슬 양끝을 다 확인했다):
 *  ①채널이 **고른 값만** 보낸다 — 대시보드 `sendChatMessage(value)` · 텔레그램 `ctx.reply(value)`.
 *  ②선택은 **다음 턴**에 도착한다.
 *  ③codex 이력은 턴 사이에 `{role, content}` **텍스트만** 나른다 — 질문이 든 `function_call`
 *    인자도, 도구 반환(`function_call_output`)도 남지 않는다.
 *  → 모델이 보는 것: `assistant: …원인만 확인했고 수정하지 않았습니다` / `user: 원인 확인만`.
 *    자기 마지막 문장과 겹치니 **답이 아니라 새 지시**로 읽힌다.
 *
 * ★고칠 자리를 **채널이 아니라 코어**로 잡았다: 채널을 고치면 세 곳을 손대야 하고 사용자가
 *  보는 자기 메시지도 바뀐다. 대화 컨텍스트는 **매 턴 fresh** 로 조립되므로 이력 보존과
 *  무관하게 닿는다.
 *
 * 등급: **동작**(레지스트리·포맷을 실제로 실행) + **배선**(세 어댑터가 좌표를 넘기는가).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearPendingOptions,
  pendingOptionsLine,
  rememberPendingOptions,
  takePendingOptions,
} from "../../core/pending-options.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
const TK = "dashboard:probe";

export const check: RegressionCheck = {
  name: "pending-options-carry-question",
  guards:
    "선택지를 고른 답이 «고른 값» 만 전달되고 질문은 턴 사이 이력에 안 남아, 비서가 자기가 방금 한 질문을 몰라 «무엇을 확인할까요» 로 되묻던 것 (2026-09-03 사용자 신고)",
  run: async (): Promise<Assertion[]> => {
    clearPendingOptions();
    const out: Assertion[] = [];

    // ① 기록 → 컨텍스트 줄에 질문과 보기가 실린다.
    rememberPendingOptions(TK, "이 수정안을 구현할까요?", ["수정 진행", "원인 확인만"]);
    const line = pendingOptionsLine(TK);
    out.push(
      assert(
        "★★질문이 다음 턴 컨텍스트에 실린다 — 이게 없으면 답이 «새 지시» 로 읽힌다",
        line.includes("이 수정안을 구현할까요?"),
        line === "" ? "★빈 줄" : line.slice(0, 60),
      ),
      assert(
        "★보기도 같이 실린다 — 모델이 «이번 메시지가 그 보기인가» 를 판정할 재료다",
        line.includes("수정 진행") && line.includes("원인 확인만"),
        line.includes("원인 확인만") ? "보기 포함" : "★보기 없음",
      ),
    );

    // ② ★한 턴만 산다 — 읽으면 지운다.
    out.push(
      assert(
        "★★한 턴만 산다 — 옛 질문이 계속 따라다니면 그게 오염이다",
        pendingOptionsLine(TK) === "",
        `2회차=${JSON.stringify(pendingOptionsLine(TK)).slice(0, 40)}`,
      ),
    );

    // ③ 낡은 것은 안 준다(시계 주입 — 검사가 기다리지 않게).
    rememberPendingOptions(TK, "오래된 질문", ["A"], 1_000);
    const stale = takePendingOptions(TK, 1_000 + 31 * 60_000);
    rememberPendingOptions(TK, "방금 질문", ["A"], 1_000);
    const fresh = takePendingOptions(TK, 1_000 + 5_000);
    out.push(
      assert(
        "★30분이 지난 질문은 안 준다 — 한참 뒤 다른 이야기를 시작할 수 있다",
        stale === undefined && fresh?.question === "방금 질문",
        `낡음=${String(stale)} · 최근=${String(fresh?.question)}`,
      ),
    );

    // ④ 다른 대화는 안 섞인다.
    clearPendingOptions();
    rememberPendingOptions("tg:1", "A 대화 질문", ["x"]);
    out.push(
      assert(
        "★대화마다 따로다 — 남의 질문이 내 턴에 실리면 그게 더 나쁘다",
        pendingOptionsLine("tg:2") === "" && pendingOptionsLine("tg:1") !== "",
        `tg:2=${JSON.stringify(pendingOptionsLine("tg:2"))} · tg:1 있음=${pendingOptionsLine("tg:1") !== ""}`,
      ),
    );

    // ⑤ 배선 — 렌더 **성공** 시에만 기록하고, 세 어댑터가 좌표를 넘긴다.
    const tool = read("src/core/llm-runtime/capabilities/prompt-options-mcp.ts");
    const adapters = [
      "claude-agent-sdk.ts",
      "openai-agents-sdk.ts",
      "openai-codex-oauth.ts",
    ].map((f) => read(`src/core/llm-runtime/adapters/${f}`));
    const wired = adapters.filter((s) =>
      /createPromptOptionsMcpServer\([\s\S]{0,120}?input\.threadKey/.test(s),
    ).length;
    out.push(
      assert(
        "★★렌더 **성공** 시에만 기록한다 — 사용자가 못 본 질문을 답으로 취급하면 안 된다",
        /if \(r\.ok\) \{[\s\S]{0,400}?rememberPendingOptions\(/.test(tool),
        /rememberPendingOptions\(/.test(tool) ? "성공 분기 안" : "★기록 안 함",
      ),
      assert(
        "★★세 어댑터가 **모두** 대화 좌표를 넘긴다 — 하나만 빠지면 그 어댑터에서만 되묻는다(무소음)",
        wired === 3,
        `배선 ${wired}/3`,
      ),
      assert(
        "★대화 컨텍스트가 그 줄을 싣는다 — 만들어놓고 안 부르면 장식이다",
        /pendingOptionsLine\(threadKey\)/.test(read("src/core/prompt-assembly.ts")),
        /pendingOptionsLine\(/.test(read("src/core/prompt-assembly.ts")) ? "호출됨" : "★미호출",
      ),
    );

    clearPendingOptions();
    return out;
  },
};
