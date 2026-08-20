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
import { getPaths } from "../core/paths.js";
import type { BridgeTokenRole } from "../store/bridge-tokens.js";
import { judgeGlobalCommand, probeNativeModule, resolveGlobalCommand } from "./doctor-install.js";
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

const PROVIDER_KEY: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  ollama: "OLLAMA_BASE_URL",
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
    console.log(line("better-sqlite3", "❌ 열 수 없음"));
    console.log(
      hint ??
        "  SQLite 네이티브 모듈을 열 수 없습니다 — 조치: `tiguclaw update`\n  원문: " +
          native.message,
    );
    fatal += 1;
    issues.push(
      "네이티브 모듈(better-sqlite3)이 안 열립니다 — 이 상태로는 데몬이 부팅마다 죽습니다. 조치: `tiguclaw update`",
    );
  }

  // ★기준은 **이 doctor 가 속한 설치**다(cwd 가 아니라). `tiguclaw doctor` 는 아무 폴더에서나
  //  실행되므로 cwd 를 쓰면 "다른 설치" 오탐이 난다 — 첫 판이 그랬다.
  const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cmd = judgeGlobalCommand(resolveGlobalCommand(), installRoot);
  console.log(line("tiguclaw 명령", cmd.kind === "ok" ? `${cmd.detail} ✅` : `⚠️  ${cmd.detail}`));
  if (cmd.kind !== "ok") {
    console.log(`  ${cmd.fix}`);
    warnings.push(`전역 \`tiguclaw\` 명령: ${cmd.detail}`);
  }
  console.log("");

  // ★네이티브가 죽었으면 여기서 멈춘다 — 아래는 전부 DB 를 만지므로 같은 에러를 반복할
  //  뿐이고, 진짜 원인이 그 소음에 묻힌다(로그가 1차 진단면이라는 원칙).
  if (!native.ok) {
    console.log("══════════════════════════════════════════");
    console.log("🔴 네이티브 모듈부터 고쳐야 합니다 — 나머지 진단은 그 뒤에 의미가 있습니다.");
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
    console.log(line("ANTHROPIC_API_KEY", "not set ⚠️  (anthropic 어댑터 비활성)"));
  } else {
    console.log(line("ANTHROPIC_API_KEY", "not set ❌"));
  }
  if (oauthToken.length > 0) {
    console.log(line("CLAUDE_CODE_OAUTH_TOKEN", "set ✅"));
  }
  if (!hasRegionAAuth) {
    fatal += 1;
    issues.push(
      "LLM 인증 없음 — .env 에 ANTHROPIC_API_KEY 또는 CLAUDE_CODE_OAUTH_TOKEN(또는 다른 provider 키) 채우기 / npm run init",
    );
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (telegramToken.length > 0) {
    console.log(line("TELEGRAM_BOT_TOKEN", "set ✅"));
  } else {
    console.log(line("TELEGRAM_BOT_TOKEN", "not set ⚠️  (Telegram 비활성)"));
  }

  const regionAPool = splitPool(process.env.REGION_A_MODELS);
  if (regionAPool.length >= 1) {
    console.log(line("REGION_A_MODELS", `${regionAPool.join(", ")} ✅`));
  } else {
    console.log(line("REGION_A_MODELS", "비어있음 ❌"));
    fatal += 1;
    issues.push("REGION_A_MODELS 비어있음 — .env 에 provider:model 설정");
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
  // 조건부: 토큰이 하나라도 있거나 REGION_A_MODELS 에 codex 가 있을 때만 점검.
  // 둘 다 아니면 침묵 (불필요 noise 금지).
  if (anyCodexTokenSet || regionAUsesCodex) {
    if (!anyCodexTokenSet && regionAUsesCodex) {
      // codex 풀에 등장했는데 토큰 0 — 폴백만 가능, 경고.
      console.log(
        line(
          "codex OAuth",
          "토큰 없음 ⚠️  (REGION_A_MODELS 에 codex 있음 — npm run codex-auth 로 발급)",
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
        console.log(line("codex access 상태", "access 토큰 없음 ❌"));
        needsReauth = true;
      } else if (expiry === undefined) {
        console.log(
          line("codex access 상태", `${expiresKey} 파싱 불가 ⚠️  (만료 시각 미상)`),
        );
      } else {
        const remainingMs = expiry - now;
        if (remainingMs <= 0) {
          const agoSec = Math.round(-remainingMs / 1000);
          console.log(
            line("codex access 상태", `만료됨 ❌ (${agoSec}s 전)`),
          );
          needsReauth = true;
        } else if (remainingMs <= EXPIRY_SOON_MS) {
          const remSec = Math.round(remainingMs / 1000);
          console.log(
            line(
              "codex access 상태",
              `만료 임박 ⚠️  (~${remSec}s 남음, ≤7d)`,
            ),
          );
          needsReauth = true;
        } else {
          const remSec = Math.round(remainingMs / 1000);
          console.log(
            line("codex access 상태", `유효 ✅ (~${remSec}s 남음)`),
          );
        }
      }

      // refresh 키는 *형식상* 존재만 확인 — 실제 유효성(refresh_token_reused 등)은
      // 런타임 갱신 시도에서만 드러남. 여기선 존재 여부까지만.
      if (codexRefresh.length > 0) {
        console.log(
          line(
            "codex refresh",
            "존재 ✅  (형식상 자동 갱신 가능 — 실제 유효성은 런타임에만 확인)",
          ),
        );
      } else {
        console.log(
          line("codex refresh", "없음 ⚠️  (access 만료 시 자동 갱신 불가)"),
        );
        if (codexAccess.length > 0) needsReauth = true;
      }

      if (needsReauth) {
        console.log(line("codex 다음 단계", "npm run codex-auth 로 재발급"));
        warnings.push(
          "codex 토큰 만료(임박) — npm run codex-auth 로 재발급(안 하면 codex 폴백만 동작)",
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
    const envName = PROVIDER_KEY[provider];
    if (envName === undefined) {
      console.log(line(`provider:${provider}`, `Unknown provider ⚠️`));
      continue;
    }
    const value = process.env[envName] ?? "";
    if (value.length > 0) {
      console.log(line(envName, "set ✅"));
    } else {
      console.log(line(envName, `not set ⚠️  (${provider} 풀에 등장)`));
    }
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
    issues.push(`DB 열기 실패 — ${dbPath} 권한/경로 확인`);
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
    console.log(line("telegram", "disabled ❌ (TELEGRAM_BOT_TOKEN 부재)"));
  }

  console.log("");

  // [telegram] — 봇 토큰 유효성 + allowlist 잠금 상태 (read-only getMe)
  console.log("[telegram]");
  if (telegramToken.length === 0) {
    console.log(line("telegram", "비활성 (TELEGRAM_BOT_TOKEN 부재)"));
  } else {
    const me = await telegramGetMe(telegramToken);
    if (me.ok && me.username !== undefined) {
      console.log(line("봇 토큰", `유효 ✅ (@${me.username})`));
    } else {
      console.log(line("봇 토큰", "무효/도달 실패 ❌"));
      issues.push(
        "텔레그램 봇 토큰 무효/도달 실패 — .env TELEGRAM_BOT_TOKEN 확인 / npm run init",
      );
      fatal += 1;
    }

    const allowlist = splitPool(process.env.TELEGRAM_ALLOWED_USER_IDS);
    if (allowlist.length === 0) {
      console.log(
        line("allowlist", "비어있음 ❌ (봇 잠김 — 아무도 사용 불가)"),
      );
      issues.push(
        "TELEGRAM_ALLOWED_USER_IDS 비어 봇 잠김 — .env 에 소유자 user id 추가 / npm run init 자동감지",
      );
    } else {
      console.log(line("allowlist", `${allowlist.length}명 허용 ✅`));
    }
  }

  console.log("");

  // [runtime]
  console.log("[runtime]");
  if (hasRegionAAuth) {
    console.log(line("LLM 런타임", "ready ✅"));
  } else {
    console.log(line("LLM 런타임", "not ready ❌"));
  }

  console.log("");

  // [daemon] — ★ "작동하나" 핵심. 이미 떠있는 데몬에 read-only health 핑.
  console.log("[daemon]");
  const bridgePort =
    (process.env.HTTP_BRIDGE_PORT ?? "7011").trim() || "7011";
  const health = await daemonHealth(bridgePort);
  if (health.up) {
    console.log(
      line("데몬", `가동 중 ✅ (health ok, port ${bridgePort})`),
    );
    if (health.channelHandler === false) {
      console.log(line("채널 핸들러", "미연결 ⚠️"));
      issues.push(
        "데몬은 떴으나 채널 핸들러 미연결 — npm run daemon:restart",
      );
    }
  } else {
    console.log(line("데몬", `미응답 ❌ (port ${bridgePort})`));
    issues.push(
      `데몬이 응답하지 않음 (port ${bridgePort}) — 안 떠있거나 포트 불일치. 'npm run daemon:status' 확인, 없으면 'npm run daemon:install' 또는 'npm run dev'`,
    );
  }

  console.log("");

  // [permissions]
  console.log("[permissions]");
  if (DISALLOWED_TOOLS.length === 0) {
    console.log(line("DISALLOWED_TOOLS", "[] (V1 인프라만) ✅"));
  } else {
    console.log(
      line(
        "DISALLOWED_TOOLS",
        `[${DISALLOWED_TOOLS.join(", ")}] (${DISALLOWED_TOOLS.length}개) ✅`,
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
    console.log(line("bridge_tokens", "⚠️  DB 미오픈으로 진단 불가"));
  }
  if (tokensOk) {
    if (activeCount === 0) {
      const envFallback = (process.env.HTTP_BRIDGE_TOKEN ?? "").length > 0;
      const fallbackNote = envFallback
        ? " (HTTP_BRIDGE_TOKEN env 폴백 활성, V1 모드)"
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
    console.log(line("schedules", "⚠️  DB 미오픈으로 진단 불가"));
  }
  if (schedulesOk) {
    if (schedulesTotal === 0) {
      console.log(line("active schedules", "0 ⚠️  (등록된 트리거 없음)"));
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
        line("last_error count", `${schedulesErrors} ⚠️  (직전 발화 실패)`),
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
            ? "0 ⚠️  (등록된 watcher 없음)"
            : `${watchesEnabled}/${watchesTotal} ✅  (last_fired=${lastFiredStr})`,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(line("watches", `❌ query failed: ${msg}`));
    }
  } else {
    console.log(line("watches", "⚠️  DB 미오픈으로 진단 불가"));
  }

  console.log("");

  // 문제 요약 — 한눈에 보이게 (★ "작동 안 하거나 문제 있을 때 잘 알려주기")
  console.log("");
  console.log("══════════════════════════════════════════");
  if (issues.length === 0 && warnings.length === 0) {
    console.log("✅ 전부 정상 — tiguclaw 작동 준비됨.");
  } else {
    if (issues.length > 0) {
      console.log(`🔴 문제 ${issues.length}개 (작동 안 할 수 있음):`);
      for (const it of issues) console.log(`   • ${it}`);
    }
    if (warnings.length > 0) {
      console.log(`🟡 주의 ${warnings.length}개:`);
      for (const w of warnings) console.log(`   • ${w}`);
    }
  }
  console.log("══════════════════════════════════════════");

  // ─── 검색 도구(ripgrep) ────────────────────────────────────────────────
  // ★Grep/Glob 이 이것 위에 선다. 없으면 **codex 계열이 검색을 통째로 잃는다**(claude 는 SDK
  //  내장이라 혼자 멀쩡해서, 같은 질문에 어댑터마다 다른 답이 나온다). 없으면 여기서 받는다.
  console.log("── 검색(ripgrep)");
  const rg = await ensureRipgrep(getPaths().home);
  console.log(
    `${"ripgrep".padEnd(PAD)}${rg.ok ? (rg.installed ? "설치함" : "OK") : "★없음"}  ${rg.detail}`,
  );
  if (!rg.ok) issues.push("ripgrep 없음 — Grep/Glob 실패(codex 계열 검색 불가)");
  console.log("");

  // 「다음 단계」 — 우선순위 사다리, 첫 번째 결손만
  let nextStep: string;
  if (!hasRegionAAuth) {
    nextStep =
      "다음 단계: .env 에 ANTHROPIC_API_KEY (https://console.anthropic.com/) 또는 CLAUDE_CODE_OAUTH_TOKEN (claude setup-token 명령으로 발급) 를 채우세요.";
  } else if (regionAPool.length === 0) {
    nextStep =
      "다음 단계: .env.example 의 REGION_A_MODELS 라인을 .env 로 복사하세요.";
  } else {
    let missingProviderEnv: string | null = null;
    for (const provider of providers) {
      if (provider === "anthropic") continue;
      const envName = PROVIDER_KEY[provider];
      if (envName === undefined) continue;
      const value = process.env[envName] ?? "";
      if (value.length === 0) {
        missingProviderEnv = envName;
        break;
      }
    }
    if (missingProviderEnv !== null) {
      nextStep = `다음 단계: .env 에 ${missingProviderEnv} 을 채우세요.`;
    } else if (!storeOk) {
      nextStep =
        "다음 단계: DATA_DIR 권한/경로를 확인하세요 (미설정 시 기본 <TIGUCLAW_HOME>/data).";
    } else if (telegramToken.length === 0) {
      nextStep =
        "다음 단계: Telegram 을 쓰려면 .env 에 TELEGRAM_BOT_TOKEN 을 채우세요 (선택).";
    } else if (
      tokensOk &&
      activeCount === 0 &&
      (process.env.HTTP_BRIDGE_TOKEN ?? "").length === 0
    ) {
      nextStep =
        "다음 단계: 외부 dashboard 를 쓰려면 npm run bridge:grant -- --label <name> --role <read|write|admin> --expires 30d 으로 토큰을 발급하세요 (선택).";
    } else if (schedulesOk && schedulesErrors > 0) {
      nextStep =
        "다음 단계: 실패한 트리거를 확인하려면 비서에게 자연어로 \"스케줄 목록 보여줘\" 또는 /schedule list 를 사용하세요.";
    } else {
      nextStep =
        "다음 단계: npm run dev → stdin 에 한 줄 입력하거나 Telegram 봇에 메시지를 보내세요.";
    }
  }
  console.log(nextStep);

  process.exit(fatal > 0 ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
