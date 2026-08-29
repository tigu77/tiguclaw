/**
 * 회귀: **플러그인이 SDK 없이 도구를 선언한다** (2026-08-29).
 *
 * ★사고 — **레포 밖에서 가이드만 보고 만들어 홈에 깔았더니 첫 부팅에서 죽었다.**
 *
 * ```
 * [plugin-loader] hello-board load:
 *   Cannot find package '@anthropic-ai/claude-agent-sdk'
 *   imported from /tmp/tiguclaw-tp-home/plugins/hello-board/index.js
 * ```
 *
 * 가이드가 `import { tool } from "@anthropic-ai/claude-agent-sdk"` 를 시켰는데 **홈에 깔린
 * 플러그인엔 `node_modules` 가 없다.** 번들 플러그인은 이걸 영영 못 겪는다 — 레포
 * `node_modules` 가 상위에 있어 저절로 잡히기 때문이다([[feedback_dev_machine_config_leak]]:
 * 내 기계 배치가 제품 계약으로 승격됐다).
 *
 * ★`npm i` 를 문서화하는 건 답이 아니었다 — 실측 **247MB**. 도구 하나 선언하는 값으로
 *  플러그인마다 SDK 전체를 복사하게 할 수는 없다. 그래서 도구를 **평범한 데이터**로 받고
 *  코어가 MCP 서버로 만든다. 실측: 같은 플러그인이 **28KB · 의존성 0** 으로 돌았다.
 *
 * 지키는 것 다섯:
 *  ① ★**의존성 0으로 도구가 선다** — 선언에서 서버가 만들어진다.
 *  ② **나쁜 칸 하나는 그 도구만 떨어뜨린다** — 오타에 나머지가 같이 죽지 않는다(§D.1).
 *  ③ ★**핸들러가 던져도 턴이 안 죽는다** — 오류로 모델에게 돌아간다. 여기서 새면 서드파티
 *     도구 하나가 대화를 끊는다.
 *  ④ **문자열을 돌려주면 그게 답이다** — 대부분 이걸로 끝나야 한다(MCP 모양 강요 금지).
 *  ⑤ ★**`getMcpServer()` 는 그대로 산다** — SDK 를 이미 쓰는 사람이 안 깨진다.
 *
 * 등급: ①~④는 **동작**(순수 함수·실제 서버 생성·핸들러 실행), ⑤는 배선 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginHost } from "../../core/plugins/host.js";
import {
  buildToolServer,
  readToolSpecs,
  runToolHandler,
  type PluginToolSpec,
} from "../../core/plugins/tools.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST = createPluginHost("regr-tools", {});

const ok = (over: Partial<PluginToolSpec> = {}): unknown => ({
  name: "add_note",
  description: "메모를 적는다",
  parameters: { text: { type: "string", description: "내용" } },
  handler: async ({ text }: Record<string, unknown>) => `적었습니다: ${String(text)}`,
  ...over,
});

export const check: RegressionCheck = {
  name: "plugin-tools-without-sdk",
  guards:
    "홈에 깔린 서드파티 플러그인이 SDK 를 import 하다 로드에서 죽던 것(node_modules 가 없다 — 번들 플러그인은 레포 node_modules 덕에 영영 못 겪는 부류) + 그 해법으로 플러그인마다 247MB 를 깔게 하는 것 + 선언 오타 하나가 나머지 도구까지 죽이는 것 + 서드파티 도구의 예외가 대화를 끊는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 의존성 0으로 도구가 선다 ─────────────────────────────────────────
    const v = readToolSpecs([ok()]);
    const server = buildToolServer("regr-tools", v.specs, HOST);
    out.push(
      assert(
        "★★평범한 데이터 선언에서 **MCP 서버가 만들어진다** — 플러그인은 아무것도 import 하지 않는다(홈에 깔리면 `node_modules` 가 없어서 import 자체가 로드에서 죽는다)",
        v.problems.length === 0 && v.specs.length === 1 && server !== undefined,
        `문제 ${String(v.problems.length)}건 · 도구 ${String(v.specs.length)}개 · 서버 ${server === undefined ? "없음" : "생성됨"}`,
      ),
    );

    // ── ② 나쁜 칸 하나는 그 도구만 ──────────────────────────────────────────
    // ★표본이 **모든 거부 갈래를 밟아야** 한다 — 처음엔 전부 객체라 "객체가 아님" 갈래를
    //  한 번도 안 밟았고, 그 자리에 변이를 넣어도 초록이었다(자격증명 가드에서 겪은 것과
    //  같은 형태: 개수가 많아도 규칙을 다 안 밟으면 표본이 아니다).
    const mixed = readToolSpecs([
      ok(),
      "문자열",
      null,
      42,
      ok({ name: "Bad-Name" }),
      { description: "이름 없음", handler: async () => "x" },
      ok({ name: "no_desc", description: "" }),
      ok({ name: "not_fn", handler: "함수 아님" as never }),
      ok({ name: "bad_param", parameters: { x: { type: "object" } } as never }),
      ok({ name: "add_note" }), // 중복
      ok({ name: "second" }),
    ]);
    out.push(
      assert(
        "★★나쁜 칸이 섞여도 **멀쩡한 것은 산다** — 오타 하나에 그 플러그인의 도구가 통째로 죽으면, 작성자는 무엇이 문제인지 모른 채 전부를 뒤진다",
        mixed.specs.length === 2 &&
          mixed.specs.map((s) => s.name).join(",") === "add_note,second" &&
          mixed.problems.length === 9,
        `살아남음 [${mixed.specs.map((s) => s.name).join(", ")}] · 떨어뜨림 ${String(mixed.problems.length)}건`,
      ),
    );
    out.push(
      assert(
        "★배열이 아니면 통째로 거부하되 **이유를 남긴다**(도구가 조용히 0개가 되지 않는다)",
        readToolSpecs("배열 아님").problems.length === 1 &&
          readToolSpecs(undefined).problems.length === 0,
        `비배열→${String(readToolSpecs("배열 아님").problems.length)}건 · 미선언→${String(readToolSpecs(undefined).problems.length)}건(정상)`,
      ),
    );
    out.push(
      assert(
        "★거부 사유가 **무엇을 고칠지** 말한다 — `false` 만 받으면 작성자는 자기 코드를 뒤진다",
        mixed.problems.some((p) => p.includes("name")) &&
          mixed.problems.some((p) => p.includes("description")) &&
          mixed.problems.some((p) => p.includes("중복")) &&
          mixed.problems.some((p) => p.includes("객체가 아닙니다")),
        mixed.problems[0]?.slice(0, 60) ?? "(없음)",
      ),
    );

    // ── ③ 핸들러가 던져도 턴이 안 죽는다 (실행) ─────────────────────────────
    const boom = readToolSpecs([
      ok({
        name: "boom",
        handler: async () => {
          throw new Error("서드파티 폭발");
        },
      }),
    ]).specs[0];
    let escaped = false;
    let result: Awaited<ReturnType<typeof runToolHandler>> | undefined;
    try {
      result = await runToolHandler(boom as PluginToolSpec, {}, HOST);
    } catch {
      escaped = true;
    }
    out.push(
      assert(
        "★★도구가 던져도 **값으로 답한다**(isError) — 여기서 새면 서드파티 도구 하나가 대화를 끊는다. 모델은 사유를 읽고 다시 시도하거나 사람에게 말할 수 있다",
        !escaped && result?.isError === true && result.content[0]?.text === "서드파티 폭발",
        escaped ? "★예외가 샜다" : `isError=${String(result?.isError)} · "${result?.content[0]?.text ?? ""}"`,
      ),
    );

    // ── ④ 문자열이면 그게 답 ────────────────────────────────────────────────
    const plain = await runToolHandler(readToolSpecs([ok()]).specs[0] as PluginToolSpec, { text: "안녕" }, HOST);
    const shaped = await runToolHandler(
      readToolSpecs([ok({ name: "shaped", handler: async () => ({ text: "모양", isError: true }) })])
        .specs[0] as PluginToolSpec,
      {},
      HOST,
    );
    out.push(
      assert(
        "★**문자열을 돌려주면 그게 답**이다 — 대부분 이걸로 끝나야 한다(MCP 응답 모양을 외우게 하지 않는다). 필요하면 `{text, isError}` 도 받는다",
        plain.content[0]?.text === "적었습니다: 안녕" &&
          plain.isError === undefined &&
          shaped.isError === true,
        `문자열→"${plain.content[0]?.text ?? ""}" · 객체→isError=${String(shaped.isError)}`,
      ),
    );

    // ── ⑤ 옛 길이 그대로 산다 ───────────────────────────────────────────────
    const wire = readFileSync(path.join(REPO, "src/core/plugins/wire.ts"), "utf8");
    out.push(
      assert(
        "★`getMcpServer()` 길이 **그대로 산다** — SDK 를 이미 쓰는 플러그인(번들 포함)이 안 깨진다. 둘은 형제지 대체가 아니다",
        wire.includes("inst.getMcpServer === \"function\"") && wire.includes("inst.getTools === \"function\""),
        `getMcpServer ${wire.includes("inst.getMcpServer") ? "유지" : "★사라짐"} · getTools ${wire.includes("inst.getTools") ? "추가됨" : "★없음"}`,
      ),
    );

    // ── 거짓 경고 — 낼 것을 냈으면 그게 곧 service ───────────────────────────
    out.push(
      assert(
        "★★도구·라우트를 낸 `service` 에게 *\"아무것도 없습니다\"* 라고 경고하지 않는다 — 실측으로 레포 밖 플러그인이 첫 부팅에서 이 경고를 받았고, 작성자 입장에선 **뭘 잘못했는지 알 수 없는 거짓 신호**다(아무것도 안 틀렸다)",
        // ★**단어가 있나** 가 아니라 **가드가 걸려 있나**를 본다. 처음엔 전자였고, 가드만
        //  지우고 선언을 남기는 변이에 그대로 초록이었다([[feedback_gate_must_actually_run]]).
        /if \(!alreadyProvides\) skip\(/.test(wire) &&
          /result\.wired\.includes\("tools"\)/.test(wire),
        /if \(!alreadyProvides\) skip\(/.test(wire)
          ? "skip 이 alreadyProvides 로 막혀 있다"
          : "★가드 없음 — 낸 것이 있어도 경고한다",
      ),
    );

    return out;
  },
};
