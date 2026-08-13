/**
 * **모델 카탈로그 — 백엔드에게 직접 물어 최신 모델을 안다** (2026-08-13).
 *
 * 사용자: "최신 자동 추정이 가능한지가 중요한 부분이야" · "구독 어댑터 사용에 대한
 * 편의성 기능 같은 거지".
 *
 * ★왜 필요한가: 빌트인 표(`builtin-profiles.ts`)는 손으로 적은 모델 이름이라 세대가 바뀌면
 *  늙는다 — 실제로 `gpt-5.5` 로 굳어 있는 동안 실사용은 `gpt-5.6-sol`(119턴)이었고,
 *  claude 쪽은 `opus-4-8` 로 두 세대 뒤처져 있었다. **구독 사용자는 그걸 알 방법이 없다**
 *  (API 키 사용자는 콘솔·청구서가 있지만 구독은 없고, codex 는 비공식 endpoint 라 더욱).
 *
 * ★두 백엔드 모두 실물 목록을 준다(2026-08-13 실측):
 *   - anthropic: `GET /v1/models` — **구독 OAuth 토큰으로도 200**
 *     (`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`). `created_at` 최신순.
 *   - codex:     `GET <codex>/models?client_version=…` — `models[].slug` 최신순.
 *
 * ★비용은 안 움직인다: 자동 최신은 **패밀리 안에서만** 고른다(opus→opus, sonnet→sonnet).
 *  등급이 곧 비용이고 그 선택은 티어 표가 고정하므로, 조용히 비싼 등급으로 올라가지 않는다.
 *
 * ★핫 경로는 동기다. `resolveModelSpecs` 는 동기 계약이라(settings.ts 헤더 참조) 여기서
 *  네트워크를 탈 수 없다. 그래서 **캐시를 읽는 동기 함수**와 **갱신하는 비동기 함수**를
 *  나눈다. 갱신은 이미 있는 `self-maintenance` 시계(부팅 즉시 + 매시)가 부른다 — 새 타이머 0.
 *  캐시가 비었거나 못 읽으면 정적 표로 강등되므로 **네트워크가 죽어도 동작이 안 바뀐다.**
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPaths } from "../paths.js";
import { claudeAuthAvailable, providerAuthAvailable } from "./provider-availability.js";
import { getAuthProvider } from "./auth-registry.js";
import { CODEX_BASE_URL } from "./adapters/openai-codex-oauth-history.js";

/** provider → 최신순 모델 이름들(접두사 없음). 빈 배열 = 조회 실패/미인증. */
export interface ModelCatalog {
  fetchedAt: number;
  models: Record<string, string[]>;
}

/**
 * ★codex 목록은 `client_version` 으로 **게이팅**된다(실측): 0.104 → gpt-5.4 까지,
 *  0.140 → gpt-5.5 까지, 0.200+ → gpt-5.6 계열까지. 즉 이 숫자가 낮으면 목록이 낡는다.
 *
 * ★정직하게 적어둔다: 이건 **우리가 호환을 주장하는 클라이언트 버전**이지 실제로 그
 *  버전의 CLI 를 흉내 낸 게 아니다. 낮으면 낡은 목록, 높으면 과장 — 그래서 env 로 덮을
 *  수 있게 두고(`CODEX_CLIENT_VERSION`), 이 숫자가 늙어도 실패가 조용하지 않게
 *  `catalogNote()` 로 무엇을 받았는지 드러낸다.
 */
const CODEX_CLIENT_VERSION = (): string =>
  (process.env.CODEX_CLIENT_VERSION ?? "").trim() || "0.200.0";

/**
 * **낡았는지 재기 위한 탐침 버전** — 이 값으로 받은 건 **쓰지 않는다.** 오직 "우리가 주장하는
 * 버전 때문에 못 보고 있는 모델이 있나" 를 알기 위해서만 부른다.
 *
 * ★왜 필요한가 (사용자 제안 2026-08-13: "릴리즈 할 때 한 번씩 최신으로 업데이트"):
 *  그 방향은 맞다 — 우리가 주장하는 버전은 우리가 정하는 게 맞다. 문제는 **잊었을 때
 *  아무 신호가 없다**는 것이다. 목록이 짧게 올 뿐 에러도 경고도 없고, 응답 어디에도
 *  "당신 버전이 낡았다" 는 힌트가 없다(실측: 본문 최상위 키는 `models` 하나뿐).
 *  이 레포가 반복해서 데인 부류가 정확히 그거다 — **조용히 늙는 손 관리 값**.
 *  그래서 숫자는 손으로 두되, **낡음은 기계가 말하게** 한다.
 */
const CODEX_PROBE_VERSION = "9.9.9";
/** 탐침 결과 — 우리 버전에선 안 보이는 모델 slug 들. 비어 있으면 최신이라는 뜻. */
let codexHiddenByVersion: string[] = [];

const CATALOG_FILE = (): string => path.join(getPaths().home, "model-catalog.json");
/** 이보다 오래된 캐시는 안 쓴다 — 늙은 값을 최신인 척하지 않는다(정적 표로 강등). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let cache: ModelCatalog | null = null;
let loadedFromDisk = false;

/** 디스크 캐시 1회 지연 로드 — 부팅 직후(첫 갱신 전)에도 지난 회차 값을 쓴다. */
const ensureLoaded = (): void => {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const p = CATALOG_FILE();
    if (!existsSync(p)) return;
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return;
    const o = parsed as ModelCatalog;
    if (typeof o.fetchedAt !== "number" || o.models === null || typeof o.models !== "object") {
      return;
    }
    cache = { fetchedAt: o.fetchedAt, models: o.models };
  } catch {
    // 캐시는 편의다 — 못 읽으면 정적 표로 간다(throw 0).
  }
};

const fresh = (): ModelCatalog | null => {
  ensureLoaded();
  if (cache === null) return null;
  return Date.now() - cache.fetchedAt <= MAX_AGE_MS ? cache : null;
};

/** 지금 캐시 상태 한 줄 — `/models` 등이 "어디서 온 값인지" 말할 때 쓴다. */
export const catalogNote = (): string | null => {
  const c = fresh();
  if (c === null) return null;
  const parts = Object.entries(c.models)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}:${v[0]}`);
  if (parts.length === 0) return null;
  const ageH = Math.round((Date.now() - c.fetchedAt) / 3_600_000);
  const stale =
    codexHiddenByVersion.length > 0
      ? ` · ⚠️ codex client_version 이 낡아 ${codexHiddenByVersion.length}개가 안 보입니다` +
        `(${codexHiddenByVersion.slice(0, 3).join(", ")}…)`
      : "";
  return `백엔드 조회값(${ageH}시간 전) — ${parts.join(" · ")}${stale}`;
};

/**
 * 카탈로그에서 provider·등급에 맞는 모델 하나. 없으면 undefined(호출자가 정적 표로 강등).
 *
 * ★anthropic 은 **패밀리 접두 + 최신순**으로 고른다 — 목록 첫 항목을 그냥 쓰면 다른 등급
 *  (예: fable)이 끼어든다. 손으로 관리하는 건 `opus`/`sonnet`/`haiku` 라는 **패밀리 이름**
 *  뿐이고, 그건 버전과 달리 안 늙는다.
 *
 * ★codex 는 사정이 다르다: `sol`·`terra`·`luna` 는 등급이 아니라 **형제**라서 high/mid 를
 *  가를 규칙이 없다. 그래서 `-mini`(명백한 소형)만 low 로 집고 나머지는 최신 하나를 공유한다.
 *  모르는 것을 아는 척 가르지 않는다.
 */
export const catalogTierModel = (
  provider: string,
  tier: "high" | "mid" | "low",
): string | undefined => {
  const c = fresh();
  const raw = c?.models[provider];
  if (raw === undefined || raw.length === 0) return undefined;
  // ★특수 목적 모델은 **선택**에서 뺀다 — 조회에서 빼면 캐시가 백엔드가 말한 것과
  //  달라진다(레코드는 보존, 의견은 선택 시점에). 조회 쪽에서 걸렀더니 디스크 캐시엔
  //  들어갈 수 있는 값이 선택을 통과해 `codex-auto-review` 가 high 로 뽑혔다(회귀가 잡음).
  const list = raw.filter((m) => !m.startsWith("codex-auto-"));
  if (list.length === 0) return undefined;
  if (provider === "anthropic") {
    const family = tier === "high" ? "claude-opus" : tier === "mid" ? "claude-sonnet" : "claude-haiku";
    return list.find((m) => m.startsWith(family));
  }
  if (tier === "low") {
    const mini = list.find((m) => m.includes("-mini"));
    if (mini !== undefined) return mini;
  }
  return list[0];
};

/** anthropic `/v1/models` — 키 또는 구독 OAuth 토큰. 실패는 빈 배열(throw 0). */
const discoverAnthropic = async (): Promise<string[]> => {
  if (!claudeAuthAvailable()) return [];
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const oauth = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (key !== "") headers["x-api-key"] = key;
  else {
    headers.authorization = `Bearer ${oauth}`;
    // 구독 토큰 경로는 이 beta 헤더가 있어야 열린다(실측).
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers });
  if (!res.ok) throw new Error(`anthropic /v1/models ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: unknown; created_at?: unknown }> };
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows
    .filter((r): r is { id: string; created_at?: string } => typeof r.id === "string")
    // 응답이 이미 최신순이지만 순서에 기대지 않는다 — created_at 으로 직접 정렬.
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .map((r) => r.id);
};

/** codex `<base>/models` — 구독 OAuth. 실패는 throw(호출자가 provider 별로 격리). */
const codexModelsAt = async (clientVersion: string): Promise<string[]> => {
  const auth = getAuthProvider("codex");
  if (auth === undefined) return [];
  const token = await auth.getAccessToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    originator: "codex_cli_rs",
  };
  // account id 는 JWT 안에 있다 — 어댑터가 /responses 에 싣는 것과 같은 값.
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as Record<string, { chatgpt_account_id?: string }>;
    const acct = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof acct === "string" && acct !== "") headers["chatgpt-account-id"] = acct;
  } catch {
    // account id 없이도 대개 통과한다 — 실패하면 아래 status 로 드러난다.
  }
  const url = `${CODEX_BASE_URL}/models?client_version=${encodeURIComponent(clientVersion)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`codex /models ${res.status}`);
  const json = (await res.json()) as { models?: Array<{ slug?: unknown }> };
  const rows = Array.isArray(json.models) ? json.models : [];
  return rows
    .map((r) => (typeof r.slug === "string" ? r.slug : ""))
    .filter((s) => s !== "");
  // ★여기서 거르지 않는다 — 캐시는 백엔드가 말한 그대로 둔다(레코드 보존).
  //  등급 후보에서 빼는 판단은 `catalogTierModel`(선택) 몫이다.
};

/**
 * 우리 버전으로 받고, **탐침 버전으로 한 번 더 받아 차이를 기록**한다.
 * 반환은 언제나 **우리 버전의 목록** — 탐침 결과를 쓰지는 않는다(주장하지 않은 것을
 * 쓰면 안 된다). 차이는 `codexHiddenByVersion` 에 남아 로그·`/models` 로 드러난다.
 *
 * 탐침이 실패하면 조용히 넘어간다 — 감지 못 한 것이지 조회가 깨진 게 아니다.
 */
const discoverCodex = async (): Promise<string[]> => {
  const ours = await codexModelsAt(CODEX_CLIENT_VERSION());
  try {
    const probe = await codexModelsAt(CODEX_PROBE_VERSION);
    const mine = new Set(ours);
    codexHiddenByVersion = probe.filter((s) => !mine.has(s));
    if (codexHiddenByVersion.length > 0) {
      console.warn(
        `[model-catalog] ⚠️ codex client_version=${CODEX_CLIENT_VERSION()} 이 낡았습니다 — ` +
          `이 버전에선 안 보이는 모델 ${codexHiddenByVersion.length}개: ` +
          `${codexHiddenByVersion.join(", ")}. ` +
          `릴리스 때 CODEX_CLIENT_VERSION 을 올리세요(env 로도 즉시 덮을 수 있습니다).`,
      );
    }
  } catch {
    // 탐침 실패는 무해 — 본 조회는 위에서 이미 성공했다.
  }
  return ours;
};

/**
 * 카탈로그 갱신 — **인증된 provider 만** 조회하고, 실패는 provider 단위로 격리한다.
 * 절대 throw 하지 않는다(시계가 이걸 부른다). 성공한 provider 만 캐시에 반영하고
 * 실패한 쪽은 **직전 값을 유지**한다(한 번 흔들렸다고 아는 것을 잃지 않는다).
 */
export const refreshModelCatalog = async (): Promise<ModelCatalog | null> => {
  ensureLoaded();
  const next: Record<string, string[]> = { ...(cache?.models ?? {}) };
  let changed = false;
  const jobs: Array<[string, () => Promise<string[]>]> = [
    ["anthropic", discoverAnthropic],
    ["codex", discoverCodex],
  ];
  for (const [provider, fn] of jobs) {
    if (!providerAuthAvailable(provider)) continue;
    try {
      const list = await fn();
      if (list.length === 0) continue;
      const before = (next[provider] ?? []).join(",");
      if (before !== list.join(",")) {
        console.log(
          `[model-catalog] ${provider}: ${list.length}개 — 최신 ${list[0]}` +
            (before === "" ? " (첫 조회)" : ` (이전 최신 ${before.split(",")[0]})`),
        );
        changed = true;
      }
      next[provider] = list;
    } catch (e) {
      console.warn(
        `[model-catalog] ${provider} 조회 실패 — ${e instanceof Error ? e.message : String(e)} ` +
          `(직전 값 유지${next[provider] === undefined ? " 없음 → 정적 표 사용" : ""})`,
      );
    }
  }
  if (Object.keys(next).length === 0) return null;
  cache = { fetchedAt: Date.now(), models: next };
  if (changed || !existsSync(CATALOG_FILE())) {
    try {
      writeFileSync(CATALOG_FILE(), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    } catch (e) {
      console.warn(
        `[model-catalog] 캐시 저장 실패 — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return cache;
};

/** 테스트용 — 탐침 결과를 직접 세운다(네트워크 없이 "낡으면 말한다" 를 실행으로 확인). */
export const __setCodexHiddenForTest = (slugs: string[]): void => {
  codexHiddenByVersion = [...slugs];
};

/** 테스트용 — 캐시를 직접 세운다(디스크·네트워크 없이 판정 경로를 실행하기 위해). */
export const __setCatalogForTest = (c: ModelCatalog | null): void => {
  cache = c;
  loadedFromDisk = true;
};
