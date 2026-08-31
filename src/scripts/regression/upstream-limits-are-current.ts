/**
 * 회귀: **"알려진 상류 한계" 목록이 아직 참인가** (2026-08-31).
 *
 * ★이 목록은 **부채다.** 우리가 못 고치는 업스트림 결함을 사용자에게 설명해 주는 대신,
 *  업스트림이 고치는 순간 **거짓말이 된다.** 그리고 거짓 설명은 없느니만 못하다 — 사용자가
 *  되는 걸 안 된다고 믿고 우회한다.
 *
 * ★그래서 **원인을 직접 본다.** `@openai/agents` 의 ChatCompletions 조립기는 같은 SDK 안에서
 *  비대칭이다: 비스트리밍은 `tool_call` 의 나머지 필드를 `providerData` 로 보존해 요청
 *  재조립 때 되돌리는데, **스트리밍은 다섯 필드만 조립하고 providerData 를 안 만든다.**
 *  Gemini 3.x 처럼 `thought_signature` 를 되돌려받아야 하는 provider 는 그래서 400 이 난다
 *  (실측: 버리면 400 / 되돌려주면 200).
 *
 * 이 검사가 빨개지면 = **업스트림이 고쳐졌다.** 그때 할 일은 목록에서 그 항목을 지우고
 * 이 검사도 같이 지우는 것이다(부채 상환).
 *
 * 등급: 대조(설치된 SDK 소스) + **동작**(해설 함수를 실제로 실행).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upstreamLimitNote } from "../../core/llm-runtime/index.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SDK = "node_modules/@openai/agents-openai/dist";

export const check: RegressionCheck = {
  name: "upstream-limits-are-current",
  guards:
    "우리가 못 고치는 업스트림 결함을 설명해 주는 목록이 업스트림 수정 뒤에도 남아, 되는 걸 안 된다고 말하게 되는 것(거짓 설명은 없느니만 못하다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 해설이 실제로 붙는가 — 문자열 존재가 아니라 실행으로.
    const note = upstreamLimitNote(
      '400 {"error":{"message":"Function call is missing a thought_signature in functionCall parts."}}',
    );
    out.push(
      assert(
        "★알려진 상류 한계에 **해설이 붙는다** — 상류 원문만 보면 사용자가 자기 설정을 의심한다(진단하던 나 자신이 두 번 오판했다)",
        note.includes("도구 호출이 안 됩니다"),
        note === "" ? "★해설 0" : `${note.slice(0, 40)}…`,
      ),
    );
    out.push(
      assert(
        "★반대 방향 — **모르는 오류엔 해설을 지어내지 않는다**(아무 데나 붙이면 그 자체가 오정보다)",
        upstreamLimitNote("404 model not found") === "",
        `무관 오류 해설 = "${upstreamLimitNote("404 model not found")}"`,
      ),
    );

    // ② 원인이 아직 살아 있는가 — 살아 있어야 위 해설이 참이다.
    const stream = path.join(REPO, SDK, "openaiChatCompletionsStreaming.js");
    const model = path.join(REPO, SDK, "openaiChatCompletionsModel.js");
    if (!existsSync(stream) || !existsSync(model)) {
      out.push(assert("SDK 소스 없음(배포 트리·미설치) — 이 축은 건너뛴다", true, "건너뜀"));
      return out;
    }
    const s = readFileSync(stream, "utf8");
    const m = readFileSync(model, "utf8");
    // 비스트리밍은 function_call 을 만들 때 providerData 를 채운다.
    const nonStreamKeeps = /type: 'function_call'[\s\S]{0,400}?providerData:/.test(m);
    // 스트리밍은 안 채운다 — 이게 결함이다.
    const streamDrops = !/type: 'function_call'[\s\S]{0,400}?providerData:/.test(s);

    out.push(
      assert(
        "★★업스트림 비대칭이 **아직 살아 있다**(비스트리밍은 보존 · 스트리밍은 버림) — 빨개지면 SDK 가 고쳐진 것이니 위 해설 항목과 이 검사를 **같이 지워라**",
        nonStreamKeeps && streamDrops,
        `비스트리밍 보존=${String(nonStreamKeeps)} · 스트리밍 버림=${String(streamDrops)}`,
      ),
    );
    return out;
  },
};
