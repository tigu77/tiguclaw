/**
 * 회귀: **상대가 프롬프트를 자르면 그렇다고 말한다** (2026-08-31).
 *
 * ★사고(실측): 로컬 ollama 는 모델이 32,768 을 지원해도 **서버 기본 4,096** 으로 서빙한다.
 *  우리 최소 턴은 26,548 토큰이라 85%가 버려지는데 **신호가 하나도 없다** — HTTP 200,
 *  에러 0, 답도 나온다. 다만 그 답엔 헌법·메모리·능력이 없다. 실측으로
 *  *"지침에 적힌 네 이름"* 을 물으면 로컬은 `모름`(같은 지침이 닿는 provider 는 `돌쇠`).
 *  사용자는 **"이 모델이 멍청하다"** 로 읽는다 — 우리 능력이 통째로 빠진 건데.
 *
 * ★판정을 **순수 함수로 뽑은 이유**: 이 규칙의 동작을 어댑터 안에 두면 검사하려고 데몬을
 *  띄워야 하고, 그러면 그물이 문자열 grep 으로 약해진다([[feedback_simple_composable_no_duplication]]
 *  의 *"검사가 껄끄러우면 코드가 잘못 놓인 것"*). 여기선 **실행으로** 잰다.
 *
 * 지키는 것 넷: ①진짜 잘림을 잡는다 ②**오탐 0**(정상 비율에 침묵) ③usage 미보고면 침묵
 * ④안내에 **판정 수치**가 실린다(원격 인스턴스는 로그가 유일한 창이다).
 */
import {
  detectTruncation,
  predictTruncation,
  truncationNote,
  willTruncateNote,
} from "../../core/llm-runtime/truncation.js";
import {
  buildCompatDiscoverResult,
  readContextLengths,
  readToolSupport,
} from "../../core/llm-runtime/model-catalog.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "truncation-is-not-silent",
  guards:
    "상대가 컨텍스트 상한으로 프롬프트를 조용히 잘라도 에러 0·200 OK 라, 지침·메모리·능력이 빠진 답이 '모델이 멍청한 것' 으로 읽히던 것(실측: ollama 기본 4,096 이 26.5K 를 85% 버린다)",
  run: async (): Promise<Assertion[]> => {
    // ① 실측 사례 그대로 — 56.4KB 를 보냈는데 4,095 토큰만 처리.
    const real = detectTruncation(56_400, 4_095);
    // ② 정상 — 같은 크기에 실측 비율(약 2.18B/토큰)이면 26K 근처다.
    const normal = detectTruncation(56_400, 26_548);
    // ②b 경계 — 보수 하한(4B/토큰)의 절반보다 조금 위면 침묵해야 한다.
    // ★픽스처를 **현실값으로** 고쳤다 (적대 검토 P5 뒤). 옛 값(40,000B·5,100토큰)은 실제로
    //  **49%만 처리**된 것이라 이제 «의심» 에 걸린다 — 그게 맞다. 옛 단일 문턱에 맞춰 고른
    //  값이었을 뿐이다. 정상은 실측 비율(2.18B/토큰)에 가까운 값이어야 한다.
    const borderline = detectTruncation(40_000, 18_348); // 40,000B ÷ 2.18 ≈ 18,348
    // ③ usage 미보고 — 모르는 것을 아는 척하지 않는다.
    const unknown = detectTruncation(56_400, undefined);
    const zero = detectTruncation(56_400, 0);

    const note = real === null ? "" : truncationNote(real, "qwen2.5:7b");

    // ⑤ 사전 판정 — 벤더가 컨텍스트를 알려주면 **보내기 전에** 안다(실측: groq
    //    `whisper-large-v3` = 448토큰). 모르면 침묵한다 — 추측하면 멀쩡한 모델을 못 쓰게
    //    막는 것처럼 읽힌다.
    const pre = predictTruncation(56_400, 448);
    const preOk = predictTruncation(56_400, 131_042);
    const preUnknown = predictTruncation(56_400, undefined);
    const preNote = pre === null ? "" : willTruncateNote(pre, "whisper-large-v3");

    // ⑥ 발견이 **벤더 필드를 실제로 읽는가** — 이걸 안 재면 추출을 통째로 지워도 초록이다
    //    (실측으로 그랬다). 실제 응답 모양 그대로 넣는다.
    const read = readContextLengths([
      { id: "tencent/hy4-preview", context_length: 1_048_576 }, // OpenRouter 모양
      { id: "qwen/qwen3.8-27b", context_window: 131_042 }, // Groq 모양
      { id: "models/gemini-3.6-flash" }, // google — 안 준다
      { id: "bad", context_length: 0 }, // 0 은 값이 아니다
    ]);

    // ⑦ 도구 지원 선언 — **삼상태**(지원함 / 선언했는데 없음 / 모름). 실제 응답 모양 그대로.
    const tools = readToolSupport([
      { id: "qwen/qwen3.8-27b", supported_features: ["tools", "json_mode"] }, // Groq
      { id: "groq/compound", supported_features: ["json_mode"] }, // 선언했는데 tools 없음
      { id: "whisper-large-v3", supported_features: null }, // 선언 자체가 없음 = 모름
      { id: "tencent/hy4", supported_parameters: ["tools", "stop"] }, // OpenRouter
      { id: "models/gemini-3.6-flash" }, // google — 안 준다
    ]);

    // ⑧ ★**이음매** — 추출한 것이 조회 결과에 실제로 실리는가(부품만 재면 여기가 빈다).
    const built = buildCompatDiscoverResult([
      { id: "qwen/qwen3.8-27b", context_window: 131_042, supported_features: ["tools"] },
      { id: "models/gemini-3.6-flash" },
    ]);

    // ⑨ ★**사각지대 표** (적대 검토 P5). 실측값(26,548토큰 = 57,875바이트)을 그대로 넣고
    //    ollama 의 흔한 `num_ctx` 들에서 무엇을 말하는지 본다. 종전엔 문턱이 하나뿐이라
    //    **69% 유실이 완전 침묵**했다.
    const SENT = 57_875;
    const say = (ctx: number): string => {
      const v = detectTruncation(SENT, ctx);
      return v === null ? "침묵" : v.confidence;
    };
    const blind = { c4096: say(4_096), c8192: say(8_192), c16384: say(16_384) };
    // ★**문구가 등급을 따라간다** (변이 «등급뭉갬»). 의심 구간인데 «잘라냈습니다» 로
    //  단정하면, 이 릴리스가 다른 자리에서 지킨 «모르는 걸 아는 척하지 않는다» 가 깨진다.
    //  오늘 이 레포가 세 번 고친 병이다 — 문구가 판정보다 넓으면 안 된다.
    const sure = detectTruncation(SENT, 4_096);
    const maybe = detectTruncation(SENT, 8_192);
    const gradedWording =
      sure !== null &&
      maybe !== null &&
      /잘라냈습니다/.test(truncationNote(sure, "m")) &&
      /잘라냈을 수 있습니다/.test(truncationNote(maybe, "m"));
    // 정상(실측 비율 2.18B/토큰 ≈ 26,548)은 여전히 침묵해야 한다 — 오탐은 상시 경고가 된다.
    const normalQuiet = detectTruncation(SENT, 26_548) === null;
    // ★**문턱 바로 위**를 잰다 (2026-09-01, 3라운드 F8). 위 픽스처의 실제 비율은
    //  26,548 / (57,875/4) = **1.835** — 문턱(0.85)에서 2.2배 떨어져 있어서
    //  `SUSPECT_RATIO ≤ 1.835` 는 **뭐든 통과했다.** 실측으로 0.85 → 1.0 도, → 1.8 도
    //  초록이었다. 1.8 이면 사실상 **모든 호출**에 «잘라냈을 수 있습니다» 가 붙는데,
    //  그건 이 릴리스가 문턱을 둘로 나눈 이유(«오탐은 상시 경고가 되고 상시 경고는 아무도
    //  안 본다»)를 정확히 되돌리는 것이다. 경계를 안 넘는 픽스처는 검사가 아니다.
    const floor = SENT / 4; // 보수 하한(4바이트/토큰)
    const justAbove = detectTruncation(SENT, Math.ceil(floor * 0.86)) === null;
    const justBelow = detectTruncation(SENT, Math.floor(floor * 0.84))?.confidence === "의심";
    // ★사전 판정에 **죽은 필드가 없다** (3라운드 F10). 종전엔 `confidence: "확실"` 을
    //  억지로 채웠는데 `willTruncateNote` 가 안 읽었다 — 값을 «의심» 으로 바꿔도 스위트가
    //  초록이었다. 예보는 구조적으로 «확실» 뿐이므로(하한이 넘으면 실제는 반드시 더 많다)
    //  소비자를 고칠 게 아니라 **필드를 없애는** 것이 답이다. 타입이 아니라 실물을 본다.
    const pred = predictTruncation(SENT, 4_096);
    const predNoDeadField = pred !== null && !("confidence" in pred) && pred.sentAtLeast > 4_096;

    return [
      assert(
        "★★진짜 잘림을 잡는다 — 56.4KB 를 보냈는데 4,095 토큰만 처리된 실측 사례",
        real !== null,
        real === null ? "★못 잡음" : `최소 ${String(real.sentAtLeast)} → 처리 ${String(real.processed)}`,
      ),
      assert(
        "★★**오탐 0** — 정상 비율엔 침묵한다(토크나이저마다 비율이 달라 보수 하한을 쓴다). 상시 경고는 아무도 안 보게 된다",
        normal === null && borderline === null,
        `정상=${normal === null ? "침묵" : "★오탐"} · 경계=${borderline === null ? "침묵" : "★오탐"}`,
      ),
      assert(
        "★usage 를 안 주는 provider 엔 **아무 말도 안 한다** — 모르는 것을 아는 척하면 그게 오정보다",
        unknown === null && zero === null,
        `미보고=${unknown === null ? "침묵" : "★말함"} · 0=${zero === null ? "침묵" : "★말함"}`,
      ),
      assert(
        "★★안내에 **판정 수치**가 실린다 — 증상만 말면 원격 인스턴스에서 진단이 안 된다(로그가 유일한 창이다)",
        /4,095/.test(note) && /num_ctx/.test(note),
        note === "" ? "★안내 없음" : `${note.slice(0, 50)}…`,
      ),
      assert(
        "★★벤더가 컨텍스트를 알려주면 **보내기 전에** 잡는다 — usage 를 안 주는 provider 도 덮이고 헛된 호출을 아낀다(실측: groq whisper 448토큰)",
        pre !== null && preOk === null,
        `작은 모델=${pre === null ? "★놓침" : "잡음"} · 큰 모델=${preOk === null ? "침묵" : "★오탐"}`,
      ),
      assert(
        "★컨텍스트를 **모르면 침묵한다** — 추측하면 멀쩡한 모델을 못 쓰게 막는 것처럼 읽힌다(막지는 않는다, 말할 뿐이다)",
        preUnknown === null && /448/.test(preNote) && /잘려 나갑니다/.test(preNote),
        `미보고=${preUnknown === null ? "침묵" : "★말함"} · 문구=${preNote.slice(0, 32)}…`,
      ),
      assert(
        "★★**69% 유실이 침묵하지 않는다** — 문턱이 하나뿐일 땐 `num_ctx=8192`(흔한 설정)에서 아무 말도 안 했다. 확실한 구간은 단정하고 애매한 구간은 «잘렸을 수 있다» 로 등급을 낮춰 말한다",
        // ★`16384` 는 **침묵이 정직하다** — 보수 하한(14,468)보다 많이 처리했으니 우리가
        //  알 수가 없다. 아는 척하지 않는 게 이 검사의 다른 절반이다.
        blind.c4096 === "확실" &&
          blind.c8192 !== "침묵" &&
          // ★16,384 는 보수 하한(14,468)보다 **많이 처리한** 값이라 우리가 알 수가 없다 —
          //  침묵이 정직하다. 계산해 놓고 단언에 안 넣으면 «본 것»이 아니다(3라운드 F9).
          blind.c16384 === "침묵" &&
          gradedWording,
        `4096=${blind.c4096} · 8192=${blind.c8192} · 16384=${blind.c16384} · 문구등급=${String(gradedWording)}`,
      ),
      assert(
        "★반대 방향 — **정상 비율엔 여전히 침묵한다**(오탐은 상시 경고가 되고, 상시 경고는 아무도 안 본다)",
        normalQuiet,
        normalQuiet ? "실측 26,548토큰 → 침묵" : "★오탐",
      ),
      assert(
        "★★문턱이 **그 자리에 있다** — 바로 위는 침묵, 바로 아래는 의심. 종전 픽스처는 문턱에서 2.2배 떨어져 있어 `SUSPECT_RATIO` 를 1.8 로 올려도 초록이었다(그러면 사실상 모든 호출에 경고가 붙는다)",
        justAbove && justBelow,
        `하한×0.86=${Math.ceil((SENT / 4) * 0.86)} → ${justAbove ? "침묵" : "★경고"} · 하한×0.84=${Math.floor((SENT / 4) * 0.84)} → ${justBelow ? "의심" : "★침묵"}`,
      ),
      assert(
        "★사전 판정엔 **아무도 안 읽는 필드가 없다** — 예보는 구조적으로 «확실» 뿐이라 등급을 채우면 죽은 값이 된다(값을 바꿔도 아무 일도 안 일어났다)",
        predNoDeadField,
        `필드=${Object.keys(pred ?? {}).join(",")}`,
      ),
      assert(
        "★★발견이 **벤더 컨텍스트 필드를 실제로 읽는다**(별칭 둘) — 안 읽으면 위 사전 판정이 영원히 침묵한다",
        read["tencent/hy4-preview"] === 1_048_576 && read["qwen/qwen3.8-27b"] === 131_042,
        JSON.stringify(read),
      ),
      assert(
        "★반대 방향 — **안 주는 모델은 없는 채로 둔다**(0도 값이 아니다). 지어낸 컨텍스트로 경고하면 멀쩡한 모델을 막는 것처럼 읽힌다",
        !("gemini-3.6-flash" in read) && !("bad" in read),
        `google=${String("gemini-3.6-flash" in read)} · 0값=${String("bad" in read)}`,
      ),
      assert(
        "★★도구 지원 **선언을 벤더 필드 둘에서 읽는다** — 고르기 전에 알 수 있어야 쓰다가 400 을 맞지 않는다",
        tools["qwen/qwen3.8-27b"] === true && tools["tencent/hy4"] === true,
        JSON.stringify(tools),
      ),
      assert(
        "★★**부재는 «지원 안 함» 이 아니다** — 삼상태를 지킨다. 뭉개면 선언 안 한 모델이 «도구 못 쓰는 모델» 이 되어 되는 걸 막는 것처럼 읽힌다",
        tools["groq/compound"] === false &&
          !("whisper-large-v3" in tools) &&
          !("gemini-3.6-flash" in tools),
        `선언·없음=${String(tools["groq/compound"])} · null=${String("whisper-large-v3" in tools)} · 미제공=${String("gemini-3.6-flash" in tools)}`,
      ),
      assert(
        "★★추출한 것이 **조회 결과에 실린다** — 부품만 재면 이음매가 빈다(실측: 싣는 줄 하나를 지워도 초록이었다)",
        built.context?.["qwen/qwen3.8-27b"] === 131_042 &&
          built.tools?.["qwen/qwen3.8-27b"] === true &&
          built.unranked === true &&
          built.slugs.includes("gemini-3.6-flash"),
        `context=${String(built.context?.["qwen/qwen3.8-27b"])} · tools=${String(built.tools?.["qwen/qwen3.8-27b"])} · unranked=${String(built.unranked)} · slugs=${String(built.slugs.length)}`,
      ),
    ];
  },
};
