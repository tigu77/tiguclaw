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
import { getEventBus } from "../eventbus.js";
import { deliverOutbound } from "../outbound.js";
import {
  getAuthProvider,
  registerAuthProvider,
  type AuthLogin,
} from "../llm-runtime/auth-registry.js";
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

  // ── 턴 밖에서 행동하기 (2026-08-29) ────────────────────────────────────────
  // ★**선언은 사용자에게 대가가 있는 것에만 요구한다** (2026-08-29 정태님).
  //
  //  처음엔 `events`(이벤트 구독)도 선언을 요구하고 안 적으면 던지게 했는데, 걷어냈다 —
  //  **이벤트를 읽는 건 대가가 없다.** 매니페스트 한 줄이 빠졌다고 서드파티 플러그인이
  //  부팅에서 죽는 건 지키는 것에 비해 과하다. 남긴 셋은 대가가 있다: 폰에 메시지가 가고
  //  (`outbound`), 돈이 나가고(`llm`), 도구가 힘을 갖는다(`tools`).
  //
  // ★**그리고 이건 보안이 아니다.** 격리가 0이라 안 적고 코어를 직접 import 하면 그만이고,
  //  실제로 번들 플러그인 둘이 이미 `host.fetch` 대신 전역 `fetch` 로 나간다(실측). 선언의
  //  값은 **사람 눈에 보이는 것** 하나뿐이다 — 그래서 `describeNeeds` 가 문장으로 낸다.
  //  문서에 "선언 안 하면 못 한다" 고 쓰면 그건 거짓 안심이다.

  /** 스스로 말하기(`host.say`). 집행: 선언 없으면 `say` 가 거부한다. */
  readonly outbound?: boolean;
  /** 모델 호출(`host.ask`). 집행: 선언 없으면 `ask` 가 거부한다. */
  readonly llm?: boolean;
  /**
   * **구독 인증을 이 설치에서 허용한다**(`host.registerAuthProvider`) — 서빙할 provider id 들.
   * 집행: 선언에 없는 id 를 등록하려 하면 거부한다.
   *
   * ★대가가 있다: 이게 있으면 데몬이 그 구독으로 **돈이 나가는 호출**을 한다. 없으면 토큰이
   *  `.env` 에 있어도 안 쓴다 — 설치가 곧 «이 구독을 쓰겠다» 는 귀속 가능한 행위다.
   */
  readonly auth?: readonly string[];
  // ★`tools` 키는 **뺐다** (2026-08-29, 적대 검토 A). 넣었다가 실측으로 되돌린 것이다:
  //  코어의 `toolPolicy` 는 `{mode:"allow", names}` 를 만들 수는 있는데 **그 `names` 를
  //  읽는 코드가 레포에 0곳**이고(세 어댑터 전부 `mode === "none"` 한 줄만 본다),
  //  `none` 이 아니면 **전체 도구**로 안전 degrade 한다. 결과가 정반대였다:
  //
  //    needs: { llm: true }              → 도구 0개  (의도대로)
  //    needs: { llm: true, tools: [...] } → **도구 전량** + `ask` 가 main 턴이라
  //                                          `update_self`·`model-settings` 까지
  //
  //  **좁히려고 적은 사람이 가장 넓게 열렸다.** 게다가 `describeNeeds` 가 설치 화면에
  //  "모델 호출(도구 Read)" 라고 찍어 **거짓 권한을 보여줬다.**
  //
  //  `KNOWN_NEED_KEYS` 의 규칙("집행 없는 선언 금지")대로 키를 뺀다. `allow` 를 세 어댑터에
  //  실제로 구현하는 날 다시 넣는다 — 그때는 이 주석이 무엇을 확인해야 하는지 말해준다.
}

/** 지금 아는 권한 키 — 여기 없는 키는 **거부**한다(집행 없는 선언 금지). */
export const KNOWN_NEED_KEYS: ReadonlySet<string> = new Set([
  "network",
  "ui",
  // ★집행한다 — `host.registerAuthProvider` 가 선언에 없는 id 를 거부한다(2026-09-01).
  "auth",
  "outbound",
  "llm",
]);

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
  const needs: {
    network?: string[];
    ui?: "chat-widget"[];
    outbound?: boolean;
    llm?: boolean;
    auth?: string[];
  } = {};
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
  if (o.auth !== undefined) {
    const ok =
      Array.isArray(o.auth) && o.auth.length > 0 && o.auth.every((v) => typeof v === "string" && v !== "");
    if (!ok) problems.push("needs.auth 는 비어 있지 않은 provider id 문자열 배열이어야 합니다");
    else needs.auth = o.auth as string[];
  }
  for (const k of ["outbound", "llm"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") problems.push(`needs.${k} 는 true/false 여야 합니다`);
    else needs[k] = o[k] as boolean;
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
/** 선언 하나 — `kind` 는 i18n 키가 되고, `value` 는 그 안의 자리표시자에 들어간다. */
export interface NeedFact {
  readonly kind: "network" | "networkUnknown" | "ui" | "outbound" | "llm" | "auth";
  readonly value?: string;
}

/**
 * **선언을 데이터로** 낸다 — 이 파일의 유일한 판정이고, 문장은 여기서 안 만든다.
 *
 * ★사고(2026-08-30 구조 검토): 종전엔 여기서 **한국어 문장**을 만들어 그대로 API 에 실었고,
 *  대시보드가 그걸 `textContent` 로 박았다. 그래서 **영어 로케일 사용자가 플러그인 목록에서
 *  한국어를 봤다.** 감싸는 문구만 i18n 을 타고 안쪽 문자열은 안 탔다.
 *
 * ★하필 이 면이다 — `docs/security.ko.md §2` 가 *"설치 전에 여기서 무엇을 요구하는지 읽으세요"*
 *  라고 안내하는 자리다. 못 읽으면 그 조언이 통째로 무효다.
 *
 * ★그래서 **판단은 여기 한 곳, 표현은 가장자리**로 갈랐다(코어는 문장을 모른다).
 *  로그용 한국어 문장(`describeNeeds`)도 **이 데이터에서 파생**시켜, 두 벌이 갈리지 않는다.
 */
export const needsFacts = (needs: PluginNeeds): NeedFact[] => {
  const facts: NeedFact[] = [];
  facts.push(
    needs.network !== undefined && needs.network.length > 0
      ? { kind: "network", value: needs.network.join(", ") }
      : { kind: "networkUnknown" },
  );
  if (needs.ui !== undefined && needs.ui.length > 0) {
    facts.push({ kind: "ui", value: needs.ui.join(", ") });
  }
  // ★행동 권한은 **사람이 보는 것**에 들어간다 — 격리가 0인 지금 이 선언은 강제가 아니라
  //  의도 표명이고, 그 값은 오직 **보이는 데** 있다. 안 보이면 적을 이유도 없다.
  if (needs.outbound === true) facts.push({ kind: "outbound" });
  // ★"도구 없음" 은 지금 **참**이다 — `ask` 는 언제나 `toolPolicy:{mode:"none"}` 으로 돈다.
  if (needs.llm === true) facts.push({ kind: "llm" });
  if (needs.auth !== undefined && needs.auth.length > 0) {
    facts.push({ kind: "auth", value: needs.auth.join(", ") });
  }
  return facts;
};

/**
 * **로그용 한국어 한 줄** — 부팅 로그·설치 로그는 개발자 진단면이라 카탈로그를 안 탄다.
 *
 * ★`needsFacts` 에서 **파생**한다. 여기서 따로 조립하면 그게 곧 두 번째 판정이고, 한쪽만
 *  고쳐지는 순간 화면과 로그가 다른 말을 한다([[feedback_simple_composable_no_duplication]]).
 */
const KO: Record<NeedFact["kind"], (v: string) => string> = {
  network: (v) => `외부 ${v}`,
  networkUnknown: () => "외부 미선언(모름)",
  auth: (v) => `구독 인증 제공(${v})`,
  ui: (v) => `화면 ${v}`,
  outbound: () => "스스로 말함",
  llm: () => "모델 호출(도구 없음)",
};

export const describeNeeds = (needs: PluginNeeds): string =>
  needsFacts(needs)
    .map((f) => KO[f.kind](f.value ?? ""))
    .join(" · ");

/**
 * 플러그인이 보는 이벤트 — 코어 `EventBusEvent` 의 **읽기 전용 모양**.
 *
 * ★코어 타입을 그대로 재수출하지 않는다. 재수출하면 코어가 필드를 더할 때마다 그게 곧
 *  서드파티 계약이 되고, 그러면 코어를 못 바꾼다. 여기 적힌 셋만 약속이다.
 */
export interface PluginEvent {
  readonly type: string;
  readonly ts: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

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

  // ── 턴 밖에서 행동하기 (2026-08-29) ────────────────────────────────────────

  /**
   * 코어 이벤트 구독 — **선언한 타입만**(`needs.events`).
   *
   * `type` 이 `.` 으로 끝나면 접두사다(`worker.` 는 `worker.started` 를 받는다).
   * @returns 해지 함수. **플러그인이 꺼질 때 반드시 부른다** — 안 그러면 죽은 플러그인이
   *          계속 깨어난다(`dispose` 에서 부르면 로더가 이미 그 시점을 준다).
   */
  on(type: string, handler: (event: PluginEvent) => void): () => void;

  /**
   * 스스로 말한다 — **턴이 없어도**(`needs.outbound`).
   *
   * ★`postCard` 와 다르다: 저건 *"지금 하는 답에 카드를 붙인다"* 이고 이건 *"내가 먼저
   *  말한다"* 다. 스케줄러·파일감시가 하는 일이 후자인데 그 길이 없었다.
   * ★반드시 `deliverOutbound` 를 지난다 — 우회하면 대시보드에 안 보인다(2026-06-30 실사고:
   *  스케줄 발화가 그렇게 사라져서 "보냈다는데 화면에 없다" 가 됐다).
   */
  say(input: {
    channel: string;
    target: string | null;
    text: string;
  }): Promise<{ ok: boolean; error?: string }>;

  /**
   * **이 설치에서 구독 인증을 허용한다** (`needs.auth`) — 2026-09-01.
   *
   * ★왜 플러그인이 하나. Business 판은 코어의 등록 배선을 빼서 구독 경로를 닫는다. 기업이
   *  그걸 되돌리려면 **자기 책임으로 되돌리는 행위**가 있어야 하는데, 앱 트리를 고치는 것은
   *  `/update` 가 되살린다(소스에서 다시 빌드한다). **홈 플러그인은 레포 밖이라 살아남는다** —
   *  그래서 이 문이 목표가 성립하는 유일한 형태다.
   *
   * ★**어댑터가 아니라 인증만** 온다. claude 어댑터는 SDK 의존(홈 플러그인엔 `node_modules`
   *  가 없다 — 폴더에 `npm i` 하면 실측 247MB)이라 코어에 남는다. 여기로 오는 것은 토큰
   *  판정 하나이고, 그건 env 문자열을 보는 게 전부라 **의존성이 0**이다.
   *
   * ★**먼저 잡은 쪽이 갖는다.** 코어가 등록한 id 는 못 뺏는다(부팅 순서상 코어가 먼저다) —
   *  즉 기본 빌드에선 이 문으로 코어 판정을 덮을 수 없다. Business 빌드에서만 비어 있다.
   *
   * ★**격리가 아니다.** 격리가 0이라 마음먹은 코드는 다른 문으로 돈다. 이 문이 막는 것은
   *  «아무도 모르게 구독으로 돌아가는 것» 이고, 그 이상을 약속하지 않는다.
   */
  registerAuthProvider(p: {
    provider: string;
    getAccessToken(): Promise<string>;
    isAuthenticated?(): boolean;
    login?: AuthLogin;
  }): { ok: boolean; error?: string };

  /**
   * 인증 결과를 홈 `.env` 에 저장한다 (`needs.auth` 선언 필수).
   *
   * ★**새 권한이 아니다.** 플러그인은 이미 `node:fs` 를 쓸 수 있다(격리 0). 이 문을 두는
   *  이유는 «홈 .env 가 어디인가 · 어떻게 쓰는가»(원자적 rename·0600 유지·in-memory 먼저)를
   *  **두 벌로 만들지 않기** 위해서다 — 그 규칙은 전부 실사고에서 나왔다(`core/env-file.ts`).
   *  베끼면 다음 사고 때 한쪽만 고쳐진다.
   * ★그리고 이 문이 있어서 `claude-subscription-auth` 가 **의존성 0** 을 지킨다 — 그게 그
   *  플러그인이 홈으로 옮겨 살아남는 근거다.
   * ★값은 절대 로그에 안 남는다. 키 이름만 남긴다.
   */
  saveAuthEnv(vars: Record<string, string>): Promise<{ ok: boolean; error?: string }>;

  /**
   * 모델에게 묻는다 (`needs.llm`).
   *
   * ★**좁은 래퍼다.** 코어의 실행 입력은 필드가 28개고 거기엔 `model`·`provider` 가 있는데,
   *  그걸 열면 플러그인이 특정 어댑터를 박을 수 있고 *"모든 기능 LLM 무관"* 이 플러그인
   *  층에서 깨진다. 재보니 좁혀도 잃는 게 없다 — 우리 원형 둘(`scheduler`·`file-watch`)이
   *  실제로 쓰는 건 **28개 중 4개**뿐이고, 그나마 `channel` 엔 자기 이름을 넣는다.
   *  그래서 채널과 대화 좌표는 **인자가 아니라 플러그인 정체성에서 파생**시킨다.
   * ★**도구는 언제나 0개다.** 한때 `needs.tools` 로 좁힐 수 있게 했다가 되돌렸다
   *  (`toolPolicyFor` 주석 참조) — 적으면 모르는 권한으로 거부된다.
   *
   * @param scope 같은 플러그인 안에서 대화를 가르고 싶을 때(기본 `"default"`).
   *              실제 좌표는 `plugin:<이름>:<scope>` 이므로 남의 대화엔 못 닿는다.
   */
  ask(input: { prompt: string; scope?: string }): Promise<
    { ok: true; text: string } | { ok: false; error: string }
  >;
}

/**
 * 구독 필터 — 이 구독이 이 이벤트를 받나. **순수 판정.**
 *
 * 규칙 둘뿐: 정확히 같거나, 신청이 `.` 으로 끝나는 **접두사**거나.
 * ★`"worker"` 는 `worker.started` 를 **안** 먹는다(부분 문자열이 아니다) — 안 그러면 신청한
 *  것보다 넓게 받아 플러그인이 자기가 안 부른 이벤트로 깨어난다.
 *
 * ★따로 세운 이유는 [[feedback_simple_composable_no_duplication]] 그대로다: 인라인이면
 *  검사하려고 호스트를 만들어야 하고, 그러면 회귀가 약해진다.
 */
export const eventAllowed = (
  declared: readonly string[] | undefined,
  type: string,
): boolean => {
  if (declared === undefined) return false;
  return declared.some((d) => (d.endsWith(".") ? type.startsWith(d) : d === type));
};

/**
 * `ask` 안의 모델이 받을 도구 정책 — **언제나 없음**.
 *
 * ★한때 `needs.tools` 로 좁힐 수 있게 했다가 되돌렸다(적대 검토 A). `{mode:"allow"}` 의
 *  `names` 를 읽는 코드가 레포에 **0곳**이고, `none` 이 아니면 어댑터가 **전체 도구**로
 *  안전 degrade 한다 — 좁히려는 선언이 정반대로 작동했다. 구현이 없는 모드를 만들어
 *  주느니 **하나만 확실히** 하는 게 낫다.
 */
/**
 * `host.ask` 가 도는 턴의 깊이 — **서브에이전트**다(메인이 아니다).
 *
 * ★리터럴 `1` 을 인라인으로 두면 검사가 소스를 볼 수밖에 없고, 그러면 `1 - 1`(=0, 메인 턴)
 *  같은 변이가 정규식 `[1-9]` 를 **통과한다**(3라운드 M11 이 그렇게 살아남았다). 이름을
 *  주면 검사가 `turnKindOf` 에 **넣어서 실행**할 수 있다 — 값이 아니라 결과를 본다.
 *
 * ★메인이 되면 사다리 최상단이라 `update_self` 까지 닿는다. 플러그인이 부르는 모델 호출이
 *  그 자리에 있으면 안 된다.
 */
export const ASK_TURN_DEPTH = 1;

export const toolPolicyFor = (_needs: PluginNeeds): { mode: "none" } => ({ mode: "none" });

/**
 * `plugin:<name>:<scope>` — 플러그인은 **자기 이름공간 밖 대화엔 못 닿는다.**
 *
 * ★접두사 `plugin:` 이 붙는다 (2026-08-29, 적대 검토 A). 종전엔 `<name>:<scope>` 였는데,
 *  좌표 이름공간은 평평해서(`dashboard:`·`worker:`·`agent:`·`telegram:`) `name:"dashboard"`
 *  인 플러그인의 `ask` 가 **사용자의 실제 메인 대화**(`dashboard:default`)를 가리켰다(실측).
 * ★고침을 **이름 단속이 아니라 좌표 생성**에 뒀다. 이름을 막으려 했더니 그게 번들
 *  플러그인의 실제 이름이었다(`cli`·`dashboard`·`telegram`) — 목록으로 푸는 문제가 아니었다.
 */
export const pluginThreadKey = (plugin: string, scope?: string): string => {
  const s = scope?.trim();
  return `plugin:${plugin}:${s === undefined || s === "" ? "default" : s}`;
};

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

  // ★게이트가 **없다** — 이벤트를 읽는 건 사용자에게 대가가 없다(위 주석 참조).
  //  버스는 어차피 import 하면 읽히므로, 여기서 막아도 막히는 건 정직한 플러그인뿐이다.
  on: (type, handler) =>
    getEventBus().subscribe((e) => {
      if (!eventAllowed([type], e.type)) return;
      handler({ type: e.type, ts: e.ts, payload: e.payload });
    }),

  registerAuthProvider: (p) => {
    if (needs.auth === undefined || !needs.auth.includes(p.provider)) {
      return {
        ok: false,
        error:
          `plugin '${plugin}': '${p.provider}' 를 등록하려면 package.json 의 ` +
          `tiguclaw.needs.auth 에 그 id 를 적으세요(사용자가 설치 전에 봅니다).`,
      };
    }
    registerAuthProvider(p);
    // ★**등록됐는지 확인한다** — 코어는 «먼저 잡은 쪽이 갖는다» 라 거절될 수 있고, 그때
    //  플러그인이 «됐다» 고 믿으면 조용히 아무 일도 안 일어난다.
    if (getAuthProvider(p.provider) !== p) {
      return {
        ok: false,
        error:
          `plugin '${plugin}': '${p.provider}' 는 이미 등록돼 있습니다 — 먼저 잡은 쪽이 ` +
          `갖습니다(기본 빌드에선 코어가 먼저입니다).`,
      };
    }
    return { ok: true };
  },

  saveAuthEnv: async (vars) => {
    if (needs.auth === undefined || needs.auth.length === 0) {
      return {
        ok: false,
        error:
          `plugin '${plugin}': 인증 값을 저장하려면 package.json 의 tiguclaw.needs.auth 를 ` +
          `적으세요(사용자가 설치 전에 봅니다).`,
      };
    }
    const keys = Object.keys(vars);
    // ★키 모양을 본다 — env 이름이 아닌 것이 오면 `.env` 가 깨져 **다음 부팅이 죽는다**.
    //  값은 검사하지 않는다(무엇이 유효한 토큰인지는 provider 가 안다).
    const bad = keys.filter((k) => !/^[A-Z][A-Z0-9_]*$/.test(k));
    if (keys.length === 0 || bad.length > 0) {
      return { ok: false, error: `env 이름이 아닙니다: ${bad.join(", ") || "(빈 목록)"}` };
    }
    try {
      const { upsertHomeEnvVars } = await import("../env-file.js");
      const written = await upsertHomeEnvVars(vars);
      console.log(`[plugin:${plugin}] 인증 값 저장: ${keys.join(", ")} → ${written}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  say: async ({ channel, target, text }) => {
    if (needs.outbound !== true) {
      return {
        ok: false,
        error:
          `plugin '${plugin}': 스스로 말하려면 package.json 의 tiguclaw.needs.outbound 를 ` +
          `true 로 두세요.`,
      };
    }
    // ★`label` 에 플러그인 이름을 실어 보낸다 — 사용자가 폰에서 "이건 누가 보낸 거지" 를
    //  물어야 했던 일이 있었다(2026-08-28 egress 라벨과 같은 규범).
    const r = await deliverOutbound({ channel, target, text, label: plugin });
    // ★`delivered` 를 그대로 읽는다 — 종전 스케줄러가 미등록 채널을 성공으로 봐서
    //  "매일 아침 리포트를 만들고 아무 데도 안 보내고 DB 엔 ok" 가 됐던 자리다.
    return r.delivered ? { ok: true } : { ok: false, error: r.reason ?? "전달 실패" };
  },

  ask: async ({ prompt, scope }) => {
    if (needs.llm !== true) {
      return {
        ok: false,
        error:
          `plugin '${plugin}': 모델을 부르려면 package.json 의 tiguclaw.needs.llm 을 ` +
          `true 로 두세요.`,
      };
    }
    try {
      // ★지연 로드 — 어댑터 스택 전체가 딸려 오므로 부팅 경로에 얹지 않는다.
      const { runRegionA } = await import("../llm-runtime/index.js");
      const out = await runRegionA({
        text: prompt,
        // 좌표는 **인자가 아니라 정체성에서** 나온다. 남의 대화엔 못 닿는다.
        threadKey: pluginThreadKey(plugin, scope),
        channel: plugin as never,
        toolPolicy: toolPolicyFor(needs),
        // ★**메인 턴이 아니다** (2026-08-29, 적대 검토 A). 깊이를 안 넘기면 `turnKindOf` 가
        //  `main` 을 주고, 그러면 사다리 최상단(`update_self`·`model-settings`·`mcp-admin`)
        //  이 열린다. `ask` 는 위임받아 도는 턴이므로 서브에이전트 층이 맞다.
        //  ★재귀 상한도 여기서 온다 — 플러그인 도구 → ask → 같은 도구 가 무한히 못 돈다.
        subagentDepth: ASK_TURN_DEPTH,
      });
      return { ok: true, text: out.text };
    } catch (e) {
      // ★플러그인의 모델 호출 실패가 데몬을 죽이면 안 된다 — 값으로 답한다.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});
