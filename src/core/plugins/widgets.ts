// src/core/plugins/widgets.ts
/**
 * **플러그인 위젯 선언** — 코어가 «이 플러그인이 무슨 위젯을 갖는가» 를 알게 한다
 * (2026-09-08, 정태님: *"플러그인이 설치되어 있으면 기본적으로 자동으로 홈에 보여야
 * 되는 거 아니야? 아니면 상세 메뉴에서 위젯 켜고 끄는 게 있던가"*).
 *
 * ★**둘 다 없었고, 없는 이유가 같았다.** 등록소가 브라우저에 있어서(`tiguWidgets.register`
 *  는 `web/widget.js` 가 로드된 뒤에야 존재한다) 코어는 위젯 id 를 알 방법이 없었다 —
 *  `home-widgets.ts` 가 *"코어는 위젯 id 목록을 모른다"* 고 스스로 적어뒀고, 그래서
 *  `configure_home` 조차 데이터 라우트 이름만 알려줄 수 있었다. 상세 화면의 토글도,
 *  자동 편입도 **이 선언 하나** 위에 얹힌다.
 *
 * ★**`settings` 선언과 같은 모양이다**(`./settings.ts`). 새 개념을 만들지 않는다 —
 *  매니페스트에 값으로 적고, 화면은 그 값에서 행을 만든다.
 *
 * ★**`default` 는 번들에서만 유효하다.** 판정은 여기가 아니라 `inventory.ts` 가 한다
 *  (`core?` 가 쓰는 규칙과 같다: *"유효성을 선언이 아니라 위치로 판정"*). 홈은 사용자
 *  자기 자리라, 설치한 플러그인이 스스로 거기 앉을 수 있으면 안 된다.
 */

/** 크기 등급 — `home-widgets.ts` 의 `HomeWidgetSize` 와 같은 어휘다(격자 좌표 아님). */
const SIZES: ReadonlySet<string> = new Set(["small", "wide"]);

/**
 * `<plugin>/<id>` 의 뒷칸. 앞칸은 **폴더가 강제**하므로 여기 적지 않는다 —
 * 적게 두면 매니페스트의 이름과 폴더 이름이 갈린다.
 */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface PluginWidgetSpec {
  /** `<plugin>/<id>` 의 뒷칸. `web/widget.js` 의 `register("<plugin>/<id>")` 와 같아야 한다. */
  readonly id: string;
  /** 홈에 놓일 때의 기본 크기. 사용자가 도구로 바꾼 값이 이긴다. */
  readonly size: "small" | "wide";
  /**
   * **설치되면 홈에 바로 놓는가.** 한 번만 놓는다 — 사용자가 끄면 다시 안 놓는다
   * (`home-widgets.ts` 의 `seeded` 기록).
   *
   * ★설정이 있어야 뜻이 서는 위젯은 `false` 여야 한다(날씨는 장소를 받아야 한다).
   *  빈 채로 자동 편입되면 홈에 «설정하세요» 카드가 생기는데, 그건 도움이 아니다.
   */
  readonly default: boolean;
  /** 상세 화면의 토글에 뜨는 이름. ★문장이 아니라 키다 — 번역은 플러그인이 들고 온다. */
  readonly labelKey?: string;
}

export interface WidgetSpecResult {
  readonly specs: PluginWidgetSpec[];
  /** 왜 떨어졌는지. 작성자가 자기가 뭘 잘못했는지 알아야 한다. */
  readonly problems: string[];
}

/**
 * 매니페스트의 `tiguclaw.widgets` 를 읽는다.
 *
 * ★**모르는 것은 조용히 고치지 않고 떨어뜨린다** — `normalizeHomeWidgets` 와 같은 규범이다.
 *  반쪽으로 살아난 선언은 «왜 이렇게 떴지» 가 되고, 그건 아무도 못 고친다.
 */
export const readWidgetSpecs = (raw: unknown): WidgetSpecResult => {
  const specs: PluginWidgetSpec[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { specs, problems };
  if (!Array.isArray(raw)) return { specs, problems: ["widgets 는 배열이어야 합니다"] };
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const at = `widgets[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} 는 객체여야 합니다`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!ID_RE.test(id)) {
      problems.push(`${at}.id "${String(e.id)}" 는 소문자·숫자·하이픈이어야 합니다`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${at}.id "${id}" 가 중복입니다`);
      continue;
    }
    const sizeRaw = e.size === undefined ? "small" : e.size;
    if (typeof sizeRaw !== "string" || !SIZES.has(sizeRaw)) {
      problems.push(`${at}.size 는 small 또는 wide 여야 합니다`);
      continue;
    }
    if (e.default !== undefined && typeof e.default !== "boolean") {
      problems.push(`${at}.default 는 참거짓이어야 합니다`);
      continue;
    }
    if (e.labelKey !== undefined && typeof e.labelKey !== "string") {
      problems.push(`${at}.labelKey 는 문자열이어야 합니다`);
      continue;
    }
    seen.add(id);
    specs.push({
      id,
      size: sizeRaw as "small" | "wide",
      default: e.default === true,
      ...(typeof e.labelKey === "string" && e.labelKey !== ""
        ? { labelKey: e.labelKey }
        : {}),
    });
  }
  return { specs, problems };
};
