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
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { dashboardUrl, initNextSteps, installedEnvLookup } from "../core/onboard-ready.js";

// 설정(.env)은 **런타임 홈**에 둔다(공개 레포 checkout 무오염, 2026-07-09). 홈 =
// TIGUCLAW_HOME env(있으면) / 기본 ~/.tiguclaw — load-env.ts·daemon.ts 와 동일 규칙.
const HOME_DIR =
  process.env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
const ENV_PATH = path.join(HOME_DIR, ".env");

type Provider = "anthropic" | "claude-sub" | "openai" | "codex";

interface Answers {
  provider: Provider;
  anthropicKey: string;
  claudeOauthToken: string;
  openaiKey: string;
  telegramToken: string;
  telegramUserIds: string;
  httpBridgeToken: string;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = async (prompt: string): Promise<string> =>
  (await rl.question(prompt)).trim();

/**
 * 구독 로그인 안내 — onboard 가 부른 init 이면 **다음 단계가 대신 한다**고만 말한다 (2026-10-18, 깨끗한 윈도우 실기).
 * ★종전 codex 문구는 «설정 뒤 `npm run codex-auth` 로 토큰을 받아야 한다» 였는데 onboard 가 바로 그걸 하고,
 *  전용 Node 로 설치한 사람의 셸엔 `npm` 도 없다. 단독 init 일 때만 명령을 적는다.
 */
const subscriptionSignInNote = (cmd: "codex-auth" | "claude-auth"): string[] =>
  process.env.TIGUCLAW_FROM_ONBOARD === "1"
    ? ["     Sign-in comes next — when the browser opens, just sign in. tiguclaw saves the token for you."]
    : [`     After setup, sign in with \`npm run ${cmd}\` — it opens the browser and saves the token for you.`];

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
    for (const l of subscriptionSignInNote("claude-auth")) console.log(l);
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
  for (const l of subscriptionSignInNote("codex-auth")) console.log(l);
  return {
    anthropicKey: "",
    claudeOauthToken: "",
    openaiKey: "",
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
  console.log("[3/4] Telegram (optional) — skip this to use the web dashboard (you can add Telegram later).");
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

  // ★모델은 쓰지 않는다 — 쓰는 순간 그 값에 고정되고 자동 최신이 죽는다(2026-08-13). 설치 때는 묻지도 않는다(2026-10-22 정태님):
  //  로그인 전이라 이 판에 든 옛 값밖에 못 보여주고, Enter 만 누른 «고정» 이 조용히 옛 모델에 묶였다. 고정이 필요하면 연결된 뒤 비서에게
  //  말하면 된다(settings.json 은 데이터라 다음 턴부터 반영).
  // ★기존 홈에 다시 돌려도 맞는 한 문장 — 프로파일이 있으면 그대로 이긴다(외부 GPT 검토 10-22: 무조건 «auto» 라고 말해 기존 설정과 달랐다).
  console.log(
    "✅ Model settings were not touched. Existing profiles in settings.json are kept; with none, every task uses the latest " +
      "model of your signed-in providers (see `/models`). To use other models later, just ask tiguclaw — it saves them to settings.json, and those win.",
  );
  console.log("");
  // 다음 단계 — onboard 가 부른 것이면 이어서 자동으로 간다고만, 단독이면 실제 설정대로(`initNextSteps`).
  const get = installedEnvLookup(ENV_PATH, process.cwd());
  for (const line of initNextSteps({
    provider,
    telegram: get("TELEGRAM_BOT_TOKEN") !== undefined,
    dashboardUrl: dashboardUrl(get),
    fromOnboard: process.env.TIGUCLAW_FROM_ONBOARD === "1",
  })) console.log(line);
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
