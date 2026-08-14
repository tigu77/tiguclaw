/**
 * 회귀: codex 무진전 가드가 **도구 인자 스트리밍을 진전으로 센다** (2026-08-14).
 *
 * 사고: XL 벤치에서 한 런이 178초 → **434초**로 튀었다. 로그:
 *   `codex 무진전(spinning) (chunks=14555, iter=306s, 마지막청크 0s 전) — 스텝 재개 1/2`
 * 초당 48개씩 청크가 오는데 "무수신" 판정이었다. 진전 beat 를 `output_text.delta` 와
 * `output_item.added`(도구 호출 **시작**)에만 걸어놨기 때문이다 — 그 뒤로 인자가 아무리
 * 길게 흘러도 타이머는 안 움직인다. 5분(CODEX_NO_PROGRESS_MS)을 넘기면 가드가 컷하고
 * 같은 컨텍스트로 재개하는데, 그건 **생성 중이던 5분을 통째로 버리는 것**이다.
 *
 * ★이 모양은 흔하다: 파일 여러 개를 **히어독 한 번**으로 쓰는 `Bash`(모델이 실제로 가장
 *  자주 고르는 방식 — 실측 XL 에서 6개 파일을 Bash 한 호출로 썼다), 큰 파일 하나의 `Write`,
 *  긴 패치의 `Edit` — 전부 "beat 한 번 뒤 인자만 수천 토큰" 이다.
 *
 *  처음 드러난 계기는 **하루만 살았던 `EditFiles`**(여러 파일 한 호출)였다. 그 도구는
 *  측정 결과 되돌렸지만 결함은 남는다 — 남는 교훈은 도구 이름이 아니라 이것이다:
 *  **도구가 바뀌면 스트림 모양이 바뀌고, 그 스트림을 지켜보는 가드도 같이 봐야 한다**
 *  (계약을 바꿨는데 소비처를 안 봤다).
 *
 * 소스 문자열이 아니라 **파서를 실제로 돌려서** 판정한다 — 이름이 바뀌어도, 분기가
 * 옮겨가도, "인자가 흐르면 beat 한다" 는 행동만 지키면 통과한다.
 */
import { parseCodexSse } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** SSE 이벤트 배열 → ReadableStream (파서가 받는 그대로의 wire 형식). */
const sseStream = (events: unknown[]): ReadableStream<Uint8Array> => {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 사고 재현 — 도구 하나 + 긴 인자 스트림 ────────────────────────────────
  //  히어독으로 6개 파일을 쓰는 Bash 의 모양: added 1번 + arguments.delta 수백 번.
  {
    const deltas = 200;
    const events: unknown[] = [
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Bash", arguments: "" } },
      ...Array.from({ length: deltas }, () => ({
        type: "response.function_call_arguments.delta",
        delta: "x".repeat(40),
      })),
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Bash", arguments: "{}" } },
      { type: "response.completed", response: { id: "resp_1" } },
    ];
    let progress = 0;
    await parseCodexSse(sseStream(events), undefined, undefined, () => {
      progress += 1;
    });
    out.push(
      assert(
        "★인자 델타마다 진전 beat 가 온다(한 번이 아니라)",
        progress >= deltas,
        `beat ${progress}회 / 인자 델타 ${deltas}회 (기대 ≥${deltas}) — 1이면 사고 재현`,
      ),
    );
  }

  // ── ② in_progress heartbeat 는 여전히 진전이 아니다 ─────────────────────────
  //  이걸 진전으로 세면 가드가 **영영 안 터진다** — 진짜 죽은 스트림을 못 잡는다.
  //  ①을 고치면서 "그냥 청크마다 beat" 로 가면 이 축이 무너지므로 같이 지킨다.
  {
    const events: unknown[] = [
      ...Array.from({ length: 50 }, () => ({ type: "response.in_progress" })),
      { type: "response.completed", response: { id: "resp_2" } },
    ];
    let progress = 0;
    let chunks = 0;
    await parseCodexSse(
      sseStream(events),
      () => {
        chunks += 1;
      },
      undefined,
      () => {
        progress += 1;
      },
    );
    out.push(
      assert(
        "★in_progress 만 흐르면 진전 0(진짜 무진전은 여전히 잡힌다)",
        progress === 0 && chunks > 0,
        `진전 ${progress}회 · 청크 ${chunks}회 (기대 진전 0)`,
      ),
    );
  }

  // ── ③ 텍스트 델타도 진전 — 원래 축이 살아 있는지 ────────────────────────────
  {
    const events: unknown[] = [
      { type: "response.output_text.delta", delta: "안" },
      { type: "response.output_text.delta", delta: "녕" },
      { type: "response.completed", response: { id: "resp_3" } },
    ];
    let progress = 0;
    await parseCodexSse(sseStream(events), undefined, undefined, () => {
      progress += 1;
    });
    out.push(assert("텍스트 델타는 진전이다(기존 축 보존)", progress >= 2, `beat ${progress}회`));
  }

  return out;
};

export const check: RegressionCheck = {
  name: "codex-progress-counts-tool-args",
  guards:
    "큰 인자를 만드는 도구(히어독 Bash·큰 Write 등)가 5분 무진전 상한에 걸려 생성 중이던 5분을 통째로 버리던 것 — 초당 48청크가 오는데 '무수신' 판정이었다(XL wall 178s→434s)",
  run,
};
