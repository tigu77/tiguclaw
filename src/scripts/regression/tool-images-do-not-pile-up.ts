/**
 * 회귀: **도구가 돌려준 이미지는 쌓이지 않는다 — 그리고 사용자가 보낸 사진은 안 지운다**
 * (2026-09-15).
 *
 * ★사고: `compactOldToolOutputs` 는 `function_call_output` **만** 훑는데, 도구 결과의
 *  이미지는 2026-08-01 부터 그 자리에 없다(문자열 전용이라 **별도 user 메시지**로 뗀다).
 *  그래서 **아무 규칙도 이미지를 안 셌다.** 실제 push 패턴을 재현해 재보니:
 *
 *      관측 20회 × 500KB  →  요청 13,339,344B · 이미지 20장 · 압축 0건
 *
 *  압축 0건은 정상이었다 — 남은 텍스트가 `CODEX_COMPACT_MIN_OUTPUT` 아래라 텍스트 규칙이
 *  **올바르게** 아무것도 안 한 것이다. 없던 건 이미지 규칙이다.
 *
 * ★같은 자리에서 agents-SDK 어댑터는 더 나빴다 — 이미지 경로가 **아예 없어** SDK 가
 *  콘텐츠 블록을 그대로 도구 출력으로 넘겼고(`content.length === 1 ? content[0] : content`),
 *  **base64 가 텍스트로** 실렸다. 어댑터마다 결과가 갈리는 건 원칙 2 위반이다.
 *
 * ★등급: 핫경로(요청 조립). **소스를 읽지 않고 실행해서 판정한다** — 종전에 «리터럴이
 *  있는가» 로 재던 검사가 값만 바꾼 변이를 통과시킨 적이 있다
 *  ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못 놓인 것").
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import {
  compactOldToolOutputs,
  compactOldToolMedia,
  appendToolResultsToInput,
  buildSteeringInputItem,
  type ResponseInputItem,
} from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import {
  splitMcpToolContent,
  emptyToolText,
  toolResultForAdapter,
  createToolMediaWindow,
  TOOL_MEDIA_KEEP_RECENT,
  toolMediaNote,
} from "../../core/llm-runtime/adapters/_mcp-content.js";
import { createTurnInputFilter } from "../../core/llm-runtime/adapters/openai-agents-sdk.js";
import { isToolMediaMessage } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

/**
 * 도구가 만든 미디어 묶음인가 — ★**제품의 판정을 그대로 쓴다**(2026-09-21).
 *
 * 종전엔 여기 규칙을 **따로 적어뒀다**(«텍스트 원소가 없는 user 메시지»). 그래서 제품이
 * 라벨을 붙이자 **검사만 눈이 멀었고**, 압축이 멎은 것을 이 검사가 「0묶음」으로만 알렸다.
 * 같은 판단이 두 곳에 있으면 갈린다 — 한 곳에서 읽는다.
 */
const isToolMedia = (it: ResponseInputItem): boolean => isToolMediaMessage(it);

const b64 = (bytes: number): string => "A".repeat(Math.ceil(bytes / 3) * 4);
/**
 * 사용자가 **직접 보낸** 사진의 표식.
 * ★`b64(600)` 같은 길이 표식을 쓰면 안 된다 — 큰 이미지의 **부분문자열**이라 언제나
 *  매치해서, «사용자 사진이 지워졌다» 를 검사가 못 본다(실제로 한 번 놓쳤다).
 */
const USER_PHOTO = "USERPHOTO".repeat(20);
/** 마지막 스텝의 이미지에만 박는 표식 — «남은 것이 최신인가» 를 재려면 구분자가 필요하다. */
const LATEST_MARK = "LATESTFRAME".repeat(8);

/**
 * codex 어댑터 루프의 push 패턴을 **그대로** 돌린다
 * (`openai-codex-oauth.ts` — 압축 → function_call_output push → 미디어 메시지 push → 미디어 압축).
 */
const runCodexTurn = (
  imageBytes: number,
  steps: number,
): {
  requestBytes: number[];
  maxToolMediaPerRequest: number;
  minToolMediaPerRequest: number;
  userPhotoAlive: boolean;
  survivingIsLatest: boolean;
  oldTextCompacted: number;
} => {
  const img = b64(imageBytes);
  // 초기 턴 = 사용자 발화 + 사용자가 **직접 보낸** 사진. 이건 살아남아야 한다.
  const inputArray: ResponseInputItem[] = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: `data:image/png;base64,${USER_PHOTO}` },
        { type: "input_text", text: "이 화면을 보고 작업해줘" },
      ],
    },
  ];
  const requestBytes: number[] = [];
  let maxToolMedia = 0;
  let minToolMedia = Number.POSITIVE_INFINITY;
  for (let i = 0; i < steps; i++) {
    inputArray.push({
      type: "function_call",
      call_id: `c${i}`,
      name: "observe",
      arguments: "{}",
    } as ResponseInputItem);
    // ★**제품이 쓰는 그 함수**를 부른다 — 여기서 루프를 다시 지으면 호출부 순서를
    //  바꾸는 편집을 검사가 못 본다.
    // ★한 스텝에 도구 **둘**을 돌린다(적대 검토 F3). 하나는 큰 텍스트, 하나는 이미지 —
    //  그래야 텍스트 압축과 미디어 창이 **같은 스텝에서 둘 다** 돌았는지 잴 수 있다(F4).
    appendToolResultsToInput(inputArray, [
      { callId: `t${i}`, name: "Read", output: `읽음-${i}\n${"y".repeat(9_000)}`, media: [] },
      {
        callId: `c${i}`,
        name: "look",
        output: emptyToolText([], 1),
        media: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${img}${i === steps - 1 ? LATEST_MARK : ""}`,
          },
        ],
      },
    ]);
    requestBytes.push(Buffer.byteLength(JSON.stringify(inputArray), "utf8"));
    if (i >= 1) {
      const n = inputArray.filter(isToolMedia).length;
      maxToolMedia = Math.max(maxToolMedia, n);
      minToolMedia = Math.min(minToolMedia, n);
    }
  }
  const userPhotoAlive = inputArray.some(
    (it) =>
      it.type === "message" &&
      it.content.some(
        (c) => c.type === "input_image" && c.image_url.includes(USER_PHOTO),
      ),
  );
  // ★남은 **한 장**이 «최신» 인가 (적대 검토 F2). 창 크기만 재면 «첫 장만 남긴다» 도
  //  통과한다 — 그러면 모델은 턴 내내 첫 화면만 보게 된다.
  // ★`every()` 만 쓰면 **빈 배열이 true** 라 «이미지를 하나도 안 싣는다» 도 통과한다
  //  (적대 검토 F3 가 그 구멍으로 빠져나갔다). «있고, 그게 최신» 둘 다 잰다.
  const surviving = inputArray.filter(isToolMedia);
  const survivingIsLatest =
    surviving.length > 0 &&
    surviving.every(
      (it) =>
        it.type === "message" &&
        it.content.some(
          (c) => c.type === "input_image" && c.image_url.includes(LATEST_MARK),
        ),
    );
  // ★오래된 **텍스트** 출력도 같은 스텝에서 압축됐나 (적대 검토 F4).
  const oldTextCompacted = inputArray.filter(
    (it) =>
      it.type === "function_call_output" && it.output.includes("이전 도구 출력 생략"),
  ).length;
  return {
    requestBytes,
    maxToolMediaPerRequest: maxToolMedia,
    minToolMediaPerRequest: minToolMedia,
    userPhotoAlive,
    survivingIsLatest,
    oldTextCompacted,
  };
};

export const check: RegressionCheck = {
  name: "tool-images-do-not-pile-up",
  guards:
    "도구가 돌려준 이미지가 요청에 무한 누적되던 것(20회 관측 = 13.3MB) · agents-SDK 가 base64 를 도구 출력 텍스트로 싣던 것 · 사용자가 보낸 사진을 그 규칙이 지워버리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const STEPS = 20;

    // ── (a) 보존 한도 — i ≥ 2 인 모든 요청에서 도구 미디어 묶음 ≤ 1 ──────────────
    //  ★**배열을 센다.** 문자열 길이를 세는 순간 이 검사는 원래 버그를 다시 통과시킨다.
    const small = runCodexTurn(50_000, STEPS);
    const large = runCodexTurn(500_000, STEPS);
    out.push(
      assert(
        "codex: i≥2 의 모든 요청에 도구 미디어 묶음이 정확히 창(1)만큼 실린다",
        // ★`<=` 만 재면 **0묶음**도 통과한다 — 즉 «이미지를 아예 안 싣는다» 가 초록이 된다.
        //  상한과 하한을 같이 잰다(적대 검토 F3).
        small.maxToolMediaPerRequest === TOOL_MEDIA_KEEP_RECENT &&
          large.maxToolMediaPerRequest === TOOL_MEDIA_KEEP_RECENT,
        `최대 ${Math.max(small.maxToolMediaPerRequest, large.maxToolMediaPerRequest)}묶음 · 최소 ${Math.min(small.minToolMediaPerRequest, large.minToolMediaPerRequest)}묶음 (창=${TOOL_MEDIA_KEEP_RECENT})`,
      ),
    );

    // ── (b) 이미지 크기에 **비례해 누적되지 않는다** ─────────────────────────────
    //  ★«전체 요청이 상수» 를 요구하지 않는다 — 도구 호출·경로 텍스트는 스텝마다 는다.
    //   그건 이미지 크기 S 와 무관하므로 **두 S 의 차분**에서 사라진다. 남는 차이가
    //   «이미지 1장분» 이면 통과, «20장분» 이면 누적이다.
    const dS = b64(500_000).length - b64(50_000).length;
    const actual =
      (large.requestBytes[STEPS - 1] as number) - (small.requestBytes[STEPS - 1] as number);
    out.push(
      assert(
        "codex: 20스텝 뒤 요청 크기 차이가 이미지 1장분 이내(20장분이 아니라)",
        actual <= dS + 4_096,
        `Δ요청=${actual.toLocaleString()}B / 1장분=${dS.toLocaleString()}B (누적이면 ≈${(dS * STEPS).toLocaleString()}B)`,
      ),
    );

    // ── 사용자가 보낸 사진은 **도구 이미지 규칙에 걸리지 않는다** ────────────────
    //  ★이 판정이 틀리면 «방금 보낸 사진을 비서가 못 본다» 가 된다. 가장 비싼 오판이다.
    out.push(
      assert(
        "사용자가 보낸 사진은 20스텝 뒤에도 원형으로 남는다",
        small.userPhotoAlive && large.userPhotoAlive,
        `small=${small.userPhotoAlive} large=${large.userPhotoAlive}`,
      ),
    );

    out.push(
      assert(
        "codex: 모든 요청에 도구 이미지가 **적어도 한 묶음** 실린다(0묶음이면 모델이 못 본다)",
        small.minToolMediaPerRequest === TOOL_MEDIA_KEEP_RECENT &&
          large.minToolMediaPerRequest === TOOL_MEDIA_KEEP_RECENT,
        `최소 small=${small.minToolMediaPerRequest} large=${large.minToolMediaPerRequest}`,
      ),
    );

    // ★창 크기만 재면 «첫 장만 남긴다» 도 통과한다 — 남는 게 **최신**이어야 한다.
    out.push(
      assert(
        "codex: 살아남은 도구 이미지는 가장 최근 스텝의 것이다",
        small.survivingIsLatest && large.survivingIsLatest,
        `small=${small.survivingIsLatest} large=${large.survivingIsLatest} (최신 표식이 남은 묶음에 있나)`,
      ),
    );
    // ★한 함수에 압축 둘을 모았으니 «둘 다 돌았나» 를 재야 한다 — 이미지 있는 스텝에서
    //  텍스트 압축을 건너뛰는 편집이 그러지 않으면 조용히 통과한다.
    out.push(
      assert(
        "codex: 이미지가 있는 스텝에서도 오래된 텍스트 출력이 압축된다",
        small.oldTextCompacted >= STEPS - 4,
        `압축된 텍스트 출력=${small.oldTextCompacted}건 / 스텝=${STEPS}`,
      ),
    );

    // ── (d) 기존 텍스트 규칙의 **뜻이 안 바뀐다** ────────────────────────────────
    //  ★`CODEX_COMPACT_MIN_OUTPUT`(2,000자) 아래 문자열은 종전대로 안 건드린다.
    const textOnly: ResponseInputItem[] = [];
    for (let i = 0; i < 10; i++) {
      textOnly.push({ type: "function_call_output", call_id: `t${i}`, output: "x".repeat(1_999) });
    }
    const beforeText = JSON.stringify(textOnly);
    compactOldToolOutputs(textOnly);
    out.push(
      assert(
        "1,999자 도구 출력은 종전대로 압축되지 않는다(env 의미 보존)",
        JSON.stringify(textOnly) === beforeText,
        `출력 길이=[${textOnly.map((t) => (t.type === "function_call_output" ? t.output.length : -1)).join(",")}] (전부 1999 여야 안 건드린 것)`,
      ),
    );

    //  ★그리고 이미지 규칙은 그 임계를 **안 본다** — 작은 이미지도 창 밖이면 밀린다.
    const tiny: ResponseInputItem[] = [];
    for (let i = 0; i < 4; i++) {
      tiny.push({
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: `data:image/png;base64,${b64(30)}` }],
      });
    }
    const compactedTiny = compactOldToolMedia(tiny);
    out.push(
      assert(
        "작은 이미지도 창 밖이면 밀린다(이미지 규칙은 CHARS 임계를 안 본다)",
        compactedTiny === 4 - TOOL_MEDIA_KEEP_RECENT &&
          tiny.filter(isToolMedia).length === TOOL_MEDIA_KEEP_RECENT,
        `압축 ${compactedTiny}건 · 남은 묶음 ${tiny.filter(isToolMedia).length}개`,
      ),
    );

    //  ★밀려난 자리는 **비어 있지 않다** — 모델이 «다시 부르면 된다» 를 알아야 한다.
    const stub = tiny[0];
    const stubText =
      stub?.type === "message"
        ? stub.content
            .map((c) => (c.type === "input_text" ? c.text : undefined))
            .find((t) => t !== undefined)
        : undefined;
    out.push(
      assert(
        "밀려난 이미지 자리에 안내가 남는다(비어 있지 않다)",
        // ★`=== supersededMediaText(1)` 로 비교하면 **동어반복**이다 — 문구를 빈 문자열로
        //  바꿔도 초록이 된다(변이 M6 가 그렇게 빠져나갔다). 성질을 직접 잰다.
        stubText !== undefined && stubText.trim().length > 0,
        `생략 자리 문구=${JSON.stringify(stubText)} — 비면 모델이 무엇이 사라졌는지 모른다`,
      ),
    );
    out.push(
      assert(
        "그 안내는 원래 이미지보다 훨씬 작다(생략의 목적)",
        (stubText ?? "").length < 1_000,
        `${(stubText ?? "").length}자`,
      ),
    );

    // ── 멱등 — 두 번 돌려도 더 안 줄고, 남은 것을 더 안 건드린다 ────────────────
    out.push(
      assert(
        "다시 돌려도 더 압축하지 않는다(멱등)",
        compactOldToolMedia(tiny) === 0,
        `재호출 압축=${compactOldToolMedia([...tiny])}건 · 남은 묶음=${tiny.filter(isToolMedia).length}개`,
      ),
    );

    // ── 이 모든 판정이 **기대는 전제**를 못 박는다 ──────────────────────────────
    //  ★«도구가 만든 미디어» 와 «사용자가 보낸 사진» 을 가르는 유일한 근거는
    //   *사용자 발화는 언제나 `input_text` 를 함께 싣는다* 는 것이다(`buildCurrentTurn`).
    //   그 전제가 조용히 깨지면 위 검사는 **전부 초록인 채로** 사용자 사진이 지워진다.
    //   그래서 전제를 실행해서 고정한다 — 주석으로 두면 다음 사람이 모른다.
    const steer = await buildSteeringInputItem({
      text: "",
      attachments: undefined,
    } as Parameters<typeof buildSteeringInputItem>[0]);
    out.push(
      assert(
        "사용자 발화는 텍스트가 비어도 input_text 원소를 싣는다(도구 미디어와 구분되는 근거)",
        steer.type === "message" &&
          steer.content.some((c) => c.type === "input_text"),
        `content=${JSON.stringify(steer.type === "message" ? steer.content.map((c) => c.type) : steer.type)}`,
      ),
    );

    // ── base64 가 **도구 출력 텍스트로 새지 않는다** (두 어댑터 공용 판단) ───────
    const bigB64 = b64(200_000);
    const split = splitMcpToolContent([
      { type: "text", text: "화면을 읽었습니다" },
      { type: "image", mimeType: "image/png", data: bigB64 },
    ]);
    out.push(
      assert(
        "MCP 이미지 블록이 도구 출력 텍스트로 새지 않는다",
        !split.text.includes(bigB64) && split.media.length === 1,
        `text=${split.text.length}자 / media=${split.media.length}개`,
      ),
    );
    out.push(
      assert(
        "텍스트 블록이 없으면 base64 를 stringify 하지 않고 사실만 알린다",
        !emptyToolText(
          [{ type: "image", mimeType: "image/png", data: bigB64 }],
          1,
        ).includes(bigB64),
        `폴백 문구=${emptyToolText([{ type: "image", mimeType: "image/png", data: bigB64 }], 1).length}자 (base64 ${bigB64.length}자를 실으면 그만큼 커진다)`,
      ),
    );

    // ── agents-SDK 쪽 창도 **같은 규칙**이다 (실행해서 잰다) ────────────────────
    //  ★배치 = 한 모델 호출 스텝. 같은 스텝의 병렬 도구 둘은 **둘 다** 살아야 한다.
    const win = createToolMediaWindow<{ id: number }>();
    win.add("A", [{ id: 1 }]);
    win.add("B", [{ id: 2 }]); // 같은 스텝의 두 번째 도구 — 같은 배치
    const step1 = win.takeForRequest();
    out.push(
      assert(
        "agents-SDK: 같은 스텝의 병렬 도구 이미지는 한 묶음으로 함께 간다",
        step1.length === 1 &&
          step1[0]?.items.length === 2 &&
          step1[0]?.tools.join(",") === "A,B",
        JSON.stringify(step1),
      ),
    );
    let overflowed = 0;
    for (let i = 3; i <= 22; i++) {
      win.add("A", [{ id: i }]);
      if (win.takeForRequest().length > TOOL_MEDIA_KEEP_RECENT) overflowed += 1;
    }
    out.push(
      assert(
        "agents-SDK: 20스텝을 돌아도 한 번도 창을 넘지 않는다",
        overflowed === 0,
        `창 초과 스텝=${overflowed}회`,
      ),
    );
    const last = win.takeForRequest();
    out.push(
      assert(
        "agents-SDK: 남는 묶음은 창 이내이고 **최신** 것이다",
        last.length <= TOOL_MEDIA_KEEP_RECENT &&
          last[last.length - 1]?.items[0]?.id === 22,
        `${last.length}묶음 · 마지막 id=${last[last.length - 1]?.items[0]?.id} · 누적 생략=${last[0]?.dropped}`,
      ),
    );

    // ── ★agents-SDK 경로를 **실행한다** (적대 검토 F1) ────────────────────────
    //  종전엔 이 검사가 순수함수만 돌고 어댑터는 한 줄도 안 지났다. 그래서 «이미지를
    //  싣는 줄 삭제» · «steering 없으면 조기 return» · «media.length >= 0» 셋이
    //  전체 스위트 3,890건 초록으로 통과했다 — 전부 이 수정이 고치려던 결함이다.
    const shot = { mimeType: "image/png", data: b64(100_000) };
    const decided = toolResultForAdapter(
      [{ type: "image", mimeType: shot.mimeType, data: shot.data }],
      { vision: true },
    );
    out.push(
      assert(
        "agents-SDK: 이미지 결과는 통과(passthrough)시키지 않고 미디어로 뽑는다",
        !decided.passthrough &&
          decided.media.length === 1 &&
          !decided.text.includes(shot.data),
        `passthrough=${decided.passthrough} media=${decided.media.length} text=${decided.text.length}자`,
      ),
    );
    const textOnlyResult = toolResultForAdapter([{ type: "text", text: "그냥 텍스트" }], {
      vision: true,
    });
    out.push(
      assert(
        "agents-SDK: 이미지 없는 결과는 SDK 결과를 그대로 흘린다(회귀 0)",
        textOnlyResult.passthrough && textOnlyResult.media.length === 0,
        `passthrough=${textOnlyResult.passthrough} media=${textOnlyResult.media.length}`,
      ),
    );
    const blind = toolResultForAdapter(
      [{ type: "image", mimeType: shot.mimeType, data: shot.data }],
      { vision: false },
    );
    out.push(
      assert(
        "agents-SDK: 비전 없는 모델이면 이미지를 버리되 버렸다고 말한다",
        blind.media.length === 0 &&
          blind.text.trim().length > 0 &&
          !blind.text.includes(shot.data),
        `media=${blind.media.length} text=${JSON.stringify(blind.text.slice(0, 60))}`,
      ),
    );

    //  ★필터를 **직접 부른다** — steering 이 없어도 이미지가 실려야 한다.
    const realWindow = createToolMediaWindow<{ type: "input_image"; image: string }>();
    realWindow.add("screenshot", [{ type: "input_image", image: "data:image/png;base64,AAA" }]);
    const filter = createTurnInputFilter({
      steering: undefined,
      buildSteeringItem: async () => ({ role: "user", content: [] }) as never,
      accumulatedSteering: [],
      mediaWindow: realWindow,
      threadKey: "t",
    });
    const modelData = { input: [] as unknown[] };
    await filter({ modelData } as never);
    out.push(
      assert(
        "agents-SDK: steering 이 없어도 도구 이미지가 모델 입력에 실린다",
        modelData.input.length === 1 &&
          JSON.stringify(modelData.input[0]).includes("input_image"),
        `주입된 항목=${modelData.input.length}개 · ${JSON.stringify(modelData.input).slice(0, 120)}`,
      ),
    );
    out.push(
      assert(
        "agents-SDK: 주입된 이미지에 어느 도구인지가 함께 간다(자리가 말해주지 않으므로)",
        JSON.stringify(modelData.input[0]).includes("screenshot"),
        JSON.stringify(modelData.input[0]).slice(0, 160),
      ),
    );
    //  ★밀려난 이미지가 있으면 그 사실도 말해야 한다 — 도구 출력엔 «첨부했습니다» 가 남는다.
    realWindow.add("screenshot", [{ type: "input_image", image: "data:image/png;base64,BBB" }]);
    realWindow.add("screenshot", [{ type: "input_image", image: "data:image/png;base64,CCC" }]);
    const md2 = { input: [] as unknown[] };
    await filter({ modelData: md2 } as never);
    out.push(
      assert(
        "agents-SDK: 밀려난 이미지가 있으면 «생략했다» 를 모델에게 말한다",
        JSON.stringify(md2.input).includes("생략"),
        JSON.stringify(md2.input).slice(0, 200),
      ),
    );
    //  ★도구 미지원 폴백 재시도는 지난 시도의 이미지를 끌고 가지 않는다.
    realWindow.reset();
    const md3 = { input: [] as unknown[] };
    await filter({ modelData: md3 } as never);
    out.push(
      assert(
        "agents-SDK: 창을 비우면 재시도 입력에 이미지가 안 붙는다",
        md3.input.length === 0,
        `주입된 항목=${md3.input.length}개`,
      ),
    );
    // ── ★도구가 준 그림에 **이름이 붙는다** (2026-09-21 정태님 실기) ─────────────────
    //  ★★이미지는 `role:"user"` 로 들어간다(`function_call_output` 은 문자열 전용이라 다른
    //   통로가 없다). 그런데 **사용자 첨부도 같은 `role:"user"` 이미지**이고, 그쪽만
    //   `formatAttachments` 가 «사용자가 아래 파일을 첨부했습니다» 라고 이름을 준다.
    //   그래서 맥락에서 **이름 있는 그림은 «첨부» 뿐**이 됐고, 모델이 자기가 `look` 으로
    //   찍은 화면을 «첨부 화면» 이라고 불렀다(실기 관측).
    //  ★종전 주석은 *"codex 는 **자리로** 말한다"* 였다 — `function_call_output` 바로
    //   뒤에 붙이니 안다는 전제였고, **그 전제가 틀렸다.** 자리는 역할을 못 바꾼다.
    //  ★문구는 `toolMediaNote` 한 곳에서 온다(openai 어댑터가 이미 쓰던 것).
    {
      const arr: ResponseInputItem[] = [];
      appendToolResultsToInput(arr, [
        { callId: "a1", name: "look", output: "관측 결과", media: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }] },
      ]);
      const msg = arr.find(
        (it) => (it as { role?: string }).role === "user",
      ) as { content?: { type: string; text?: string }[] } | undefined;
      const first = msg?.content?.[0];
      out.push(
        assert(
          "★★도구 이미지 앞에 **글 한 줄**이 붙는다 — 없으면 사용자 첨부와 구분이 안 된다",
          first?.type === "input_text" && (first.text ?? "") !== "",
          JSON.stringify(first ?? null).slice(0, 80),
        ),
      );
      out.push(
        assert(
          "★그 줄이 **어느 도구인지** 말한다 — 이름이 곧 구분이다",
          (first?.text ?? "").includes("look"),
          first?.text ?? "(없음)",
        ),
      );
      // ★막으면 안 되는 것 — 이미지가 없으면 그 메시지 자체가 없어야 한다(빈 글만 남기지 않는다).
      const none: ResponseInputItem[] = [];
      appendToolResultsToInput(none, [{ callId: "b1", name: "Bash", output: "텍스트만", media: [] }]);
      out.push(
        assert(
          "★반대 방향 — 그림이 없으면 사용자 메시지를 **안 만든다**",
          !none.some((it) => (it as { role?: string }).role === "user"),
          JSON.stringify(none.map((it) => (it as { type?: string }).type)),
        ),
      );
    }

    // ── ★밀려났다는 안내가 **몇 장인지** 틀리지 않는다 (2026-09-21 검토자 지적) ─────
    //  ★라벨을 붙이자 `content.length` 가 «그림 수» 가 아니게 됐다(라벨 한 줄이 끼었다).
    //   압축은 제대로 됐는데 모델에게 «미디어 2개 생략» 이라고 말한다 — 한 장이었는데도.
    //   ★`content.length - 1` 로 고치면 안 된다: 판별자는 **라벨 없는 옛 묶음**도 받으므로
    //    그 경우 한 장을 0개로 말하게 된다. 세야 할 것은 **그림·파일 원소**뿐이다.
    {
      const mk = (content: unknown[]): ResponseInputItem =>
        ({ type: "message", role: "user", content }) as ResponseInputItem;
      const img = { type: "input_image", image_url: "data:image/png;base64,AA==" };
      const file = { type: "input_file", file_data: "data:text/plain;base64,AA==" };
      const label = (n: number) => ({ type: "input_text", text: toolMediaNote(["look"], n, 0) });
      const textOf = (it: ResponseInputItem): string => {
        const c = (it as { content?: { type: string; text?: string }[] }).content;
        return c?.[0]?.text ?? "";
      };
      const keep = { keepRecent: 1 };

      const a = [mk([label(1), img]), mk([label(1), img])];
      compactOldToolMedia(a, keep);
      out.push(
        assert(
          "★밀려난 안내가 **그림 수**를 말한다(라벨을 세지 않는다) — 1장",
          textOf(a[0] as ResponseInputItem).includes("미디어 1개"),
          textOf(a[0] as ResponseInputItem),
        ),
      );

      const b = [mk([label(3), img, img, file]), mk([label(1), img])];
      compactOldToolMedia(b, keep);
      out.push(
        assert(
          "★그림 2 + 파일 1 은 3개라고 말한다",
          textOf(b[0] as ResponseInputItem).includes("미디어 3개"),
          textOf(b[0] as ResponseInputItem),
        ),
      );

      // ★라벨 없는 **옛 묶음**(라벨 이전 이력이 그대로 남아 있을 수 있다)도 맞게 센다.
      const c = [mk([img]), mk([label(1), img])];
      compactOldToolMedia(c, keep);
      out.push(
        assert(
          "★라벨 없는 옛 묶음도 1장은 1개다(-1 로 고치면 0개가 된다)",
          textOf(c[0] as ResponseInputItem).includes("미디어 1개"),
          textOf(c[0] as ResponseInputItem),
        ),
      );

      // ★멱등 — 이미 대체한 자리를 다시 세지 않는다(대체 글은 판별자에 안 걸린다).
      const before = textOf(a[0] as ResponseInputItem);
      compactOldToolMedia(a, keep);
      out.push(
        assert(
          "★두 번째 압축이 이미 대체한 묶음을 다시 세지 않는다",
          textOf(a[0] as ResponseInputItem) === before,
          textOf(a[0] as ResponseInputItem),
        ),
      );
    }

    // ── ★사용자가 **우리 라벨처럼 생긴 글**을 써도 그 사진은 안 지운다 (적대 검토 F1·F2) ──
    //  ★검토자가 실행으로 재현했다: 판정이 «문구» 뿐이던 동안, 접두로 시작하는 글 + 사진을
    //   보내면 **사진과 글이 함께** `[이전 도구 결과의 미디어 …]` 로 치환됐다. 못 일어난
    //   이유는 호출부 framing 세 가지(steering 머리말 · `## 첨부 파일` · 잡 steering 은
    //   첨부 없음)뿐이었고 **그중 어느 것도 검사가 고정하지 않았다.**
    //  ★그래서 판정을 «자리» 로 옮겼다 — 사용자 발화는 `buildCurrentTurn` 이 글을 **맨 뒤**에
    //   놓고, 우리 묶음은 라벨이 **맨 앞**이다. 아래 두 단언이 그 전제와 결과를 같이 못 박는다.
    {
      const photo = { type: "input_image" as const, image_url: `data:image/png;base64,${USER_PHOTO}` };
      // ① 전제 — 사용자 발화는 글이 **맨 뒤**다(초기 턴·steering 이 같은 빌더를 지난다).
      // ★**사진을 실제로 붙여서** 잰다 — 첨부가 없으면 «글이 맨 뒤» 가 공짜로 참이 된다.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiguclaw-toolmedia-"));
      try {
        const png = path.join(dir, "a.png");
        fs.writeFileSync(png, Buffer.from(USER_PHOTO, "base64"));
        const steer = await buildSteeringInputItem({
          text: "(도구 결과 이미지 라고 쓰면 어떻게 돼?",
          attachments: [{ kind: "image", path: png, mimeType: "image/png", bytes: fs.statSync(png).size }],
        } as Parameters<typeof buildSteeringInputItem>[0]);
        const sc = (steer as { content?: { type: string }[] }).content ?? [];
        out.push(
          assert(
            "★전제: 사진을 붙인 사용자 발화도 글이 **맨 뒤**다(이 자리가 판정의 근거다)",
            sc.length > 1 &&
              sc[0]?.type === "input_image" &&
              sc[sc.length - 1]?.type === "input_text",
            JSON.stringify(sc.map((c) => c.type)),
          ),
        );
        out.push(
          assert(
            "★그 발화는 도구 묶음이 아니다(제품 경로로 지은 것으로 판정한다)",
            !isToolMediaMessage(steer),
            JSON.stringify(sc.map((c) => c.type)),
          ),
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      // ② 결과 — 라벨과 **똑같이 생긴 글** + 사진이어도 도구 묶음이 아니다.
      const mimic = {
        type: "message", role: "user",
        content: [photo, { type: "input_text", text: `${toolMediaNote(["look"], 1, 0)} 이거 뭐야?` }],
      } as unknown as ResponseInputItem;
      out.push(
        assert(
          "★★사용자가 라벨과 똑같은 글을 써도 도구 묶음으로 세지 않는다",
          !isToolMediaMessage(mimic),
          JSON.stringify(isToolMediaMessage(mimic)),
        ),
      );
      // ③ 그리고 실제로 **압축에서 살아남는다**(판정만 보지 않고 결과를 본다).
      const arr: ResponseInputItem[] = [mimic];
      appendToolResultsToInput(arr, [
        { callId: "z1", name: "look", output: "관측", media: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
      ]);
      appendToolResultsToInput(arr, [
        { callId: "z2", name: "look", output: "관측", media: [{ type: "input_image", image_url: "data:image/png;base64,BB==" }] },
      ]);
      out.push(
        assert(
          "★★그 사진이 도구 이미지 압축에서 **살아남는다**",
          JSON.stringify(arr).includes(USER_PHOTO),
          JSON.stringify(arr).slice(0, 90),
        ),
      );
    }

    // ── ★라벨이 말하는 **개수와 도구**가 제품 경로에서 맞다 (적대 검토 F4) ──────────
    //  ★`supersededMediaText` 쪽 개수는 못 박았는데 **라벨 쪽 개수**는 안 쟀다 — 같은
    //   종류의 거짓말인데 한쪽만 닫혀 있었다.
    {
      const im = (n: string) => ({ type: "input_image" as const, image_url: `data:image/png;base64,${n}` });
      const arr: ResponseInputItem[] = [];
      appendToolResultsToInput(arr, [
        { callId: "p1", name: "look", output: "관측", media: [im("A1"), im("A2"), im("A3")] },
      ]);
      const label = (it: ResponseInputItem | undefined): string =>
        ((it as { content?: { type: string; text?: string }[] } | undefined)?.content?.[0]?.text) ?? "";
      out.push(
        assert(
          "★라벨이 **실제 장수**를 말한다(한 스텝에 그림 셋)",
          label(arr.at(-1)).includes("3장"),
          label(arr.at(-1)),
        ),
      );
      // ★그림을 **안 준** 도구는 라벨에 이름이 안 실린다 — 오귀속은 이 커밋이 닫으려던 부류다.
      const mixed: ResponseInputItem[] = [];
      appendToolResultsToInput(mixed, [
        { callId: "q1", name: "Bash", output: "텍스트만", media: [] },
        { callId: "q2", name: "look", output: "관측", media: [im("B1")] },
      ]);
      out.push(
        assert(
          "★그림을 안 준 도구를 라벨이 지목하지 않는다(Bash 는 그림이 없다)",
          label(mixed.at(-1)).includes("look") && !label(mixed.at(-1)).includes("Bash"),
          label(mixed.at(-1)),
        ),
      );
    }


    return out;
  },
};
