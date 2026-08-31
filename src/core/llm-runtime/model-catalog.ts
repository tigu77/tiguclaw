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
import { loadModelReasoning } from "../settings.js";
import { listProviderNames, resolveProviderConn } from "./provider-registry.js";

/** provider → 최신순 모델 이름들(접두사 없음). 빈 배열 = 조회 실패/미인증. */
export interface ModelCatalog {
  fetchedAt: number;
  models: Record<string, string[]>;
  /**
   * `provider:model` → 그 모델이 **설계된 추론 강도**(백엔드가 목록에 실어 내려주는
   * `default_reasoning_level`). 2026-08-14 신설.
   *
   * ★이미 받고 있던 값을 버리고 있었다. codex `/models` 응답은 모델마다 이 필드를 주고
   *  (실측: sol=low · terra/luna/5.5=medium) 정품 CLI 는 그 값을 명시해 보낸다. 우리는
   *  아무것도 안 보내 백엔드 기본을 받았고 그건 카탈로그 기본과 달랐다 — "빠르라고 만든
   *  모델"을 고른 적 없이 무겁게 굴리고 있었다(실측: 명시 low 로 바꾸니 출력 −37%).
   *
   * 옛 캐시 파일엔 이 키가 없다 — 부재는 "모른다"이고, 모르면 아무것도 안 보낸다(종전 동작).
   */
  reasoning?: Record<string, string>;
  /**
   * 순서에 의미가 없는 provider 들 — `catalogTierModel` 이 등급을 주장하지 않는다.
   * ★**없음 = 순위 있음**으로 읽는다(옛 캐시 무회귀). 2026-08-31.
   */
  unranked?: string[];
  /**
   * `provider:model` → 컨텍스트 토큰. **벤더가 알려줄 때만** 채운다(실측: OpenRouter·Groq 는
   * 준다, google 은 안 준다). 없으면 모르는 것이고, 모르면 아무 말도 안 한다.
   */
  context?: Record<string, number>;
  /** `provider:model` → 도구 지원. **선언이 있을 때만**(부재 = 모름). */
  tools?: Record<string, boolean>;
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
    cache = {
      fetchedAt: o.fetchedAt,
      models: o.models,
      ...(o.reasoning !== null && typeof o.reasoning === "object"
        ? { reasoning: o.reasoning }
        : {}),
    };
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
  // ★**순서에 의미가 없는 목록엔 등급을 주장하지 않는다** (2026-08-31). 아래 일반 경로는
  //  *"첫 원소가 최상급"* 을 전제하는데 그건 최신순을 주는 조회에서만 참이다. 표준
  //  `/models` 를 붙이면서 실측으로 걸렸다 — 정품 openai 는 임베딩·TTS 까지 한 배열이라
  //  `tier:high` 가 `text-embedding-…` 이 될 수 있었다. 이름은 알되 등급은 모른다고 말한다
  //  (모르면 호출자가 정적 표로 강등한다 — 그게 옛 동작이다).
  if (provider !== "anthropic" && (c?.unranked ?? []).includes(provider)) return undefined;
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

/**
 * 카탈로그가 아는 모든 `provider:model` — **이름 해석용**(set_model_reasoning 이 "sol" 을
 * `codex:gpt-5.6-sol` 로 푼다). 목록을 코드에 박지 않기 위한 조회면이다.
 *
 * ★신선도(MAX_AGE_MS)를 요구하지 않는다 — `resolveReasoningEffort` 와 같은 이유다. 모델
 *  **이름**은 목록처럼 늙지 않고, 낡았다고 안 쓰면 오프라인·조회실패 상태에서 이름 해석이
 *  조용히 실패한다(그때 사용자는 "sol 로 설정해줘" 가 왜 안 되는지 알 길이 없다).
 */
export const catalogModelKeys = (): string[] => {
  ensureLoaded();
  if (cache === null) return [];
  return Object.entries(cache.models).flatMap(([provider, list]) =>
    list.map((m) => `${provider}:${m}`),
  );
};

/** anthropic `/v1/models` — 키 또는 구독 OAuth 토큰. 실패는 빈 배열(throw 0). */
const discoverAnthropic = async (): Promise<DiscoverResult> => {
  if (!claudeAuthAvailable()) return { slugs: [] };
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
  // ★anthropic 은 추론 강도 등급 개념이 없다(adaptive thinking) → reasoning 없음.
  //  "안 준 것" 과 "0" 을 구분한다 — 없으면 아무것도 안 보낸다.
  return {
    slugs: rows
      .filter((r): r is { id: string; created_at?: string } => typeof r.id === "string")
      // 응답이 이미 최신순이지만 순서에 기대지 않는다 — created_at 으로 직접 정렬.
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .map((r) => r.id),
  };
};

/** codex `<base>/models` — 구독 OAuth. 실패는 throw(호출자가 provider 별로 격리). */
const codexModelsAt = async (
  clientVersion: string,
): Promise<{ slugs: string[]; reasoning: Record<string, string> }> => {
  const auth = getAuthProvider("codex");
  if (auth === undefined) return { slugs: [], reasoning: {} };
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
  const json = (await res.json()) as {
    models?: Array<{ slug?: unknown; default_reasoning_level?: unknown }>;
  };
  const rows = Array.isArray(json.models) ? json.models : [];
  const slugs: string[] = [];
  const reasoning: Record<string, string> = {};
  for (const r of rows) {
    if (typeof r.slug !== "string" || r.slug === "") continue;
    slugs.push(r.slug);
    // ★백엔드가 말한 그대로 담는다 — 유효값 목록을 우리가 흉내 내지 않는다(모델마다 다르다:
    //  sol 은 max·ultra 까지, 5.5 는 xhigh 까지). 이상한 값이면 백엔드가 400 으로 말한다.
    if (typeof r.default_reasoning_level === "string" && r.default_reasoning_level !== "") {
      reasoning[`codex:${r.slug}`] = r.default_reasoning_level;
    }
  }
  return { slugs, reasoning };
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
const discoverCodex = async (): Promise<DiscoverResult> => {
  const ours = await codexModelsAt(CODEX_CLIENT_VERSION());
  try {
    const probe = await codexModelsAt(CODEX_PROBE_VERSION);
    const mine = new Set(ours.slugs);
    codexHiddenByVersion = probe.slugs.filter((s) => !mine.has(s));
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
 * **OpenAI 호환 `<base>/models`** — 표준 경로 하나로 provider 전부 (2026-08-31).
 *
 * ★왜 필요한가(실측): 종전엔 조회하는 provider 가 `anthropic`·`codex` **둘뿐**이었고 그
 *  둘은 **구독** 경로다. 공식 API 키 경로(`openai`·`google`·`ollama` + 사용자 정의 전부)는
 *  목록이 **0** 이라, 사용자가 벤더 사이트를 보고 모델 이름을 손으로 알아내야 했고
 *  티어(`tier:high`) 자동 선택에서도 통째로 빠졌다. `parseModelSpec` 은 `provider:model`
 *  을 요구하는데 *"어떤 provider 가 이 모델을 지원하나"* 에 답할 자리가 제품 안에 없었다.
 *
 * ★**provider 별 분기 0.** 판정은 *"이 provider 가 openai 어댑터를 쓰나"* 하나다 — 그러면
 *  OpenAI 호환을 말한다는 뜻이고 `/models` 는 그 규약의 표준이다. 새 provider 를 붙이면
 *  **저절로** 들어온다(손 목록을 늘리지 않는다).
 *  실측 200: openrouter(396) · google(54) · ollama. 정품 openai 는 baseURL 이 없어
 *  규약 기본값으로 친다.
 *
 * ★**목록 ≠ 호출 가능**이다 — google 은 `gemini-2.5-flash` 를 목록에 계속 실으면서 호출은
 *  404(*"no longer available to new users"*)로 거절한다. 그래서 이 목록은 **후보**이지
 *  보증이 아니다. 고르면 왜 안 되는지는 폴백 고지가 말한다(`index.ts` 의 `사유:`).
 */
/**
 * `/models` 행들 → `모델 → 컨텍스트 토큰`. **아는 이름만 읽고 없으면 뺀다.**
 *
 * ★필드 이름이 벤더마다 다르다(실측: OpenRouter `context_length` · Groq `context_window` ·
 *  google 은 **안 준다**). 별칭 목록은 어쩔 수 없지만 **지어내지는 않는다** — 모르는 모델은
 *  없는 채로 둔다. 추측한 컨텍스트로 경고하면 멀쩡한 모델을 못 쓰게 막는 것처럼 읽힌다.
 * ★**함수로 뽑아 둔 이유**: 조회 안에 인라인으로 두면 이 판정을 재려고 네트워크를 타야 하고,
 *  그러면 그물이 약해진다(실측: 이 추출을 통째로 지워도 스위트가 초록이었다).
 */
export const readContextLengths = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const id = typeof r["id"] === "string" ? r["id"].replace(/^models\//, "") : "";
    const n = ["context_length", "context_window"]
      .map((k) => r[k])
      .find((v): v is number => typeof v === "number" && v > 0);
    if (id !== "" && n !== undefined) out[id] = n;
  }
  return out;
};

/**
 * `/models` 행들 → `모델 → 도구 지원 여부`. **선언이 있을 때만** 담는다 (2026-08-31).
 *
 * ★삼상태다 — **지원함 / 선언했는데 없음 / 모름.** 부재를 "지원 안 함" 으로 읽으면 안 된다
 *  (실측: Groq `whisper-large-v3` 는 `supported_features: null` 이다). 모르는 건 빼 둔다.
 * ★필드 이름은 벤더마다 다르다(실측: OpenRouter `supported_parameters` · Groq
 *  `supported_features` · google 은 **안 준다**). 둘 다 문자열 배열이고 `"tools"` 가 들어
 *  있으면 지원 선언이다.
 * ★**추측하지 않는다** — 모델 이름으로 "이건 도구 되겠지" 를 판정하면 그게 곧 화이트리스트다.
 */
export const readToolSupport = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const r of rows) {
    const id = typeof r["id"] === "string" ? r["id"].replace(/^models\//, "") : "";
    const arr = ["supported_parameters", "supported_features"]
      .map((k) => r[k])
      .find((v): v is unknown[] => Array.isArray(v));
    if (id === "" || arr === undefined) continue; // 선언 없음 = 모름
    out[id] = arr.some((x) => x === "tools");
  }
  return out;
};

/**
 * `/models` 행들 → 조회 결과 **전체**. 네트워크 밖의 모든 판단이 여기 있다 (2026-08-31).
 *
 * ★**조립까지 뽑아낸 이유**: 추출 함수(`readContextLengths`·`readToolSupport`)만 뽑았더니
 *  그것들을 **결과에 싣는 줄**이 그물 밖이었다 — 실측으로 `...(tools 있으면 싣기)` 한 줄을
 *  지워도 스위트가 초록이었다. **부품은 검사되는데 이음매가 비는** 이 레포의 그 모양이다.
 *  이제 조립 결과 전체를 실행으로 잰다.
 */
export const buildCompatDiscoverResult = (
  rows: ReadonlyArray<Record<string, unknown>>,
): DiscoverResult => {
  const context = readContextLengths(rows);
  const tools = readToolSupport(rows);
  return {
    // ★표준 `/models` 는 **정렬을 약속하지 않는다** — 등급을 주장하지 않는다(아래 unranked).
    unranked: true,
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    slugs: rows
      .filter((r): r is { id: string } => typeof r["id"] === "string")
      // google 은 `models/gemini-…` 처럼 접두를 붙여 준다 — 호출할 때 쓰는 이름으로 맞춘다.
      .map((r) => (r["id"] as string).replace(/^models\//, "")),
  };
};

const discoverOpenAiCompat = async (provider: string): Promise<DiscoverResult> => {
  const conn = resolveProviderConn(provider);
  if (conn === null || conn.adapter !== "openai") return { slugs: [] };
  const base = (conn.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const key = (conn.apiKey ?? "").trim();
  const res = await fetch(`${base}/models`, {
    ...(key === "" ? {} : { headers: { authorization: `Bearer ${key}` } }),
  });
  if (!res.ok) throw new Error(`${provider} ${base}/models ${String(res.status)}`);
  const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const rows = Array.isArray(json.data) ? json.data : [];
  // ★**벤더가 알려주면 받는다** (2026-08-31). 컨텍스트 길이를 알면 잘림을 **보내기 전에**
  //  말할 수 있다. 필드 이름은 벤더마다 다르다(실측: OpenRouter `context_length` ·
  //  Groq `context_window` · google 은 **안 준다**) — 아는 이름만 읽고 없으면 침묵한다.
  //  **지어내지 않는다**: 모르는 컨텍스트를 추측하면 멀쩡한 모델을 못 쓰게 막는 것처럼 된다.
  return buildCompatDiscoverResult(rows as Array<Record<string, unknown>>);
};

/** provider 조회 결과 — 모델 목록 + (있으면) 모델별 설계 기본 추론 강도. */
interface DiscoverResult {
  slugs: string[];
  reasoning?: Record<string, string>;
  /** 모델별 컨텍스트 토큰 — 벤더가 알려줄 때만. 없으면 모르는 것이다(추측 금지). */
  context?: Record<string, number>;
  /** 모델별 도구 지원 — 벤더가 **선언했을 때만**. 부재 = 모름(≠ 지원 안 함). */
  tools?: Record<string, boolean>;
  /**
   * ★**이 목록의 순서에 의미가 없다**(2026-08-31). 표준 `/models` 는 정렬을 약속하지 않고
   *  종류도 섞여 나온다(정품 openai 는 임베딩·TTS·이미지까지 한 배열이다). 그런데
   *  `catalogTierModel` 의 일반 경로는 *"첫 원소가 최상급"* 을 전제한다 — 그건 **최신순을
   *  주는 조회**(codex)를 위해 쓰인 것이다.
   * ★없으면 순위 있음(기존 동작 보존) — 옛 캐시를 읽어도 회귀 0.
   */
  unranked?: boolean;
}

/**
 * 카탈로그 갱신 — **인증된 provider 만** 조회하고, 실패는 provider 단위로 격리한다.
 * 절대 throw 하지 않는다(시계가 이걸 부른다). 성공한 provider 만 캐시에 반영하고
 * 실패한 쪽은 **직전 값을 유지**한다(한 번 흔들렸다고 아는 것을 잃지 않는다).
 */
/**
 * 한 provider 의 추론 강도 맵을 **조회 결과로 교체**한다(제자리 변경, 바뀌었으면 true).
 *
 * ★병합만 하면 벤더가 어떤 모델의 `default_reasoning_level` 을 없애도 우리 옛 값이 영구히
 *  이긴다 — `resolveReasoningEffort` 가 신선도를 요구하지 않는 것(오프라인에서 조용히 옛
 *  동작으로 돌아가는 걸 막으려는 의도)과 겹쳐 **되돌릴 방법이 없어진다**. 조회가 성공했을
 *  때만 부르므로 "실패 시 직전 값 보존" 은 그대로다.
 *
 * ★다른 provider 의 키는 **안 건드린다** — codex 조회 성공이 anthropic 값을 지우면 안 된다.
 *
 * ★`refreshModelCatalog` 안에 두면 네트워크·인증 뒤라 검사가 못 닿는다(적대 검토 F9:
 *  이 경로 커버리지가 0이었고, 삭제 로직을 통째로 되돌려도 초록이었다). 판정만 순수
 *  함수로 꺼내 실행으로 지킨다.
 */
export const mergeReasoning = (
  target: Record<string, string>,
  provider: string,
  incoming: Record<string, string>,
): boolean => {
  let changed = false;
  const prefix = `${provider}:`;
  for (const k of Object.keys(target)) {
    if (k.startsWith(prefix) && !(k in incoming)) {
      delete target[k];
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(incoming)) {
    if (target[k] !== v) changed = true;
    target[k] = v;
  }
  return changed;
};

export const refreshModelCatalog = async (): Promise<ModelCatalog | null> => {
  ensureLoaded();
  const next: Record<string, string[]> = { ...(cache?.models ?? {}) };
  // ★reasoning 은 provider 실패 시에도 **직전 값을 잃지 않는다** — 목록과 같은 규칙
  //  ("한 번 흔들렸다고 아는 것을 잃지 않는다").
  const nextReasoning: Record<string, string> = { ...(cache?.reasoning ?? {}) };
  const nextUnranked = new Set<string>(cache?.unranked ?? []);
  const nextContext: Record<string, number> = { ...(cache?.context ?? {}) };
  const nextTools: Record<string, boolean> = { ...(cache?.tools ?? {}) };
  let changed = false;
  // ★조회 대상을 **손으로 적지 않는다** (2026-08-31). 종전엔 배열에 둘을 적어뒀고, 그래서
  //  새 provider 를 붙여도 목록이 영원히 비어 있었다([[feedback_hand_maintained_lists]]).
  //  규칙: 전용 조회가 있는 둘 + **openai 어댑터를 쓰는 provider 전부**(표준 `/models`).
  const compat = listProviderNames().filter(
    (n) => resolveProviderConn(n)?.adapter === "openai",
  );
  const jobs: Array<[string, () => Promise<DiscoverResult>]> = [
    ["anthropic", discoverAnthropic],
    ["codex", discoverCodex],
    ...compat.map(
      (n): [string, () => Promise<DiscoverResult>] => [n, () => discoverOpenAiCompat(n)],
    ),
  ];
  for (const [provider, fn] of jobs) {
    if (!providerAuthAvailable(provider)) continue;
    try {
      const res = await fn();
      const list = res.slugs;
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
      if (res.unranked === true) nextUnranked.add(provider);
      else nextUnranked.delete(provider);
      for (const [m, n] of Object.entries(res.context ?? {})) nextContext[`${provider}:${m}`] = n;
      for (const [m, t] of Object.entries(res.tools ?? {})) nextTools[`${provider}:${m}`] = t;
      // ★그 provider 의 키를 **통째로 교체**한다 (적대 검토 B1 곁가지). 병합만 하면 벤더가
      //  어떤 모델의 `default_reasoning_level` 을 없애도 우리 옛 값이 영구히 이긴다 —
      //  신선도 미요구와 겹쳐 되돌릴 방법이 없어진다. 조회가 **성공했을 때만** 교체하므로
      //  실패 시 직전 값 보존이라는 원칙은 그대로다.
      if (res.reasoning !== undefined) {
        if (mergeReasoning(nextReasoning, provider, res.reasoning)) changed = true;
      }
    } catch (e) {
      console.warn(
        `[model-catalog] ${provider} 조회 실패 — ${e instanceof Error ? e.message : String(e)} ` +
          `(직전 값 유지${next[provider] === undefined ? " 없음 → 정적 표 사용" : ""})`,
      );
    }
  }
  if (Object.keys(next).length === 0) return null;
  cache = {
    fetchedAt: Date.now(),
    models: next,
    ...(Object.keys(nextReasoning).length > 0 ? { reasoning: nextReasoning } : {}),
    ...(nextUnranked.size > 0 ? { unranked: [...nextUnranked].sort() } : {}),
    ...(Object.keys(nextContext).length > 0 ? { context: nextContext } : {}),
    ...(Object.keys(nextTools).length > 0 ? { tools: nextTools } : {}),
  };
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

/**
 * 이 모델을 **얼마나 생각하게 할 것인가** — `provider:model` → reasoning effort.
 *
 * 우선순위: `settings.json models.reasoning` 덮어쓰기 → 카탈로그가 말한 설계 기본 →
 * **없으면 undefined**(= 아무것도 안 보냄, 종전 동작).
 *
 * ★모르는 것에 추측값을 씌우지 않는다. 카탈로그가 없거나(미인증·조회 실패·옛 캐시) 그
 *  모델에 값이 없으면 종전처럼 필드를 생략한다 — 백엔드 기본으로 가는 게, 우리가 지어낸
 *  값으로 가는 것보다 낫다.
 *
 * ★anthropic 도 **이 함수를 지난다**(claude-agent-sdk.ts, 2026-08-14 22:15). 카탈로그에
 *  anthropic 기본이 없을 뿐이라, 결과적으로 "덮어쓰기가 있을 때만" 이 된다 — 손잡이는
 *  양쪽에 있고 기본값만 한쪽에 없다. (이 주석은 같은 날 12:20 에 "anthropic 은 여기 안
 *  들어온다" 였는데 열 시간 뒤 거짓이 됐다.)
 */
export const resolveReasoningEffort = (
  provider: string,
  model: string,
  cwd: string = process.cwd(),
): string | undefined => {
  const key = `${provider}:${model}`;
  const override = loadModelReasoning(cwd).get(key);
  if (override !== undefined) return override;
  ensureLoaded();
  // ★신선도(MAX_AGE_MS)를 요구하지 않는다 — 모델의 설계 강도는 목록처럼 늙는 값이 아니고,
  //  낡았다고 안 쓰면 오프라인에서 조용히 종전 동작(백엔드 기본)으로 되돌아간다.
  const v = cache?.reasoning?.[key];
  // ★값 검증을 settings 와 **같은 판정**으로 (2026-08-15, 적대 검토 B1). 종전엔
  //  `typeof o.reasoning === "object"` 만 보고 값은 무검증이라, 손편집·부분기록된 캐시의
  //  숫자·객체·null 이 그대로 새어 wire 로 갔다(`{"effort":3}` → 400 → 그 모델 전 턴 폴백).
  //  `undefined` 만 보던 가드가 `null` 을 통과시킨 것이 본질이다 — 두 자리가 같은 판단을
  //  다르게 하고 있었다.
  if (typeof v !== "string") return undefined;
  // settings 쪽(loadModelReasoning)이 trim 해서 저장하므로 **여기서도 trim** 한다 —
  // '같은 판정으로 통일' 이 절반만 참이면 두 자리는 언젠가 다시 갈린다(적대 검토 지적).
  const t = v.trim();
  return t === "" ? undefined : t;
};

/**
 * `provider:model` 의 컨텍스트 토큰 — 모르면 `undefined`.
 *
 * ★신선도를 요구하지 않는다(`catalogModelKeys` 와 같은 이유) — 컨텍스트 길이는 목록처럼
 *  늙지 않고, 낡았다고 안 쓰면 오프라인에서 경고가 조용히 사라진다.
 */
export const catalogContextTokens = (provider: string, model: string): number | undefined => {
  ensureLoaded();
  return cache?.context?.[`${provider}:${model}`];
};

/**
 * `provider:model` 이 도구를 지원하나 — **모르면 `undefined`**(≠ `false`).
 *
 * ★삼상태를 소비처까지 들고 간다. `false` 로 뭉개면 *"선언 안 한 모델"* 이 *"도구 못 쓰는
 *  모델"* 이 되어, 실제로는 되는 모델을 못 쓰게 막는 것처럼 읽힌다.
 */
export const catalogSupportsTools = (provider: string, model: string): boolean | undefined =>
  (ensureLoaded(), cache?.tools?.[`${provider}:${model}`]);

/**
 * `provider:model` → 화면이 쓸 능력 꼬리표 재료. **`/models` 렌더러에 주입한다.**
 *
 * ★**`index.ts` 에서 뽑아냈다** (2026-08-31). 조회를 부팅 파일 안 인라인 클로저로 두면
 *  그 배선을 재려고 데몬을 띄워야 하고, 그래서 **끊어도 스위트가 초록**이었다(실측).
 *  이 레포가 이미 같은 대가를 치렀다 — `/logs` 규칙을 `index.ts` 에 뒀다가 grep 검사밖에
 *  못 했고, 모듈로 뽑자 동작 검사가 변이를 5/5 잡았다
 *  ([[feedback_simple_composable_no_duplication]]).
 * ★**아무것도 모르면 `undefined`** — 삼상태를 화면까지 그대로 옮긴다(뭉개면 화면이 거짓말).
 */
export const modelCapsFor = (
  spec: string,
): { context?: number; tools?: boolean } | undefined => {
  const i = spec.indexOf(":");
  if (i < 0) return undefined;
  const provider = spec.slice(0, i);
  const model = spec.slice(i + 1);
  const context = catalogContextTokens(provider, model);
  const tools = catalogSupportsTools(provider, model);
  return context === undefined && tools === undefined ? undefined : { context, tools };
};
