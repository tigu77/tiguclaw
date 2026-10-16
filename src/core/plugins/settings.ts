// src/core/plugins/settings.ts
/**
 * **플러그인 설정 — 선언은 값이고, 화면은 그 값에서 생긴다** (2026-08-28, 위젯 플랫폼 §D).
 *
 * ★**설정 화면을 손으로 짓지 않는다.** 지금 설정 페이지는 `buildLocaleRow`·`buildThemeRow`…
 *  가 전부 손으로 쓴 것이라 그 자체가 다음 드리프트 자리다(§D.2). 플러그인은 매니페스트에
 *  **값으로** 적고, 화면은 그 선언에서 행을 만든다 — 그래야 플러그인이 늘어도 화면을 안 고친다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * ★**파일은 플러그인마다 하나**다(`<home>/plugins/<name>/settings.json`). 코어 정본
 *  `settings.json` 에 섞지 않는 이유는 편의가 아니라 셋이다(§D.1): 폭발 반경(서드파티 버그
 *  하나가 모델·테마·gateway 를 날린다) · 소유권(제거한 플러그인의 섹션이 영원히 남는다) ·
 *  경계가 코드가 아니라 파일시스템에서 지켜진다.
 *
 * ★**쓰기는 코어가 한다.** 플러그인이 자기 설정 파일에 직접 쓰지 않는다 — 그래야 스키마
 *  검증이 한 곳이다. 런타임 상태는 설정이 아니니 같은 폴더의 **다른 파일**로 간다.
 *
 * ★**secret 은 설정 파일에 안 들어간다.** 이유가 *"한 파일이라서"* 가 아니라 *"설정 파일은
 *  대시보드가 읽어 화면에 뿌리고 백업에 들어가서"* 이므로, 파일을 갈라도 그대로 성립한다.
 *  값은 홈 `.env` 의 `TIGUCLAW_PLUGIN_<NAME>_<KEY>` 에서만 오고 **화면엔 있다/없다만** 간다.
 */
import path from "node:path";
import { getPaths } from "../paths.js";
import {
  readSettingsRootForWrite,
  readSettingsRootLenient,
  writeSettingsRootAtomic,
} from "../settings-file.js";

/**
 * 설정 한 칸의 종류.
 *
 * ★**지금 화면이 그릴 수 있는 것만 있다.** `readNeeds` 가 *"집행하지 않는 권한은 받지
 *  않는다"* 인 것과 같은 규범이다 — 그릴 수 없는 종류를 받으면 선언은 있는데 화면엔 아무것도
 *  안 생기고, 플러그인 작성자는 자기가 뭘 잘못했는지 모른다.
 */
export type PluginSettingType = "string" | "number" | "boolean" | "enum" | "secret";

const KNOWN_TYPES: ReadonlySet<string> = new Set<PluginSettingType>([
  "string",
  "number",
  "boolean",
  "enum",
  "secret",
]);

export interface PluginSettingSpec {
  readonly key: string;
  readonly type: PluginSettingType;
  /** 화면에 뜨는 이름. ★**문장이 아니라 키**다 — 번역은 플러그인이 들고 온다(§G). */
  readonly labelKey?: string;
  /** `enum` 일 때의 값들. */
  readonly values?: readonly string[];
  readonly default?: string | number | boolean;
  /**
   * ★**이 값의 정본은 홈 `.env` 의 이 환경변수다** (2026-09-02 정태님: *"홈셋팅도 같이
   *  읽어서 사용할 수 있어도 나쁘진 않을거같아"*).
   *
   * 왜: 번들 플러그인들은 `process.env.HTTP_BRIDGE_PORT` 처럼 **자기가 직접** 읽는다.
   * 그걸 전부 `host.settings` 로 옮기는 건 큰 이사이고, 토큰류는 env 이름이 바뀌어
   * **기존 설치가 깨진다**. 이 한 칸이면 옮기지 않고도 «봇 토큰이 있나»·«포트가 몇이지» 가
   * 화면에 뜬다 — 선언만 추가하면 된다.
   *
   * ★그래서 이건 **기본 읽기 전용**이다(2026-09-02). 플러그인이 env 를 직접 읽으므로 화면에서 고쳐도 재시작 전엔 안 먹고, 포트 같은
   *  값은 잘못 넣으면 대시보드 자체가 죽어 화면에서 되돌릴 길이 없다(10-16 적대 검토 P1 — 전부 열었다가 되돌림). 화면에서 고치게
   *  하려면 플러그인이 `editable: true` 로 **명시**한다(`writePluginEnvSetting`). `secret` 은 넣기만 하는 칸이라 늘 쓸 수 있다.
   */
  readonly env?: string;
  /** `env` 칸을 설정 화면에서 고쳐도 되는가 — 플러그인이 명시할 때만(기본 읽기 전용). 예: 텔레그램 소유자 ID. */
  readonly editable?: boolean;
  /** 플러그인이 이 값을 **쓸 때마다** 읽는다(재시작 없이 바로 먹는다) — 화면이 «재시작 필요» 를 말하지 않게. 예: 텔레그램 소유자 ID. */
  readonly live?: boolean;
  /**
   * **값 후보를 내주는 이 플러그인의 데이터 라우트 이름** (2026-10-16) — 화면이 칸 옆에 «찾기» 를 그리고, 누르면
   *  `GET /api/plugin-data/<플러그인>/<suggest>` 의 `{ items: [{ value, label }], note? }` 를 보여준다. 사용자가 하나를 골라야
   *  저장된다(자동으로 넣지 않는다). 예: 텔레그램 «내 ID 찾기» — 봇에게 말을 건 사람 목록.
   */
  readonly suggest?: string;
  /**
   * **이 값은 손대는 게 아니다** — 플러그인이 그렇게 말한 경우 (2026-09-02 정태님:
   * *"읽기 전용인지, 설정 가능인지 뭐 이런것들도 공통적으로 다 가능한가?"*).
   *
   * ★규칙은 하나다: **선언은 «더 조이는 방향» 만 유효하다. 푸는 방향은 코어가 정한다.**
   *  - `true` → 존중한다(플러그인이 스스로 조인 것).
   *  - `false` → **약속이 아니다.** `env` 가 정본이거나 `secret` 이면 코어가 그대로 막는다.
   *    제약받는 쪽이 제약을 풀 수 있으면 그건 게이트가 아니다.
   *  같은 규범이 `ActionSpec.requiresConfirmation` 에도 있다(켜는 건 되고 끄는 건 안 된다).
   *
   * 쓰는 곳: 플러그인이 스스로 계산해 두는 값, 다른 곳에서 관리되는 값.
   */
  readonly readOnly?: boolean;
}

export interface SettingsSpecVerdict {
  readonly specs: PluginSettingSpec[];
  /** 사람이 읽는 거부 사유. 비어 있으면 전부 정상. */
  readonly problems: string[];
}

/** 키는 `.env` 이름과 파일 키가 되므로 좁게 잡는다. */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/**
 * 매니페스트의 `tiguclaw.settings` 를 읽고 검사한다.
 *
 * ★순수 함수다 — 회귀가 **실제로 부른다**(`readNeeds` 와 같은 형). 로더 안에 인라인이면
 *  검사하려고 데몬을 띄워야 하고, 그러면 그물이 문자열 grep 으로 약해진다.
 * ★**나쁜 칸 하나가 나머지를 안 죽인다** — 그 칸만 떨어뜨리고 이유를 남긴다. 통째로 거부하면
 *  오타 하나에 플러그인의 설정이 전부 사라진다.
 */
export const readSettingsSpec = (raw: unknown): SettingsSpecVerdict => {
  const specs: PluginSettingSpec[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { specs, problems };
  if (!Array.isArray(raw)) return { specs, problems: ["settings 는 배열이어야 합니다"] };
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const at = `settings[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at}: 객체가 아닙니다`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key.trim() : "";
    if (!KEY_RE.test(key)) {
      problems.push(`${at}: key 는 영문으로 시작하는 1~40자 이름이어야 합니다 (받은 값: ${String(e.key)})`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`${at}: key '${key}' 가 중복입니다`);
      continue;
    }
    const type = typeof e.type === "string" ? e.type : "";
    if (!KNOWN_TYPES.has(type)) {
      problems.push(
        `${at}: 모르는 type '${String(e.type)}' — 아는 것은 [${[...KNOWN_TYPES].join(", ")}]. ` +
          `화면이 그릴 수 없는 종류는 받지 않습니다(선언은 있는데 아무것도 안 생깁니다).`,
      );
      continue;
    }
    const spec: {
      key: string;
      type: PluginSettingType;
      labelKey?: string;
      values?: string[];
      default?: string | number | boolean;
      env?: string;
      readOnly?: boolean;
      suggest?: string;
      editable?: boolean;
      live?: boolean;
    } = { key, type: type as PluginSettingType };
    if (typeof e.labelKey === "string" && e.labelKey !== "") spec.labelKey = e.labelKey;
    if (e.env !== undefined) {
      // ★`secret` 에도 붙일 수 있다 — 그때는 «이 비밀의 env 이름은 규칙 대신 이것» 이라는
      //  뜻이다. 이게 있어야 기존 설치가 안 깨진다: 규칙대로면 telegram 토큰이
      //  `TIGUCLAW_PLUGIN_TELEGRAM_BOTTOKEN` 이 되어 사용자의 `TELEGRAM_BOT_TOKEN` 을
      //  못 찾고 봇이 죽는다. 명시했으니 «어디서 오는지 모른다» 는 문제도 없다.
      if (typeof e.env !== "string" || !ENV_RE.test(e.env)) {
        problems.push(`${at}: env 는 대문자 환경변수 이름이어야 합니다 (받은 값: ${String(e.env)})`);
        continue;
      }
      spec.env = e.env;
    }
    // ★`true` 만 받는다 — `false` 는 «풀어달라» 는 뜻인데 그건 선언으로 되는 일이 아니다.
    //  받아서 저장하면 화면·서버가 그 값을 참고할 위험이 생기므로 아예 안 담는다.
    if (e.readOnly === true) spec.readOnly = true;
    if (e.editable === true) spec.editable = true;
    if (e.live === true) spec.live = true;
    if (e.suggest !== undefined) {
      if (typeof e.suggest !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(e.suggest)) {
        problems.push(`${at}: suggest 는 이 플러그인의 데이터 라우트 이름이어야 합니다(소문자·숫자·하이픈, 받은 값: ${String(e.suggest)})`);
        continue;
      }
      spec.suggest = e.suggest;
    }
    if (type === "enum") {
      const vs = e.values;
      if (!Array.isArray(vs) || vs.length === 0 || vs.some((v) => typeof v !== "string")) {
        problems.push(`${at}: enum 은 values 에 문자열 배열이 필요합니다`);
        continue;
      }
      spec.values = vs as string[];
    }
    if (e.default !== undefined) {
      const d = e.default;
      const okDefault =
        type === "secret"
          ? false
          : type === "boolean"
            ? typeof d === "boolean"
            : type === "number"
              ? typeof d === "number"
              : typeof d === "string" &&
                (type !== "enum" || (spec.values ?? []).includes(d));
      if (!okDefault) {
        problems.push(
          type === "secret"
            ? `${at}: secret 에는 default 를 둘 수 없습니다(열쇠는 코드에 적는 것이 아닙니다)`
            : `${at}: default 가 type '${type}' 과 맞지 않습니다`,
        );
        continue;
      }
      spec.default = d as string | number | boolean;
    }
    seen.add(key);
    specs.push(spec);
  }
  return { specs, problems };
};

/** `TIGUCLAW_PLUGIN_<NAME>_<KEY>` — secret 이 사는 유일한 자리. */
export const secretEnvName = (plugin: string, key: string): string =>
  `TIGUCLAW_PLUGIN_${plugin.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_${key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;

const settingsFile = (plugin: string): string =>
  path.join(getPaths().commonPlugins, plugin, "settings.json");

/**
 * 파일에 저장된 원값(검증 전).
 *
 * ★**읽기와 쓰기가 다르다**(2026-08-29, 적대 검토 A-F3). 읽기는 깨졌어도 기본값으로
 *  물러서지만(깨진 JSON 하나가 **그 플러그인만** 죽인다 — §D.1 의 폭발 반경), **쓰기는
 *  거부한다**: 그 `{}` 를 덮으면 같은 파일의 다른 칸이 조용히 사라진다. 실측으로
 *  `{units, count, city}` 중 둘이 없어졌다.
 */
const readRaw = (plugin: string, forWrite = false): Record<string, unknown> => {
  const f = settingsFile(plugin);
  return forWrite ? readSettingsRootForWrite(f) : readSettingsRootLenient(f);
};

export type PluginSettingValue = string | number | boolean;

/**
 * 이 플러그인이 런타임에 보는 값 — **선언된 키만**, 기본값 적용.
 *
 * ★선언에 없는 키는 안 준다. 파일에 남아 있어도(선언이 바뀐 뒤) 조용히 흘러들지 않는다.
 * ★`secret` 은 파일이 아니라 `.env` 에서 온다. 없으면 **키 자체가 없다**(빈 문자열이 아니라).
 */
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 환경변수는 언제나 문자열이다 — 선언한 형으로 읽어본다. 안 맞으면 `undefined`(= 없는 것). */
const coerceEnv = (
  raw: string | undefined,
  spec: PluginSettingSpec,
): PluginSettingValue | undefined => {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const v = raw.trim();
  if (spec.type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (spec.type === "boolean") {
    if (["true", "1", "yes", "on"].includes(v.toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(v.toLowerCase())) return false;
    return undefined;
  }
  if (spec.type === "enum") return (spec.values ?? []).includes(v) ? v : undefined;
  return v;
};

export const effectiveSettings = (
  plugin: string,
  specs: readonly PluginSettingSpec[],
): Record<string, PluginSettingValue> => {
  const raw = readRaw(plugin);
  const out: Record<string, PluginSettingValue> = {};
  for (const spec of specs) {
    if (spec.type === "secret") {
      const v = process.env[spec.env ?? secretEnvName(plugin, spec.key)];
      if (typeof v === "string" && v !== "") out[spec.key] = v;
      continue;
    }
    const v = raw[spec.key];
    const ok =
      spec.type === "boolean"
        ? typeof v === "boolean"
        : spec.type === "number"
          ? typeof v === "number"
          : typeof v === "string" &&
            (spec.type !== "enum" || (spec.values ?? []).includes(v));
    if (ok) out[spec.key] = v as PluginSettingValue;
    else {
      // ★파일에 없으면 **선언한 env** 를 본다(정본이 거기라고 적힌 경우). 그래야 빌트인을
      //  옮기지 않고도 화면이 «지금 값» 을 말한다. 없거나 형이 안 맞으면 조용히 default 로.
      const fromEnv = spec.env === undefined ? undefined : coerceEnv(process.env[spec.env], spec);
      if (fromEnv !== undefined) out[spec.key] = fromEnv;
      else if (spec.default !== undefined) out[spec.key] = spec.default;
    }
  }
  return out;
};

/**
 * 화면이 볼 것 — 값 + **secret 은 있다/없다만**.
 *
 * ★secret 을 절대 안 싣는다. 이 응답은 브라우저로 나가고 사용자의 화면에 그려진다.
 */
export const settingsForClient = (
  plugin: string,
  specs: readonly PluginSettingSpec[],
  /**
   * ★**어디서 온 선언인가** (2026-10-09, 전체 적대 검토 P2). `env` 는 «이 값은 그 환경변수에서
   *  읽는다» 는 선언인데, 어느 변수를 가리킬지는 **매니페스트가 정한다.** 그래서 홈 플러그인이
   *  매니페스트 한 줄(`{"key":"x","type":"string","env":"ANTHROPIC_API_KEY"}`)만으로 우리
   *  열쇠를 `/plugins` 응답 — 브라우저 — 에 실을 수 있었다(실측). 코드 한 줄 없이.
   * ★번들 선언은 믿는다 — 포트·허용 호스트처럼 **보여주려고** 적은 것이고 우리가 썼다.
   *  `core` 와 같은 규칙이다: 유효성을 선언이 아니라 **위치**로 판정한다(`inventory.ts`).
   *  홈 선언이 env 를 가리키면 그 값은 **secret 처럼**(있다/없다만) 나간다 — 화면은 이미
   *  그 모양을 그릴 줄 알아서 새 필드가 필요 없다.
   */
  source: "bundled" | "home",
): Array<PluginSettingSpec & { value?: PluginSettingValue; hasSecret?: boolean }> => {
  const eff = effectiveSettings(plugin, specs);
  return specs.map((spec) =>
    spec.type === "secret" || (source === "home" && spec.env !== undefined)
      ? { ...spec, type: "secret" as const, hasSecret: eff[spec.key] !== undefined }
      : {
          ...spec,
          ...(eff[spec.key] !== undefined ? { value: eff[spec.key] } : {}),
          // `env` 는 스펙에 그대로 실려 나간다 — 화면이 «읽기 전용 + 어느 변수인지» 를 그린다.
        },
  );
};

/**
 * 한 칸 쓰기의 판정.
 *
 * ★`error` 는 **로그·폴백용 한 문장**이고, `errorKey` 가 화면이 자기 언어로 그리는 근거다
 *  (2026-08-30, 3라운드 D-4). 종전엔 문장만 있었고 브리지가 그걸 그대로 `reason` 으로
 *  실어 보내서, 영어 사용자가 플러그인 설정을 바꾸다 실패하면 한국어 토스트를 만났다 —
 *  매니저 쪽에서 고친 것과 **같은 부류**이고, 그때 이 형제 경로만 빠졌다.
 *  키 이름은 `PluginActionResult.reasonKey` 와 같은 `plugins.reason.*` 이름공간이다.
 */
export interface WriteVerdict {
  readonly ok: boolean;
  readonly error?: string;
  readonly errorKey?: string;
  readonly errorArgs?: Record<string, string>;
}

/**
 * 한 칸을 쓴다 — **코어만 이 문을 쓴다**(플러그인은 자기 파일에 직접 안 쓴다).
 *
 * ★`undefined` 를 주면 그 키를 지운다(=기본값으로 되돌린다). "비우기" 를 별도 동사로 두지
 *  않는 이유는 같은 판단이 두 곳이 되기 때문이다.
 */
export const writePluginSetting = (
  plugin: string,
  specs: readonly PluginSettingSpec[],
  key: string,
  value: PluginSettingValue | undefined,
): WriteVerdict => {
  const spec = specs.find((s) => s.key === key);
  if (spec === undefined)
    return {
      ok: false,
      error: `모르는 설정 키 '${key}'`,
      errorKey: "plugins.reason.unknownSettingKey",
      errorArgs: { key },
    };
  if (spec.type === "secret") {
    return {
      ok: false,
      error:
        `'${key}' 는 secret 입니다 — 홈 .env 의 ${spec.env ?? secretEnvName(plugin, key)} 에 두세요. ` +
        `설정 파일은 화면에 뿌려지고 백업에 들어갑니다.`,
      errorKey: "plugins.reason.secretGoesInEnv",
      errorArgs: { key, env: spec.env ?? secretEnvName(plugin, key) },
    };
  }
  if (spec.readOnly === true) {
    return {
      ok: false,
      error: `'${key}' 는 읽기 전용입니다 — 이 플러그인이 그렇게 선언했습니다.`,
      errorKey: "plugins.reason.settingReadOnly",
      errorArgs: { key },
    };
  }
  if (spec.env !== undefined) {
    // ★서버가 막는다. 화면만 읽기 전용으로 두면 API 를 직접 부르는 순간 파일에 값이 남고,
    //  그 값은 플러그인이 안 읽으므로 «고쳤는데 안 먹는» 상태가 영구히 남는다.
    return {
      ok: false,
      error:
        `'${key}' 의 정본은 홈 .env 의 ${spec.env} 입니다 — 거기서 고치세요. ` +
        `이 플러그인은 그 환경변수를 직접 읽습니다.`,
      errorKey: "plugins.reason.settingComesFromEnv",
      errorArgs: { key, env: spec.env },
    };
  }
  if (value !== undefined) {
    const ok =
      spec.type === "boolean"
        ? typeof value === "boolean"
        : spec.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === "string" &&
            (spec.type !== "enum" || (spec.values ?? []).includes(value));
    if (!ok)
      return {
        ok: false,
        error: `'${key}' 값이 type '${spec.type}' 과 맞지 않습니다`,
        errorKey: "plugins.reason.settingTypeMismatch",
        errorArgs: { key, type: spec.type },
      };
  }
  // ★깨진 파일이면 **여기서 던진다** — 호출부가 사유를 사용자에게 그대로 전한다.
  const raw = readRaw(plugin, true);
  if (value === undefined) delete raw[key];
  else raw[key] = value;
  writeSettingsRootAtomic(settingsFile(plugin), raw);
  return { ok: true };
};

/**
 * **secret·`.env` 칸을 화면에서 저장한다** — 홈 `.env` 에 쓴다 (2026-10-16, 정태님 «텔레그램 채널 플러그인에서 쉽게 연결»).
 *
 * ★종전엔 이 칸들이 «있다/없다» 만 보이고 쓰기는 거절됐다 — 그래서 텔레그램 토큰 하나 넣으려고 사용자가 `.env` 를 직접 고쳐야
 *  했다. 정본은 여전히 홈 `.env` 다(두 벌 없음) — 이 함수는 그 파일에 쓰는 **문**일 뿐이고, 쓰기는 공용 `upsertHomeEnvVars`
 *  (원자적·0600·직렬)가 한다. 값은 응답·로그에 싣지 않는다. 토큰이 채팅·모델을 거치지 않는다.
 *
 * ★**쓸 수 있는 이름을 좁힌다** — 사용자가 설치한(홈) 플러그인이 `env: "CLAUDE_CODE_OAUTH_TOKEN"` 처럼 코어 키를 선언하면, 이 화면이
 *  코어 인증을 덮는 문이 된다. 앱과 함께 오는 플러그인의 선언 `env` 이거나, 그 플러그인 자기 이름공간(`TIGUCLAW_PLUGIN_<이름>_<키>`)만.
 *
 * 반환 `undefined` = 이 칸은 `.env` 칸이 아니다(파일 칸 — `writePluginSetting` 이 맡는다).
 * 플러그인은 대개 부팅 때 값을 읽으므로 적용엔 재시작이 필요하다(`restartNeeded`). `process.env` 는 즉시 바뀐다(데이터 라우트는 바로 본다).
 */
export const writePluginEnvSetting = async (
  plugin: string,
  specs: readonly PluginSettingSpec[],
  key: string,
  value: string | undefined,
  source: "bundled" | "home",
): Promise<(WriteVerdict & { restartNeeded?: boolean }) | undefined> => {
  const spec = specs.find((s) => s.key === key);
  if (spec === undefined || (spec.type !== "secret" && spec.env === undefined)) return undefined;
  if (spec.readOnly === true) {
    return { ok: false, error: `'${key}' 는 읽기 전용입니다 — 이 플러그인이 그렇게 선언했습니다.`, errorKey: "plugins.reason.settingReadOnly", errorArgs: { key } };
  }
  // `.env` 칸(비밀 아님)은 플러그인이 명시한 것만 — 포트처럼 잘못 넣으면 대시보드가 죽어 되돌릴 길이 없는 값이 있다(적대 검토 P1).
  if (spec.type !== "secret" && spec.editable !== true) {
    return {
      ok: false,
      error: `'${key}' 의 정본은 홈 .env 의 ${spec.env} 입니다 — 거기서 고치세요. 이 플러그인은 그 환경변수를 직접 읽습니다.`,
      errorKey: "plugins.reason.settingComesFromEnv",
      errorArgs: { key, env: spec.env ?? "" },
    };
  }
  const own = secretEnvName(plugin, key);
  const name = spec.env ?? own;
  if (source === "home" && name !== own) {
    return {
      ok: false,
      error: `'${key}' 는 이 화면에서 쓸 수 없는 이름(${name})을 가리킵니다 — 직접 설치한 플러그인은 ${own} 만 쓸 수 있습니다.`,
      errorKey: "plugins.reason.envNameNotOwn",
      errorArgs: { key, env: name, own },
    };
  }
  const v = (value ?? "").trim();
  // 한 줄 값만 — 줄바꿈이 들어가면 `.env` 에 **다른 키**를 몰래 심을 수 있다.
  if (/[\r\n\0]/.test(v) || v.length > 8192) {
    return { ok: false, error: `'${key}' 값은 한 줄(8192자 이하)이어야 합니다`, errorKey: "plugins.reason.envValueOneLine", errorArgs: { key } };
  }
  // ★따옴표·`#`·역슬래시는 받지 않는다 — `.env` 파서가 따옴표로 시작하는 값을 **다음 줄까지** 읽어 뒤 키(예: HTTP_BRIDGE_TOKEN)를
  //  삼키고, `#` 뒤는 주석으로 잘랐다(적대 검토 P2 실측). 이 칸에 들어갈 값(토큰·ID·이름)엔 안 쓰이는 문자다.
  if (/['"`#\\]/.test(v)) {
    return { ok: false, error: `'${key}' 값에 따옴표·#·역슬래시는 쓸 수 없습니다`, errorKey: "plugins.reason.envValueUnsafe", errorArgs: { key } };
  }
  if (v !== "" && spec.type === "number" && !Number.isFinite(Number(v))) {
    return { ok: false, error: `'${key}' 값이 type 'number' 과 맞지 않습니다`, errorKey: "plugins.reason.settingTypeMismatch", errorArgs: { key, type: spec.type } };
  }
  if (v !== "" && spec.type === "enum" && !(spec.values ?? []).includes(v)) {
    return { ok: false, error: `'${key}' 값이 type 'enum' 과 맞지 않습니다`, errorKey: "plugins.reason.settingTypeMismatch", errorArgs: { key, type: spec.type } };
  }
  const { upsertHomeEnvVars } = await import("../env-file.js");
  await upsertHomeEnvVars({ [name]: v });
  console.log(`[plugin:${plugin}] 설정 '${key}' 을 홈 .env 의 ${name} 에 저장(${v === "" ? "비움" : `${v.length}자`}) — ${spec.live === true ? "바로 적용" : "적용엔 재시작"}`);
  // 플러그인이 쓸 때마다 읽는 값(`live`)은 바로 먹는다 — 그때 «재시작 필요» 라고 하면 사실과 다르다(레드팀 A: 소유자를 골라도 막대가 떴다).
  return spec.live === true ? { ok: true } : { ok: true, restartNeeded: true };
};
