/**
 * `/providers` 슬래시 — **이 설치에 붙은 provider 와 그들이 주는 모델** (읽기 전용).
 * `/models`(내가 설정한 프로파일)의 짝이다.
 *
 * ★왜 별도 명령인가 (2026-09-02 정태님: *"기존 커맨드는 모델 프로필 목록이자나 /
 *  따로 만드는게 낫지 않나?"*). 맞다 — 둘은 **다른 질문**에 답한다:
 *   `/models`    = 내가 **설정한** 것 (`settings.json`, 내가 고칠 때 바뀐다)
 *   `/providers` = 저쪽이 **주는** 것 (카탈로그 캐시, 벤더가 모델을 내놓을 때 바뀐다)
 *  한 화면에 섞으면 `/models` 가 두 일을 하게 된다.
 *
 * ★그리고 종전엔 **연결된 provider 목록조차 볼 곳이 없었다.** 카탈로그는 부팅·매시 갱신으로
 *  실물을 받아두고 있었는데, 그걸 읽는 곳이 비서의 도구와 dev 스크립트뿐이었다 —
 *  v0.44.0 릴리스 노트가 *"어떤 모델을 쓸 수 있는지 제품이 알려줍니다"* 라고 했는데
 *  **절반만 지킨 약속**이었다.
 *
 * ★**두 단계인 이유는 실측이다**(추측 아님). 이 설치의 카탈로그가 **627개**다 —
 *  openrouter 420 · openai 118 · google 53. 한 응답에 쏟으면 텔레그램에서 잘린다.
 *  그래서 목록은 **개수**만, 상세는 **부를 때**([[project_hotpath_bound_preserve_record]]).
 * ★캡만 두면 안 된다 — *"캡 있는 자리에 반드시 도달해야 할 것을 두지 마라"*. 420번째
 *  모델에 닿을 길이 있어야 해서 **필터**를 같이 준다(캡+검색은 능력 인덱스가 쓰는 그 수법).
 *
 * ★**순서를 주장하지 않는다.** 카탈로그는 provider 마다 순서 의미가 다르다(다섯은 아예
 *  `unranked`). "최신순" 이라고 적으면 그중 다섯에겐 거짓말이라, 아무 말도 안 한다 —
 *  그 대신 필터를 쓰라고 한다. (그래서 이 렌더는 `unranked` 를 **알 필요가 없다**.)
 *
 * 설계: 순수 함수 — (provider 뷰 + 인자 + 능력 조회) → 문자열. IO·전역읽기는 호출부가
 * 조달한다(`models-command.ts` 와 같은 배치). 채널·어댑터 분기 0.
 */
import { capsLabel, type ModelCaps } from "./models-command.js";

/** 한 provider 의 지금 상태 — 호출부가 카탈로그·인증에서 조립해 넘긴다. */
export interface ProviderView {
  name: string;
  /** 카탈로그가 받아둔 모델 이름들(접두사 없음). 빈 배열 = 조회 못 함. */
  models: readonly string[];
  /** 이 설치가 이 provider 에 인증돼 있나. */
  authed: boolean;
}

/**
 * 한 번에 보여줄 모델 수. **잘리는 것보다 적게** 보여주고 «더 있다» 고 말하는 쪽이 낫다 —
 * 잘림은 조용하지만 안내는 다음 행동을 준다.
 */
const CAP = 30;

/**
 * 모델 id 의 **네임스페이스**로 묶는다 — `vendor/model` 의 앞부분.
 *
 * ★이건 우리가 지어낸 분류가 아니라 **데이터에 이미 있는 구조**다(실측 2026-09-02):
 *  openrouter 420개가 전부 `/` 를 갖고 벤더가 58종이다. 반대로 anthropic·google·openai·
 *  codex·ollama 는 `/` 가 **하나도** 없다. 그래서 «묶을 수 있으면 묶는다» 가 provider
 *  이름을 코드에 적지 않고도 성립한다(원칙 2 — 새 provider 가 저절로 맞는 모양을 얻는다).
 *
 * ★왜 필요한가 (정태님: *"굳이 다보여줄 필요는 없을거같긴한데.. 특히 오픈라우터"*).
 *  420개 중 **아무 30개**는 아무것도 아니다 — 고르는 데 도움이 안 되고, 남은 390개로
 *  가는 길도 «검색어를 떠올려라» 뿐이었다. 벤더 58줄은 **읽고 고를 수 있는 색인**이고,
 *  이미 있는 필터가 그대로 다음 단계가 된다.
 */
const byVendor = (models: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const m of models) {
    const at = m.indexOf("/");
    if (at <= 0) return new Map(); // 하나라도 네임스페이스가 없으면 묶지 않는다.
    out.set(m.slice(0, at), (out.get(m.slice(0, at)) ?? 0) + 1);
  }
  return out;
};

const fmtCount = (v: ProviderView): string =>
  v.models.length > 0
    ? `모델 ${String(v.models.length)}개`
    : v.authed
      ? "모델 목록 없음(조회 실패 또는 미지원)"
      : "인증 없음";

/** 이름·인자를 사람이 친 대로 비교한다(대소문자 무시). */
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * `/providers [provider] [검색어…]` 렌더.
 *
 * @param views     연결된 provider 전부(모델 0개인 것도 포함 — 「왜 안 보이지」에 답한다).
 * @param arg       명령 뒤 인자 원문. 빈 문자열이면 목록.
 * @param caps      `provider:model` → 컨텍스트·도구 지원. 모르면 `undefined`(아무것도 안 붙는다).
 */
export const renderProviders = (
  views: readonly ProviderView[],
  arg: string,
  caps: ((spec: string) => ModelCaps | undefined) | undefined,
): string => {
  if (views.length === 0) {
    return [
      "🔌 프로바이더",
      "붙어 있는 provider 가 없습니다.",
      "`<home>/settings.json` 의 `models.providers` 에 추가하면 여기 나타납니다.",
    ].join("\n\n");
  }

  const parts = arg.trim().split(/\s+/).filter((s) => s !== "");
  // ── 목록 ────────────────────────────────────────────────────────────────
  if (parts.length === 0) {
    const lines = views.map((v) => `• **${v.name}** — ${fmtCount(v)}`);
    return [
      "🔌 프로바이더",
      lines.join("\n"),
      "`/providers <이름>` 으로 그 provider 의 모델을 봅니다. " +
        "`/providers <이름> <검색어>` 로 좁힐 수 있습니다.",
      "여기 있는 모델을 쓰려면 `/models` 의 프로파일에 `provider:model` 로 적습니다.",
    ].join("\n\n");
  }

  // ── 한 provider ─────────────────────────────────────────────────────────
  const [wanted, ...rest] = parts;
  const view = views.find((v) => eq(v.name, wanted!));
  if (view === undefined) {
    return [
      `🔌 \`${wanted!}\` 라는 provider 는 없습니다.`,
      `있는 것: ${views.map((v) => `\`${v.name}\``).join(" · ")}`,
    ].join("\n\n");
  }

  const needle = rest.join(" ").toLowerCase();
  const matched =
    needle === ""
      ? view.models
      : view.models.filter((m) => m.toLowerCase().includes(needle));

  if (matched.length === 0) {
    return [
      `🔌 **${view.name}**`,
      needle === ""
        ? fmtCount(view)
        : `\`${needle}\` 와 맞는 모델이 없습니다(전체 ${String(view.models.length)}개).`,
    ].join("\n\n");
  }

  // ★캡을 넘고 **묶을 수 있으면** 모델 대신 색인을 준다. 색인은 자르지 않는다 —
  //  색인을 자르면 그게 다시 벽이 되고(그러면 묶은 의미가 없다), 58줄은 짧다.
  const vendors = needle === "" && matched.length > CAP ? byVendor(matched) : new Map();
  if (vendors.size > 1) {
    const ranked = [...vendors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [
      `🔌 **${view.name}** — 모델 ${String(view.models.length)}개 · 벤더 ${String(ranked.length)}종`,
      ranked.map(([v, n]) => `${v}(${String(n)})`).join(" · "),
      `\`/providers ${view.name} <벤더>\` 로 그 벤더의 모델을 봅니다. ` +
        `이름 일부로 바로 찾아도 됩니다(\`/providers ${view.name} sonnet\`).`,
    ].join("\n\n");
  }

  const shown = matched.slice(0, CAP);
  const head =
    needle === ""
      ? `🔌 **${view.name}** — 모델 ${String(view.models.length)}개`
      : `🔌 **${view.name}** — \`${needle}\` 와 맞는 ${String(matched.length)}개 ` +
        `(전체 ${String(view.models.length)}개)`;

  const body = shown
    .map((m) => `• \`${view.name}:${m}\`${capsLabel(caps?.(`${view.name}:${m}`))}`)
    .join("\n");

  const tail: string[] = [];
  if (matched.length > shown.length) {
    // ★남은 것에 **닿을 길**을 같이 준다. 개수만 말하면 캡이 곧 벽이 된다.
    tail.push(
      `…외 ${String(matched.length - shown.length)}개. ` +
        `\`/providers ${view.name} <검색어>\` 로 좁히세요.`,
    );
  }
  tail.push("목록에 있다고 다 쓸 수 있는 건 아닙니다 — 안 되면 그 이유를 알려드립니다.");
  return [head, body, ...tail].join("\n\n");
};
