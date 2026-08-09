/**
 * 회귀: **claude 어댑터가 앱 함수콜(externalTools)을 캡처한다** — ★행동 게이트 (2026-08-09).
 *
 * 사고: 한 설치본에서 외부 앱이 LLM 게이트웨이로 `tools[]` 를 보냈는데
 * **경고 한 줄 없이 버려지고** 평범한 텍스트가 돌아왔다. 앱 입장에선 "AI 가 도구를 안 쓴다"
 * 로만 보였고, 원인을 찾는 데 하루가 걸렸다. 뿌리는 두 겹이었다:
 *  ① claude 어댑터가 `externalTools` 를 **의도적으로 안 읽었다**(ADR 2026-07-25 §Decision-3).
 *  ② 그 사실이 **어디에도 안 드러났다** — 에러도 로그도 없이 성공한 텍스트 응답이 나갔다.
 *    codex 폴백이 429 로 막히자 claude 로 내려왔고, 그 폴백이 실패를 성공처럼 보이게 했다.
 *
 * ★ADR 이 "능력 공백 0" 의 근거로 든 prod 모드(openai 어댑터 + Anthropic OpenAI-호환)는
 *  **API 키를 전제**한다. 구독 OAuth 만 쓰는 설치본에선 그 전제가 성립하지 않아 공백이 실재했다.
 *  결정 문서가 **안 맞는 전제로 갭을 정당화**하고 있었다 — 이 검사가 그 자리를 지킨다.
 *
 * 등급: **행동 게이트**. 판정(`collectExternalToolCalls`)이 순수 함수라 데몬·SDK·네트워크
 * 없이 **실행**해서 검사한다. 배선(어댑터가 그 판정을 실제로 부르는가)만 소스 대조다.
 */
import { readFile } from "node:fs/promises";
import {
  collectExternalToolCalls,
  jsonSchemaToShape,
  stripServerPrefix,
  EXTERNAL_TOOLS_SERVER,
} from "../../core/llm-runtime/capabilities/external-tools.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ADAPTER = "../../../src/core/llm-runtime/adapters/claude-agent-sdk.ts";

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const names = new Set(["set_voxel_layers", "clear_scene"]);
const block = (type: string, extra: Record<string, unknown>): unknown => ({ type, ...extra });

export const check: RegressionCheck = {
  name: "external-tools-claude",
  guards:
    "claude 어댑터가 게이트웨이 앱 함수콜을 캡처한다 — 조용히 버려져 앱이 '도구를 안 쓴다'로만 보이던 것",
  run: async (): Promise<Assertion[]> => {
    const adapter = strip(
      await readFile(new URL(ADAPTER, import.meta.url), "utf8"),
    );

    // ── ①판정 실행: 단일 호출을 잡는다 ──
    const single = collectExternalToolCalls(
      [
        block("text", { text: "레이어를 채우겠습니다" }),
        block("tool_use", {
          id: "toolu_1",
          name: `mcp__${EXTERNAL_TOOLS_SERVER}__set_voxel_layers`,
          input: { layers: [1, 2] },
        }),
      ],
      names,
    );

    // ── ②★병렬 호출 전수: 한 메시지에 여러 개면 **전부** 잡아야 한다 ──
    //  MCP 핸들러에서 하나 잡고 abort 하는 설계였다면 여기서 1건만 나왔을 것이다.
    const parallel = collectExternalToolCalls(
      [
        block("tool_use", { id: "a", name: "set_voxel_layers", input: { n: 1 } }),
        block("tool_use", { id: "b", name: "clear_scene", input: {} }),
      ],
      names,
    );

    // ── ③tiguclaw 자기 도구는 캡처 대상이 아니다(게이트웨이 아닌 턴 오염 0) ──
    const ours = collectExternalToolCalls(
      [
        block("tool_use", { id: "x", name: "Read", input: { path: "a.ts" } }),
        block("tool_use", { id: "y", name: "mcp__memory__save_memory", input: {} }),
      ],
      names,
    );

    // ── ④깨진 블록은 그것만 건너뛴다 — 부분 캡처가 전무 캡처보다 낫다 ──
    const partial = collectExternalToolCalls(
      [
        block("tool_use", { name: "set_voxel_layers", input: {} }), // id 없음 → 스킵
        block("tool_use", { id: "ok", name: "clear_scene", input: { a: 1 } }),
        null,
        "쓰레기",
      ],
      names,
    );

    // ── ⑤externalTools 미지정 턴은 무영향(일반 대화 회귀 0) ──
    const noTools = collectExternalToolCalls(
      [block("tool_use", { id: "z", name: "set_voxel_layers", input: {} })],
      new Set<string>(),
    );

    // ── ⑥★앱 스키마 → 도구 스키마 번역 (실측이 잡은 결함 2건) ──
    //  ㉠키를 감싸면 앱 계약이 깨진다: 첫 판은 `{args: …}` 한 겹이라 모델이
    //    `{"args":{"layers":[…]}}` 를 보냈다(앱은 `{"layers":[…]}` 를 기대).
    //  ㉡타입을 안 옮기면 모델이 모양을 지어낸다: 전부 `unknown` 이던 두 번째 판에서
    //    배열을 **문자열** `"[1, 2, 3]"` 로 보냈다. 모델은 설명글이 아니라 형식 스키마를 본다.
    //  둘 다 읽어서는 안 보였고 실호출에서만 나왔다 — 그래서 여기에 못 박는다.
    const shape = jsonSchemaToShape({
      type: "object",
      properties: {
        layers: { type: "array", items: { type: "number" } },
        name: { type: "string" },
        count: { type: "integer" },
        flag: { type: "boolean" },
        mode: { type: "string", enum: ["a", "b"] },
        nested: { type: "object", properties: { x: { type: "number" } } },
      },
      required: ["layers"],
    });
    const keys = Object.keys(shape).sort().join(",");
    // 번역 결과를 **실행**해서 확인한다 — 배열은 배열만, 문자열은 거부.
    const layersOk =
      shape.layers?.safeParse([1, 2, 3]).success === true &&
      shape.layers?.safeParse("[1, 2, 3]").success === false;
    const countOk =
      shape.count?.safeParse(3).success === true && shape.count?.safeParse(1.5).success === false;
    const nestedOk = shape.nested?.safeParse({ x: 1 }).success === true;
    const noProps = Object.keys(jsonSchemaToShape({ type: "object" })).length === 0;

    // ── 배선: 어댑터가 판정을 실제로 부르고, 게이팅 밖에서 등록하고, 마감에서 실어 보낸다 ──
    const callsCollector = /collectExternalToolCalls\(/.test(adapter);
    // toolsNone 이어도 앱 도구는 붙어야 한다(게이트웨이는 toolPolicy:none 으로 온다).
    const outsideGate = /toolsNone\s*\?\s*\{\s*\.\.\.externalToolsMcp\s*\}/.test(adapter);
    // abort 를 에러로 승격하지 않는다(성공한 함수콜 턴이 폴백 풀을 태우면 안 된다).
    const abortAbsorbed =
      /pendingExternalToolCalls\.length > 0 && effectiveAc\.signal\.aborted/.test(adapter);
    // 텍스트 0 이어도 성공 — 도구만 부르고 마는 건 정상이다.
    const returnsCalls = /externalToolCalls: pendingExternalToolCalls/.test(adapter);

    return [
      assert(
        "단일 함수콜을 캡처한다(서버 접두를 벗겨 앱이 준 이름으로)",
        single.length === 1 &&
          single[0]?.name === "set_voxel_layers" &&
          single[0]?.argumentsJson === '{"layers":[1,2]}',
        `${String(single.length)}건 ${single[0]?.name ?? "-"} ${single[0]?.argumentsJson ?? "-"}`,
      ),
      assert(
        "★병렬 호출을 **전부** 잡는다(핸들러에서 하나씩 잡으면 형제를 잃는다)",
        parallel.length === 2 && parallel.map((c) => c.id).join(",") === "a,b",
        `${String(parallel.length)}건: ${parallel.map((c) => c.name).join(",")}`,
      ),
      assert(
        "tiguclaw 자기 도구는 캡처하지 않는다(일반 턴 오염 0)",
        ours.length === 0,
        ours.length === 0 ? "0건" : `★${String(ours.length)}건 샜다`,
      ),
      assert(
        "깨진 블록만 건너뛰고 나머지는 살린다(부분 캡처 > 전무 캡처)",
        partial.length === 1 && partial[0]?.id === "ok",
        `${String(partial.length)}건 ${partial[0]?.id ?? "-"}`,
      ),
      assert(
        "externalTools 없는 턴은 무영향(회귀 0)",
        noTools.length === 0,
        noTools.length === 0 ? "0건" : "★일반 턴을 건드렸다",
      ),
      assert(
        "접두 스트립이 접두 없는 이름도 안전하게 통과시킨다",
        stripServerPrefix("foo") === "foo" &&
          stripServerPrefix(`mcp__${EXTERNAL_TOOLS_SERVER}__foo`) === "foo",
        "양쪽 모두 foo",
      ),
      assert(
        "★앱 스키마 키가 **최상위 그대로** 노출된다(감싸면 앱 계약이 깨진다 — 실측 결함 ㉠)",
        keys === "count,flag,layers,mode,name,nested",
        keys,
      ),
      assert(
        "★타입을 옮긴다 — 배열은 배열만 통과, 문자열 거부(안 옮기면 모델이 문자열을 보낸다 — 실측 결함 ㉡)",
        layersOk === true && countOk === true && nestedOk === true,
        `array=${String(layersOk)} integer=${String(countOk)} object=${String(nestedOk)}`,
      ),
      assert(
        "properties 없는 스키마는 빈 shape(인자 없는 도구)",
        noProps,
        noProps ? "빈 shape" : "★없는 인자를 지어냈다",
      ),
      assert(
        "어댑터가 판정을 실제로 부른다",
        callsCollector,
        callsCollector ? "collectExternalToolCalls 호출" : "★판정이 배선 안 됨",
      ),
      assert(
        "★앱 도구는 toolPolicy:none **밖**에서 등록된다(게이트웨이는 항상 none 으로 온다)",
        outsideGate,
        outsideGate ? "toolsNone 에도 externalToolsMcp 유지" : "★게이트웨이에서 도구가 사라진다",
      ),
      assert(
        "우리가 낸 abort 를 실패로 승격하지 않는다(성공한 함수콜이 폴백을 태우면 안 된다)",
        abortAbsorbed,
        abortAbsorbed ? "abort 흡수" : "★함수콜 턴이 타임아웃/실패로 잡힌다",
      ),
      assert(
        "마감이 externalToolCalls 를 실어 보낸다(텍스트 0 이어도 성공)",
        returnsCalls,
        returnsCalls ? "반환부 배선됨" : "★캡처해놓고 안 돌려준다",
      ),
    ];
  },
};
