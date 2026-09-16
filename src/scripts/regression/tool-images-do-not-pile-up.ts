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
} from "../../core/llm-runtime/adapters/_mcp-content.js";
import { createTurnInputFilter } from "../../core/llm-runtime/adapters/openai-agents-sdk.js";

/** 도구가 만든 미디어 묶음인가 — 텍스트 원소가 없는 user 메시지. */
const isToolMedia = (it: ResponseInputItem): boolean =>
  it.type === "message" &&
  it.role === "user" &&
  it.content.length > 0 &&
  it.content.every((c) => c.type === "input_image" || c.type === "input_file");

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
      { callId: `t${i}`, output: `읽음-${i}\n${"y".repeat(9_000)}`, media: [] },
      {
        callId: `c${i}`,
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

    return out;
  },
};
