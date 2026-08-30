/**
 * **설정 라우트** — 읽고 쓰는 열둘. 전부 `settings.json` 을 만진다.
 *
 * ★`index.ts` 의 `handleRequest` 에서 떼어냈다 (2026-08-30, R3). 324줄이고 **한 관심사**다 —
 *  모델 프로파일·테마·언어·제안·egress·모듈 on/off.
 *
 * ★여기가 08-29 「깨진 설정 파일 위에 덮어쓰기」 사고가 났던 부류다. 쓰기는 전부
 *  `src/core/settings-file.ts` 한 곳을 지나야 한다 — 그게 「없다」와 「깨졌다」를 가른다.
 *
 * ★조건(`if (pathname === …)`)은 `index.ts` 에 남겼다. 본문의 `return;` 을 한 글자도
 *  안 건드리려는 것이다(자세한 이유는 `routes-gateway.ts` 머리말).
 */
import { setLocale, setProfileColor, setTheme } from "../../src/core/settings.js";
import { listOutboundChannels } from "../../src/core/channel-outbound.js";
import { BUILTIN_DEFAULT_TIER, resolveModelProfiles } from "../../src/core/llm-runtime/builtin-profiles.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { readSuggestionSettings } from "../../src/core/next-message-suggestion.js";
import { collectInventory, isCoreModule, isSelfReferentialModule } from "../../src/core/plugins/inventory.js";
import { collectModules } from "../../src/core/plugins/providers.js";
import { setDefaultProfile, getDefaultProfileName, loadModelProfiles, readEgressChannels, setEgressChannels, setModuleDisabled, setSuggestionEnabled } from "../../src/core/settings.js";
import { resolveSessionId } from "../../src/core/threadkey.js";
import { SESSION_STORAGE_CHANNEL, clearSessionModelProfile, setSessionModelProfile } from "../../src/store/sessions.js";
import { readJsonBody } from "./http-body.js";
import type http from "node:http";
import type { RouteCtx } from "./route-ctx.js";



export const handleSetDefaultProfile = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let dbody: Record<string, unknown>;
  try {
    dbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const name = typeof dbody.name === "string" ? dbody.name.trim() : "";
  if (name === "") {
    writeJson(res, 400, { error: "name required" });
    return;
  }
  const profiles = loadModelProfiles();
  if (profiles[name] === undefined) {
    writeJson(res, 400, {
      error: `존재하지 않는 프로파일: ${name}`,
      available: Object.keys(profiles),
    });
    return;
  }
  try {
    setDefaultProfile(name);
    writeJson(res, 200, { ok: true, default: name });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleSetProfileColor = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let cbody: Record<string, unknown>;
  try {
    cbody = await readJsonBody(req);
  } catch (e) {
    writeJson(res, 400, { error: `invalid body: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  const name = typeof cbody.name === "string" ? cbody.name.trim() : "";
  if (name === "") {
    writeJson(res, 400, { error: "name(string) required" });
    return;
  }
  const raw = cbody.color;
  if (raw !== null && typeof raw !== "string") {
    writeJson(res, 400, { error: "color 는 '#rrggbb' 문자열이거나 null(지우기) 이어야 합니다" });
    return;
  }
  try {
    const ok = setProfileColor(name, raw === null ? undefined : raw);
    if (!ok) {
      writeJson(res, 400, {
        error: `'${name}' 프로파일을 못 찾았거나 색 형식이 '#rrggbb' 가 아닙니다`,
      });
      return;
    }
    writeJson(res, 200, { ok: true, name, color: raw });
  } catch (e) {
    writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
  return;
};

export const handleSetSuggestion = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let sbody: Record<string, unknown>;
  try {
    sbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  if (typeof sbody.enabled !== "boolean") {
    writeJson(res, 400, { error: "enabled(boolean) required" });
    return;
  }
  try {
    setSuggestionEnabled(sbody.enabled);
    writeJson(res, 200, { ok: true, enabled: sbody.enabled });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleSetLocale = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let lbody: Record<string, unknown>;
  try {
    lbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const want = typeof lbody.locale === "string" ? lbody.locale.trim() : "";
  if (want === "") {
    writeJson(res, 400, { error: "locale(string) required" });
    return;
  }
  try {
    if (!setLocale(want)) {
      writeJson(res, 400, { error: `'${want}' 언어가 설치돼 있지 않습니다` });
      return;
    }
    writeJson(res, 200, { ok: true, locale: want });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleSetTheme = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let tbody: Record<string, unknown>;
  try {
    tbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  try {
    const changed: Record<string, unknown> = {};
    if (tbody.theme !== undefined) {
      const want = typeof tbody.theme === "string" ? tbody.theme.trim() : "";
      if (!setTheme(want === "" ? undefined : want)) {
        writeJson(res, 400, { error: `'${want}' 테마가 설치돼 있지 않습니다` });
        return;
      }
      changed.theme = want;
    }
    writeJson(res, 200, { ok: true, ...changed });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleSetEgress = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let ebody: Record<string, unknown>;
  try {
    ebody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  if (!Array.isArray(ebody.channels)) {
    writeJson(res, 400, { error: "channels(string[]) required" });
    return;
  }
  const known = new Set(listOutboundChannels());
  const channels = ebody.channels.filter(
    (c): c is string => typeof c === "string" && known.has(c),
  );
  // 오타·사라진 채널은 조용히 버린다 — 댕글링 좌표를 저장하면 영구 무발신이 된다
  // (add_schedule dest_channel 이 그렇게 당했다).
  try {
    setEgressChannels(channels);
    writeJson(res, 200, { ok: true, channels, available: [...known] });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleGetEgress = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  writeJson(res, 200, {
    channels: readEgressChannels(),
    available: listOutboundChannels(),
  });
  return;
};

export const handleGetSuggestion = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  writeJson(res, 200, { enabled: readSuggestionSettings().enabled });
  return;
};

export const handleSetSessionProfile = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let dbody: Record<string, unknown>;
  try {
    dbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const rawThreadKey =
    typeof dbody.threadKey === "string" ? dbody.threadKey.trim() : "";
  if (rawThreadKey === "") {
    writeJson(res, 400, { error: "threadKey required" });
    return;
  }
  // profile 필드(계약) — name alias 도 관용 허용.
  const rawProfile =
    typeof dbody.profile === "string"
      ? dbody.profile.trim()
      : typeof dbody.name === "string"
        ? dbody.name.trim()
        : "";
  // /messages 와 동일 정규화 — sessionId = resolveSessionId(ctx.channelName, threadKey, threadKey).
  const sessionId = resolveSessionId(ctx.channelName, rawThreadKey, rawThreadKey);
  // "" / "default" / 현재 전역 default 이름 → 세션 override 제거(전역 default 상속).
  const isInherit =
    rawProfile === "" ||
    rawProfile === "default" ||
    rawProfile === getDefaultProfileName();
  if (isInherit) {
    try {
      clearSessionModelProfile(SESSION_STORAGE_CHANNEL, sessionId);
      writeJson(res, 200, { ok: true, threadKey: rawThreadKey, profile: null });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      writeJson(res, 500, { error: m });
    }
    return;
  }
  // 실존 프로파일 검증(댕글링 차단 = constraint 2 방어심).
  const profiles = loadModelProfiles();
  if (profiles[rawProfile] === undefined) {
    writeJson(res, 400, {
      error: `존재하지 않는 프로파일: ${rawProfile}`,
      available: Object.keys(profiles),
    });
    return;
  }
  try {
    setSessionModelProfile(SESSION_STORAGE_CHANNEL, sessionId, rawProfile);
    writeJson(res, 200, {
      ok: true,
      threadKey: rawThreadKey,
      profile: rawProfile,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleSetModuleEnabled = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let dbody: Record<string, unknown>;
  try {
    dbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const name = typeof dbody.name === "string" ? dbody.name.trim() : "";
  const enabled = dbody.enabled;
  if (name === "") {
    writeJson(res, 400, { error: "name required" });
    return;
  }
  if (typeof enabled !== "boolean") {
    writeJson(res, 400, { error: "enabled(boolean) required" });
    return;
  }
  // 존재 검증(댕글링 이름 차단) — inventory 의 channel/external_plugin 카테고리(loadPlugins
  // 가 <root>/plugins/* 에서 훑는 대상과 동일 모집단)에서 이름을 찾는다.
  try {
    const inv = await collectInventory();
    const known = [...inv.channel, ...inv.external_plugin].some(
      (e) => e.name === name,
    );
    if (!known) {
      writeJson(res, 400, {
        error: `존재하지 않는 모듈: ${name}`,
        available: [...inv.channel, ...inv.external_plugin].map((e) => e.name),
      });
      return;
    }
    // ★코어는 끄기 대상이 아니다 — 거절한다(2026-08-26). 켜기는 통과시킨다(되돌리기는
    //  언제나 열려 있어야 한다). 판정은 손 목록이 아니라 manifest 선언이다.
    if (!enabled && isCoreModule(name)) {
      writeJson(res, 400, {
        ok: false,
        name,
        error:
          `'${name}' 은 코어 모듈이라 끌 수 없습니다 — 끄면 대시보드와 이 API 가 함께 ` +
          "멈추고, 다시 켤 경로도 여기 하나뿐이라 제품 안에서 되돌릴 수 없게 됩니다.",
      });
      return;
    }
    setModuleDisabled(name, !enabled);
    // ★손 목록이 아니라 **매니페스트 선언**을 읽는다 (2026-08-30, B-2). 종전엔 이 Set 과
    //  `view-providers.js` 의 사본 두 벌이었고, **둘 다 플러그인 화면엔 없어서** 그 화면은
    //  확인도 경고도 없이 대시보드를 껐다.
    const warning = isSelfReferentialModule(name) ? "critical" : undefined;
    writeJson(res, 200, {
      ok: true,
      name,
      enabled,
      requiresRestart: true,
      ...(warning !== undefined ? { warning } : {}),
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleGetModelProfiles = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  try {
    // ★설정이 0개면 **런타임이 실제로 쓰는 것**(빌트인 자동 조립)을 보여준다
    //  (2026-08-19 사용자 신고: "설치하면 기본 모델 프로파일들이 생기지가 않아 —
    //  대시보드에 비어 있는 상태"). 런타임은 원래 빌트인으로 잘 도는데 **화면만**
    //  비어 있어서 설치가 덜 된 것처럼 보였다. 같은 폴백을 2026-08-13 에 `/models`
    //  에는 넣었는데 여기와 프롬프트 인벤토리는 빠졌다 — 그래서 폴백을 소비처마다
    //  적지 않고 `resolveModelProfiles` 한 곳으로 모았다.
    const { profiles: map, builtin } = resolveModelProfiles();
    const defaultName = builtin ? BUILTIN_DEFAULT_TIER : getDefaultProfileName();
    const names = Object.keys(map);
    const rest = names.filter((n) => n !== defaultName);
    const ordered = names.includes(defaultName)
      ? [defaultName, ...rest]
      : rest;
    const profiles = ordered.map((name) => {
      const p = map[name]!;
      return {
        name,
        isDefault: name === defaultName,
        ...(p.description !== undefined ? { description: p.description } : {}),
        pool: p.pool,
        ...(p.fallback !== undefined ? { fallback: p.fallback } : {}),
        ...(p.color !== undefined ? { color: p.color } : {}),
      };
    });
    writeJson(res, 200, {
      profiles,
      count: profiles.length,
      // 화면이 "자동 조립본" 임을 말할 수 있게(설정으로 고정한 것과 구분).
      builtin,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleGetProviders = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  try {
    const providers = await collectModules();
    writeJson(res, 200, providers);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};
