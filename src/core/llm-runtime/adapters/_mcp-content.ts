/**
 * **MCP 도구 결과를 텍스트와 미디어로 가른다** — 어댑터 무관 (2026-09-15).
 *
 * ★이 판단은 원래 codex 어댑터 안에만 있었고(2026-08-01), **openai 에는 아예 없었다.**
 *  그래서 같은 플러그인이 이미지를 돌려줘도 어댑터에 따라 결과가 갈렸다:
 *   - codex : 이미지 블록을 비전 채널로 옮기고 텍스트만 도구 출력에 남긴다 (맞다)
 *   - openai: SDK 가 콘텐츠 블록을 **그대로** 도구 출력으로 넘긴다
 *             (`@openai/agents-core/dist/mcp.js` — `content.length === 1 ? content[0] : content`)
 *             → **base64 가 텍스트로 쏟아진다.** codex 가 2026-08-01 에 고친 바로 그 사고다.
 *  «모든 기능은 LLM 무관» 이므로 판단을 한 곳에 두고 **표현만** 어댑터가 한다
 *  ([[feedback_every_feature_llm_agnostic]]).
 *
 * ★**wire 모양은 여기서 안 만든다.** codex 는 `{type:"input_image", image_url}`,
 *  agents-SDK 는 `{type:"input_image", image}` 로 필드 이름이 다르다. 중립형(mime+base64)
 *  까지만 내고 각 어댑터가 자기 모양으로 옮긴다 — 판단은 한 곳, 표현은 가장자리.
 */

/** 도구가 돌려준 미디어 한 장 — 어느 wire 에도 안 묶인 중립형. */
export type McpMediaBlock = { mimeType: string; data: string };

/**
 * MCP `CallToolResult.content` 를 «모델이 읽을 텍스트» 와 «비전 채널로 보낼 미디어» 로 가른다.
 *
 * ★**미디어를 텍스트에 섞지 않는다.** 블록을 통째로 `JSON.stringify` 하면 base64 가 도구
 *  출력에 들어가고, 그 출력은 턴 내내 매 요청에 재전송된다(실측: 관측 20회 × 500KB =
 *  13.3MB). 텍스트 블록이 하나도 없을 때만 «무엇이 왔는지» 한 줄로 알린다.
 */
export const splitMcpToolContent = (
  result: unknown,
): { text: string; media: McpMediaBlock[] } => {
  const arr = Array.isArray(result) ? result : [];
  const text = arr
    .filter(
      (c) =>
        c !== null && typeof c === "object" && (c as { type?: string }).type === "text",
    )
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("");
  const media: McpMediaBlock[] = [];
  for (const c of arr) {
    if (c === null || typeof c !== "object") continue;
    const b = c as { type?: string; data?: unknown; mimeType?: unknown };
    if (b.type !== "image" || typeof b.data !== "string") continue;
    media.push({
      mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png",
      data: b.data,
    });
  }
  return { text, media };
};

/** 텍스트가 비었을 때 도구 출력에 남길 한 줄 — 미디어가 있으면 그 사실만 말한다. */
export const emptyToolText = (result: unknown, mediaCount: number): string =>
  mediaCount > 0
    ? `(이미지 ${mediaCount}개를 비전 채널로 첨부했습니다.)`
    : JSON.stringify(result ?? {});

/**
 * 모델이 이미지를 못 볼 때 — **조용히 버리지 않는다.**
 *
 * ★agents-SDK 어댑터는 이질 모델(openai·gemini·ollama)을 한 몸으로 굴리고 vision 은
 *  모델별이라, 비전 없는 모델에 이미지를 넣으면 그 턴이 에러난다. 버리되 **버렸다고 말한다** —
 *  안 그러면 모델은 «도구가 아무것도 안 줬다» 로 읽는다.
 */
export const visionUnavailableNote = (mediaCount: number): string =>
  `(이미지 ${mediaCount}개가 왔지만 이 모델은 이미지를 읽지 못해 생략했습니다.)`;

/**
 * **도구가 만든 미디어는 몇 묶음까지 원형으로 들고 가나** — 개수다, 글자 수가 아니다.
 *
 * ★텍스트 압축(`CODEX_COMPACT_KEEP_RECENT`=3)과 **다른 차원**이고, `*_CHARS` env 를
 *  참조하지 않는다. 이유 둘:
 *   ① 옛 텍스트(파일 내용)는 시간이 지나도 참이라 최근 셋이 쓸모 있지만, 도구가 만든
 *     이미지는 대개 **다음 결과가 덮어쓴다**(화면·차트·미리보기).
 *   ② 이미지 한 장이 텍스트 결과의 100~1000배라 창 3 = 요청당 수 MB다.
 * ★**새 env 를 만들지 않는다.** 누가 요구하면 그때 승격한다 — 지금 만들면 아무도 안 쓰는
 *  손잡이가 하나 는다.
 * ★상수를 여기 두는 이유: codex(요청 배열을 훑어 고쳐 쓴다)와 agents-SDK(우리가 든
 *  누적기를 자른다)가 **기제는 다르고 규칙은 같아서**다. 두 곳에 숫자를 적으면 갈린다.
 */
export const TOOL_MEDIA_KEEP_RECENT = 1;

/**
 * 더 최근 결과에 밀려난 미디어 자리에 남기는 글 — 모델이 «다시 부르면 된다» 를 알아야 한다.
 * ★«이미지» 가 아니라 «미디어» 라고 쓴다 — 같은 규칙이 PDF(`input_file`)에도 걸린다.
 */
export const supersededMediaText = (mediaCount: number): string =>
  `[이전 도구 결과의 미디어 ${mediaCount}개 생략 — 더 최근 결과가 있습니다. 필요하면 같은 인자로 도구를 재호출하세요.]`;

/**
 * **도구 결과 하나를 어댑터가 무엇으로 바꿔야 하나** — 판정을 순수 함수로 (2026-09-15).
 *
 * ★적대 검토 F1: 이 판정이 어댑터의 `callTool` 안에 인라인으로 있었더니 **실행 검사가
 *  닿지 않았다.** `if (media.length === 0) return result` 를 `>= 0` 으로 바꾸는 변이 —
 *  즉 이 수정이 «고쳤다» 고 선언한 사고 자체 — 가 전체 스위트 3,890건 초록으로 통과했다.
 *  판정을 밖으로 내면 검사가 **실행**한다([[feedback_simple_composable_no_duplication]]).
 *
 * `passthrough` = 이미지가 없다 → 어댑터는 SDK 결과를 **손대지 말고 그대로** 흘린다
 * (텍스트 전용 결과의 형상·`structuredContent`·`isError` 를 우리가 재구성하지 않는다).
 */
export const toolResultForAdapter = (
  result: unknown,
  opts: { vision: boolean },
): { passthrough: boolean; text: string; media: McpMediaBlock[] } => {
  const split = splitMcpToolContent(result);
  if (split.media.length === 0) {
    return { passthrough: true, text: split.text, media: [] };
  }
  // ★비전 없는 모델(gemini·ollama 포함)에 이미지를 넣으면 그 턴이 에러난다. 버리되
  //  **조용히 버리지 않는다** — 텍스트가 있든 없든 «이미지가 왔는데 못 본다» 를 말한다.
  const text = !opts.vision
    ? split.text === ""
      ? visionUnavailableNote(split.media.length)
      : `${split.text}\n${visionUnavailableNote(split.media.length)}`
    : split.text === ""
      ? emptyToolText(result, split.media.length)
      : split.text;
  return { passthrough: false, text, media: opts.vision ? split.media : [] };
};

/**
 * 비전 채널로 따로 실어 보내는 이미지 묶음에 **붙이는 말** (2026-09-15, 적대 검토 F5·F6).
 *
 * ★**종전엔 codex 를 예외로 뒀다** — 이미지를 그 `function_call_output` **바로 뒤**에
 *  두니 «어느 도구 결과인가» 가 자리로 드러난다고 봤다. 2026-09-21 에 그게 깨졌다:
 *  모델이 자기가 `look` 으로 찍은 화면을 **사용자가 첨부한 사진**으로 읽고 엉뚱한 답을
 *  했다. 사용자 첨부는 `formatAttachments` 가 「## 첨부 파일」을 달아주는데 도구 이미지엔
 *  아무 말이 없어서, **자리가 같은 것을 두 출처가 나눠 쓰고 있었다.** 이제 codex 도
 *  이 글을 단다 — 자리는 순서를 말할 뿐 **출처를 말하지 않는다.**
 *  (Anthropic 은 이 문제가 없다 — `tool_result` 블록 **안에** 이미지가 들어가서
 *   출처가 구조로 찍힌다. 라벨이 필요한 건 그 자리가 없는 OpenAI 계열뿐이다.)
 *  밀려난 자리엔 `supersededMediaText` 가 남는다. agents-SDK 는 SDK 가
 *  매 호출 입력을 clone 해서 우리가 **끝에 다시 실을** 수밖에 없어 그 둘이 없다 —
 *  스텝 N 의 이미지가 스텝 N+2 의 도구 출력 뒤에 붙고, 밀려난 이미지는 조용히 사라진다.
 *  그런데 도구 출력엔 «비전 채널로 첨부했습니다» 가 남아 **모델에게 거짓이 된다.**
 *  자리로 못 말하니 **글로 말한다.**
 */
/**
 * **도구 미디어 묶음의 표식** — 문구이자 판별자다 (2026-09-21).
 *
 * ★★종전 판별자는 «텍스트 원소가 **없는** user 메시지» 였다. 사용자 발화는 언제나
 *  `input_text` 를 함께 싣기 때문에 그게 통했다. 그런데 그 규칙은 **모델에게도 라벨이
 *  없다**는 뜻이라, 모델이 자기가 `look` 으로 찍은 화면을 «첨부» 로 읽었다(실기 관측).
 * ★라벨을 붙이면 옛 판별자가 깨진다(회귀가 즉시 잡았다 — 압축이 멎어 이미지가 다시
 *  쌓인다). 그래서 **문구 자체를 판별자로** 쓴다 — 한 곳에서 만들고 한 곳에서 읽는다.
 */
export const TOOL_MEDIA_NOTE_PREFIX = "(도구 결과 이미지 ";

export const toolMediaNote = (
  tools: readonly string[],
  count: number,
  dropped: number,
): string => {
  const who = tools.length > 0 ? ` — ${tools.join(", ")} 의 결과` : "";
  const gone =
    dropped > 0
      ? ` 더 이전 관측 이미지 ${dropped}묶음은 생략했습니다. 필요하면 같은 인자로 도구를 재호출하세요.`
      : "";
  return `${TOOL_MEDIA_NOTE_PREFIX}${count}장${who}.${gone})`;
};

/**
 * **agents-SDK 쪽 창** — codex 와 같은 규칙, 다른 기제 (2026-09-15).
 *
 * codex 는 요청 배열을 직접 들고 있어 **제자리에서 고쳐 쓴다**(`compactOldToolMedia`).
 * agents-SDK 는 SDK 가 루프를 소유하고, 필터가 받는 `modelData` 는 매 호출 clone 이라
 * **우리가 누적기를 들고 매번 다시 싣는다.** 그래서 «자른다» 가 «덜 담는다» 가 된다.
 *
 * ★어댑터 안에 인라인으로 두면 검사하려고 SDK 런을 띄워야 한다 — 그건 자리가 잘못됐다는
 *  신호다([[feedback_simple_composable_no_duplication]]). 여기 두면 검사가 **실행**한다.
 * ★**배치 = 한 모델 호출 스텝**이다(한 도구 호출이 아니다). 같은 스텝의 병렬 도구가
 *  각자 이미지를 주면 둘 다 한 배치에 들어간다 — codex 가 그 둘을 한 메시지에 담는 것과
 *  같게 만드는 지점이다.
 */
export const createToolMediaWindow = <T>(
  keepRecent: number = TOOL_MEDIA_KEEP_RECENT,
): {
  add: (tool: string, items: readonly T[]) => void;
  takeForRequest: () => { tools: string[]; items: T[]; dropped: number }[];
  reset: () => void;
} => {
  const batches: { tools: string[]; items: T[] }[] = [];
  let batchOpen = false;
  let dropped = 0;
  return {
    add: (tool, items) => {
      if (items.length === 0) return;
      if (!batchOpen) {
        batches.push({ tools: [], items: [] });
        batchOpen = true;
      }
      const batch = batches[batches.length - 1] as { tools: string[]; items: T[] };
      if (!batch.tools.includes(tool)) batch.tools.push(tool);
      batch.items.push(...items);
    },
    /**
     * 모델 호출 직전 — 창 밖 배치를 **버리고** 남은 것을 준다. 여기가 스텝 경계다.
     * ★자르는 게 먼저다: 싣고 자르면 이번 요청엔 이미 다 나간 뒤다.
     * ★버린 수를 **누적해서 들고 간다** — 모델에게 «더 있었다» 를 말해야 하기 때문이다
     *  (codex 는 밀려난 자리에 스텁을 남기는데, 여기선 자리가 없어 글로 말한다).
     */
    takeForRequest: () => {
      const over = Math.max(0, batches.length - keepRecent);
      dropped += over;
      batches.splice(0, over);
      batchOpen = false;
      return batches
        .filter((b) => b.items.length > 0)
        .map((b) => ({ tools: b.tools, items: b.items, dropped }));
    },
    /**
     * 창을 비운다 — **도구 미지원 폴백 재시도** 전용 (적대 검토 F7).
     * 그 재시도는 도구도 히스토리도 없이 다시 묻는 것이라, 지난 시도의 이미지를 끌고 가면
     * 맥락 없는 사진이 입력 끝에 붙는다.
     */
    reset: () => {
      batches.length = 0;
      batchOpen = false;
      dropped = 0;
    },
  };
};
