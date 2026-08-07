// src/scripts/init.ts
/**
 * tiguclaw init — 자가호스트 설치 마법사 (배포 계획서 Phase 1).
 *
 * 새 사용자가 대화형으로 LLM provider·텔레그램·토큰을 설정해 `.env` 를 생성한다.
 * 빌트인 모듈만 사용 (새 의존성 0):
 *   - node:readline/promises — 대화형 입력
 *   - node:crypto           — HTTP_BRIDGE_TOKEN / 검증용 토큰 생성
 *   - node:fs               — `.env` 작성
 *
 * ★ 안전장치: 기존 `.env` 는 명시적 동의(overwrite/y) 없이는 절대 덮어쓰지 않는다.
 *   라이브 데몬의 실 토큰이 들어있을 수 있으므로 기본 동작 = 중단.
 */
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ModelProfile } from "../core/settings.js";

// 설정(.env)은 **런타임 홈**에 둔다(공개 레포 checkout 무오염, 2026-07-09). 홈 =
// TIGUCLAW_HOME env(있으면) / 기본 ~/.tiguclaw — load-env.ts·daemon.ts 와 동일 규칙.
const HOME_DIR =
  process.env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
const ENV_PATH = path.join(HOME_DIR, ".env");
// settings.json — 구조화 비-시크릿 노브(모델 프로파일 등, ADR model-profiles D5). .env(시크릿)
// 와 별개 파일. init 이 seed 프로파일을 여기 기록(hooks 등 기존 키는 비파괴 병합).
const SETTINGS_PATH = path.join(HOME_DIR, "settings.json");

type Provider = "anthropic" | "claude-sub" | "openai" | "codex";

interface Answers {
  provider: Provider;
  anthropicKey: string;
  claudeOauthToken: string;
  openaiKey: string;
  regionAModels: string;
  tierHigh: string;
  tierMid: string;
  tierLow: string;
  telegramToken: string;
  telegramUserIds: string;
  httpBridgeToken: string;
}

// sub-agent 등급(티어) 기본값 — 선택한 provider 를 따른다. codex/openai 로 설치했는데
// tier 가 anthropic 을 가리키면(과거 하드코딩) 그 provider 키가 없어 서브에이전트가 실패했다.
// (런타임 폴백 안전망이 있어도 근본은 tier 를 provider 에 맞추는 것.) anthropic/claude-sub 는
// opus/sonnet/haiku 스프레드, openai/codex 는 알려진 기본 모델(사용자가 .env 로 세분화 가능).
const TIER_DEFAULTS: Record<Provider, { high: string; mid: string; low: string }> = {
  anthropic: {
    high: "anthropic:claude-opus-4-8",
    mid: "anthropic:claude-sonnet-4-6",
    low: "anthropic:claude-haiku-4-5",
  },
  "claude-sub": {
    high: "anthropic:claude-opus-4-8",
    mid: "anthropic:claude-sonnet-4-6",
    low: "anthropic:claude-haiku-4-5",
  },
  openai: { high: "openai:gpt-5.5", mid: "openai:gpt-5.5", low: "openai:gpt-5.5" },
  codex: { high: "codex:gpt-5.5", mid: "codex:gpt-5.5", low: "codex:gpt-5.5" },
};

/** 콤마 문자열 → provider:model 배열 (빈/공백 제거). init 값은 보통 단일이나 방어적. */
const toPool = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * seed 모델 프로파일 (ADR model-profiles 잔여 — TIER_DEFAULTS 2026-07-08 을 프로파일로 승격).
 *  - default = 메인 턴 암묵 풀(REGION_A_MODELS 대응, 코어 예약 이름).
 *  - high/mid/low = 서브에이전트/워커 등급(MODEL_TIER_* 대응) → 구조적 실패 시 default 로 폴백.
 * 값은 선택 provider(TIER_DEFAULTS + regionAModels) 기준 — 사용자가 settings.json 으로 세분화.
 * (nano 는 시드하지 않는다 — 사용자 요청 2026-07-18. 필요하면 사용자가 직접 추가.)
 */
const buildSeedProfiles = (a: Answers): Record<string, ModelProfile> => ({
  default: {
    description: "기본 마스터 모델 풀 (메인 턴)",
    pool: toPool(a.regionAModels),
  },
  high: {
    description: "설계·분석 등 고난도 작업",
    pool: toPool(a.tierHigh),
    fallback: "default",
  },
  mid: {
    description: "일반 작업",
    pool: toPool(a.tierMid),
    fallback: "default",
  },
  low: {
    description: "단순·대량 작업",
    pool: toPool(a.tierLow),
    fallback: "default",
  },
});

/**
 * seed 프로파일을 settings.json 에 쓴다. **★기존에 프로파일이 하나라도 있으면 시드 스킵**
 * (사용자 요청 2026-07-18 — 사용자 설정을 존중, 없는 이름 추가조차 안 함). 프로파일이
 * 0개(부재/빈 객체)일 때만 seed 를 통째로 깐다. 다른 키(hooks·models.default 등)는 보존.
 * 파싱 실패 시 새 객체로 안전 강등(throw 0).
 */
const seedModelProfiles = (profiles: Record<string, ModelProfile>): void => {
  let root: Record<string, unknown> = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      // 파싱 실패 — 기존 내용 복구 불가. 새 객체로 진행(비-시크릿이라 손실 위험 낮음).
    }
  }
  const models =
    root.models !== null && typeof root.models === "object"
      ? (root.models as { profiles?: Record<string, unknown> })
      : {};
  const existing = models.profiles;
  const existingCount =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? Object.keys(existing).length
      : 0;
  // ★기존 프로파일이 하나라도 있으면 시드 스킵 — 사용자 설정 존중.
  if (existingCount > 0) return;
  models.profiles = { ...profiles };
  root.models = models;
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(root, null, 2)}\n`, {
    encoding: "utf8",
  });
};

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = async (prompt: string): Promise<string> =>
  (await rl.question(prompt)).trim();

/** 빈 값이면 안내문구로 재질문. */
const askRequired = async (prompt: string, retryHint: string): Promise<string> => {
  for (;;) {
    const v = await ask(prompt);
    if (v.length > 0) return v;
    console.log(`  ⚠️  ${retryHint}`);
  }
};

const askProvider = async (): Promise<Provider> => {
  console.log("");
  console.log("[1/4] LLM provider 선택 — 가진 것 하나만 고르세요.");
  console.log("  1) anthropic  — Anthropic API 키 (가장 쉬움, 토큰 종량)");
  console.log("  2) claude-sub — Claude 구독 OAuth (`claude setup-token`, 키 입력 없이 토큰)");
  console.log("  3) openai     — OpenAI API 키 (토큰 종량)");
  console.log("  4) codex      — ChatGPT 구독 OAuth (키 입력 없음, 설치 후 발급)");
  for (;;) {
    const v = await ask("  선택 [1/2/3/4] (기본 1): ");
    if (v === "" || v === "1" || v.toLowerCase() === "anthropic") return "anthropic";
    if (v === "2" || v.toLowerCase() === "claude-sub" || v.toLowerCase() === "claude")
      return "claude-sub";
    if (v === "3" || v.toLowerCase() === "openai") return "openai";
    if (v === "4" || v.toLowerCase() === "codex") return "codex";
    console.log("  ⚠️  1, 2, 3, 4 중 하나를 입력하세요.");
  }
};

const collectProviderConfig = async (
  provider: Provider,
): Promise<
  Pick<Answers, "anthropicKey" | "claudeOauthToken" | "openaiKey" | "regionAModels">
> => {
  if (provider === "anthropic") {
    console.log("");
    console.log("  → Anthropic 콘솔(console.anthropic.com)에서 API 키를 발급하세요.");
    const anthropicKey = await askRequired(
      "  ANTHROPIC_API_KEY (sk-ant-...): ",
      "키는 비워둘 수 없습니다. 발급 후 붙여넣으세요.",
    );
    return {
      anthropicKey,
      claudeOauthToken: "",
      openaiKey: "",
      regionAModels: "anthropic:claude-sonnet-4-6",
    };
  }
  if (provider === "claude-sub") {
    console.log("");
    console.log("  → Claude 구독(Pro/Max)으로 인증합니다 — 키 대신 OAuth 토큰을 씁니다.");
    console.log("     Claude Code CLI 에서 `claude setup-token` 실행 → 브라우저 로그인 →");
    console.log("     발급된 토큰을 복사해 아래 붙여넣으세요.");
    const claudeOauthToken = await askRequired(
      "  CLAUDE_CODE_OAUTH_TOKEN: ",
      "토큰은 비워둘 수 없습니다. `claude setup-token` 으로 발급 후 붙여넣으세요.",
    );
    return {
      anthropicKey: "",
      claudeOauthToken,
      openaiKey: "",
      regionAModels: "anthropic:claude-sonnet-4-6",
    };
  }
  if (provider === "openai") {
    console.log("");
    console.log("  → OpenAI 플랫폼(platform.openai.com)에서 API 키를 발급하세요.");
    const openaiKey = await askRequired(
      "  OPENAI_API_KEY (sk-...): ",
      "키는 비워둘 수 없습니다. 발급 후 붙여넣으세요.",
    );
    console.log("  ℹ️  REGION_A_MODELS=openai:gpt-5.5 로 설정합니다.");
    console.log("     모델 ID가 안 맞으면 나중에 .env 의 REGION_A_MODELS 를 편집하세요.");
    return {
      anthropicKey: "",
      claudeOauthToken: "",
      openaiKey,
      regionAModels: "openai:gpt-5.5",
    };
  }
  // codex
  console.log("");
  console.log("  → codex 는 ChatGPT 구독 OAuth 를 사용합니다. 여기서 키 입력은 없습니다.");
  console.log("  ℹ️  REGION_A_MODELS=codex:gpt-5.5 로 설정합니다.");
  console.log("     설치 후 반드시 `npm run codex-auth` 로 OAuth 토큰을 발급하세요.");
  return {
    anthropicKey: "",
    claudeOauthToken: "",
    openaiKey: "",
    regionAModels: "codex:gpt-5.5",
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// 텔레그램 Bot API 호출 (fetch, 새 의존성 0).
const telegramApi = async (
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: any; description?: string }> => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  return (await res.json()) as {
    ok: boolean;
    result?: any;
    description?: string;
  };
};

/**
 * 봇 토큰 + 사용자 메시지 1번 → from.id 자동 감지 (getUpdates long-poll).
 * 봇은 먼저 DM 못 하는 텔레그램 제약상 "메시지 1번"이 유일한 상호작용.
 * 성공 {id,name} / 실패·시간초과 null(호출자가 수동 입력 폴백).
 */
const detectTelegramUserId = async (
  token: string,
): Promise<{ id: string; name: string } | null> => {
  try {
    const me = await telegramApi(token, "getMe");
    if (!me.ok || me.result === undefined) {
      console.log("  ⚠️  봇 토큰이 유효하지 않습니다(getMe 실패). 수동 입력으로 진행합니다.");
      return null;
    }
    console.log(`  ✅ 봇 확인: @${me.result.username}`);
    // webhook 설정 시 getUpdates 가 막히므로 해제(대기 업데이트는 보존).
    await telegramApi(token, "deleteWebhook", { drop_pending_updates: false });
    console.log("");
    console.log("  → 지금 텔레그램에서 이 봇에게 아무 메시지나 보내세요 (최대 2분 대기)…");
    const deadline = Date.now() + 120_000;
    let offset: number | undefined;
    while (Date.now() < deadline) {
      const upd = await telegramApi(token, "getUpdates", {
        timeout: 10,
        ...(offset !== undefined ? { offset } : {}),
      });
      if (upd.ok && Array.isArray(upd.result)) {
        for (const u of upd.result) {
          offset = (u.update_id as number) + 1;
          const from = u.message?.from;
          if (from !== undefined && from.is_bot !== true) {
            const name =
              [from.first_name, from.last_name].filter(Boolean).join(" ") ||
              from.username ||
              "?";
            return { id: String(from.id), name };
          }
        }
      }
      await sleep(500);
    }
    console.log("  ⚠️  2분 내 메시지를 못 받았습니다. 수동 입력으로 진행합니다.");
    return null;
  } catch (e) {
    console.log(
      `  ⚠️  자동 감지 오류: ${e instanceof Error ? e.message : String(e)} — 수동 입력으로 진행합니다.`,
    );
    return null;
  }
};

const collectTelegram = async (): Promise<
  Pick<Answers, "telegramToken" | "telegramUserIds">
> => {
  console.log("");
  console.log("[3/4] 텔레그램 (선택) — CLI 만 쓸 거면 건너뛸 수 있습니다.");
  const skip = await ask("  텔레그램을 설정할까요? [y/N]: ");
  if (skip.toLowerCase() !== "y" && skip.toLowerCase() !== "yes") {
    console.log("  → 텔레그램 건너뜀. (나중에 .env 에 TELEGRAM_BOT_TOKEN 추가 가능)");
    return { telegramToken: "", telegramUserIds: "" };
  }

  console.log("  → @BotFather 에서 /newbot → 봇 생성 후 토큰을 복사하세요.");
  const telegramToken = await askRequired(
    "  TELEGRAM_BOT_TOKEN: ",
    "봇 토큰은 비워둘 수 없습니다 (텔레그램을 설정하기로 선택함).",
  );

  console.log("");
  console.log("  소유자 user id — 봇 토큰으로 자동 감지 가능(봇에게 메시지 1번 보내면 됨).");
  const auto = await ask("  자동 감지할까요? [Y/n]: ");
  let telegramUserIds = "";
  if (auto.toLowerCase() !== "n" && auto.toLowerCase() !== "no") {
    const detected = await detectTelegramUserId(telegramToken);
    if (detected !== null) {
      console.log(`  → 감지됨: ${detected.id} (${detected.name})`);
      const ok = await ask("  이 ID 를 소유자로 설정할까요? [Y/n]: ");
      if (ok.toLowerCase() !== "n" && ok.toLowerCase() !== "no") {
        telegramUserIds = detected.id;
      }
    }
  }
  if (telegramUserIds.length === 0) {
    console.log("");
    console.log("  → 수동: @userinfobot 에게 메시지를 보내 내 user id 를 확인 후 입력.");
    console.log("    (여러 명 허용 시 콤마로: 111,222)");
    telegramUserIds = await ask("  TELEGRAM_ALLOWED_USER_IDS: ");
  }
  if (telegramUserIds.length === 0) {
    console.log("");
    console.log("  ⚠️⚠️  경고: allowlist 가 비어 있습니다.");
    console.log("  ⚠️    봇이 잠겨 어떤 메시지도 처리하지 않습니다 (소유자 식별 불가 = 전면 차단).");
    console.log("  ⚠️    나중에 .env 의 TELEGRAM_ALLOWED_USER_IDS 를 반드시 채우세요.");
  }
  console.log("");
  console.log("  💡 보안 권장 — @BotFather 에서 봇을 1:1 전용으로 잠그세요:");
  console.log("     /setjoingroups → Disable  (봇을 그룹에 추가 못 하게)");
  console.log("     /setprivacy   → Enable    (그룹에서 명령만 — 기본값)");
  return { telegramToken, telegramUserIds };
};

const renderEnv = (a: Answers): string => {
  return `# tiguclaw .env — \`tiguclaw init\` 마법사 생성.
# ★ 이 파일은 비밀(토큰)을 담습니다. 절대 커밋/공유하지 마세요. (.gitignore 처리됨)

# 앱 런타임 홈. ★이 .env 는 홈 안에 있으므로 TIGUCLAW_HOME 은 여기서 결정되지 않습니다 —
# 환경변수(launchd/셸)로 설정되며 미설정 시 ~/.tiguclaw. daemon:install 이 유닛에 주입합니다.
# (이 줄은 참고용 — 값을 바꿔도 .env 를 찾는 홈 경로엔 영향 없음.)
TIGUCLAW_HOME=

# ── LLM provider 키 ─────────────────────────────────────────────
# 선택한 provider = ${a.provider}. 미선택 provider 키는 빈 값으로 남겨둡니다.
# (다른 provider 로 바꾸려면 해당 키를 채우고 REGION_A_MODELS 를 편집하세요.)
ANTHROPIC_API_KEY=${a.anthropicKey}
# Claude 구독 OAuth (claude-sub provider). \`claude setup-token\` 으로 발급, claude 어댑터가
# ANTHROPIC_API_KEY 대신 이 토큰으로 인증. 둘 중 하나만 있으면 됩니다.
CLAUDE_CODE_OAUTH_TOKEN=${a.claudeOauthToken}
OPENAI_API_KEY=${a.openaiKey}

# (미사용 provider — region-A 미연결, 참고용)
GOOGLE_GENERATIVE_AI_API_KEY=
OLLAMA_BASE_URL=

# ChatGPT OAuth 우회 (codex provider). \`npm run codex-auth\` 로 자동 발급/갱신됩니다.
# codex 를 선택했어도 설치 후 codex-auth 를 실행해야 토큰이 채워집니다.
OPENAI_CODEX_OAUTH_TOKEN=
OPENAI_CODEX_OAUTH_REFRESH=
OPENAI_CODEX_OAUTH_EXPIRES=

# ── 모델 풀 ─────────────────────────────────────────────────────
# REGION_A_MODELS — provider:model, 콤마 순서 = 폴백 우선순위.
# provider: anthropic→claude / openai→openai / codex→codex-oauth.
# 모델 ID 가 안 맞으면 런타임 폴백 안전망이 있고, 여기서 자유롭게 편집 가능합니다.
REGION_A_MODELS=${a.regionAModels}

# sub-agent 등급(티어) → 모델 폴백 풀. agent.md 의 model: high/mid/low 가 매핑됨.
# 선택한 provider(${a.provider}) 기준으로 세팅됨 — 다른 모델로 세분화하려면 편집하세요.
# 여기 지정 모델을 쓸 수 없으면(키/토큰 부재 등) 런타임이 REGION_A_MODELS 기본 풀로 폴백합니다.
MODEL_TIER_HIGH=${a.tierHigh}
MODEL_TIER_MID=${a.tierMid}
MODEL_TIER_LOW=${a.tierLow}

# ── 텔레그램 채널 ───────────────────────────────────────────────
# TELEGRAM_ALLOWED_USER_IDS 가 비면 봇이 잠겨 어떤 메시지도 처리하지 않습니다.
TELEGRAM_BOT_TOKEN=${a.telegramToken}
TELEGRAM_ALLOWED_USER_IDS=${a.telegramUserIds}

# ── HTTP 브리지 채널 ────────────────────────────────────────────
# 인증 토큰 (Authorization: Bearer). init 이 자동 생성했습니다.
HTTP_BRIDGE_TOKEN=${a.httpBridgeToken}
# 포트 기본값 7011. 바꿀 때만 주석을 푸세요(기본값은 적지 않는 편이 안전합니다).
# HTTP_BRIDGE_PORT=7011

# ── 대시보드 ────────────────────────────────────────────────────
# 브라우저로 http://127.0.0.1:7010 을 열면 웹 대시보드입니다.
# 127.0.0.1 에만 바인딩됩니다 — 다른 기기에서 쓰려면 포트를 열지 말고 사설 네트워크로
# 터널링하세요(예: tailscale serve 7010).
# DASHBOARD_PORT=7010

# ── LLM 게이트웨이 (선택) ───────────────────────────────────────
# 다른 로컬 앱이 tiguclaw 멀티LLM 백엔드를 OpenAI 호환으로 씀: POST /v1/chat/completions
# (http-bridge 포트). ★토큰 설정 시에만 활성(미설정=비활성). 앱 *서버* 가 이 토큰으로 호출
# (브라우저에 노출 금지). 앱은 비서(codex 등)와 다른 백엔드로 분리 권장(rate-limit·밴 격리).
LLM_GATEWAY_TOKEN=
# 게이트웨이 기본 모델 풀(콤마, provider:model). 미설정 시 REGION_A_MODELS 사용.
LLM_GATEWAY_MODELS=
# 동시 처리 상한(앱 폭주가 비서 흔드는 것 방지). 기본 4.
LLM_GATEWAY_MAX_CONCURRENCY=4

# ── 데몬 ────────────────────────────────────────────────────────
LOG_LEVEL=info
NODE_ENV=production
`;
};

const main = async (): Promise<void> => {
  console.log("");
  console.log("=== tiguclaw init — 자가호스트 설치 마법사 ===");
  console.log("대화형으로 LLM·텔레그램·토큰을 설정해 .env 를 생성합니다.");
  console.log("키·토큰 발급 단계가 헷갈리면 README 의 '키·토큰 발급 가이드' 섹션을 참고하세요.");

  // ★ 안전장치: 기존 .env 가 있으면 명시적 동의 없이는 중단.
  if (existsSync(ENV_PATH)) {
    console.log("");
    console.log(`⚠️  이미 .env 가 존재합니다: ${ENV_PATH}`);
    console.log("⚠️  이 파일에는 라이브 데몬의 실제 토큰이 들어있을 수 있습니다.");
    console.log("⚠️  덮어쓰면 복구할 수 없습니다.");
    const confirm = await ask('계속 덮어쓰려면 "overwrite" 를 입력하세요 (그 외 입력 = 중단): ');
    if (confirm !== "overwrite" && confirm.toLowerCase() !== "y") {
      console.log("→ 중단했습니다. 기존 .env 는 그대로 유지됩니다.");
      rl.close();
      return;
    }
    console.log("→ 덮어쓰기를 진행합니다.");
  }

  const provider = await askProvider();
  const providerCfg = await collectProviderConfig(provider);

  console.log("");
  console.log("[2/4] HTTP 브리지 인증 토큰 자동 생성 중...");
  const httpBridgeToken = randomBytes(32).toString("hex");
  console.log("  ✅ HTTP_BRIDGE_TOKEN 생성 완료 (.env 에 기록됩니다).");

  const telegram = await collectTelegram();

  console.log("");
  console.log("[4/4] 포트 = 코드 기본값 사용 (브리지 7011 · 대시보드 7010).");
  console.log("  ℹ️  바꾸려면 .env 의 해당 주석을 푸세요(적어두지 않는 게 기본 — 갈라집니다).");

  const tier = TIER_DEFAULTS[provider];
  const answers: Answers = {
    provider,
    ...providerCfg,
    tierHigh: tier.high,
    tierMid: tier.mid,
    tierLow: tier.low,
    ...telegram,
    httpBridgeToken,
  };

  mkdirSync(HOME_DIR, { recursive: true }); // 홈 디렉터리 보장(첫 설치).
  // ★0600 (2026-07-28 보안 감사) — 종전엔 mode 미지정이라 umask 기본 0644 로 만들어져
  //  봇 토큰·OAuth 토큰·게이트웨이 토큰이 **같은 머신의 다른 계정에게 읽혔다**.
  //  공유/회사 PC·다중 사용자 환경에서 전 백엔드 크리덴셜 노출 경로.
  writeFileSync(ENV_PATH, renderEnv(answers), { encoding: "utf8", mode: 0o600 });
  console.log("");
  console.log(`✅ .env 작성 완료: ${ENV_PATH}  (런타임 홈 — 레포 아님)`);

  // 모델 프로파일 seed (settings.json) — .env 의 REGION_A_MODELS/MODEL_TIER_* 를 명명 프로파일로
  // 승격(ADR model-profiles). 기존 settings.json 의 hooks 등은 보존, models.profiles 만 병합.
  seedModelProfiles(buildSeedProfiles(answers));
  console.log(
    `✅ settings.json 모델 프로파일 seed 완료: ${SETTINGS_PATH}  (default/high/mid/low)`,
  );

  console.log("");
  console.log("── 다음 단계 ──────────────────────────────────────");
  console.log("  ① `npm install` 이 완료됐는지 확인하세요.");
  if (provider === "codex") {
    console.log("  ② `npm run codex-auth` 로 ChatGPT OAuth 토큰을 발급하세요. (codex 필수)");
  } else {
    console.log("  ② (codex provider 아님 — OAuth 발급 단계 건너뜀)");
  }
  console.log("  ③ `npm run daemon:install` (상시 데몬) 또는 `npm run dev` (개발)로 실행하세요.");
  console.log("  ④ `npm run doctor` 로 설정을 검증하세요.");
  console.log("  ⑤ 텔레그램에서 봇에게 메시지를 보내 응답을 확인하세요.");
  console.log("  ⑥ 브라우저로 http://127.0.0.1:7010 — 웹 대시보드(채팅·진행 상황·백그라운드 작업).");
  console.log("");
  console.log("  ★ .env 는 절대 커밋·공유하지 마세요 (실 토큰 포함).");
  console.log("");

  rl.close();
};

main().catch((err) => {
  rl.close();
  console.error("init failed:", err);
  process.exit(1);
});
