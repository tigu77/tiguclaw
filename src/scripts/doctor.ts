// src/scripts/doctor.ts
/**
 * Phase 5 — npm run doctor 진단 스크립트.
 *
 * 환경변수·DB·채널·LLM 런타임·권한 섹션을 한 번에 확인하고 「다음 단계」 한 줄을 안내.
 *
 * 데몬을 띄우지 않는다 — SDK 호출 / Telegram polling / CLI stdin 호출 0.
 * 어댑터 풀(llm-runtime) 도 import 하지 않는다 — top-level POOLS 평가가 env 미설정 시 throw 하기 때문.
 * 자체 splitPool 6 줄 + provider→envvar 매핑 7 줄로 진단만 수행.
 */
import "../core/load-env.js"; // ★가장 먼저 — <home>/.env(레포 폴백) 로드.
import { subscriptionAuthAvailable } from "../core/auth-plugin-presence.js";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
// ★store 계열은 **동적** import 다 (2026-08-20). 정적으로 두면 `better-sqlite3` 가 안 열릴 때
//  이 파일이 **로드 단계에서** 죽어 `main()` 이 시작조차 못 한다 — 진단 도구가 가장 필요한
//  순간(데몬이 부팅마다 죽는 그 머신)에 아무것도 안 찍는다. 아래 [install] 섹션이 네이티브를
//  먼저 확인하고, 통과했을 때만 이것들을 부른다.
//  (`initStore`·`getDb`·`resolveDataDir`·`listActive`·`listSchedules`·`listWatches`)
import { DISALLOWED_TOOLS } from "../auth/permissions.js";
import { ensureRipgrep } from "../core/ripgrep.js";
import { findBundledClaude, bundledClaudeMissingHint } from "../core/claude-cli.js";
import { getPaths } from "../core/paths.js";
import { loadModelProviders } from "../core/settings.js";
import { describeBasePool, specLabel } from "../core/llm-runtime/index.js";
import { resolveProviderConn } from "../core/llm-runtime/provider-registry.js";
import type { BridgeTokenRole } from "../store/bridge-tokens.js";
import {
  judgeGlobalCommand,
  probeNativeModule,
  resolveGlobalCommand,
  resolveLinkedInstall,
} from "./doctor-install.js";
// codex OAuth 토큰 키 상수 + 만료 파서를 어댑터에서 재사용 (하드코딩 중복 금지).
// 해당 모듈은 top-level side-effect 0 (순수 const + 함수 정의) — env 미설정에서도
// 안전히 로드됨 (POOLS 평가 throw 와 무관: pool 레지스트리를 import 하지 않음).
import {
  TOKEN_KEYS as CODEX_TOKEN_KEYS,
  getCodexTokenExpiry,
} from "../core/llm-runtime/adapters/openai-codex-oauth.js";

const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000; // 7일

const PAD = 30;

const splitPool = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

/**
 * provider 가 키를 읽는 env 이름 — **런타임과 같은 해석**(`resolveProviderConn`). `null` = 모르는 provider, `undefined` =
 * 키 없는 서버. ★종전엔 여기 손 목록을 따로 들고 있어, 사용자가 `settings.json` 에 정의한 provider(doctor 가 스스로
 *  안내한 ollama 연결 포함)를 «Unknown provider» 로 오진했다(적대 검토 2026-09-28 P5-3).
 */
const providerKeyEnv = (provider: string): string | undefined | null => {
  const conn = resolveProviderConn(provider);
  return conn === null ? null : conn.apiKeyEnv;
};

const line = (key: string, body: string): string =>
  `${key} ${".".repeat(Math.max(1, PAD - key.length))} ${body}`;

// --- read-only 네트워크 핑 helper (빌트인 fetch, 새 의존성 0) ---

/**
 * Telegram getMe — read-only. getUpdates 가 아니므로 라이브 폴러와 충돌(409) 없음.
 * 네트워크/인증 실패는 흡수하여 ok=false 반환.
 */
const telegramGetMe = async (
  token: string,
): Promise<{ ok: boolean; username?: string }> => {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as {
      ok?: boolean;
      result?: { username?: string };
    };
    if (json.ok === true && typeof json.result?.username === "string") {
      return { ok: true, username: json.result.username };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
};

/**
 * 데몬 health 핑 — http://localhost:<port>/health GET. 이미 떠있는 서비스에
 * read-only 핑만 (데몬 start 금지). 실패는 흡수하여 up=false 반환.
 */
const daemonHealth = async (
  port: string,
): Promise<{ up: boolean; channelHandler?: boolean }> => {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { up: false };
    const json = (await res.json()) as {
      ok?: boolean;
      channel_handler?: boolean;
    };
    if (json.ok === true) {
      return { up: true, channelHandler: json.channel_handler };
    }
    return { up: false };
  } catch {
    return { up: false };
  }
};

const main = async (): Promise<void> => {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`tiguclaw doctor (${today})`);
  console.log("");

  let fatal = 0;
  const issues: string[] = [];
  const warnings: string[] = []; // 곧 문제될 수 있는 주의(비차단).

  // ─── [install] — 여기가 **가장 먼저**다 ────────────────────────────────────────
  //  네이티브 모듈이 안 열리면 아래 전부가 무의미하고, 실제로 그 상태에서 데몬은 부팅마다
  //  죽는다(실측: 6회 연속). 종전엔 이 진단 자체가 모듈 로드 단계에서 같이 죽어 **한 줄도
  //  안 찍혔다** — 그래서 사용자가 로그를 손으로 보내야 했다.
  console.log("[install]");
  const native = await probeNativeModule();
  if (native.ok) {
    console.log(line("better-sqlite3", "load ✅"));
  } else {
    const { describeNativeLoadFailure } = await import("../store/sessions.js").catch(
      () => ({ describeNativeLoadFailure: () => null }) as never,
    );
    const hint = describeNativeLoadFailure(native.message) as string | null;
    console.log(line("better-sqlite3", "❌ cannot load"));
    console.log(
      hint ??
        "  Cannot load the SQLite native module — fix: `tiguclaw update`\n  Original error: " +
          native.message,
    );
    fatal += 1;
    issues.push(
      "The native module (better-sqlite3) won't load — in this state the daemon crashes on every boot. Fix: `tiguclaw update`",
    );
  }

  // ★기준은 **이 doctor 가 속한 설치**다(cwd 가 아니라). `tiguclaw doctor` 는 아무 폴더에서나
  //  실행되므로 cwd 를 쓰면 "다른 설치" 오탐이 난다 — 첫 판이 그랬다.
  const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cmd = judgeGlobalCommand(
    resolveGlobalCommand(),
    installRoot,
    resolveLinkedInstall(),
  );
  console.log(line("tiguclaw command", cmd.kind === "ok" ? `${cmd.detail} ✅` : `⚠️  ${cmd.detail}`));
  if (cmd.kind !== "ok") {
    console.log(`  ${cmd.fix}`);
    warnings.push(`Global \`tiguclaw\` command: ${cmd.detail}`);
  }
  console.log("");

  // ★네이티브가 죽었으면 여기서 멈춘다 — 아래는 전부 DB 를 만지므로 같은 에러를 반복할
  //  뿐이고, 진짜 원인이 그 소음에 묻힌다(로그가 1차 진단면이라는 원칙).
  if (!native.ok) {
    console.log("══════════════════════════════════════════");
    console.log("🔴 Fix the native module first — the remaining checks only mean something after that.");
    console.log("   " + issues[0]);
    console.log("══════════════════════════════════════════");
    process.exitCode = 1;
    return;
  }

  const { initStore, getDb, resolveDataDir } = await import("../store/sessions.js");
  const { listActive } = await import("../store/bridge-tokens.js");
  const { listSchedules } = await import("../store/schedules.js");
  const { listWatches } = await import("../store/watches.js");

  // [env]
  console.log("[env]");
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  const hasRegionAAuth = anthropicKey.length > 0 || oauthToken.length > 0;
  if (anthropicKey.length > 0) {
    console.log(line("ANTHROPIC_API_KEY", "set ✅"));
  } else if (oauthToken.length > 0) {
    console.log(line("ANTHROPIC_API_KEY", "not set ⚠️  (anthropic adapter disabled)"));
  } else {
    console.log(line("ANTHROPIC_API_KEY", "not set ❌"));
  }
  if (oauthToken.length > 0) {
    console.log(line("CLAUDE_CODE_OAUTH_TOKEN", "set ✅"));
  }
  if (!hasRegionAAuth) {
    fatal += 1;
    // ★구독 인증이 이 설치에 **없으면 권하지 않는다** (2026-09-01). 그 토큰을 채워도
    //  등록할 플러그인이 없어 아무 일도 안 난다 — 없는 길을 처방하는 셈이다.
    const claudeSub = subscriptionAuthAvailable("claude-subscription");
    issues.push(
      claudeSub
        ? "No LLM credentials — set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (or another provider key) in .env / npm run init"
        : "No LLM credentials — set ANTHROPIC_API_KEY (or another provider key) in .env / npm run init",
    );
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (telegramToken.length > 0) {
    console.log(line("TELEGRAM_BOT_TOKEN", "set ✅"));
  } else {
    console.log(line("TELEGRAM_BOT_TOKEN", "not set ⚠️  (Telegram disabled)"));
  }

  // ★기본 모델 풀은 **런타임과 같은 해석**으로 본다 (2026-09-29) — 종전엔 옛 `.env` 의 `REGION_A_MODELS` 를 읽어,
  //  프로파일로 도는 설치에서도 그게 비면 치명(❌)으로 셌다. 순서: 사용자 기본 프로파일 → 빌트인(자동).
  //  ★사용자 프로파일이 없을 때(빌트인)는 비어도 치명으로 세지 않는다 — doctor 는 구독 인증 플러그인을 띄우지 않아
  //   데몬보다 적게 볼 수 있다(거짓 경보 금지). 그땐 «데몬이 인증된 provider 로 조립» 이라고 말한다.
  // 출처 판정은 `/model` 과 같은 함수(`describeBasePool`) — 두 곳이 따로 판정하면 다르게 말한다.
  const base = describeBasePool();
  const regionAPool = base.specs.map(specLabel);
  const poolName = base.source === "profile" ? `Default model pool (profile '${base.profile}')` : "Default model pool (built-in — auto)";
  if (base.profileUnresolved !== undefined) {
    // 기본 프로파일이 있는데 풀리지 않는다 — 런타임은 빌트인으로 돈다. 치명은 아니지만 사용자가 적은 게 안 먹는 상태다.
    console.log(line(poolName, `${regionAPool.join(", ") || "(none)"} ⚠️  (default profile '${base.profileUnresolved}' does not resolve)`));
    issues.push(`The pool of default profile '${base.profileUnresolved}' does not resolve, so the built-in pool is used — check models.profiles in settings.json`);
  } else if (regionAPool.length >= 1) {
    console.log(line(poolName, `${regionAPool.join(", ")} ✅`));
  } else {
    console.log(line(poolName, "the daemon builds it from the latest models of signed-in providers"));
  }

  // codex OAuth 토큰 진단 (region A 인증 직후) — V5 관측 공백 메우기.
  // access+refresh 만료 시 폴백 60s 지연이 조용히 발생하던 사각지대를 정적으로 노출.
  // [access(TOKEN), refresh(REFRESH), expires(EXPIRES)] 순.
  const [accessKey, refreshKey, expiresKey] = CODEX_TOKEN_KEYS;
  const codexAccess = process.env[accessKey] ?? "";
  const codexRefresh = process.env[refreshKey] ?? "";
  const codexExpires = process.env[expiresKey] ?? "";
  const anyCodexTokenSet =
    codexAccess.length > 0 ||
    codexRefresh.length > 0 ||
    codexExpires.length > 0;
  const regionAUsesCodex = regionAPool.some((t) => t.startsWith("codex:"));
  // ★**이 설치에 codex 구독 인증이 없으면 아예 안 묻는다** (2026-09-01 사용자 지시).
  //  v0.45.0 부터 구독 인증은 번들 플러그인이다 — 그 폴더를 뺀 설치에서 *"npm run
  //  codex-auth 로 발급하세요"* 라고 안내하면, 발급해도 등록할 곳이 없어 아무 일도 안 난다.
  //  없는 능력을 진단하고 처방까지 주는 상태였다. 판정은 플러그인이 **선언한 것**을 읽는다.
  const codexAuthInstalled = subscriptionAuthAvailable("codex");
  // 조건부: (구독 인증이 설치돼 있고) 토큰이 하나라도 있거나 기본 모델 풀에 codex 가
  // 있을 때만 점검. 아니면 침묵 (불필요 noise 금지).
  if (codexAuthInstalled && (anyCodexTokenSet || regionAUsesCodex)) {
    if (!anyCodexTokenSet && regionAUsesCodex) {
      // codex 풀에 등장했는데 토큰 0 — 폴백만 가능, 경고.
      console.log(
        line(
          "codex OAuth",
          "no token ⚠️  (codex is in the default model pool — get one with npm run codex-auth)",
        ),
      );
    } else {
      const set = (v: string): string => (v.length > 0 ? "set ✅" : "not set ❌");
      console.log(line(accessKey, set(codexAccess)));
      console.log(line(refreshKey, set(codexRefresh)));
      console.log(line(expiresKey, set(codexExpires)));

      // access 만료 상태 — getCodexTokenExpiry 로 epoch ms 파싱 (env 진실 소스).
      const expiry = getCodexTokenExpiry();
      const now = Date.now();
      let needsReauth = false;
      if (codexAccess.length === 0) {
        console.log(line("codex access status", "no access token ❌"));
        needsReauth = true;
      } else if (expiry === undefined) {
        console.log(
          line("codex access status", `${expiresKey} unreadable ⚠️  (expiry time unknown)`),
        );
      } else {
        const remainingMs = expiry - now;
        if (remainingMs <= 0) {
          const agoSec = Math.round(-remainingMs / 1000);
          console.log(
            line("codex access status", `expired ❌ (${agoSec}s ago)`),
          );
          needsReauth = true;
        } else if (remainingMs <= EXPIRY_SOON_MS) {
          const remSec = Math.round(remainingMs / 1000);
          console.log(
            line(
              "codex access status",
              `expires soon ⚠️  (~${remSec}s left, ≤7d)`,
            ),
          );
          needsReauth = true;
        } else {
          const remSec = Math.round(remainingMs / 1000);
          console.log(
            line("codex access status", `valid ✅ (~${remSec}s left)`),
          );
        }
      }

      // refresh 키는 *형식상* 존재만 확인 — 실제 유효성(refresh_token_reused 등)은
      // 런타임 갱신 시도에서만 드러남. 여기선 존재 여부까지만.
      if (codexRefresh.length > 0) {
        console.log(
          line(
            "codex refresh",
            "present ✅  (auto-refresh should work — whether it is actually valid only shows at runtime)",
          ),
        );
      } else {
        console.log(
          line("codex refresh", "missing ⚠️  (cannot auto-refresh when access expires)"),
        );
        if (codexAccess.length > 0) needsReauth = true;
      }

      if (needsReauth) {
        console.log(line("codex next step", "get a new token with npm run codex-auth"));
        warnings.push(
          "codex token expired (or about to) — get a new one with npm run codex-auth (until then only the codex fallback works)",
        );
      }
    }
  }

  // provider key 동적 진단 — 풀에 등장한 provider 만, anthropic 은 위에 표시되었으므로 skip
  const providers = new Set<string>();
  for (const tok of regionAPool) {
    const provider = tok.split(":")[0];
    if (provider !== undefined && provider.length > 0) {
      providers.add(provider);
    }
  }
  for (const provider of providers) {
    // anthropic=위 ANTHROPIC_API_KEY 라인 / codex=OAuth 섹션에서 별도 표시(env 키 없음).
    if (provider === "anthropic" || provider === "codex") continue;
    const envName = providerKeyEnv(provider);
    if (envName === null) {
      console.log(line(`provider:${provider}`, `Unknown provider ⚠️`));
      continue;
    }
    if (envName === undefined) {
      console.log(line(`provider:${provider}`, "keyless server (settings.json) ✅"));
      continue;
    }
    const value = process.env[envName] ?? "";
    if (value.length > 0) {
      console.log(line(envName, "set ✅"));
    } else {
      console.log(line(envName, `not set ⚠️  (${provider} is in the pool)`));
    }
  }

  // ★내장 ollama 를 뺐다(2026-09-28) — 옛 설치의 `OLLAMA_BASE_URL` 은 더 이상 읽지 않는다. 값이 있는데 settings.json 에
  //  연결이 없으면 그 설치본은 ollama 를 쓰다 끊긴 것이므로 옮기는 법을 알린다(비어 있는 줄은 «안 쓴다» 라 조용히 둔다).
  //  ★그 주소를 쓰는 provider 가 이미 있으면(이름이 ollama 가 아니어도) 옮긴 것이다 — 이름으로만 보면 오탐이다(P5-3).
  const legacyOllama = (process.env.OLLAMA_BASE_URL ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  //  ★이름이 ollama 인 provider 가 **쓸 수 있게** 있으면 주소가 달라도(다른 호스트·127.0.0.1↔localhost) 옮긴 것이다(재검토 참고).
  //   «적혀만 있음» 이 아니라 런타임 해석(`resolveProviderConn`)으로 본다 — 모르는 adapter 로 적은 항목은 옮긴 게 아니다.
  const userProviders = loadModelProviders();
  const ollamaMigrated = resolveProviderConn("ollama") !== null || Object.entries(userProviders).some(
    ([n, p]) => resolveProviderConn(n) !== null && (p.baseURL ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "") === legacyOllama,
  );
  if (legacyOllama !== "" && !ollamaMigrated) {
    console.log(line("OLLAMA_BASE_URL", "no longer read ⚠️"));
    warnings.push(
      "`OLLAMA_BASE_URL` is no longer read — to use ollama, add " +
        '`"models": { "providers": { "ollama": { "adapter": "openai", "baseURL": "<address>/v1", "apiKeyEnv": null } } }` to settings.json.',
    );
  }

  console.log("");

  // [store]
  console.log("[store]");
  // V9.2 — DATA_DIR 미설정 시 getPaths().data (sessions.ts 와 동일 규칙).
  const dataDir = resolveDataDir();
  const dbPath = path.join(dataDir, "tiguclaw.db");
  let storeOk = false;
  let threadsCount = 0;
  try {
    initStore();
    const db = getDb();
    threadsCount = (db
      .prepare("SELECT COUNT(*) AS c FROM threads")
      .get() as { c: number }).c;
    storeOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(line(dbPath, `❌ open failed: ${msg}`));
    fatal += 1;
    issues.push(`Failed to open the DB — check permissions/path for ${dbPath}`);
  }
  if (storeOk) {
    console.log(line(dbPath, `✅ open, threads=${threadsCount}`));
  }

  console.log("");

  // [channels]
  console.log("[channels]");
  console.log(line("cli", "active ✅"));
  if (telegramToken.length > 0) {
    console.log(line("telegram", "active ✅"));
  } else {
    console.log(line("telegram", "disabled ❌ (no TELEGRAM_BOT_TOKEN)"));
  }

  console.log("");

  // [telegram] — 봇 토큰 유효성 + allowlist 잠금 상태 (read-only getMe)
  console.log("[telegram]");
  if (telegramToken.length === 0) {
    console.log(line("telegram", "disabled (no TELEGRAM_BOT_TOKEN)"));
  } else {
    const me = await telegramGetMe(telegramToken);
    if (me.ok && me.username !== undefined) {
      console.log(line("bot token", `valid ✅ (@${me.username})`));
    } else {
      console.log(line("bot token", "invalid or unreachable ❌"));
      issues.push(
        "Telegram bot token is invalid or unreachable — check TELEGRAM_BOT_TOKEN in .env / npm run init",
      );
      fatal += 1;
    }

    const allowlist = splitPool(process.env.TELEGRAM_ALLOWED_USER_IDS);
    if (allowlist.length === 0) {
      console.log(
        line("allowlist", "empty ❌ (bot locked — nobody can use it)"),
      );
      issues.push(
        "TELEGRAM_ALLOWED_USER_IDS is empty, so the bot is locked — add the owner's user id to .env / npm run init detects it automatically",
      );
    } else {
      console.log(line("allowlist", `${allowlist.length} allowed ✅`));
    }
  }

  console.log("");

  // [runtime]
  console.log("[runtime]");
  if (hasRegionAAuth) {
    console.log(line("LLM runtime", "ready ✅"));
  } else {
    console.log(line("LLM runtime", "not ready ❌"));
  }

  console.log("");

  // [daemon] — ★ "작동하나" 핵심. 이미 떠있는 데몬에 read-only health 핑.
  console.log("[daemon]");
  const bridgePort =
    (process.env.HTTP_BRIDGE_PORT ?? "7011").trim() || "7011";
  const health = await daemonHealth(bridgePort);
  if (health.up) {
    console.log(
      line("daemon", `running ✅ (health ok, port ${bridgePort})`),
    );
    if (health.channelHandler === false) {
      console.log(line("channel handler", "not connected ⚠️"));
      issues.push(
        "The daemon is up but the channel handler is not connected — npm run daemon:restart",
      );
    }
  } else {
    console.log(line("daemon", `not responding ❌ (port ${bridgePort})`));
    issues.push(
      `The daemon is not responding (port ${bridgePort}) — it is not running or the port doesn't match. Check 'npm run daemon:status'; if it isn't there, run 'npm run daemon:install' or 'npm run dev'`,
    );
  }

  console.log("");

  // [permissions]
  console.log("[permissions]");
  if (DISALLOWED_TOOLS.length === 0) {
    console.log(line("DISALLOWED_TOOLS", "[] (V1 infrastructure only) ✅"));
  } else {
    console.log(
      line(
        "DISALLOWED_TOOLS",
        `[${DISALLOWED_TOOLS.join(", ")}] (${DISALLOWED_TOOLS.length}) ✅`,
      ),
    );
  }

  console.log("");

  // [tokens] — http-bridge 외부 access 토큰 진단 (V2 dashboard-v2)
  console.log("[tokens]");
  let activeCount = 0;
  let expiringSoonCount = 0;
  let roleCounts: Record<BridgeTokenRole, number> = {
    read: 0,
    write: 0,
    admin: 0,
  };
  let tokensOk = false;
  if (storeOk) {
    try {
      const now = Date.now();
      const rows = listActive();
      activeCount = rows.length;
      for (const r of rows) {
        roleCounts[r.role] += 1;
        if (
          r.expiresAt !== null &&
          r.expiresAt - now <= EXPIRY_SOON_MS
        ) {
          expiringSoonCount += 1;
        }
      }
      tokensOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(line("bridge_tokens", `❌ query failed: ${msg}`));
    }
  } else {
    console.log(line("bridge_tokens", "⚠️  cannot check — DB not open"));
  }
  if (tokensOk) {
    if (activeCount === 0) {
      const envFallback = (process.env.HTTP_BRIDGE_TOKEN ?? "").length > 0;
      const fallbackNote = envFallback
        ? " (HTTP_BRIDGE_TOKEN env fallback active, V1 mode)"
        : "";
      console.log(line("active tokens", `0 ⚠️${fallbackNote}`));
    } else {
      console.log(
        line(
          "active tokens",
          `${activeCount} ✅  (read=${roleCounts.read}, write=${roleCounts.write}, admin=${roleCounts.admin})`,
        ),
      );
    }
    if (expiringSoonCount > 0) {
      console.log(
        line("expiring (≤7d)", `${expiringSoonCount} ⚠️`),
      );
    }
  }

  console.log("");

  // [schedules] — scheduler v1/v1.1 진단 (bridge_tokens 동형)
  console.log("[schedules]");
  let schedulesActive = 0;
  let schedulesTotal = 0;
  let schedulesErrors = 0;
  let schedulesCron = 0;
  let schedulesReboot = 0;
  let schedulesOk = false;
  if (storeOk) {
    try {
      const rows = listSchedules();
      schedulesTotal = rows.length;
      for (const r of rows) {
        if (r.enabled) schedulesActive += 1;
        if (r.lastStatus === "error") schedulesErrors += 1;
        if (r.triggerType === "reboot") schedulesReboot += 1;
        else schedulesCron += 1;
      }
      schedulesOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(line("schedules", `❌ query failed: ${msg}`));
    }
  } else {
    console.log(line("schedules", "⚠️  cannot check — DB not open"));
  }
  if (schedulesOk) {
    if (schedulesTotal === 0) {
      console.log(line("active schedules", "0 ⚠️  (no triggers registered)"));
    } else {
      console.log(
        line(
          "active schedules",
          `${schedulesActive}/${schedulesTotal} ✅  (cron=${schedulesCron}, reboot=${schedulesReboot})`,
        ),
      );
    }
    if (schedulesErrors > 0) {
      console.log(
        line("last_error count", `${schedulesErrors} ⚠️  (last run failed)`),
      );
    }
  }

  console.log("");

  // [watches] — file-watch trigger v1 진단 (schedules 동형)
  console.log("[watches]");
  let watchesTotal = 0;
  let watchesEnabled = 0;
  let watchesLastFiredAt: number | null = null;
  if (storeOk) {
    try {
      const rows = listWatches();
      watchesTotal = rows.length;
      for (const r of rows) {
        if (r.enabled) watchesEnabled += 1;
        if (
          r.lastFiredAt !== null &&
          (watchesLastFiredAt === null || r.lastFiredAt > watchesLastFiredAt)
        ) {
          watchesLastFiredAt = r.lastFiredAt;
        }
      }
      const lastFiredStr =
        watchesLastFiredAt === null
          ? "never"
          : new Date(watchesLastFiredAt).toISOString();
      console.log(
        line(
          "active watches",
          watchesTotal === 0
            ? "0 ⚠️  (no watchers registered)"
            : `${watchesEnabled}/${watchesTotal} ✅  (last_fired=${lastFiredStr})`,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(line("watches", `❌ query failed: ${msg}`));
    }
  } else {
    console.log(line("watches", "⚠️  cannot check — DB not open"));
  }

  console.log("");

  // 문제 요약 — 한눈에 보이게 (★ "작동 안 하거나 문제 있을 때 잘 알려주기")
  console.log("");
  console.log("══════════════════════════════════════════");
  if (issues.length === 0 && warnings.length === 0) {
    console.log("✅ All good — tiguclaw is ready.");
  } else {
    if (issues.length > 0) {
      console.log(`🔴 ${issues.length} problem(s) (tiguclaw may not work):`);
      for (const it of issues) console.log(`   • ${it}`);
    }
    if (warnings.length > 0) {
      console.log(`🟡 ${warnings.length} warning(s):`);
      for (const w of warnings) console.log(`   • ${w}`);
    }
  }
  console.log("══════════════════════════════════════════");

  // ─── 검색 도구(ripgrep) ────────────────────────────────────────────────
  // ★Grep/Glob 이 이것 위에 선다. 없으면 **codex 계열이 검색을 통째로 잃는다**(claude 는 SDK
  //  내장이라 혼자 멀쩡해서, 같은 질문에 어댑터마다 다른 답이 나온다). 없으면 여기서 받는다.
  console.log("── Search (ripgrep)");
  const rg = await ensureRipgrep(getPaths().home);
  console.log(
    `${"ripgrep".padEnd(PAD)}${rg.ok ? (rg.installed ? "installed" : "OK") : "★missing"}  ${rg.detail}`,
  );
  if (!rg.ok) issues.push("ripgrep missing — Grep/Glob fail (codex-family adapters cannot search)");
  console.log("");

  // ─── Claude 실행기 ────────────────────────────────────────────────────
  // ★rg 와 **같은 축**이다 (2026-08-27): 우리가 부르는 실행기가 실제로 있는가. 종전엔 키만
  //  보고 통과시켰다 — **키는 있는데 실행기가 없는** 상태가 "정상" 으로 보였다.
  //  보통은 `npm ci` 가 의존성으로 같이 깐다(플랫폼별 optional). 없을 수 있는 경우는
  //  `--omit=optional` 설치와 미지원 플랫폼뿐이고, 둘 다 조치가 다르므로 그대로 말한다.
  //  ★rg 와 달리 **받아오지 않는다** — 전역 설치는 같은 259MB 를 두 벌로 만들고 버전이 갈린다.
  console.log("── Claude executable");
  const claudeBin = findBundledClaude();
  console.log(
    `${"claude".padEnd(PAD)}${claudeBin !== null ? "OK" : "★missing"}  ${claudeBin ?? bundledClaudeMissingHint()}`,
  );
  if (claudeBin === null) {
    issues.push(
      "Claude executable missing — the anthropic and Claude subscription providers will not work (rerun `npm ci`)",
    );
  }
  console.log("");

  // 「다음 단계」 — 우선순위 사다리, 첫 번째 결손만
  let nextStep: string;
  if (!hasRegionAAuth) {
    nextStep =
      (subscriptionAuthAvailable("claude-subscription")
        ? "Next step: set ANTHROPIC_API_KEY (https://console.anthropic.com/) or CLAUDE_CODE_OAUTH_TOKEN (get one with `claude setup-token`) in .env."
        : "Next step: set ANTHROPIC_API_KEY (https://console.anthropic.com/) in .env.");
  } else if (base.profileUnresolved !== undefined) {
    nextStep =
      `Next step: fix the pool of default profile '${base.profileUnresolved}' under models.profiles in settings.json.`;
  } else {
    let missingProviderEnv: string | null = null;
    for (const provider of providers) {
      // codex 는 env 키가 아니라 OAuth(`npm run codex-auth`) — 위 표시 루프와 같은 제외(재검토 P1: 토큰 env 를 채우라고 처방했다).
      if (provider === "anthropic" || provider === "codex") continue;
      const envName = providerKeyEnv(provider);
      if (envName === null || envName === undefined) continue;
      const value = process.env[envName] ?? "";
      if (value.length === 0) {
        missingProviderEnv = envName;
        break;
      }
    }
    // codex 는 env 키가 아니라 로그인이다 — 풀에 있는데 토큰이 없으면 그걸 처방한다(재검토 F3: 건너뛰기만 해서 첫 순위 모델이
    //  매 턴 실패하는데도 다음 단계가 «Telegram (선택)» 이었다). 구독 인증이 없는 설치본엔 없는 길이라 처방하지 않는다.
    const codexLoginNeeded = codexAuthInstalled && regionAUsesCodex && codexAccess.length === 0 &&
      (process.env[refreshKey] ?? "").length === 0;
    if (missingProviderEnv !== null) {
      nextStep = `Next step: set ${missingProviderEnv} in .env.`;
    } else if (codexLoginNeeded) {
      nextStep = "Next step: sign in to ChatGPT with `npm run codex-auth` (codex is in the pool but there is no token).";
    } else if (!storeOk) {
      nextStep =
        "Next step: check the DATA_DIR permissions/path (defaults to <TIGUCLAW_HOME>/data when unset).";
    } else if (telegramToken.length === 0) {
      nextStep =
        "Next step (optional): to use Telegram, set TELEGRAM_BOT_TOKEN in .env.";
    } else if (
      tokensOk &&
      activeCount === 0 &&
      (process.env.HTTP_BRIDGE_TOKEN ?? "").length === 0
    ) {
      nextStep =
        "Next step (optional): to use an external dashboard, issue a token with npm run bridge:grant -- --label <name> --role <read|write|admin> --expires 30d.";
    } else if (schedulesOk && schedulesErrors > 0) {
      nextStep =
        "Next step: to see the failed triggers, ask the assistant \"show my schedules\" or use /schedule list.";
    } else {
      nextStep =
        "Next step: run npm run dev and type a line on stdin, or send your Telegram bot a message.";
    }
  }
  console.log(nextStep);

  // ★종료코드는 **화면에 찍은 판정과 같아야 한다** (2026-08-20 적대 검토 B-F2).
  //  종전엔 `fatal` 카운터와 `issues` 배열이 **두 벌의 손 관리 목록**이었고 9곳 중 4곳이
  //  어긋났다 — 데몬 미응답 / 채널 핸들러 미연결 / **텔레그램 allowlist 빈값(봇 완전 잠김)** /
  //  ripgrep 없음. 그 상태에서 화면은 "🔴 문제 1개" 를 찍는데 종료코드는 **0**(정상)이었다.
  //  기계가 읽는 답과 사람이 읽는 답이 갈리면 자동화(CI·설치 스크립트·이슈 템플릿)가 속는다.
  //  ★숫자를 맞추는 게 아니라 **목록을 하나로** 한다 — 화면에 문제로 적은 것이 곧 실패다.
  //  (`fatal` 은 아래 참고용으로만 남긴다 — 안 맞으면 그 자체가 신호다.)
  if (fatal > 0 && issues.length === 0) {
    console.log(
      `⚠️ Internal mismatch: fatal=${fatal} but the problem list is empty — a check may be missing its report.`,
    );
  }
  process.exit(issues.length > 0 || fatal > 0 ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
