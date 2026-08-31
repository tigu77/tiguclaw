/**
 * 회귀: **모델 고르는 화면이 능력을 보여준다** (2026-08-31).
 *
 * ★사고: 벤더에게 물어 컨텍스트·도구 지원을 카탈로그에 담아뒀는데(`/models` 응답의
 *  `context_length`·`supported_parameters` 등) **사용자가 모델을 고르는 화면이 그걸 안 썼다.**
 *  재놓고 안 보여주면 없는 것과 같다 — 사용자는 여전히 골라 보고 400 을 맞아야 알았다.
 *
 * ★그리고 **삼상태를 화면까지** 들고 가야 한다: 지원함 / 선언했는데 없음 / **모름**.
 *  모름을 `도구✖` 로 뭉개면 화면이 **거짓말**을 한다(실측: `whisper-large-v3` 는
 *  `supported_features: null`, google 은 필드 자체가 없다 — 둘 다 "안 됨" 이 아니다).
 *
 * ★렌더러가 **순수 함수**라 조회를 주입받는다 — 그래서 이 검사가 데몬·네트워크 없이 돈다
 *  (그 파일 헤더가 *"IO·전역읽기를 인자로 끌어올려 격리 테스트 가능"* 이라고 적어둔 이유).
 *
 * 등급: **동작** — 실제 렌더러를 돌려 문자열을 본다.
 */
import { renderModelProfiles, capsLabel } from "../../core/entry/models-command.js";
import { modelCapsFor, __setCatalogForTest } from "../../core/llm-runtime/model-catalog.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "models-view-shows-caps",
  guards:
    "컨텍스트·도구 지원을 벤더에게 물어 담아두고도 모델 고르는 화면이 안 써서, 사용자가 골라 보고 나서야 알던 것 + 그걸 보여주며 «모름» 을 «안 됨» 으로 뭉개 화면이 거짓말하는 것",
  run: async (): Promise<Assertion[]> => {
    const CAPS: Record<string, { context?: number; tools?: boolean }> = {
      "groq:qwen/qwen3.8-27b": { context: 131_042, tools: true },
      "groq:groq/compound": { context: 131_072, tools: false },
      "groq:whisper-large-v3": { context: 448 }, // 도구는 모름
    };
    const profiles = {
      default: {
        pool: [
          { spec: "groq:qwen/qwen3.8-27b" },
          { spec: "groq:groq/compound" },
          { spec: "groq:whisper-large-v3" },
          { spec: "google:gemini-3.6-flash" }, // 아무것도 모름
        ],
      },
    } as unknown as Parameters<typeof renderModelProfiles>[0];

    const out = renderModelProfiles(profiles, null, "default", {}, false, (s) => CAPS[s]);
    const bare = renderModelProfiles(profiles, null, "default", {}, false, undefined);

    // ★**배선까지 잰다** — 렌더러(순수)만 재면 *조회를 실제로 꽂는 자리*가 사각이다.
    //  실측: `index.ts` 안 인라인 클로저를 끊어도 스위트가 초록이었다. 그래서 모듈로 뽑고
    //  여기서 카탈로그를 세워 **실행으로** 본다(네트워크 0).
    __setCatalogForTest({
      fetchedAt: Date.now(),
      models: { groq: ["qwen/qwen3.8-27b"] },
      context: { "groq:qwen/qwen3.8-27b": 131_042 },
      tools: { "groq:qwen/qwen3.8-27b": true },
    });
    const wired = modelCapsFor("groq:qwen/qwen3.8-27b");
    const wiredUnknown = modelCapsFor("groq:nope");
    const wiredBad = modelCapsFor("콜론없음");
    __setCatalogForTest(null);

    return [
      assert(
        "★★능력을 **아는 모델엔 보여준다** — 재놓고 안 보여주면 없는 것과 같다(사용자는 골라 보고 400 을 맞아야 알았다)",
        /131K · 도구✅/.test(out) && /131K · 도구✖/.test(out),
        out.split("\n").find((l) => l.includes("풀:"))?.slice(0, 110) ?? "(풀 줄 없음)",
      ),
      assert(
        "★★**모름은 «안 됨» 이 아니다** — 도구 선언이 없는 모델엔 도구 표식을 안 붙인다(뭉개면 화면이 거짓말한다)",
        /whisper-large-v3`\s*\[448\]/.test(out) && !/whisper-large-v3`\s*\[448 · 도구/.test(out),
        `whisper 꼬리표 = ${/\[448[^\]]*\]/.exec(out)?.[0] ?? "(없음)"}`,
      ),
      assert(
        "★아무것도 모르는 모델엔 **꼬리표가 아예 없다** — 빈 자리가 «모름» 이라는 뜻이 되게 둔다(`도구?` 를 늘어놓아 화면을 시끄럽게 하지 않는다)",
        capsLabel(undefined) === "" && !/gemini-3\.6-flash`\s*\[/.test(out),
        `undefined 라벨="${capsLabel(undefined)}"`,
      ),
      assert(
        "★조회를 **`undefined` 로 주면 종전 그대로** — 렌더러의 순수성 유지(인자 자체는 필수라 호출부가 빼면 컴파일이 깨진다)",
        !bare.includes("[") || !/도구/.test(bare),
        bare.split("\n").find((l) => l.includes("풀:"))?.slice(0, 80) ?? "(풀 줄 없음)",
      ),
      assert(
        "★★조회가 **카탈로그에 실제로 꽂혀 있다** — 렌더러만 재면 배선이 사각이다(실측: 부팅 파일 안 인라인 클로저를 끊어도 초록이었다)",
        wired?.context === 131_042 && wired?.tools === true,
        JSON.stringify(wired),
      ),
      assert(
        "★반대 방향 — **모르는 것·이상한 spec 엔 `undefined`**(꼬리표가 안 붙는다)",
        wiredUnknown === undefined && wiredBad === undefined,
        `모르는모델=${String(wiredUnknown)} · 콜론없음=${String(wiredBad)}`,
      ),
    ];
  },
};
