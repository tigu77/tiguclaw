// src/core/plugins/data-routes.ts
/**
 * **플러그인 데이터 라우트** — 위젯이 모델을 안 거치고 값을 받아오는 길
 * (2026-08-28, 위젯 플랫폼 §E.2 · §J.4).
 *
 * 채팅 위젯은 데이터를 **첨부 안에** 들고 온다(안 바뀐다). 홈 위젯은 다르다 — 몇 분에
 * 한 번 다시 받아야 하고, 그때마다 LLM 턴을 태울 수는 없다. 그 길이 여기다.
 *
 * ★**외부는 데몬이 부른다.** 대시보드 CSP 가 `connect-src 'self'` 라 브라우저는 애초에
 *  밖으로 못 나간다(§A.5). 그래서 이 라우트는 편의가 아니라 **유일한 경로**이고, 덕분에
 *  `needs.network` 집행·로깅·차단이 한 곳에서 성립한다(`plugin-fetch.ts` 가 그대로 먹는다).
 *
 * ★**캐시가 서버에 있다.** 브라우저에 두면 탭 수만큼 외부 호출이 곱해진다 — 우리가 만드는
 *  건 *"왼쪽 모니터에 항상 띄워놓는 화면"* 이고, 무료 티어 API 와 그게 만나면 차단이
 *  기본값이 된다. 여기 두면 탭이 몇이든 TTL 당 한 번이다.
 *
 * ★**반환형이 둘이다 — 새 배관을 만들지 않는다** (2026-08-28, 지도 착수에서 드러났다).
 *  대시보드 CSP 가 `img-src 'self' data: blob:` 라 **외부 타일 URL 은 브라우저가 못 받는다.**
 *  그러니 지도 이미지도 데몬을 지나야 하는데, 첫 판의 라우트는 JSON 만 낼 수 있었다.
 *  `data:` 로 우회하는 길은 접었다 — base64 로 33% 부풀고, 매 poll 마다 다시 받고,
 *  **브라우저 캐시가 안 먹는다.** 대신 핸들러가 `{contentType, body}` 를 돌려주면 바이트로
 *  나간다. 같은 등록소·같은 캐시·같은 게이트를 쓰므로 배관이 하나 더 생기지 않는다.
 *
 * ★**실패는 캐시하지 않는다.** 대신 **동시 호출은 합친다**(in-flight 공유) — 탭 셋이 같은
 *  순간에 물어도 밖으로는 한 번만 나간다. 연속 실패의 상한은 poll 주기가 준다(분 단위).
 *  실패를 캐시하면 사용자가 새로고침해도 몇 분간 옛 실패를 보게 되는데, 그게 더 나쁘다.
 */
import { createPluginHost, type PluginHost, type PluginNeeds } from "./host.js";
import type { PluginSettingSpec } from "./settings.js";

/** 라우트 하나 — 값을 만드는 함수 + 그 값이 얼마나 신선한가. */
export interface PluginDataRoute {
  /** 이 값의 수명. 같은 질의는 이 시간 안에 다시 안 나간다. */
  readonly ttlMs: number;
  handler(
    query: Readonly<Record<string, string>>,
    host: PluginHost,
  ): Promise<unknown>;
}

export type PluginDataRoutes = Readonly<Record<string, PluginDataRoute>>;

/**
 * 핸들러가 **바이트**를 낼 때의 반환형(지도 타일 등). 이게 아니면 JSON 으로 나간다.
 *
 * ★`Uint8Array` 다 — `Buffer` 는 node 전용이고, 이 표면은 언젠가 IPC 를 건너간다.
 */
export interface PluginMedia {
  readonly contentType: string;
  readonly body: Uint8Array;
}

/**
 * 미디어 한 건의 상한.
 *
 * ★캐시가 메모리에 사는데 바이트는 JSON 과 자릿수가 다르다 — 상한이 없으면 플러그인 하나가
 *  데몬 메모리를 먹는다. 타일 한 장이 보통 20~50KB 라 2MB 는 넉넉하고, 넘는 건 애초에
 *  위젯에 실을 물건이 아니다([[project_hotpath_bound_preserve_record]] — 핫 워킹셋만 바운드).
 */
export const PLUGIN_MEDIA_MAX_BYTES = 2 * 1024 * 1024;

export const isPluginMedia = (v: unknown): v is PluginMedia =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as PluginMedia).contentType === "string" &&
  (v as PluginMedia).body instanceof Uint8Array;

interface Entry {
  readonly needs: PluginNeeds;
  readonly routes: PluginDataRoutes;
  readonly settingsSpec: readonly PluginSettingSpec[];
}

const REGISTRY = new Map<string, Entry>();

/**
 * 캐시 — `plugin/route?정렬된질의` → 값.
 *
 * ★**바운드**다([[project_hotpath_bound_preserve_record]] — 핫 워킹셋만 묶는다).
 *  위젯 수는 캡이 있지만 질의는 아니다(도시 이름은 무한하다). 상한을 안 두면
 *  상시 도는 프로세스에서 이건 그냥 누수다.
 */
const CACHE = new Map<string, { at: number; value: unknown }>();
const INFLIGHT = new Map<string, Promise<unknown>>();
const CACHE_MAX = 64;

/** 라우트를 낸다. 같은 플러그인 재등록은 **덮어쓴다**(핫 리로드가 그 길로 온다). */
export const registerPluginDataRoutes = (
  plugin: string,
  needs: PluginNeeds,
  routes: PluginDataRoutes,
  settingsSpec: readonly PluginSettingSpec[] = [],
): void => {
  REGISTRY.set(plugin, { needs, routes, settingsSpec });
};

/**
 * 등록 해제 — 플러그인을 끄거나 지울 때.
 * ★캐시도 같이 버린다. 안 그러면 꺼진 플러그인의 값이 TTL 동안 계속 나간다.
 */
export const unregisterPluginDataRoutes = (plugin: string): boolean => {
  for (const key of [...CACHE.keys()]) {
    if (key.startsWith(`${plugin}/`)) CACHE.delete(key);
  }
  return REGISTRY.delete(plugin);
};

/** 진단·검사용 — 지금 어떤 라우트가 서 있나. */
export const listPluginDataRoutes = (): string[] => {
  const out: string[] = [];
  for (const [plugin, entry] of REGISTRY) {
    for (const route of Object.keys(entry.routes)) out.push(`${plugin}/${route}`);
  }
  return out.sort();
};

/** 검사용 — 캐시를 비운다(회귀가 TTL 을 재현할 때). */
export const clearPluginDataCache = (): void => {
  CACHE.clear();
  INFLIGHT.clear();
};

const cacheKey = (
  plugin: string,
  route: string,
  query: Readonly<Record<string, string>>,
): string => {
  const parts = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`);
  return `${plugin}/${route}?${parts.join("&")}`;
};

export type PluginDataResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly cached: boolean;
      /** 이 값의 수명 — 전송부가 `Cache-Control` 을 정하는 근거. */
      readonly ttlMs: number;
    }
  | { readonly ok: false; readonly status: 404 | 502; readonly error: string };

/**
 * 라우트를 부른다 — 캐시 → in-flight 합류 → 실제 호출 순.
 *
 * ★모르는 플러그인·라우트는 **404** 다. 502(외부 실패)와 가르는 이유는 진단면이다:
 *  전자는 우리 배선 문제이고 후자는 남의 서버 문제라, 같은 코드로 뭉치면 로그만 보고
 *  어느 쪽인지 알 수 없다([[feedback_logs_must_stand_alone]]).
 */
export const callPluginDataRoute = async (
  plugin: string,
  route: string,
  query: Readonly<Record<string, string>>,
): Promise<PluginDataResult> => {
  const entry = REGISTRY.get(plugin);
  if (entry === undefined) {
    return { ok: false, status: 404, error: `plugin "${plugin}" 에 데이터 라우트가 없습니다.` };
  }
  const def = Object.prototype.hasOwnProperty.call(entry.routes, route)
    ? entry.routes[route]
    : undefined;
  if (def === undefined) {
    return { ok: false, status: 404, error: `route "${plugin}/${route}" 를 모릅니다.` };
  }
  const key = cacheKey(plugin, route, query);
  const hit = CACHE.get(key);
  if (hit !== undefined && Date.now() - hit.at < def.ttlMs) {
    return { ok: true, value: hit.value, cached: true, ttlMs: def.ttlMs };
  }
  const sharing = INFLIGHT.get(key);
  if (sharing !== undefined) {
    try {
      return { ok: true, value: await sharing, cached: true, ttlMs: def.ttlMs };
    } catch (e) {
      return { ok: false, status: 502, error: e instanceof Error ? e.message : String(e) };
    }
  }
  // ★호스트는 **턴 없이** 만든다 — 이 호출엔 대화 좌표가 없다(사람이 화면을 보는 중이지
  //  모델이 도구를 부르는 중이 아니다). `postCard` 는 그래서 여기선 못 쓴다(경고를 남기고
  //  false 를 준다 — 이미 그렇게 동작한다).
  const host = createPluginHost(plugin, entry.needs, undefined, entry.settingsSpec);
  const p = def.handler(query, host);
  INFLIGHT.set(key, p);
  try {
    const value = await p;
    // ★상한을 **쓸 때** 막는다 — 읽을 때 자르면 조용한 반쪽이 된다(§C.1.1 과 같은 규칙).
    if (isPluginMedia(value) && value.body.byteLength > PLUGIN_MEDIA_MAX_BYTES) {
      throw new Error(
        `미디어가 상한을 넘었습니다: ${value.body.byteLength}B > ${PLUGIN_MEDIA_MAX_BYTES}B`,
      );
    }
    if (CACHE.size >= CACHE_MAX) {
      const oldest = CACHE.keys().next();
      if (!oldest.done) CACHE.delete(oldest.value);
    }
    CACHE.set(key, { at: Date.now(), value });
    return { ok: true, value, cached: false, ttlMs: def.ttlMs };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[plugin-data] ${plugin}/${route} 실패: ${error}`);
    return { ok: false, status: 502, error };
  } finally {
    INFLIGHT.delete(key);
  }
};
