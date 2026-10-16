/**
 * 온보딩의 도착점 — **대시보드에서 첫 대화를 할 수 있는 상태**까지 (2026-10-16, 아스트라 인계 «대시보드 중심 온보딩»).
 *
 * ★종전 `tiguclaw onboard` 는 doctor 결과를 버리고 무조건 «Onboard complete!» 를 찍은 뒤 «텔레그램 봇에게 말해 보라» 로 끝났다.
 *  텔레그램을 안 쓴 사용자는 다음에 뭘 할지 몰랐고, 서비스가 안 떴어도 완료라고 했다. 대시보드가 주 화면이다(정태님).
 *
 * 리프 모듈이다 — CLI(`src/cli.ts`)를 import 하면 회귀가 판정을 실행할 수 없다(import 가 CLI 를 돈다, onboard-provider 와 같은 이유).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import util from "node:util";

/**
 * `.env` 본문 해석 — **데몬과 같은 파서**(`util.parseEnv` = 데몬의 `process.loadEnvFile`)로 (2026-10-16 레드팀 B F1).
 * ★정규식으로 읽으면 `KEY=18080 # 메모`·`KEY = 값`·`export KEY=`·같은 키 두 번에서 데몬과 다른 값을 봐, 서비스는 정상인데 «안 끝났다»
 *  로 끝나거나 엉뚱한 주소를 열었다(같은 부류를 `bin/daemon.mjs` 가 10-03 에 이미 고쳤다). parseEnv 가 없는 Node(<20.12)는 데몬도
 *  못 뜨므로 옛 규칙으로만 버틴다.
 */
const parseEnvBody = (body: string): Record<string, string> => {
  const parse = (util as { parseEnv?: (s: string) => Record<string, string> }).parseEnv;
  if (typeof parse === "function") return parse(body);
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m !== null) out[m[1]!] = (m[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
};

/** `.env` 본문에서 키 하나(없거나 비면 undefined) — 데몬과 같은 해석. */
export const envKeyFromBody = (body: string, key: string): string | undefined => {
  const v = parseEnvBody(body)[key];
  return v === undefined || v === "" ? undefined : v;
};

/**
 * 데몬이 보는 순서대로 값을 찾는다 — 홈 `.env` → (윈도우만) 설치 때 붙잡은 실행 환경 → 레포 `.env`(옛 설치 폴백).
 * ★셸 환경을 맨 앞에 두지 않는다 (2026-10-16 좁은 재검토 P1) — 맥·리눅스의 launchd·systemd 유닛은 데몬에 `TIGUCLAW_HOME`·
 *  `TIGUCLAW_RUNTIME`·`PATH` 만 넘긴다. onboard 셸의 `DASHBOARD_PORT` 는 데몬에 안 닿는데 그걸 이긴다고 보면, 서비스는 정상인데
 *  엉뚱한 포트를 두드려 «안 끝났다» 로 끝나거나 그 포트의 다른 인스턴스를 «준비됨» 으로 읽었다. 윈도우는 설치 셸의 값을
 *  `win-service-env.json` 에 붙잡아 쓰되 홈 `.env` 가 이긴다(`bin/daemon.mjs winLaunchEnv`) — 그래서 `serviceEnv` 는 홈 다음이다.
 *  ★윈도우의 `serviceEnv` 는 셸 환경이 아니라 **그 붙잡은 파일**이다(재검토 2차 P2) — 레포 `.env` 가 정한 키는 붙잡지 않으므로
 *   (`saveWinServiceEnv`) 셸 값을 넣으면 레포 값을 이긴다고 잘못 본다.
 * ★**있음**으로 판정한다(P2) — 홈 `.env` 의 `KEY=` 는 데몬에서 레포 값을 막고 빈 값(=기본값)이 된다(`loadEnvFile` 은 이미 있는
 *  키를 안 덮는다). 빈 값을 «없음» 으로 보면 레포로 넘어가 데몬과 갈린다.
 */
export const daemonEnvLookup = (
  serviceEnv: NodeJS.ProcessEnv,
  homeBody: string,
  repoBody: string,
): ((key: string) => string | undefined) => {
  const home = parseEnvBody(homeBody);
  const repo = parseEnvBody(repoBody);
  return (key) => {
    const v = Object.hasOwn(home, key) ? home[key] : serviceEnv[key]?.trim() || repo[key];
    return v === undefined || v.trim() === "" ? undefined : v;
  };
};

/**
 * 이 설치본의 데몬이 볼 값 — 홈 `.env` 와 레포 `.env` 를 읽어 위 순서로. onboard 와 init 이 같은 해석을 쓴다(두 곳이 따로 읽으면 갈린다).
 *  설치 때 실행 환경은 윈도우에서만, 홈의 `win-service-env.json` 으로 센다(위 주석 — 맥·리눅스 서비스엔 안 닿는다).
 *  그 파일이 깨졌으면 데몬이 기동을 거절하므로 없는 것으로 본다.
 */
export const installedEnvLookup = (
  homeEnvPath: string,
  repoDir: string,
  platform: NodeJS.Platform = process.platform,
): ((key: string) => string | undefined) => {
  const readOr = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  let saved: NodeJS.ProcessEnv = {};
  if (platform === "win32") {
    try {
      const raw = JSON.parse(readOr(path.join(path.dirname(homeEnvPath), "win-service-env.json")) || "{}") as Record<string, unknown>;
      saved = Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      saved = {};
    }
  }
  return daemonEnvLookup(saved, readOr(homeEnvPath), readOr(path.join(repoDir, ".env")));
};

/** 모든 주소 바인딩이면 이 기계에서 두드릴 주소는 루프백. */
const localHostOf = (raw: string | undefined): string => {
  const h = raw?.trim() || "127.0.0.1";
  return h === "0.0.0.0" || h === "::" || h === "[::]" ? "127.0.0.1" : h;
};
const urlHost = (h: string): string => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

/**
 * 이 설치본의 로컬 대시보드 주소 — 설정(`DASHBOARD_HOST`·`DASHBOARD_PORT`)을 따른다. 기본값은 코드 정본과 같다(회귀
 *  `default-port-truth` 가 대조한다). 모든 주소에 바인딩(`0.0.0.0`·`::`)했으면 이 기계에서 여는 주소는 루프백이다.
 * ★공개 바인딩으로 바꾸지 않는다 — 원격 접근은 사용자가 정한 접근 제어(tailscale serve 등)를 따른다.
 */
export const dashboardUrl = (get: (key: string) => string | undefined): string => {
  const port = get("DASHBOARD_PORT")?.trim() || "17010";
  return `http://${urlHost(localHostOf(get("DASHBOARD_HOST")))}:${port}`;
};

/** `.env` 본문 기준(온보딩 — 데몬이 읽을 바로 그 파일). */
export const dashboardUrlFromEnv = (body: string): string => dashboardUrl((k) => envKeyFromBody(body, k));

/** 브리지 health 주소 — 대시보드 프록시와 같은 규칙(`HTTP_BRIDGE_HOST`, 기본 루프백). 기본 포트는 코드 정본과 같다. */
export const bridgeHealthUrl = (get: (key: string) => string | undefined): string =>
  `http://${urlHost(localHostOf(get("HTTP_BRIDGE_HOST")))}:${get("HTTP_BRIDGE_PORT")?.trim() || "17011"}/health`;

export interface ReadyResult {
  /** 데몬이 health 에 ok 로 답했나. */
  daemon: boolean;
  /** 대시보드가 페이지를 내줬나. */
  dashboard: boolean;
  waitedMs: number;
}

/**
 * 서비스 준비를 **유한한 시간** 안에 확인한다 — 데몬(`/health`)과 대시보드(페이지)를 둘 다 본다. 무한 대기하지 않고, 시한이
 *  지나면 어느 쪽이 안 됐는지 돌려준다(성공으로 표시하지 않는다).
 */
export const waitForServiceReady = async (o: {
  bridgePort?: string;
  /** 브리지 health 주소 — 주면 `bridgePort` 대신 이걸 두드린다(호스트까지 설정을 따른다). */
  healthUrl?: string;
  dashboardUrl: string;
  /** 대시보드 모듈을 꺼 둔 설치 — 대시보드는 기다리지 않는다(꺼 둔 것을 «실패» 로 세지 않는다). */
  skipDashboard?: boolean;
  timeoutMs: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  /** 부르는 쪽이 그만 기다리게 할 때(회귀 — 시한을 못 지키는 판정이 들어와도 프로세스를 붙잡지 않게). */
  signal?: AbortSignal;
}): Promise<ReadyResult> => {
  const f = o.fetchImpl ?? fetch;
  const start = Date.now();
  let daemon = false;
  let dashboard = o.skipDashboard === true;
  const probe = async (url: string, isHealth: boolean): Promise<boolean> => {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return false;
      if (!isHealth) return true;
      const j = (await res.json()) as { ok?: boolean };
      return j.ok === true;
    } catch {
      return false;
    }
  };
  for (;;) {
    if (!daemon) daemon = await probe(o.healthUrl ?? `http://127.0.0.1:${o.bridgePort}/health`, true);
    if (!dashboard) dashboard = await probe(o.dashboardUrl, false);
    if ((daemon && dashboard) || Date.now() - start >= o.timeoutMs || o.signal?.aborted === true) break;
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 1000));
  }
  return { daemon, dashboard, waitedMs: Date.now() - start };
};

/**
 * 브라우저를 열어도 되는 자리인가 — SSH 로 들어온 세션이나 화면이 없는 리눅스에선 열지 않는다(열 화면이 없거나 원격 기계에서 연다).
 *  못 열어도 설치 실패가 아니다 — 주소를 보여주면 된다.
 */
export const canOpenBrowser = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean => {
  if ((env.SSH_CONNECTION ?? "") !== "" || (env.SSH_TTY ?? "") !== "") return false;
  if (platform === "darwin" || platform === "win32") return true;
  return (env.DISPLAY ?? "") !== "" || (env.WAYLAND_DISPLAY ?? "") !== "";
};

/** 이 OS 에서 경로·주소를 기본 앱으로 여는 명령 — darwin=open · win32=explorer · 그 외=xdg-open. */
export const systemOpener = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";

/** 기본 브라우저로 연다 — 결과를 기다리지 않는다(fire-and-forget). Windows explorer 는 성공해도 exit 1 이라 결과로 판정하지 않는다. */
export const openInBrowser = (url: string, platform: NodeJS.Platform = process.platform): void => {
  try {
    execFile(systemOpener(platform), [url], () => undefined).unref();
  } catch {
    /* 못 열어도 주소는 이미 보여줬다 */
  }
};

/**
 * `init` 마법사 끝의 «다음 단계» (2026-10-16 아스트라 «초보자 설치 검토» 3번).
 * ★onboard 가 부른 init 은 수동 단계를 늘어놓지 않는다 — onboard 가 로그인·빌드·서비스 등록·준비 확인을 이어서 하는데, 종전엔
 *  `daemon:install`·`doctor` 를 직접 하라고 적어 사용자가 그 사이에 손을 대게 만들었다.
 * ★단독 init 은 실제 설정을 따른다 — 로그인은 고른 provider 대로(종전엔 codex 가 아니면 «OAuth 생략» 이라 해 놓고 onboard 는
 *  claude-auth 를 돌렸다), 텔레그램은 설정했을 때만, 대시보드 주소는 설정에서(종전엔 17010 고정).
 */
export const initNextSteps = (o: { provider: string; telegram: boolean; dashboardUrl: string; fromOnboard: boolean }): string[] => {
  if (o.fromOnboard) return ["→ Setup continues automatically: sign-in (if needed), service registration, and a check that it answers."];
  const signIn =
    o.provider === "codex"
      ? "  ② Sign in to ChatGPT with `npm run codex-auth`. (required for codex)"
      : o.provider === "claude-sub"
        ? "  ② Sign in to your Claude subscription with `npm run claude-auth`. (required for a subscription)"
        : "  ② Your API key is already in .env — no sign-in step needed.";
  return [
    "── Next steps ─────────────────────────────────────",
    "  ① Make sure `npm install` has finished.",
    signIn,
    "  ③ Start it with `npm run daemon:install` (always-on daemon) or `npm run dev` (development).",
    "  ④ Check the setup with `npm run doctor`.",
    `  ⑤ Open ${o.dashboardUrl} in a browser and say hello — the web dashboard (chat, progress, background jobs).`,
    ...(o.telegram ? ["  ⑥ Telegram is set up too — send your bot a message to check that it replies."] : []),
  ];
};
