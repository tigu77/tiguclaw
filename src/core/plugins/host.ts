// src/core/plugins/host.ts
/**
 * **플러그인이 코어를 만지는 유일한 표면** — 그리고 무엇을 요구하는지 적는 자리 (2026-08-28).
 *
 * ★왜 지금 이걸 짓나(정태님: *"3번도 미리 준비해야 하는 거 아니야?"*): **격리를 미리 짓는 게
 *  아니라 나중에 넣을 수 있게 경계를 긋는 것**이다. 지금 플러그인은 `src/core/*` 를 직접
 *  import 한다(`weather` 는 3개, `http-bridge` 는 31개) — 그 상태로 자식 프로세스나 iframe 에
 *  옮기면 **그 import 가 전부 깨진다.** 반대로 표면이 하나면, 격리는 *"이 표면을 IPC 로 바꾸는
 *  것"* 으로 끝나고 **플러그인은 한 줄도 안 고친다.**
 *
 * ★그래서 여기 있는 건 둘뿐이다:
 *   - `PluginNeeds` — 플러그인이 **무엇을 요구하는가**(사용자에게 보여주고, 코어가 집행한다)
 *   - `PluginHost`  — 플러그인이 **무엇을 만질 수 있는가**(여기 없으면 못 한다)
 *
 * ★**모르는 권한 키는 거부한다.** 집행하지 않는 권한을 선언하게 두면 그건 약속이 아니라
 *  장식이고, 사용자는 "선언했으니 막히겠지" 로 오해한다. 축을 넓히는 건 **집행을 같이
 *  들고 올 때**다([[feedback_gate_must_actually_run]]).
 *
 * ★**정직한 한계**: 이 표면은 플러그인이 *협조할 때* 성립한다. 지금 격리는 0이라 플러그인은
 *  마음먹으면 `src/core/*` 를 그냥 import 한다. 그걸 막는 건 표면이 아니라 프로세스 경계이고,
 *  그건 아직 없다(설계 §H). 여기서 하는 일은 **그 경계를 나중에 그을 수 있게 해두는 것**이다.
 */
import path from "node:path";
import { readLocale } from "../i18n.js";
import { getPaths } from "../paths.js";
import { deliverOutbound } from "../outbound.js";
import { pluginFetch } from "../plugin-fetch.js";
import {
  effectiveSettings,
  type PluginSettingSpec,
  type PluginSettingValue,
} from "./settings.js";

/**
 * 플러그인이 요구하는 것.
 *
 * ★**지금 집행되는 것만 있다.** `fs`·`db`·`tools`·`secrets` 같은 축은 설계 노트에 적혀 있지만
 *  집행이 없어서 **여기 안 넣는다** — 넣는 순간 거짓 안심이 된다.
 */
export interface PluginNeeds {
  /** 데몬이 나갈 수 있는 호스트(exact, https). 집행: `plugin-fetch.ts`. */
  readonly network?: readonly string[];
  /** 화면에 붙는 자리. 집행: 위젯 첨부가 이 선언 없이 오면 거부한다. */
  readonly ui?: readonly "chat-widget"[];
}

/** 지금 아는 권한 키 — 여기 없는 키는 **거부**한다(집행 없는 선언 금지). */
export const KNOWN_NEED_KEYS: ReadonlySet<string> = new Set(["network", "ui"]);

export interface NeedsVerdict {
  readonly needs: PluginNeeds;
  /** 사람이 읽는 거부 사유들. 비어 있으면 전부 정상. */
  readonly problems: readonly string[];
}

/**
 * 매니페스트의 `tiguclaw.needs` 를 읽고 검사한다.
 *
 * ★순수 함수 — 회귀가 실제로 부른다. 로더 안에 인라인이면 데몬을 띄워야 검사가 된다.
 */
export const readNeeds = (raw: unknown): NeedsVerdict => {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { needs: {}, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { needs: {}, problems: ["needs 는 객체여야 합니다"] };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!KNOWN_NEED_KEYS.has(k)) {
      problems.push(
        `모르는 권한 '${k}' — 아는 것은 [${[...KNOWN_NEED_KEYS].join(", ")}]. ` +
          `집행하지 않는 권한은 받지 않습니다(선언만 있으면 막히는 줄 오해합니다).`,
      );
    }
  }
  const needs: { network?: string[]; ui?: "chat-widget"[] } = {};
  if (o.network !== undefined) {
    if (!Array.isArray(o.network) || o.network.some((h) => typeof h !== "string")) {
      problems.push("needs.network 는 호스트 문자열 배열이어야 합니다");
    } else {
      needs.network = o.network as string[];
    }
  }
  if (o.ui !== undefined) {
    const ok = Array.isArray(o.ui) && o.ui.every((v) => v === "chat-widget");
    if (!ok) problems.push('needs.ui 는 ["chat-widget"] 만 받습니다');
    else needs.ui = o.ui as "chat-widget"[];
  }
  return { needs, problems };
};

/**
 * 사람이 읽는 한 줄 — 부팅 로그·인벤토리·설치 안내가 **같은 문장**을 쓴다.
 *
 * ★**"선언 없음" 과 "안 나감" 을 구분한다.** 첫 판은 선언이 비면 `외부 없음` 이라고 찍었는데,
 *  그건 **모르는 것을 아는 것처럼** 말하는 것이다 — 실제로 `telegram` 이 `외부 없음` 으로
 *  찍혔고 그 플러그인은 grammy 를 통해 계속 밖으로 나간다. 라이브러리가 자기 소켓을 여는
 *  경우는 우리가 못 보므로(설계 §H), 안 보이는 것을 "없다" 고 하면 안 된다.
 *  [[feedback_verify_before_asserting]] 과 같은 규범이다.
 */
export const describeNeeds = (needs: PluginNeeds): string => {
  const parts: string[] = [];
  parts.push(
    needs.network !== undefined && needs.network.length > 0
      ? `외부 ${needs.network.join(", ")}`
      : "외부 미선언(모름)",
  );
  if (needs.ui !== undefined && needs.ui.length > 0) parts.push(`화면 ${needs.ui.join(", ")}`);
  return parts.join(" · ");
};

/** 이 턴이 어느 대화인가. 없을 수도 있다(부팅 탐침 등 — 그땐 카드를 안 붙인다). */
export interface PluginTurn {
  readonly threadKey: string;
  readonly channel: string;
  readonly target: string | null;
}

/**
 * **플러그인이 만질 수 있는 전부.**
 *
 * ★여기 없는 건 못 한다 — 그게 경계다. 그리고 여기 있는 것들은 전부 **직렬화 가능한 인자**만
 *  받는다: 나중에 이 표면이 IPC 를 건너가야 하기 때문이다(그때 시그니처를 안 바꾸려고).
 */
export interface PluginHost {
  readonly turn?: PluginTurn;
  /**
   * **설정 언어** — 외부 API 에 언어를 넘겨야 할 때 쓴다.
   *
   * ★없어서 `weather` 가 지오코딩에 `language=ko` 를 **박아놨고**, 영어 사용자가 한국어
   *  지명을 받았다. 카탈로그로는 못 푸는 축이다(문구가 아니라 **요청 인자**다).
   * ★이건 *"설정 언어"* 이지 *"보는 사람의 언어"* 가 아니다 — 데몬은 하나인데 브라우저마다
   *  다를 수 있고, 서버는 전자만 안다. 화면 쪽은 `ctx.locale` 이 후자를 준다.
   */
  readonly locale: string;
  /** 밖으로 — **선언한 호스트만**. 안 선언했으면 던진다. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /**
   * 대화에 카드를 붙인다. **텍스트가 정본이고 위젯은 덤**이다 —
   * 텔레그램·CLI 사용자는 위젯을 못 보지만 `text` 는 받는다.
   * @returns 붙었으면 true. 좌표를 모르거나 규칙 위반이면 false(답은 그대로 간다).
   */
  postCard(input: { text: string; widget: string; data: unknown }): Promise<boolean>;
  /**
   * **이 플러그인 몫 설정만** — 남의 설정도, 코어 설정도 안 보인다 (§D.2).
   *
   * ★선언(`tiguclaw.settings`)에 있는 키만 담긴다. 파일에 남은 옛 키는 안 흘러든다.
   * ★`secret` 은 파일이 아니라 홈 `.env` 에서 온다. 없으면 **키 자체가 없다** —
   *  빈 문자열을 주면 플러그인이 "설정됐는데 비었다" 로 오해한다.
   */
  readonly settings: Readonly<Record<string, PluginSettingValue>>;
  /** 이 플러그인 몫 저장 자리(`<home>/plugins/<name>`). 홈이지 앱 폴더가 아니다. */
  readonly dataDir: string;
  /** 로그 — 접두사가 자동으로 붙어 어느 플러그인인지 안다. */
  log(message: string): void;
}

export const createPluginHost = (
  plugin: string,
  needs: PluginNeeds,
  turn?: PluginTurn,
  settingsSpec: readonly PluginSettingSpec[] = [],
): PluginHost => ({
  ...(turn !== undefined ? { turn } : {}),
  locale: readLocale(),
  // ★**매 호출 새로 읽는다** — 이 레포는 설정류를 매 턴 fresh 하게 읽으므로
  //  ([[reference_config_reload_boundary]]) 값을 바꾸면 재시작 없이 다음 호출부터 먹는다.
  settings: effectiveSettings(plugin, settingsSpec),
  fetch: (url, init) => pluginFetch(plugin, url, init),
  postCard: async ({ text, widget, data }) => {
    // ★**왜 안 붙었는지 말한다** (2026-08-28 실사용 신고: "도구는 쓰는 것 같은데 위젯이
    //  안 나오네"). 종전엔 세 갈래 전부 조용히 `false` 였고, 그래서 도구가 네 번 불렸는데
    //  카드가 한 번만 뜬 이유를 **로그로 알 수가 없었다.** 실패는 요란해야 한다
    //  ([[feedback_logs_must_stand_alone]]).
    if (turn === undefined) {
      console.warn(
        `[plugin:${plugin}] 카드를 못 붙였습니다 — 이 호출엔 대화 좌표가 없습니다` +
          `(부팅 탐침·백그라운드 경로일 수 있습니다). 도구의 텍스트 답은 그대로 갑니다.`,
      );
      return false;
    }
    if (needs.ui === undefined || !needs.ui.includes("chat-widget")) {
      // ★선언 없이 화면에 붙이지 못한다 — 사용자가 "이건 화면에 뜬다" 를 알고 깔아야 한다.
      console.error(
        `[plugin:${plugin}] 화면에 카드를 붙이려면 매니페스트에 needs.ui: ["chat-widget"] 이 필요합니다.`,
      );
      return false;
    }
    const r = await deliverOutbound({
      channel: turn.channel,
      target: turn.target,
      observeThreadKey: turn.threadKey,
      text,
      attachments: [{ kind: "widget", widget, data }],
    });
    const ok = r.delivered && (r.rejectedAttachments ?? []).length === 0;
    if (!ok) {
      console.warn(
        `[plugin:${plugin}] 카드를 못 붙였습니다 — 배달=${r.delivered}` +
          `${r.reason !== undefined ? `(${r.reason})` : ""}` +
          `${(r.rejectedAttachments ?? []).length > 0 ? ` · 첨부 거절: ${(r.rejectedAttachments ?? []).join(" / ")}` : ""}` +
          ` · 좌표 ${turn.channel}/${turn.threadKey}`,
      );
    }
    return ok;
  },
  dataDir: path.join(getPaths().commonPlugins, plugin),
  log: (message) => console.log(`[plugin:${plugin}] ${message}`),
});
