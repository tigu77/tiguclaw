// src/core/home-widgets.ts
/**
 * **홈 위젯 배치** — 무엇이 · 어떤 순서로 · 얼마나 크게 (2026-08-28, 위젯 플랫폼 §J).
 *
 * ★**좌표를 저장하지 않는다.** 이 파일에 `x`·`y`·픽셀·breakpoint 가 없는 것은 빠뜨린 게
 *  아니라 설계다(§J.1). 로드맵 A3 는 *"레이아웃은 비서가 읽고 쓸 수 있는 데이터여야
 *  한다"* 고 하고 프런트 노트는 *"그리드 좌표·픽셀은 Client-local"* 이라고 하는데,
 *  **비서에겐 브라우저가 없다.** 둘 다 지키는 방법은 비서가 쓰는 것을 좌표가 아니게
 *  만드는 것뿐이다 — 순서 배열 + 크기 등급이면 격자는 CSS 가 푼다.
 *  덤으로 breakpoint 마다 레이아웃이 한 벌씩 생기는 일도 없다.
 *
 * ★**판정이 순수 함수다**(`normalizeHomeWidgets`). 도구 핸들러 안에 두면 검사가 문자열
 *  grep 밖에 못 하고, 그러면 지키는 게 없다
 *  ([[feedback_simple_composable_no_duplication]] — *"검사가 껄끄러우면 코드가 잘못 놓인 것"*).
 *
 * ★**읽기는 홈 레이어만** 본다. 쓰기가 `<home>/settings.json` 으로 가는데 읽기를 레이어
 *  병합으로 하면, 프로젝트 `.tiguclaw/settings.json` 이 값을 가리는 순간 **쓰기가 먹은 것
 *  처럼 보이는데 화면은 안 바뀐다.** 읽는 자리와 쓰는 자리는 같아야 한다.
 */
import { getPaths } from "./paths.js";
import {
  readSettingsRootForWrite,
  readSettingsRootLenient,
  writeSettingsRootAtomic,
} from "./settings-file.js";

/** 크기 등급 — 격자 좌표가 아니라 **의미**다. 실제 열 수는 CSS 가 정한다. */
export type HomeWidgetSize = "small" | "wide";

const SIZES: ReadonlySet<string> = new Set<HomeWidgetSize>(["small", "wide"]);

export interface HomeWidget {
  /** 이 배치 안에서만 유일하면 된다. 화면이 컨테이너를 식별하는 데 쓴다. */
  readonly id: string;
  /** `<plugin>/<widget>` — 이름공간은 폴더가 강제한다(§D.3). */
  readonly type: string;
  readonly size: HomeWidgetSize;
  /** 이 **인스턴스** 몫 설정(도시 등). 플러그인 설정(§D.1)과 자리가 다르다. */
  readonly config: Readonly<Record<string, string | number | boolean>>;
}

export interface HomeWidgetsResolution {
  readonly widgets: HomeWidget[];
  /** 왜 떨어졌는지 — 모델이 고쳐서 다시 부를 수 있어야 한다. */
  readonly rejected: { readonly at: string; readonly reason: string }[];
}

/**
 * 홈에 놓을 수 있는 최대 개수.
 *
 * ★캡을 두는 이유는 화면이 아니라 **poll** 이다 — 위젯 하나가 곧 주기적인 외부 호출
 *  하나가 될 수 있다. 무한히 놓을 수 있으면 사용자가(또는 모델이) 자기도 모르게 데몬을
 *  크롤러로 만든다.
 *
 * ★**12 → 24** (2026-08-29 정태님: *"플러그인에 너무 과한 억제를 하지 말자"*). 여긴
 *  **사용자 자기 홈**이고, 12는 내가 근거 없이 고른 숫자였다. 진짜 비용은 개수가 아니라
 *  poll 이므로 이 캡은 폭주 방지선일 뿐이다 — 그 선은 넉넉해도 된다. 정확히 재려면
 *  *"poll 하는 위젯만 센다"* 가 맞지만, 그건 분기를 하나 더 만드는 값이 아직 없다
 *  (필요해지면 그때).
 */
export const HOME_WIDGET_MAX = 24;

/** `<plugin>/<widget>` — 소문자·숫자·하이픈. 경로가 되는 값이라 좁게 잡는다. */
const TYPE_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/**
 * **자격증명 낱말** — 키 이름 어디에 있어도 걸린다(부분 문자열).
 *
 * ★규칙이 **하나**다. 종전엔 "어디서나 걸리는 낱말" 과 "낱말로 서 있을 때만 걸리는 낱말"
 *  둘로 나눴는데, 뒤쪽이 `accesskey`·`authkey`·`basicauth`·`authorization` 처럼 **붙여 쓴
 *  소문자·대문자 이름에서 통째로 사라졌다**(쪼갤 경계가 없으면 한 낱말이 된다).
 *  실측 29/29 통과 — 규칙의 절반이 없는 것과 같았다.
 */
/**
 * **이름만으로 자격증명이라고 부를 수 있는 낱말** — 평범한 설정 이름엔 안 들어간다.
 *
 * ★`key`·`auth`·`pass` 같은 **약한 조각은 뺐다** (2026-08-30). 그것들이 오탐 전부의
 *  출처였다 — 실측: 정상 위젯 키 24종 중 **20종(83%)** 이 막혔다(`chartKey`·`sortKey`·
 *  `dataKey`·`labelKey`·`titleKey`·`hotkey`·`sessionCount`·`tokenCount`·`passRate`…).
 *  차트·표 위젯을 만들면 거의 반드시 부딪히는데, 사유 문구는 *"자격증명처럼 보입니다"* 라
 *  작성자는 영문을 모른다.
 *
 * ★`apikey` 처럼 **붙여 쓴 형태**는 강한 낱말로 남긴다(`key` 단독과 다르다).
 */
// ★★**오늘 바꿨다가 되돌렸다** (2026-08-30). 이름 추측 → 값 관측으로 판정을 뒤집었는데,
//  적대 검토 2라운드가 그 수정에서 **P≥3 을 넷** 찾았다: 구분자 하나면 통과(Ed25519 개인키
//  전문이 `cert` 이름으로 홈 설정에 실렸다) · hex 갈래가 mongo ObjectId·git SHA 를 먹음 ·
//  대소문자 섞인 URL 차단 · 그리고 고치려던 83% 과차단이 다른 갈래로 되살아남.
//
//  ★세 판(이 판 / 값 관측 / 절충)이 **다 나빴다.** 매 라운드 새 결함이 나는 건
//  *"이름·값으로 열쇠를 알아맞히기"* 가 원리적으로 어렵다는 신호다. 그래서 **되돌리고
//  다음 릴리스로 미룬다** — 계속 고치면서 내보내는 것보다 낫다(수렴 v3).
//
//  ★남아 있는 결함은 **정상 키 과차단**(실측 24종 중 20종)이다. 로드맵에 적어뒀고,
//  다음엔 "차단은 좁고 확실하게, 나머지는 경고" 로 다시 설계한다.
const CREDENTIAL_WORDS = [
  "token", "secret", "password", "passwd", "credential", "bearer", "cookie",
  "jwt", "oauth", "signature", "authorization",
  // ★`key`·`session` 을 약한 목록에서 빼면서 잃은 것을 **합성어로** 되찾는다 —
  //  이것들은 평범한 설정 이름에 안 들어간다(위 주석 참조). 구분자는 판정 전에 지운다.
  "apikey", "accesskey", "privatekey", "secretkey", "sessionkey", "sessionid",
  "authtoken", "accesstoken", "refreshtoken", "clientsecret",
];

/**
 * 같은 자격증명 낱말이지만, **무해한 낱말을 덜어낸 뒤에** 본다 — 이것들은 평범한 이름에도
 * 자주 들어간다(`keyword`·`author`·`passenger`).
 */
const CREDENTIAL_WORDS_AFTER_STRIP = [
  // ★`key`·`pass`·`session` 을 **되돌렸다** (2026-08-30, 적대 검토 B조 P-2).
  //
  //  아침에 이 셋을 빼고 *"모호하지 않은 합성어로 되찾는다"* 고 적었는데, 그 되찾기가
  //  **손 목록**이었고 손 목록은 완전해지지 않는다. 실측: 자격증명 **24종이 새로 뚫렸다**
  //  (직전 판에선 전부 막혔다):
  //
  //      passphrase · passcode · pass · gpgPassphrase · signingKey · encryptionKey
  //      consumerKey · hmacKey · masterKey · deployKey · keyfile · …
  //
  //  진짜 export 로 돌려보니 `config.passphrase="correct-horse-battery-staple"` 와
  //  `config.signingKey="MIIEpAIBAAKCAQEA…"` 가 그대로 `<home>/settings.json` 에 쓰이고
  //  브라우저로 나갔다. `pass` 는 합성어를 **하나도** 안 넣었었다.
  //
  // ★**방향을 잘못 골랐다.** 이 가드는 비대칭이다 — 과차단은 되돌릴 수 있고(이름을 바꾸면
  //  된다) 유출은 되돌릴 수 없다(값이 화면·백업으로 나간 뒤다). 모호한 이름
  //  (`chartKey` vs `apiKey` — 문법이 같다)에서는 **막는 쪽이 기본**이어야 한다.
  //
  // ★남은 과차단은 결함이 아니라 **치르는 값**이다. 진짜 해법은 이름 맞히기가 아니라
  //  **플러그인이 선언하는 것**이다(설정 스펙의 secret 필드는 이미 있다) — 이 목록은
  //  선언 안 한 config 를 위한 **뒷받침**이지 분류기가 아니다.
  "auth", "cert", "private", "pwd", "key", "pass", "session",
];

/**
 * **자격증명 낱말을 품고 있지만 무해한 낱말** — 판정 전에 **지워서** 본다.
 *
 * ★지우고 보는 이유는 합성을 살리기 위해서다. `authorName` 은 `author` 를 지우면 `Name`
 *  만 남아 통과하고, `keywordToken` 은 `keyword` 를 지워도 `Token` 이 남아 걸린다.
 *  이름 전체를 열거하면 `authorName` 이 새 이름일 때마다 목록이 낡는다
 *  ([[feedback_hand_maintained_lists]]).
 */
const INNOCENT_WORDS = [
  "keyword", "monkey", "donkey", "turnkey", "keyboard", "hockey", "whiskey",
  "author", "passenger", "passage", "compass", "certain", "concert",
];

/**
 * **값이 대놓고 자격증명인가** — 이름으로 못 잡는 마지막 방어 (2026-08-30, 적대 검토 D조 D-1).
 *
 * ★사고: 이름 가드를 되돌리면서 **값 관측 갈래까지 같이 지웠다.** 그래서
 *  `pem: "-----BEGIN RSA PRIVATE KEY-----…"` 처럼 **값이 개인키인데** 이름에 걸릴 낱말이
 *  없어 그대로 통과했다. 실측으로 19종(`pem`·`githubPat`·`slackWebhook`·`databaseUrl`·
 *  `identityFile`·`kubeconfig`·…)이 홈 `settings.json` 에 쓰이고 브라우저로 나갔다.
 *
 * ★**좁고 확실한 모양만** 본다. 길이·엔트로피 같은 추측은 안 쓴다 — 그건 또 하나의
 *  이름 맞히기이고, 과차단이 늘면 사람들이 가드를 우회하는 법부터 배운다. 아래 다섯은
 *  **무해한 설정값이 될 수 없는 모양**이다.
 *
 * ★못 잡는 것을 적어 둔다(정직이 이 함수의 절반이다): `otp: "123456"`·`pinCode: "0000"`·
 *  `mnemonic: "abandon abandon ability"` 는 모양이 평범해서 여기서 안 걸린다. 그런 값은
 *  설정 스펙에 **`secret` 으로 선언**해야 한다 — 이 함수는 선언을 대신하지 못한다.
 */
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM 개인키
  /-----BEGIN (?:CERTIFICATE|OPENSSH|PGP)/, // 인증서·SSH·PGP 블록
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub 토큰
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack 토큰
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI 계열 키
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/, // scheme://사용자:비밀번호@호스트
];

export const looksLikeCredentialValue = (value: unknown): boolean =>
  typeof value === "string" && CREDENTIAL_VALUE_SHAPES.some((re) => re.test(value));

/**
 * 자격증명처럼 **보이는** 키인가 — 거부 판정.
 *
 * ★이건 경계가 아니라 **가드**다. 진짜 경계는 §D.1 이 정한 것(secret 은 `.env`)이고,
 *  여기서 막는 건 흔한 실수 하나다: 모델이 친절하게 `apiKey` 를 위젯 설정에 넣는 것.
 *  이 레코드는 **브라우저로 나가고 백업에 들어간다** — 들어가면 조용히 샌다.
 *
 * ★**종전 정규식은 거의 아무것도 안 막았다** (2026-08-29, 적대 검토 A-F2). 앞에 `(^|[^a-z])`
 *  가 붙어 있어서 낱말이 이름 중간에 오면 통과했다 — `authToken`·`clientSecret`·
 *  `accessKey`·`x-api-key`·`bearer`·`cookie` 가 전부 뚫렸다.
 *
 * ★**첫 수정은 절반만 닫았다**(같은 날 적대 검토). 낱말 경계를 쓰는 갈래를 뒀는데, 경계가
 *  없는 이름(`accesskey`·`AUTHORIZATION`)에선 그 갈래가 통째로 무효였다. 그런데 **표본
 *  21종이 전부 camelCase 라 그 절반을 한 번도 안 밟았다** — 표본이 규칙을 다 밟지 않으면
 *  개수가 많아도 표본이 아니다.
 *
 * ★**틀리는 방향을 골랐다.** 잘못 막으면 위젯이 사유와 함께 떨어져 사용자가 즉시 안다.
 *  잘못 통과시키면 열쇠가 브라우저와 백업으로 **조용히** 나간다. 그래서 넓게 잡고,
 *  흔한 무해 낱말만 위에서 덜어낸다.
 *
 * @param key 설정 키 이름
 */
export const looksLikeCredentialKey = (key: string): boolean => {
  // ★구분자를 지우고 본다 — `apiKey`·`api_key`·`x-api-key` 는 같은 이름이다.
  const lower = key.toLowerCase().replace(/[-_]/g, "");
  // ★강한 낱말은 **지우기 전에** 본다 — 안 그러면 `author` 를 덜어내다 `authorization`
  //  까지 사라진다(실측으로 그렇게 뚫렸다).
  if (CREDENTIAL_WORDS.some((w) => lower.includes(w))) return true;
  let rest = lower;
  for (const w of INNOCENT_WORDS) rest = rest.split(w).join(" ");
  return CREDENTIAL_WORDS_AFTER_STRIP.some((w) => rest.includes(w));
};

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * 값 하나를 배치로 해석한다. **모르는 것은 조용히 고치지 않고 떨어뜨린다** —
 * 반쪽으로 살아난 위젯은 "왜 이렇게 떴지" 가 되고, 그건 아무도 못 고친다.
 *
 * @param raw `settings.json` 의 `dashboard.home.widgets` 또는 도구가 받은 배열.
 * @param knownPlugins 지금 **로드된** 플러그인 이름들. 코어는 위젯 id 목록을 모른다
 *   (등록소는 브라우저에 있다) — 그래서 확인할 수 있는 데까지만 확인한다: 플러그인이
 *   실재하는가. 목록을 여기 적어두면 그게 곧 드리프트다([[feedback_hand_maintained_lists]]).
 */
export const normalizeHomeWidgets = (
  raw: unknown,
  knownPlugins: ReadonlySet<string>,
): HomeWidgetsResolution => {
  const widgets: HomeWidget[] = [];
  const rejected: { at: string; reason: string }[] = [];
  if (raw === undefined || raw === null) return { widgets, rejected };
  if (!Array.isArray(raw)) {
    return { widgets, rejected: [{ at: "widgets", reason: "배열이 아닙니다." }] };
  }
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const at = `widgets[${i}]`;
    const drop = (reason: string): void => {
      rejected.push({ at, reason });
    };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      drop("객체가 아닙니다.");
      continue;
    }
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type.trim() : "";
    if (!TYPE_RE.test(type)) {
      drop(`type "${String(e.type)}" 이 <plugin>/<widget> 형식이 아닙니다.`);
      continue;
    }
    const owner = type.slice(0, type.indexOf("/"));
    if (!knownPlugins.has(owner)) {
      drop(
        `플러그인 "${owner}" 이 없거나 꺼져 있습니다 — 켜져 있는 것만 홈에 놓을 수 있습니다.`,
      );
      continue;
    }
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (id === "" || id.length > 64) {
      drop("id 는 1~64자 문자열이어야 합니다.");
      continue;
    }
    if (seen.has(id)) {
      drop(`id "${id}" 가 중복입니다.`);
      continue;
    }
    const sizeRaw = e.size === undefined ? "small" : e.size;
    if (typeof sizeRaw !== "string" || !SIZES.has(sizeRaw)) {
      drop(`size 는 small 또는 wide 여야 합니다(받은 값: ${String(e.size)}).`);
      continue;
    }
    let config: Record<string, string | number | boolean> = {};
    if (e.config !== undefined && e.config !== null) {
      if (typeof e.config !== "object" || Array.isArray(e.config)) {
        drop("config 는 객체여야 합니다.");
        continue;
      }
      const src = e.config as Record<string, unknown>;
      const keys = Object.keys(src);
      // ★**개수 상한을 걷어냈다** (2026-08-29 정태님). 종전엔 16개를 넘으면 떨어뜨렸는데
      //  **왜 16인지 한 줄도 적혀 있지 않았다** — 내가 그냥 고른 숫자였고, 지도·차트처럼
      //  설정이 많은 위젯을 만든 사람을 이유 없이 막는다. 레코드가 부는 걸 막는 건 개수가
      //  아니라 **아래 스칼라 규칙**이다(문자열·숫자·참거짓만 — 중첩 객체·배열이 안 들어온다).
      //  기준: 제한은 **사용자나 데몬이 다치는 것**에만 두고, 개발자 취향은 안 단속한다.
      let bad: string | undefined;
      for (const k of keys) {
        const v = src[k];
        // ★이름 **또는** 값 — 둘 중 하나만 걸려도 막는다. 이름 가드는 `pem`·`kubeconfig`
        //  처럼 낱말이 없는 이름을 못 보고, 값 가드는 모양이 평범한 값을 못 본다. 둘을
        //  같이 둬야 각자의 사각이 서로 덮인다.
        if (looksLikeCredentialKey(k) || looksLikeCredentialValue(v)) {
          bad =
            `config.${k} 는 자격증명처럼 보입니다 — 이 값은 브라우저로 나가고 백업에 ` +
            `들어갑니다. 열쇠는 홈 .env 의 TIGUCLAW_PLUGIN_<NAME>_<KEY> 로 두세요.`;
          break;
        }
        if (!isScalar(v)) {
          bad = `config.${k} 는 문자열·숫자·참거짓만 됩니다.`;
          break;
        }
        if (typeof v === "string" && v.length > 200) {
          bad = `config.${k} 가 200자를 넘습니다.`;
          break;
        }
      }
      if (bad !== undefined) {
        drop(bad);
        continue;
      }
      config = src as Record<string, string | number | boolean>;
    }
    if (widgets.length >= HOME_WIDGET_MAX) {
      drop(`홈 위젯은 최대 ${HOME_WIDGET_MAX}개입니다.`);
      continue;
    }
    seen.add(id);
    widgets.push({ id, type, size: sizeRaw as HomeWidgetSize, config });
  }
  return { widgets, rejected };
};

/**
 * `<home>/settings.json` 의 `dashboard.home.widgets` 원값.
 *
 * ★**읽기와 쓰기가 다른 함수를 쓴다**(2026-08-29, 적대 검토). 읽기는 못 읽어도 `{}` 로
 *  물러서지만(화면이 깨진 파일 하나로 죽으면 고칠 수단까지 잃는다), **쓰기는 거부한다** —
 *  그 `{}` 를 파일에 덮으면 모델 프로파일·테마가 함께 사라진다.
 */
const readRaw = (forWrite = false): { root: Record<string, unknown>; widgets: unknown } => {
  const file = getPaths().settings;
  const root = forWrite
    ? readSettingsRootForWrite(file)
    : readSettingsRootLenient(file);
  const dashboard = root.dashboard;
  const home =
    dashboard !== null && typeof dashboard === "object" && !Array.isArray(dashboard)
      ? (dashboard as Record<string, unknown>).home
      : undefined;
  const widgets =
    home !== null && typeof home === "object" && !Array.isArray(home)
      ? (home as Record<string, unknown>).widgets
      : undefined;
  return { root, widgets };
};

/** 지금 배치. 못 읽거나 깨졌으면 **빈 배열**(홈은 위젯 영역을 아예 안 그린다). */
export const readHomeWidgets = (
  knownPlugins: ReadonlySet<string>,
): HomeWidgetsResolution => normalizeHomeWidgets(readRaw().widgets, knownPlugins);

/**
 * 배치를 쓴다 — `setModelReasoning` 과 같은 형(읽고·그 키만 바꾸고·원자 교체).
 *
 * ★빈 배열이면 키를 **지운다.** 남겨두면 "설정한 적 없음" 과 "비워둠" 이 구분 안 되는데,
 *  화면 동작은 어차피 같다(안 그린다). 흔적을 안 남기는 쪽이 파일을 읽는 사람에게 정직하다.
 */
export const writeHomeWidgets = (widgets: readonly HomeWidget[]): void => {
  const file = getPaths().settings;
  // ★깨진 파일이면 **여기서 던진다** — 덮으면 남의 설정이 사라진다(적대 검토 A-F1).
  const { root } = readRaw(true);
  const existingDashboard = root.dashboard;
  const dashboard: Record<string, unknown> =
    existingDashboard !== null &&
    typeof existingDashboard === "object" &&
    !Array.isArray(existingDashboard)
      ? (existingDashboard as Record<string, unknown>)
      : {};
  const existingHome = dashboard.home;
  const home: Record<string, unknown> =
    existingHome !== null && typeof existingHome === "object" && !Array.isArray(existingHome)
      ? (existingHome as Record<string, unknown>)
      : {};
  if (widgets.length === 0) delete home.widgets;
  else home.widgets = widgets;
  if (Object.keys(home).length === 0) delete dashboard.home;
  else dashboard.home = home;
  if (Object.keys(dashboard).length === 0) delete root.dashboard;
  else root.dashboard = dashboard;
  writeSettingsRootAtomic(file, root);
};
