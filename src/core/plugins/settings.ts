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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPaths } from "../paths.js";

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
    } = { key, type: type as PluginSettingType };
    if (typeof e.labelKey === "string" && e.labelKey !== "") spec.labelKey = e.labelKey;
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

/** 파일에 저장된 원값(검증 전). 없거나 깨졌으면 빈 객체 — **다른 플러그인은 무사하다**. */
const readRaw = (plugin: string): Record<string, unknown> => {
  const f = settingsFile(plugin);
  try {
    if (!existsSync(f)) return {};
    const parsed = JSON.parse(readFileSync(f, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 깨진 JSON 하나가 **그 플러그인만** 죽인다(§D.1 의 폭발 반경). 코어는 무사하다.
    console.warn(`[plugin-settings] ${plugin}: settings.json 을 읽지 못했습니다 — 기본값으로 봅니다.`);
  }
  return {};
};

export type PluginSettingValue = string | number | boolean;

/**
 * 이 플러그인이 런타임에 보는 값 — **선언된 키만**, 기본값 적용.
 *
 * ★선언에 없는 키는 안 준다. 파일에 남아 있어도(선언이 바뀐 뒤) 조용히 흘러들지 않는다.
 * ★`secret` 은 파일이 아니라 `.env` 에서 온다. 없으면 **키 자체가 없다**(빈 문자열이 아니라).
 */
export const effectiveSettings = (
  plugin: string,
  specs: readonly PluginSettingSpec[],
): Record<string, PluginSettingValue> => {
  const raw = readRaw(plugin);
  const out: Record<string, PluginSettingValue> = {};
  for (const spec of specs) {
    if (spec.type === "secret") {
      const v = process.env[secretEnvName(plugin, spec.key)];
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
    else if (spec.default !== undefined) out[spec.key] = spec.default;
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
): Array<PluginSettingSpec & { value?: PluginSettingValue; hasSecret?: boolean }> => {
  const eff = effectiveSettings(plugin, specs);
  return specs.map((spec) =>
    spec.type === "secret"
      ? { ...spec, hasSecret: eff[spec.key] !== undefined }
      : { ...spec, ...(eff[spec.key] !== undefined ? { value: eff[spec.key] } : {}) },
  );
};

export interface WriteVerdict {
  readonly ok: boolean;
  readonly error?: string;
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
  if (spec === undefined) return { ok: false, error: `모르는 설정 키 '${key}'` };
  if (spec.type === "secret") {
    return {
      ok: false,
      error:
        `'${key}' 는 secret 입니다 — 홈 .env 의 ${secretEnvName(plugin, key)} 에 두세요. ` +
        `설정 파일은 화면에 뿌려지고 백업에 들어갑니다.`,
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
    if (!ok) return { ok: false, error: `'${key}' 값이 type '${spec.type}' 과 맞지 않습니다` };
  }
  const raw = readRaw(plugin);
  if (value === undefined) delete raw[key];
  else raw[key] = value;
  const f = settingsFile(plugin);
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  renameSync(tmp, f);
  return { ok: true };
};
