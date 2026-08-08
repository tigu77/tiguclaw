/**
 * 회귀: **쓸 수 없는 요약을 성공으로 확정하지 않는다** (2026-08-01 라이브 유실).
 *
 * 사고: codex 히스토리 압축이 47턴 **40,121자**를 접었는데 모델이 **5자**를 돌려줬다.
 * 가드가 `fresh.trim() !== ""` 뿐이라 그것을 **성공으로 확정** — `compactedThrough` 가
 * 전진해 그 47턴이 **영구히** 컨텍스트 밖으로 나갔다. 그리고 셋 다 거짓을 말했다:
 *   로그 `[codex 6b] 압축 성공 … 요약=5자` · 사용자 통지 `요약으로 압축했습니다`
 *   · 이벤트 `llm.compacted{summaryChars:5}`
 *
 * ★임계는 직감이 아니라 실측이다(기록된 압축 6건):
 *   정상 = 377·485·257·355·354자 — 입력 2만~6만 자와 **무관하게** 수백 자에 몰린다.
 *   실패 = 5자.
 *  그 사이가 비어 있으므로 **절대 하한**이 맞다(비율은 입력 크기에 흔들린다).
 *
 * ★거부가 수용보다 싸다: 거부하면 watermark 가 안 움직여 원문이 `transcripts` 에 남고
 *  **다음 턴에 다시 시도**한다(그 턴의 전송분만 oldest-drop 으로 잘린다 = 일시적).
 *  수용은 되돌릴 수 없다. 애매하면 거부가 안전한 쪽이다 — 이 검사는 그 방향을 지킨다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "summary-quality-gate",
  guards:
    "히스토리 압축이 5자짜리 요약을 성공으로 확정해 47턴 40,121자를 영구히 잃던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { isUsableSummary, MIN_USABLE_SUMMARY_CHARS } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.js"
    );

    // ★① 실제 관측값 — 정상은 통과, 사고 케이스는 거부.
    const observedOk = [377, 485, 257, 355, 354]; // 라이브 정상 요약 길이
    const passed = observedOk.filter((n) => isUsableSummary("가".repeat(n)));
    out.push(
      assert(
        "★실제로 정상이었던 요약 5건이 전부 통과한다(과잉 거부 0)",
        passed.length === observedOk.length,
        `${passed.length}/${observedOk.length} 통과 (관측 최소 ${Math.min(...observedOk)}자)`,
      ),
    );
    out.push(
      assert(
        "★사고 케이스(5자)는 거부된다",
        !isUsableSummary("가나다라마"),
        `5자 → ${isUsableSummary("가나다라마") ? "★통과(유실)" : "거부"}`,
      ),
    );

    // ★② 경계 — 하한 바로 아래/위. 여기가 흐리면 임계가 있으나 마나다.
    out.push(
      assert(
        `하한 ${MIN_USABLE_SUMMARY_CHARS}자 미만은 거부, 이상은 통과`,
        !isUsableSummary("가".repeat(MIN_USABLE_SUMMARY_CHARS - 1)) &&
          isUsableSummary("가".repeat(MIN_USABLE_SUMMARY_CHARS)),
        `${MIN_USABLE_SUMMARY_CHARS - 1}자=거부 / ${MIN_USABLE_SUMMARY_CHARS}자=통과`,
      ),
    );
    // 공백만 채운 것도 요약이 아니다(trim 후 판정).
    out.push(
      assert(
        "공백·개행만 있는 것은 거부한다(길이만 채운 위장)",
        !isUsableSummary("   \n\n\t  ".repeat(20)),
        "공백 160자 → 거부",
      ),
    );
    out.push(
      assert("빈 문자열은 당연히 거부", !isUsableSummary(""), "거부"),
    );

    // ★③ 임계가 관측 사이에 **여유 있게** 놓였는가 — 양쪽에 붙어 있으면 플래키해진다.
    const worstFail = 5;
    const bestNormal = Math.min(...observedOk);
    out.push(
      assert(
        "★임계가 관측 실패와 관측 정상 사이에 여유 있게 있다(직감 아님)",
        MIN_USABLE_SUMMARY_CHARS >= worstFail * 2 &&
          MIN_USABLE_SUMMARY_CHARS <= bestNormal / 2,
        `실패 ${worstFail}자 ×${(MIN_USABLE_SUMMARY_CHARS / worstFail).toFixed(0)} = ${MIN_USABLE_SUMMARY_CHARS}자 = 정상 ${bestNormal}자 ÷${(bestNormal / MIN_USABLE_SUMMARY_CHARS).toFixed(0)}`,
      ),
    );

    // ★④ 배선 — `compactedThrough` 를 확정하는 **모든** 자리가 이 판정 뒤인가.
    //  ★순서 나열로 쓰지 않는다: 처음엔 그렇게 썼다가 **두 번째 쓰기 경로**(수동 압축)를
    //   발견했다 — 그쪽은 여전히 `=== ""` 라 5자를 통과시키고 있었다. 자리를 세는 대신
    //   "쓰기 지점 수 == 게이트 통과 지점 수" 로 판정한다(새 경로가 생겨도 잡힌다).
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../core/llm-runtime/adapters/openai-codex-oauth-history.ts",
      ),
      "utf8",
    );
    const writes = (src.match(/upsertThreadSummary\(\{/g) ?? []).length;
    // ★인자 **이름**이 아니라 **판정 호출**을 센다 (2026-08-09). 종전엔
    //  `isUsableSummary(fresh)` 로 변수명까지 박아, 같은 판정을 다른 이름의 값에 적용한
    //  세 번째 쓰기 경로(누적 요약 재압축)를 "가드 없음" 으로 오탐했다 — 손으로 적은
    //  이름이 판정을 가로챈 것이다([[feedback_hand_maintained_lists]]).
    const gates = (src.match(/isUsableSummary\([A-Za-z_$][\w$]*\)/g) ?? []).length;
    out.push(
      assert(
        "★요약 저장 지점 수 = 품질 판정 지점 수(가드 없는 쓰기 경로 0)",
        writes > 0 && writes === gates,
        `저장 ${writes}곳 · 판정 ${gates}곳`,
      ),
    );
    // 남은 `=== ""` 식 약한 가드가 없어야 한다 — 그게 5자를 통과시킨 형상이다.
    out.push(
      assert(
        "★`빈 문자열만 거부` 형태의 약한 가드가 남아 있지 않다",
        !/fresh\.trim\(\)\s*(===|!==)\s*""/.test(src),
        /fresh\.trim\(\)\s*(===|!==)\s*""/.test(src) ? "★약한 가드 잔존" : "잔존 0",
      ),
    );

    // ★⑤ 요약 호출이 **codex 규칙 안**에 있는가 (2026-08-01 ②).
    //  종전엔 쿨다운을 안 보고 때렸고 실패해도 등록하지 않았다 — 어댑터가 index 를
    //  import 할 수 없어(순환) 판정에 닿지 못한 **구조 문제**였다. 포트로 내려보낸다.
    //  ★미등록이면 게이트가 통째로 죽는다(막지 않도록 설계했으므로 조용히). 그래서
    //   "등록됐는가" 를 여기서 지킨다 — 이게 없으면 배선이 빠져도 아무도 모른다.
    const { setSummarizerCooldownPort } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.js"
    );
    out.push(
      assert(
        "요약 쿨다운 포트가 주입 가능하다(구조 확인)",
        typeof setSummarizerCooldownPort === "function",
        typeof setSummarizerCooldownPort,
      ),
    );
    const idxSrc = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../core/llm-runtime/index.ts",
      ),
      "utf8",
    );
    out.push(
      assert(
        "★index 가 부팅 시 그 포트를 실제로 꽂는다(배선 누락 0)",
        /setSummarizerCooldownPort\(\{/.test(idxSrc),
        /setSummarizerCooldownPort\(\{/.test(idxSrc) ? "등록 확인" : "★미등록 — 게이트가 죽어 있다",
      ),
    );
    // 요약 경로가 쿨다운을 **보고** 실패를 **등록**하는가(두 방향 모두).
    const hist = src;
    out.push(
      assert(
        "★요약 호출 전 쿨다운을 보고, 실패는 등록한다(양방향)",
        /cooldownPort\?\.remainingMs\(/.test(hist) && /cooldownPort\?\.register\(/.test(hist),
        `조회=${/cooldownPort\?\.remainingMs\(/.test(hist)} 등록=${/cooldownPort\?\.register\(/.test(hist)}`,
      ),
    );

    return out;
  },
};
