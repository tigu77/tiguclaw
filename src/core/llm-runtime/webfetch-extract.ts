/**
 * `WebFetch(prompt)` — 받아온 본문에 **프롬프트를 실제로 돌린다** (2026-08-15).
 *
 * 사고: 우리 `WebFetch` 는 `prompt` 를 **선언만 하고 한 번도 안 썼다**(`args.prompt` 참조
 * 0회). SDK 계약은 *"The prompt to run on the fetched content"* 인데, codex 가
 * *"Verify that this is a real American Academy of Dermatology page…"* 라고 물으면 답 대신
 * **페이지 전문**이 돌아왔다. 에러도 로그도 없다 — 결과는 나오니 아무도 모르고, 대신
 * 모델이 본문을 통째로 읽느라 토큰을 태운다. 20일 실측: codex 22건 **전부** prompt 를
 * 실었고 **전부 무시**됐다(claude 는 SDK 것이라 정상 처리 — 어댑터 간 비대칭).
 *
 * ★원칙 1(슈퍼셋 — 누락은 버그)과 "모든 기능 LLM 무관" 둘 다에 걸린다. 그래서 **없애는 게
 *  아니라 구현**한다(사용자 결정 2026-08-15: "우린 언제나 근본이 중요해").
 *
 * ★새 어댑터·새 HTTP 클라이언트 0 — `classify.ts` 와 **같은 이음매**(runRegionA 재사용)를
 *  쓴다. 그래서 어느 어댑터로 돌든 동작이 같고, 폴백·풀 선택은 이미 있는 코드가 한다.
 *  - `toolPolicy: none` — 추출에 도구는 불필요(미지원 모델도 graceful).
 *  - `internal: true` — turn_done/persist 미발행. 이 호출이 다시 self-growth 입력이 되어
 *    루프를 만드는 걸 구조적으로 막는다.
 *  - `leanMemory` — 웹 본문 추출에 대화 메모리가 낄 이유가 없다.
 *
 * ★**실패는 조용하면 안 된다.** 이 결함의 본질이 "조용한 무시" 였으므로, 추출이 안 되면
 *  본문을 그대로 돌려주되 **왜 프롬프트를 못 돌렸는지 한 줄로 말한다**. 같은 병을 다른
 *  모양으로 다시 만들지 않기 위해서다.
 */
import { cheapInternalTierSpecs } from "./classify.js";
import { runRegionA } from "./index.js";

/**
 * 모델에 먹일 본문 상한. fetch 자체는 5MB 까지 받지만 그걸 그대로 모델에 넣으면
 * 추출이 원래 아끼려던 토큰을 도로 태운다. 넘치면 **잘렸다고 모델에게 말한다**
 * (모르는 채로 답하면 "문서에 없다" 는 틀린 답이 나온다).
 */
export const WEBFETCH_EXTRACT_MAX_CHARS = 60_000;

/** 추출 호출 시한(ms). 본문 한 장 읽는 일이라 넉넉하되 턴을 잡아먹지 않게. */
export const WEBFETCH_EXTRACT_TIMEOUT_MS = 25_000;

export interface ExtractInput {
  url: string;
  prompt: string;
  /** markdown 변환까지 끝난 본문. */
  content: string;
  timeoutMs?: number;
}

export type ExtractResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: string };

/**
 * 모델에 줄 지시 — **순수 함수**(검사 가능). 본문은 경계로 감싸서 지시와 섞이지 않게 한다.
 *
 * ★"문서에 없으면 없다고 말하라" 를 박는다. 웹 본문 추출에서 가장 비싼 실패는 못 찾은 걸
 *  지어내는 것이고, 그건 호출자가 검증할 수단이 없다(그러려고 부른 도구다).
 */
export const buildExtractPrompt = (input: {
  url: string;
  prompt: string;
  content: string;
  truncated: boolean;
}): string =>
  [
    "아래 웹 문서를 읽고 요청에 답하세요.",
    "- 문서에 근거가 없으면 지어내지 말고 '문서에 없음' 이라고 답하세요.",
    "- 답만 쓰세요. 서두·맺음말·문서 요약은 넣지 마세요.",
    input.truncated
      ? "- ★문서가 길어 **앞부분만** 실려 있습니다. 뒤쪽에 답이 있을 수 있으면 그렇다고 말하세요."
      : "",
    "",
    `URL: ${input.url}`,
    "",
    "요청:",
    input.prompt,
    "",
    "--- 문서 시작 ---",
    input.content,
    "--- 문서 끝 ---",
    "",
    "답:",
  ]
    .filter((l) => l !== "")
    .join("\n");

/**
 * 본문에 프롬프트를 1회 돌린다. **절대 throw 하지 않는다** — 실패하면 호출부가 본문을
 * 그대로 돌려줄 수 있어야 한다(가져온 것을 잃지 않는 게 우선).
 */
export const extractFromContent = async (
  input: ExtractInput,
): Promise<ExtractResult> => {
  const prompt = input.prompt.trim();
  if (prompt === "") return { ok: false, reason: "prompt 가 비어 있음" };

  const truncated = input.content.length > WEBFETCH_EXTRACT_MAX_CHARS;
  const content = truncated
    ? input.content.slice(0, WEBFETCH_EXTRACT_MAX_CHARS)
    : input.content;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), input.timeoutMs ?? WEBFETCH_EXTRACT_TIMEOUT_MS);
  try {
    const output = await runRegionA(
      {
        text: buildExtractPrompt({ url: input.url, prompt, content, truncated }),
        // 비채널 내부 호출 — 라우팅이 아니라 출처 라벨이다(classify 와 동형).
        threadKey: "webfetch:extract",
        channel: "internal",
        internal: true,
        leanMemory: true,
        toolPolicy: { mode: "none" },
        abortSignal: ac.signal,
      },
      { specs: cheapInternalTierSpecs() },
    );
    const text = output.text.trim();
    if (text === "") return { ok: false, reason: "모델이 빈 응답" };
    return { ok: true, text, truncated };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
};
