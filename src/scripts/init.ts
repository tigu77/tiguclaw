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
import { declaredAuthProviders } from "../core/auth-plugin-presence.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ModelProfile } from "../core/settings.js";
import { countHomeModelProfiles, profileToSettingsJson } from "../core/settings.js";
import { builtinTierModel } from "../core/llm-runtime/builtin-profiles.js";

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
// ★모델 이름은 **코어의 빌트인 표 하나**에서 온다 (2026-08-13). 종전엔 여기 사본이 따로
//  있었고, 그래서 `claude-opus-4-8`/`claude-sonnet-4-6` 로 굳은 채 두 세대를 지났다
//  (실사용은 이미 `claude-opus-5`·`claude-sonnet-5` 였다 — context-windows.ts 실측 표).
//  같은 표를 런타임(프로파일 미설정 시 자동 조립)과 온보딩이 공유하면 갈릴 수가 없다.
//  ★init 의 provider 이름은 **인증 수단**(claude-sub = 구독 OAuth)이고 모델 provider 는
//   `anthropic` 하나다 — 그 사상만 여기서 한다.
const TIER_PROVIDER: Record<Provider, string> = {
  anthropic: "anthropic",
  "claude-sub": "anthropic",
  openai: "openai",
  codex: "codex",
};

const tierDefaults = (provider: Provider): { high: string; mid: string; low: string } => {
  const p = TIER_PROVIDER[provider];
  const pick = (tier: "high" | "mid" | "low"): string => {
    // ★빌트인은 "인증된 provider" 만 담는다(런타임 기준). 온보딩은 **지금 막 고른**
    //  provider 를 물어야 하므로 인증 여부를 무시하고 이름만 뽑는다.
    const raw = builtinTierModel(p, tier);
    return raw === undefined ? "" : `${p}:${raw}`;
  };
  return { high: pick("high"), mid: pick("mid"), low: pick("low") };
};

/** 콤마 문자열 → provider:model 배열 (빈/공백 제거). init 값은 보통 단일이나 방어적. */
const toPool = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * seed 모델 프로파일 — **high/mid/low 셋뿐이고 기본은 high** (사용자 결정 2026-08-13).
 *
 * ★왜 `default` 프로파일을 뺐나: 이름이 넷이면 "메인 턴은 어느 것인가" 가 두 곳(프로파일
 *  `default` · 포인터 `models.default`)에 적히고, 그 둘은 갈릴 수 있다. 등급은 하나의 축
 *  (high↔low)이면 충분하고, "그중 무엇이 기본인가" 는 포인터 하나로 답한다
 *  (`models.default = "high"`, seedModelProfiles 가 같이 쓴다).
 *
 * ★`fallback` 을 안 적는 이유: `resolveProfileChain` 이 모든 체인 말미에 **기본 프로파일**을
 *  자동으로 덧붙인다. 즉 low → (실패) → high 는 이미 성립한다. 손으로 `fallback: "default"`
 *  를 적으면 기본이 바뀔 때 같이 안 바뀌는 두 번째 진실 소스가 된다.
 *
 * (nano 는 시드하지 않는다 — 사용자 요청 2026-07-18. 필요하면 사용자가 직접 추가.)
 */
const buildSeedProfiles = (a: Answers): Record<string, ModelProfile> => ({
  // ★high 가 첫 키 — `models.default` 포인터가 지워져도 `getDefaultProfileName` 의
  //  "첫 프로파일" 폴백이 여기로 떨어진다(기본이 조용히 low 로 내려가지 않게).
  high: {
    description: "기본 — 메인 턴 · 설계·분석 등 고난도 작업",
    pool: toPool(a.tierHigh).map((spec) => ({ spec })),
  },
  mid: {
    description: "일반 작업",
    pool: toPool(a.tierMid).map((spec) => ({ spec })),
  },
  low: {
    description: "단순·대량 작업",
    pool: toPool(a.tierLow).map((spec) => ({ spec })),
  },
});

/**
 * seed 프로파일을 settings.json 에 쓴다. **★기존에 프로파일이 하나라도 있으면 시드 스킵**
 * (사용자 요청 2026-07-18 — 사용자 설정을 존중, 없는 이름 추가조차 안 함). 프로파일이
 * 0개(부재/빈 객체)일 때만 seed 를 통째로 깐다. 다른 키(hooks·models.default 등)는 보존.
 * 파싱 실패 시 새 객체로 안전 강등(throw 0).
 */
const seedModelProfiles = (
  profiles: Record<string, ModelProfile>,
  defaultName: string,
): void => {
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
      ? (root.models as { profiles?: Record<string, unknown>; default?: unknown })
      : {};
  // ★기존 프로파일이 하나라도 **읽히면** 시드 스킵 — 사용자 설정 존중. 원시 키 수로 세면 읽히지 않는 `{ spec }` 시드
  //  (2026-08-24~09-29)가 «있음» 으로 잡혀 다시 시드하지 않았다(적대 검토 P-7). 판정은 옛 .env 이전과 같은 함수다.
  if (countHomeModelProfiles() > 0) return;
  // 파일 모양으로 쓴다 — 메모리 모양(`{ spec }`)을 그대로 쓰면 읽히지 않았다(2026-08-24~09-29, 수동 모드 프로파일 전부 무시).
  models.profiles = Object.fromEntries(Object.entries(profiles).map(([n, p]) => [n, profileToSettingsJson(p)]));
  // ★기본 포인터를 프로파일과 **같이** 쓴다 — 시드에는 `default` 라는 이름의 프로파일이
  //  없으므로, 포인터를 안 쓰면 `getDefaultProfileName` 이 "첫 프로파일" 폴백으로 넘어간다.
  //  그건 키 순서에 기대는 암묵 규칙이라 명시한다(사용자가 나중에 바꾸면 그 값이 이긴다).
  models.default = defaultName;
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

/**
 * ★**이 설치에 없는 구독은 묻지 않는다** (2026-09-01 사용자 지시).
 *  구독 인증은 v0.45.0 부터 번들 플러그인이다 — 그 폴더를 뺀 설치(Business 판 등)에서
 *  *"Claude 구독 OAuth 를 고르세요"* 라고 권하면, 고른 뒤 부팅 때 그 인증이 없어 조용히
 *  폴백한다. **없는 능력을 권하는 상태**였다.
 *  판정은 이름 열거가 아니라 플러그인이 **선언한 것**을 읽는다(`auth-plugin-presence`).
 *  번호는 남은 항목으로 **다시 매긴다** — 안 그러면 «2번은 없습니다» 를 사람이 외워야 한다.
 */
const askProvider = async (): Promise<Provider> => {
  const has = declaredAuthProviders();
  const all: Array<{ p: Provider; desc: string; aliases: string[] }> = [
    { p: "anthropic", desc: "anthropic  — Anthropic API key (easiest, pay per token)", aliases: ["anthropic"] },
    ...(has.has("claude-subscription")
      ? [{
          p: "claude-sub" as Provider,
          desc: "claude-sub — Claude subscription OAuth (`claude setup-token`, a token instead of a key)",
          aliases: ["claude-sub", "claude"],
        }]
      : []),
    { p: "openai", desc: "openai     — OpenAI API key (pay per token)", aliases: ["openai"] },
    ...(has.has("codex")
      ? [{
          p: "codex" as Provider,
          desc: "codex      — ChatGPT subscription OAuth (no key to enter, sign in after setup)",
          aliases: ["codex"],
        }]
      : []),
  ];
  console.log("");
  console.log("[1/4] Choose an LLM provider — pick one you have.");
  all.forEach((o, i) => console.log(`  ${i + 1}) ${o.desc}`));
  const nums = all.map((_, i) => String(i + 1));
  for (;;) {
    const v = await ask(`  Choice [${nums.join("/")}] (default 1): `);
    if (v === "") return all[0]!.p;
    const byNum = nums.indexOf(v);
    if (byNum >= 0) return all[byNum]!.p;
    const lower = v.toLowerCase();
    const hit = all.find((o) => o.aliases.includes(lower));
    if (hit !== undefined) return hit.p;
    console.log(`  ⚠️  Enter one of ${nums.join(", ")}.`);
  }
};

const collectProviderConfig = async (
  provider: Provider,
): Promise<
  Pick<Answers, "anthropicKey" | "claudeOauthToken" | "openaiKey">
> => {
  if (provider === "anthropic") {
    console.log("");
    console.log("  → Create an API key in the Anthropic Console (console.anthropic.com).");
    // ★Claude Code 설치 안내는 **필요 없다** (2026-08-27 확인). Agent SDK 가 플랫폼별
    //  `claude` 바이너리를 optional 의존으로 **같이 깔기** 때문에 키만으로 돈다
    //  (실증: PATH 를 비우고 SDK 를 돌려도 정상 기동).
    const anthropicKey = await askRequired(
      "  ANTHROPIC_API_KEY (sk-ant-...): ",
      "The key can't be empty. Create one and paste it here.",
    );
    return {
      anthropicKey,
      claudeOauthToken: "",
      openaiKey: "",
    };
  }
  if (provider === "claude-sub") {
    console.log("");
    console.log("  → Signing in with your Claude subscription (Pro/Max) — an OAuth token is used instead of a key.");
    // ★여기서 토큰을 **받아 적지 않는다** (2026-08-27). codex 와 같은 모양으로, 온보드
    //  [2/5] 가 `npm run claude-auth` 를 대신 돌린다 — 사용자는 브라우저 로그인만 하면 된다.
    //  종전엔 "CLI 를 깔고 → 토큰을 받고 → 붙여넣으세요" 세 걸음이었고, 첫 걸음은 이미
    //  `npm ci` 로 받아둔 259MB 를 한 번 더 받는 것이었다.
    console.log("     The token is issued automatically in the next step (`npm run claude-auth`).");
    console.log("     When the browser opens, just sign in — tiguclaw saves the token for you.");
    return {
      anthropicKey: "",
      claudeOauthToken: "",
      openaiKey: "",
    };
  }
  if (provider === "openai") {
    console.log("");
    console.log("  → Create an API key on the OpenAI Platform (platform.openai.com).");
    const openaiKey = await askRequired(
      "  OPENAI_API_KEY (sk-...): ",
      "The key can't be empty. Create one and paste it here.",
    );
    return {
      anthropicKey: "",
      claudeOauthToken: "",
      openaiKey,
    };
  }
  // codex
  console.log("");
  console.log("  → codex uses ChatGPT subscription OAuth. There is no key to enter here.");
  console.log("     After setup, you must get an OAuth token with `npm run codex-auth`.");
  return {
    anthropicKey: "",
    claudeOauthToken: "",
    openaiKey: "",
  };
};

/**
 * 초기 모델 셋팅 — **자동이 기본, 고정은 선택** (2026-08-13, 2차 수정).
 *
 * ★1차(같은 날 오전)엔 "표를 보여주고 수락/수정" 이었는데, 그건 **자동 최신을 꺼버렸다.**
 *  카탈로그 경로(`builtin-profiles` → `model-catalog`)는 **프로파일이 0개일 때만** 돈다.
 *  그런데 init 이 그 값을 `settings.json` 에 박고 `.env` 의 `REGION_A_MODELS` 에도 써서,
 *  init 을 거친 설치는 **영영 그 시점 값에 고정**됐다. 같은 날 만든 두 기능이 서로를
 *  막고 있었다 — 사용자 질문("온보딩에서 인증 태우면 모델도 알아서 셋팅되냐")이 드러냈다.
 *
 * ★그래서 기본을 뒤집는다: **아무것도 안 적는 게 기본**이다. 안 적으면 런타임이 매 턴
 *  인증된 provider 의 최신으로 구성한다. 적는 건 재현성이 필요할 때의 **선택**이다.
 *  ("설정이 없다" 가 결함이 아니라 기능인 드문 자리 — 그래서 화면에 그렇게 적는다.)
 */
/** "auto" = 아무것도 고정하지 않는다(런타임이 매번 최신을 고름). 아니면 고정할 세 값. */
type ModelMode = "auto" | { high: string; mid: string; low: string };

const chooseModelMode = async (tier: {
  high: string;
  mid: string;
  low: string;
}): Promise<ModelMode> => {
  console.log("");
  console.log("  ── Models ────────────────────────────────────────");
  console.log("  1) Auto (recommended) — nothing is written. The daemon asks the backend and");
  console.log("     builds high/mid/low from the **latest** models of your signed-in providers every time.");
  console.log("     It follows new models as they ship. Each tier only moves within its family");
  console.log("     (opus→opus), so the cost tier never rises silently.");
  console.log("  2) Fixed — writes the currently known values into settings.json. For when you need");
  console.log("     reproducibility or a specific model. To change them later, edit that file.");
  console.log(`     (currently known: high=${tier.high} · mid=${tier.mid} · low=${tier.low})`);
  const v = await ask("  Choice [1/2] (default 1): ");
  if (v === "" || v === "1") return "auto";
  const pick = async (label: string, cur: string): Promise<string> => {
    const raw = await ask(`  ${label} (Enter=${cur}): `);
    return raw === "" ? cur : raw;
  };
  return {
    high: await pick("high", tier.high),
    mid: await pick("mid", tier.mid),
    low: await pick("low", tier.low),
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
      console.log("  ⚠️  The bot token is not valid (getMe failed). Continuing with manual entry.");
      return null;
    }
    console.log(`  ✅ Bot found: @${me.result.username}`);
    // webhook 설정 시 getUpdates 가 막히므로 해제(대기 업데이트는 보존).
    await telegramApi(token, "deleteWebhook", { drop_pending_updates: false });
    console.log("");
    console.log("  → Now send this bot any message on Telegram (waiting up to 2 minutes)…");
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
    console.log("  ⚠️  No message arrived within 2 minutes. Continuing with manual entry.");
    return null;
  } catch (e) {
    console.log(
      `  ⚠️  Auto-detection failed: ${e instanceof Error ? e.message : String(e)} — continuing with manual entry.`,
    );
    return null;
  }
};

const collectTelegram = async (): Promise<
  Pick<Answers, "telegramToken" | "telegramUserIds">
> => {
  console.log("");
  console.log("[3/4] Telegram (optional) — skip this if you only use the CLI.");
  const skip = await ask("  Set up Telegram? [y/N]: ");
  if (skip.toLowerCase() !== "y" && skip.toLowerCase() !== "yes") {
    console.log("  → Skipped Telegram. (You can add TELEGRAM_BOT_TOKEN to .env later.)");
    return { telegramToken: "", telegramUserIds: "" };
  }

  console.log("  → In @BotFather, run /newbot to create a bot, then copy its token.");
  const telegramToken = await askRequired(
    "  TELEGRAM_BOT_TOKEN: ",
    "The bot token can't be empty (you chose to set up Telegram).",
  );

  console.log("");
  console.log("  Owner user id — can be detected automatically with the bot token (just send the bot one message).");
  const auto = await ask("  Detect it automatically? [Y/n]: ");
  let telegramUserIds = "";
  if (auto.toLowerCase() !== "n" && auto.toLowerCase() !== "no") {
    const detected = await detectTelegramUserId(telegramToken);
    if (detected !== null) {
      console.log(`  → Detected: ${detected.id} (${detected.name})`);
      const ok = await ask("  Set this ID as the owner? [Y/n]: ");
      if (ok.toLowerCase() !== "n" && ok.toLowerCase() !== "no") {
        telegramUserIds = detected.id;
      }
    }
  }
  if (telegramUserIds.length === 0) {
    console.log("");
    console.log("  → Manual: message @userinfobot to find your user id, then enter it.");
    console.log("    (to allow several people, separate with commas: 111,222)");
    telegramUserIds = await ask("  TELEGRAM_ALLOWED_USER_IDS: ");
  }
  if (telegramUserIds.length === 0) {
    console.log("");
    console.log("  ⚠️⚠️  Warning: the allowlist is empty.");
    console.log("  ⚠️    The bot is locked and will not handle any message (no owner can be identified = everything is blocked).");
    console.log("  ⚠️    Be sure to fill in TELEGRAM_ALLOWED_USER_IDS in .env later.");
  }
  console.log("");
  console.log("  💡 Security tip — in @BotFather, lock the bot to one-on-one chats:");
  console.log("     /setjoingroups → Disable  (the bot can't be added to groups)");
  console.log("     /setprivacy   → Enable    (commands only in groups — the default)");
  return { telegramToken, telegramUserIds };
};

const renderEnv = (a: Answers): string => {
  return `# tiguclaw .env — generated by the \`tiguclaw init\` wizard.
# ★ This file holds secrets (tokens). Never commit or share it. (It is in .gitignore.)

# App runtime home. ★This .env lives inside the home, so TIGUCLAW_HOME is not decided here —
# it comes from the environment (launchd/shell) and defaults to ~/.tiguclaw. daemon:install puts it into the service.
# (This line is for reference only — changing it does not change where .env is looked up.)
TIGUCLAW_HOME=

# ── LLM provider keys ───────────────────────────────────────────
# ★The provider chosen during onboarding — tiguclaw onboard uses it to decide whether to run
#  the codex OAuth step (it can't be inferred from the models, which are often left on auto).
TIGUCLAW_PROVIDER=${a.provider}
# Keys for providers you didn't choose are left empty.
# (To switch providers, fill in that key — models come from the profiles in settings.json, or are built automatically from signed-in providers.)
ANTHROPIC_API_KEY=${a.anthropicKey}
# Claude subscription OAuth (claude-sub provider). Issued with \`claude setup-token\`; the claude adapter
# signs in with this token instead of ANTHROPIC_API_KEY. You only need one of the two.
CLAUDE_CODE_OAUTH_TOKEN=${a.claudeOauthToken}
OPENAI_API_KEY=${a.openaiKey}

# (Unused provider — not wired to region A, for reference)
GOOGLE_GENERATIVE_AI_API_KEY=

# ChatGPT OAuth (codex provider). Issued and refreshed automatically by \`npm run codex-auth\`.
# Even if you chose codex, the tokens are only filled in after you run codex-auth.
OPENAI_CODEX_OAUTH_TOKEN=
OPENAI_CODEX_OAUTH_REFRESH=
OPENAI_CODEX_OAUTH_EXPIRES=

# ── Models ──────────────────────────────────────────────────────
# Models are not set here but by the model profiles in settings.json (models.profiles).
# Without profiles, the latest models of your signed-in providers are used (check with \`/models\`).

# ── Telegram channel ────────────────────────────────────────────
# If TELEGRAM_ALLOWED_USER_IDS is empty, the bot is locked and handles no messages.
TELEGRAM_BOT_TOKEN=${a.telegramToken}
TELEGRAM_ALLOWED_USER_IDS=${a.telegramUserIds}

# ── HTTP bridge channel ─────────────────────────────────────────
# Auth token (Authorization: Bearer). Generated by init.
HTTP_BRIDGE_TOKEN=${a.httpBridgeToken}
# Default port 17011. Uncomment only to change it (leaving the default unwritten is safer).
# HTTP_BRIDGE_PORT=17011

# ── Dashboard ───────────────────────────────────────────────────
# Open http://127.0.0.1:17010 in a browser for the web dashboard.
# It binds to 127.0.0.1 only — to use it from another device, don't open the port; tunnel it
# over a private network instead (e.g. tailscale serve 17010).
# DASHBOARD_PORT=17010

# ── LLM gateway (optional) ──────────────────────────────────────
# Lets other local apps use the tiguclaw multi-LLM backend through an OpenAI-compatible API: POST /v1/chat/completions
# (on the http-bridge port). ★Only enabled when a token is set (unset = disabled). The app *server* calls it with this token
# (never expose it to a browser). Keep apps on a different backend from the assistant (codex etc.) to isolate rate limits and bans.
LLM_GATEWAY_TOKEN=
# Default model pool for the gateway (comma-separated, provider:model). Unset = the default model profile (or the automatic setup).
LLM_GATEWAY_MODELS=
# Concurrency cap (keeps a runaway app from disturbing the assistant). Default 4.
LLM_GATEWAY_MAX_CONCURRENCY=4

# ── Daemon ──────────────────────────────────────────────────────
LOG_LEVEL=info
NODE_ENV=production
`;
};

const main = async (): Promise<void> => {
  console.log("");
  console.log("=== tiguclaw init — self-hosted setup wizard ===");
  console.log("Sets up the LLM, Telegram and tokens interactively and creates .env.");
  console.log("If getting keys or tokens is confusing, see the key and token guide in the README.");

  // ★ 안전장치: 기존 .env 가 있으면 명시적 동의 없이는 중단.
  if (existsSync(ENV_PATH)) {
    console.log("");
    console.log(`⚠️  A .env already exists: ${ENV_PATH}`);
    console.log("⚠️  It may hold the real tokens of a running daemon.");
    console.log("⚠️  Overwriting it cannot be undone.");
    const confirm = await ask('Type "overwrite" to overwrite it (anything else cancels): ');
    if (confirm !== "overwrite" && confirm.toLowerCase() !== "y") {
      console.log("→ Cancelled. The existing .env is left as is.");
      rl.close();
      return;
    }
    console.log("→ Overwriting.");
  }

  const provider = await askProvider();
  const providerCfg = await collectProviderConfig(provider);
  const modelMode = await chooseModelMode(tierDefaults(provider));
  const tier = modelMode === "auto" ? { high: "", mid: "", low: "" } : modelMode;

  console.log("");
  console.log("[2/4] Generating the HTTP bridge auth token...");
  const httpBridgeToken = randomBytes(32).toString("hex");
  console.log("  ✅ Generated HTTP_BRIDGE_TOKEN (it will be written to .env).");

  const telegram = await collectTelegram();

  console.log("");
  console.log("[4/4] Ports = code defaults (bridge 17011 · dashboard 17010).");
  console.log("  ℹ️  To change them, uncomment the matching lines in .env (they are left out by default so they can't drift).");

  const answers: Answers = {
    provider,
    ...providerCfg,
    // ★메인 턴 풀(.env 레거시 경로)을 high 와 **같은 값**으로 맞춘다 (2026-08-13).
    //  종전엔 REGION_A_MODELS 가 sonnet, high 가 opus 로 갈려 있었다 — 기본이 high 가 된
    //  지금 그대로 두면 "profiles 를 지우면 갑자기 다른 모델로 답한다" 가 된다.
    //  같은 질문("메인 턴은 무엇으로")에 두 답이 있으면 안 된다.
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
  console.log(`✅ Wrote .env: ${ENV_PATH}  (runtime home, not the repo)`);

  // 모델 프로파일 seed (settings.json) — .env 의 REGION_A_MODELS/MODEL_TIER_* 를 명명 프로파일로
  // 승격(ADR model-profiles). 기존 settings.json 의 hooks 등은 보존, models.profiles 만 병합.
  // ★자동이면 **아무것도 안 쓴다** — 쓰는 순간 그 값에 고정되고 자동 최신이 죽는다.
  if (modelMode === "auto") {
    console.log(
      "✅ Models = auto. No profiles were written to settings.json — the daemon builds " +
        "high/mid/low from the latest models of your signed-in providers every time (see `/models`).",
    );
  } else {
    seedModelProfiles(buildSeedProfiles(answers), "high");
    console.log(
      `✅ Seeded model profiles in settings.json: ${SETTINGS_PATH}  (high/mid/low · default=high)`,
    );
  }

  console.log("");
  console.log("── Next steps ─────────────────────────────────────");
  console.log("  ① Make sure `npm install` has finished.");
  if (provider === "codex") {
    console.log("  ② Get a ChatGPT OAuth token with `npm run codex-auth`. (required for codex)");
  } else {
    console.log("  ② (not the codex provider — skipping the OAuth step)");
  }
  console.log("  ③ Start it with `npm run daemon:install` (always-on daemon) or `npm run dev` (development).");
  console.log("  ④ Check the setup with `npm run doctor`.");
  console.log("  ⑤ Send your bot a message on Telegram to check that it replies.");
  console.log("  ⑥ Open http://127.0.0.1:17010 in a browser — the web dashboard (chat, progress, background jobs).");
  console.log("");
  console.log("  ★ Never commit or share .env (it holds real tokens).");
  console.log("");

  rl.close();
};

main().catch((err) => {
  rl.close();
  console.error("init failed:", err);
  process.exit(1);
});
