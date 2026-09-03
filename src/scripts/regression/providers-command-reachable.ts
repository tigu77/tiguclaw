/**
 * 회귀: **`/providers` 가 627개를 감당한다** (2026-09-02 정태님 요청으로 신설).
 *
 * ★이 명령이 생긴 이유: 카탈로그는 부팅·매시 provider 에게 물어 모델 목록을 받아두는데,
 *  그걸 읽는 곳이 **비서의 도구와 dev 스크립트뿐**이라 사용자는 «무슨 모델이 있는지» 볼
 *  곳이 없었다. v0.44.0 릴리스 노트가 *"제품이 알려줍니다"* 라고 했는데 절반만 지킨 약속이었다.
 *
 * ★검사의 초점은 **도달 가능성**이다. 이 설치의 실측이 627개(openrouter 420)라 한 응답에
 *  다 실을 수 없어 캡을 뒀는데, 캡만 두면 그게 곧 벽이 된다 —
 *  *"캡 있는 자리에 반드시 도달해야 할 것을 두지 마라"*([[project_hotpath_bound_preserve_record]]).
 *  그래서 «잘랐다» 가 아니라 «어떻게 닿는가» 를 말하는지, 그리고 그 길이 **실제로 통하는지**
 *  둘 다 실행으로 확인한다.
 *
 * 등급: **동작**(순수 렌더를 실제 호출) + **판정**(provider 이름이 코드에 없는가).
 */
import { renderProviders, type ProviderView } from "../../core/entry/providers-command.js";
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 실측 규모를 그대로 흉내낸다 — 30개짜리 픽스처로는 캡이 안 눌린다. */
const many = (n: number, pre: string): string[] =>
  Array.from({ length: n }, (_, i) => `${pre}-${String(i)}`);

/** 실물 모양: openrouter id 는 `vendor/model` 이고 벤더가 여럿이다(실측 58종). */
const OR = [
  ...many(200, "openai/gpt"),
  ...many(150, "qwen/qwen"),
  ...many(69, "google/gemini"),
  "anthropic/claude-fable",
];

const VIEWS: ProviderView[] = [
  { name: "anthropic", models: ["claude-opus-5", "claude-sonnet-5"], authed: true },
  { name: "openrouter", models: OR, authed: true },
  // ★**섞인** provider — 일부만 네임스페이스가 있고 캡을 넘는다. 실물엔 아직 없지만
  //  (groq 이 11/14 로 섞여 있으나 캡 미만) 묶기가 여기서 살아나면 `/` 없는 5개가
  //  **색인에도 목록에도 안 나와** 닿을 길이 사라진다. 잠복 결함이라 픽스처로 세워둔다.
  //  ★벤더를 **둘 이상** 둔다 — 하나면 `vendors.size > 1` 가드에 가려 변이가 안 드러난다
  //   (첫 판이 그랬다: 섞인 케이스를 넣고도 변이가 통과했다).
  { name: "mixed", models: [...many(25, "acme/m"), ...many(15, "beta/m"), ...many(5, "plain")], authed: true },
  { name: "groq", models: [], authed: true }, // 인증은 됐는데 목록을 못 받았다
  { name: "ollama", models: [], authed: false }, // 인증 자체가 없다
];

const CAPS = (spec: string): { context?: number; tools?: boolean } | undefined =>
  spec === "anthropic:claude-opus-5" ? { context: 200_000, tools: true } : undefined;

export const check: RegressionCheck = {
  name: "providers-command-reachable",
  guards:
    "카탈로그가 provider 별 모델을 받아두고도 사용자에게 보여줄 곳이 없던 것 + 그걸 보여주면서 627개(openrouter 420)를 한 응답에 쏟아 잘리던 것 + 캡만 두어 420번째 모델에 닿을 길이 없던 것(2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    const list = renderProviders(VIEWS, "", CAPS);
    const one = renderProviders(VIEWS, "openrouter", CAPS);
    const filtered = renderProviders(VIEWS, "openrouter claude", CAPS);
    const unknown = renderProviders(VIEWS, "openai", CAPS);
    const nomatch = renderProviders(VIEWS, "openrouter zzzz", CAPS);
    const empty = renderProviders([], "", CAPS);
    const withCaps = renderProviders(VIEWS, "anthropic", CAPS);
    const bodyLines = (s: string): number =>
      s.split("\n").filter((l) => l.startsWith("• `")).length;

    return [
      assert(
        "★목록은 **모든 provider** 를 센다 — 설정했는데 0개인 것도 보여야 «왜 안 보이지» 에 답한다",
        VIEWS.every((v) => list.includes(v.name)),
        VIEWS.filter((v) => !list.includes(v.name)).map((v) => v.name).join(",") || "전부 있음",
      ),
      assert(
        "★★목록에 **모델 이름을 싣지 않는다** — 627개가 한 응답에 들어가면 잘린다(그래서 개수만)",
        !list.includes("openai/gpt-0") && list.includes("420"),
        `모델명 유출=${list.includes("openai/gpt-0")} · 개수 표기=${list.includes("420")}`,
      ),
      assert(
        "★«인증 없음» 과 «목록 못 받음» 을 **구분**한다 — 뭉개면 사용자가 엉뚱한 데를 고친다",
        list.includes("인증 없음") && list.includes("조회 실패"),
        `인증없음=${list.includes("인증 없음")} · 조회실패=${list.includes("조회 실패")}`,
      ),
      // ★큰 provider 는 **모델이 아니라 색인**을 준다 (2026-09-02 정태님:
      //  *"굳이 다보여줄 필요는 없을거같긴한데.. 특히 오픈라우터"*). 420개 중 아무 30개는
      //  고르는 데 도움이 안 된다 — id 에 이미 있는 네임스페이스로 묶는다.
      assert(
        "★★네임스페이스가 있는 큰 provider 는 **모델을 나열하지 않는다**(아무 30개는 아무것도 아니다)",
        bodyLines(one) === 0 && one.includes("벤더"),
        `모델줄 ${bodyLines(one)}개(0이어야) · 색인=${one.includes("벤더")}`,
      ),
      assert(
        "★★색인은 **자르지 않는다** — 색인을 자르면 그게 다시 벽이라 묶은 의미가 없다",
        ["openai(200)", "qwen(150)", "google(69)", "anthropic(1)"].every((v) => one.includes(v)),
        ["openai(200)", "qwen(150)", "google(69)", "anthropic(1)"]
          .filter((v) => !one.includes(v))
          .join(",") || "벤더 4종 전부 있음",
      ),
      assert(
        "★색인이 **많은 순**이다 — 고를 때 큰 것부터 보인다",
        one.indexOf("openai(200)") < one.indexOf("qwen(150)") &&
          one.indexOf("qwen(150)") < one.indexOf("google(69)"),
        one.split("\n").find((l) => l.includes("openai(200)"))?.slice(0, 50) ?? "",
      ),
      assert(
        "★★색인에서 **다음 단계로 가는 길**을 준다 — 벤더든 이름 일부든",
        one.includes("/providers openrouter <벤더>") && one.includes("이름 일부"),
        `벤더안내=${one.includes("<벤더>")} · 이름검색안내=${one.includes("이름 일부")}`,
      ),
      assert(
        "★★색인이 가리키는 벤더로 **실제로 좁혀진다**(안내만 있고 안 되면 더 나쁘다)",
        bodyLines(renderProviders(VIEWS, "openrouter google", CAPS)) === 30 &&
          renderProviders(VIEWS, "openrouter google", CAPS).includes("69"),
        `google 좁힘 ${bodyLines(renderProviders(VIEWS, "openrouter google", CAPS))}줄 · 총계 표기=${renderProviders(VIEWS, "openrouter google", CAPS).includes("69")}`,
      ),
      ((): Assertion => {
        const mixed = renderProviders(VIEWS, "mixed", CAPS);
        // `/` 없는 것 하나를 골라 **닿을 수 있나**를 본다 — 색인으로 묶어버리면 못 닿는다.
        const reach = renderProviders(VIEWS, "mixed plain-4", CAPS);
        return assert(
          "★★네임스페이스가 **섞이면** 묶지 않는다 — 묶으면 `/` 없는 모델이 색인에도 목록에도 없어 닿을 길이 사라진다",
          !mixed.includes("벤더") && bodyLines(mixed) === 30 && reach.includes("plain-4"),
          `색인화=${mixed.includes("벤더")} · 모델줄 ${bodyLines(mixed)} · 비네임스페이스 도달=${reach.includes("plain-4")}`,
        );
      })(),
      assert(
        "★네임스페이스가 **없는** provider 는 종전대로 모델을 바로 보여준다(회귀 0)",
        bodyLines(withCaps) === 2,
        `anthropic ${bodyLines(withCaps)}줄(2여야)`,
      ),
      assert(
        "★★그 길이 **실제로 통한다** — 안내대로 좁히면 캡 밖 항목에 닿는다(안내만 있고 안 되면 더 나쁘다)",
        filtered.includes("anthropic/claude-fable") && bodyLines(filtered) === 1,
        `${bodyLines(filtered)}줄 · 캡밖 항목 도달=${filtered.includes("anthropic/claude-fable")}`,
      ),
      assert(
        "★모르는 이름엔 **있는 것**을 알려준다(막다른 길 금지)",
        unknown.includes("openrouter") && unknown.includes("anthropic"),
        unknown.split("\n")[0] ?? "",
      ),
      assert(
        "★검색이 안 맞으면 **전체 개수**를 같이 말한다 — 0을 보고 «없다» 로 오해하지 않게",
        nomatch.includes("420"),
        nomatch.includes("420") ? "전체 개수 표기" : "★개수 없음",
      ),
      assert(
        "★능력은 **아는 것만** 붙인다 — 모르면 아무 표시도 안 한다(삼상태 유지)",
        withCaps.includes("[200K · 도구✅]") &&
          !renderProviders(VIEWS, "openrouter", undefined).includes("["),
        withCaps.includes("200K") ? "아는 것 표기·모르는 것 무표기" : "★꼬리표 없음",
      ),
      assert(
        "★provider 0개면 **어디를 고치면 되는지** 말한다(빈 화면 금지)",
        empty.includes("settings.json"),
        empty.replace(/\n+/g, " ").slice(0, 60),
      ),
      // 배선 — provider 이름을 코드에 적으면 새 provider 가 안 나타난다(원칙 2).
      ((): Assertion => {
        const idx = readSourceSync("src/index.ts");
        const at = idx.indexOf('trimmed === "/providers"');
        const blk = at < 0 ? "" : idx.slice(at, at + 1400);
        const hardcoded = blk.match(/"(anthropic|openai|openrouter|groq|google|ollama|codex)"/g) ?? [];
        const derives = /listProviderNames\(\)/.test(blk) && /catalogModelKeys\(\)/.test(blk);
        return assert(
          "★★배선이 provider 이름을 **파생**시킨다 — 코드에 열거하면 새 provider 가 안 나타난다",
          blk !== "" && derives && hardcoded.length === 0,
          blk === ""
            ? "★배선 블록을 못 찾음(아래는 미검사)"
            : `파생=${String(derives)} · 박힌 이름 ${String(hardcoded.length)}개${hardcoded.length > 0 ? `(${hardcoded.join(",")})` : ""}`,
        );
      })(),
    ];
  },
};
