/**
 * 실제 어댑터 결과 적재 함수를 **실행해** 첫 전송 전에 새 출력이 사라지는 결함을 검사한다.
 *
 * ★종전엔 어댑터 소스에서 «C2 주석 ~ iteration += 1» 구간을 **문자열로 잘라 transpile** 해서
 *  돌렸다. 의도는 옳았다(별도 모형으로 순서를 복제하지 않는다). 하지만 그 구간이 함수로
 *  빠지자 앵커가 사라져 검사가 통째로 던졌다 — **검사가 리팩터를 막는 자리**였다.
 *  지금은 제품이 쓰는 `appendToolResultsToInput` 을 **그대로 부른다**: 모형도 없고 소스
 *  슬라이싱도 없다(지키려는 성질은 «그 모듈이 그렇게 한다» 이지 «그 파일 안에 그렇게
 *  적혀 있다» 가 아니다).
 */
import {
  appendToolResultsToInput,
  capToolOutputForEntry,
  codexCompactionLimits as L,
  CODEX_KNOWN_SAFE_INPUT_CHARS,
  isToolMediaMessage,
  type ResponseInputItem,
  type ResponseMediaItem,
} from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type ToolResult = { callId: string; name: string; output: string; media: ResponseMediaItem[] };

export const check: RegressionCheck = {
  name: "codex-fresh-tool-output",
  guards: "병렬 도구 결과를 모델에 한 번도 전달하기 전에 최근 3개 밖의 본문을 압축하던 것 · 도구를 부를 때마다 한 칸씩 압축해 프리픽스 캐시를 깨던 것(2026-09-26)",
  run: async (): Promise<Assertion[]> => {
    const input: ResponseInputItem[] = [];
    const batch = (prefix: string, count: number, size = 3000): ToolResult[] =>
      Array.from({ length: count }, (_, i) => ({
        callId: `${prefix}-${i}`,
        name: prefix,
        output: `${prefix}-${i}\n${"x".repeat(size)}`,
        media: [],
      }));
    const push = (outputs: ToolResult[]): number => {
      input.push(
        ...outputs.map(
          (o) =>
            ({
              type: "function_call",
              call_id: o.callId,
              name: "Read",
              arguments: "{}",
            }) as ResponseInputItem,
        ),
      );
      return appendToolResultsToInput(input, outputs, { requestChars: 0 });
    };
    const outputs = (): { call_id: string; output: string }[] =>
      input.filter(
        (i): i is Extract<ResponseInputItem, { type: "function_call_output" }> =>
          i.type === "function_call_output",
      );

    const first = batch("first", 5);
    const count = push(first);
    const assertions = [
      assert(
        "첫 병렬 결과 5개가 모두 첫 요청에 전달됨",
        count === 0 && outputs().every((o, i) => o.output === first[i]?.output),
        outputs().map((o) => o.output.length),
      ),
    ];
    const second = batch("second", 4);
    const oldCount = push(second);
    // ★몰아서 압축 (2026-09-26) — 오래된 결과가 기준(L.batchChars) 아래면 **아무것도 안 고친다**.
    //  고치면 그 자리부터 프리픽스 캐시가 깨진다(실측: 깨짐 158건 전부 압축 턴에서).
    assertions.push(
      assert(
        "★오래된 결과가 적게 쌓였으면 앞부분을 고치지 않는다(프리픽스 캐시 보존)",
        oldCount === 0 && outputs()[0]?.output === first[0]?.output,
        oldCount,
      ),
    );
    assertions.push(
      assert(
        "다음 배치 4개도 모두 보존",
        outputs()
          .slice(-4)
          .every((o, i) => o.output === second[i]?.output),
        outputs()
          .slice(-4)
          .map((o) => o.output.length),
      ),
    );
    const big = batch("big", 1, 50_000);
    big[0]?.media.push({ type: "input_image", image_url: "data:image/png;base64,AA==" });
    push(big);
    const last = outputs().at(-1);
    assertions.push(
      assert(
        "단일 출력 진입 cap은 유지",
        last?.output === capToolOutputForEntry(big[0]?.output ?? "") &&
          (last?.output.length ?? 0) < 16_500,
        last?.output.length,
      ),
    );
    const tail = input.at(-1);
    assertions.push(
      assert(
        "도구 이미지 연결 유지",
        // ★«묶음인가» 는 제품 함수가 판정한다 — 여기 규칙을 또 적으면 갈린다(2026-09-21).
        //  종전엔 `content[0] === input_image` 였는데, 라벨 한 줄이 앞에 붙자 빨개졌다.
        //  이 검사가 지키려는 것은 «자리» 가 아니라 «그림이 실려 왔는가» 다.
        isToolMediaMessage(tail) &&
          tail?.type === "message" &&
          tail.content.some((c) => c.type === "input_image"),
        tail,
      ),
    );
    // 긴 루프 — 앞부분을 고친 push 는 곧 압축한 push 여야 하고, 압축은 기준을 넘을 때만 일어난다.
    let pushes = 0, compactPushes = 0, changedWithoutCompaction = 0, pushedOldChars = 0;
    const windowBroken: string[] = [];
    for (let i = 0; i < 30; i++) {
      const before = JSON.stringify(input);
      const fresh = batch(`long-${i}`, 5, 50_000);
      const n = push(fresh);
      pushes += 1;
      pushedOldChars += 5 * L.entryCap;
      if (n > 0) {
        compactPushes += 1;
        // ★압축한 push 에서도 **이번 묶음 전부**(한 번도 전달 안 됨)와 **직전 최근 창**은 원형이어야 한다
        //  (2026-09-26 적대 검토 F1 — 새 계약으로 바꾸며 이 그물이 비었었다).
        const tail = outputs().slice(-(fresh.length + L.keepRecent));
        if (tail.some((o) => o.output.startsWith("\u0000"))) windowBroken.push(`push ${i}`);
      } else if (!JSON.stringify(input).startsWith(before.slice(0, -1))) changedWithoutCompaction += 1;
    }
    const liveChars = outputs()
      .filter((o) => !o.output.startsWith("\u0000"))
      .reduce((n, o) => n + o.output.length, 0);
    assertions.push(
      assert("압축하지 않은 push 는 앞부분을 한 글자도 안 바꾼다", changedWithoutCompaction === 0, { changedWithoutCompaction, compactPushes, pushes }),
      assert("★압축한 push 에서도 이번 묶음과 최근 창은 원형(전달 안 된 결과를 압축하지 않는다)", compactPushes > 0 && windowBroken.length === 0, windowBroken),
      assert("★압축은 몰아서 — 기준을 넘을 때만(push 마다가 아니다)", compactPushes > 0 && compactPushes <= Math.ceil(pushedOldChars / L.batchChars) + 1 && compactPushes < pushes, { compactPushes, pushes, 기준: L.batchChars }),
      assert(
        "긴 루프에서도 과거 본문 누적은 제한(기준 + 최근 창 + 이번 묶음)",
        liveChars < L.batchChars + (L.keepRecent + 5) * L.entryCap,
        { liveChars, 상한: L.batchChars + (L.keepRecent + 5) * L.entryCap },
      ),
    );
    // ★짧은 출력은 기준에 **안 센다**(F2) — 세면 짧은 게 쌓인 뒤 push 마다 기준을 넘어 한 칸씩 압축으로 돌아간다.
    const shorty: ResponseInputItem[] = [];
    const pushTo = (arr: ResponseInputItem[], outs: ToolResult[], room = { requestChars: 0 }): number => {
      arr.push(...outs.map((o) => ({ type: "function_call", call_id: o.callId, name: "Read", arguments: "{}" }) as ResponseInputItem));
      return appendToolResultsToInput(arr, outs, room);
    };
    pushTo(shorty, batch("short", Math.ceil(L.batchChars / (L.minOutputChars - 100)) + 5, L.minOutputChars - 100));
    let shortCompacted = 0;
    for (let i = 0; i < 6; i++) shortCompacted += pushTo(shorty, batch(`lg-${i}`, 1, 10_000));
    // ★상한 근처면 기준과 무관하게 즉시(F3) — 같은 배열·같은 입력인데 요청 크기만 다르다.
    const nearA: ResponseInputItem[] = []; const nearB: ResponseInputItem[] = [];
    pushTo(nearA, batch("na", 5, 10_000)); pushTo(nearB, batch("nb", 5, 10_000));
    const far = pushTo(nearA, batch("na2", 1, 10_000), { requestChars: 100_000 });
    const near = pushTo(nearB, batch("nb2", 1, 10_000), { requestChars: CODEX_KNOWN_SAFE_INPUT_CHARS - 5_000 });
    assertions.push(
      assert("★짧은 출력만 기준 이상 쌓여도 긴 출력 한 칸씩 압축으로 돌아가지 않는다", shortCompacted === 0, shortCompacted),
      assert("★다음 요청이 실측 성공 상한을 넘을 것 같으면 즉시 압축 · 멀면 몰아서 기다린다", near > 0 && far === 0, { near, far }),
    );
    const calls = input
      .filter((i) => i.type === "function_call")
      .map((i) => (i as { call_id: string }).call_id);
    assertions.push(
      assert(
        "호출·응답 ID 대응 보존",
        calls.length === outputs().length &&
          outputs().every((o, i) => o.call_id === calls[i]),
        calls.length,
      ),
    );
    return assertions;
  },
};
