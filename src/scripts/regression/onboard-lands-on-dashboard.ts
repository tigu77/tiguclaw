/**
 * 회귀: **온보딩의 도착점은 대시보드의 첫 대화다** (2026-10-16, 아스트라 인계 «대시보드 중심 온보딩» · 정태님 «대시보드가 메인»).
 *
 * 사고(인계 문서가 공개 main 을 읽고 찾은 것): `tiguclaw onboard` 가 doctor 결과를 버리고 무조건 «Onboard complete!» 를 찍은 뒤
 *  «텔레그램 봇에게 메시지를 보내 보세요» 로 끝났다 — 텔레그램을 안 쓴 사용자는 다음에 뭘 할지 몰랐고, 서비스가 안 떴어도 완료였다.
 *  마법사는 텔레그램 생략을 «CLI 만 쓰면» 으로 설명했고, doctor 는 텔레그램이 없으면 ❌ 를 찍었다(문제 목록엔 안 들면서).
 *
 * 본다:
 *  ① 대시보드 주소는 설정을 따른다(기본 포트·바꾼 포트·모든 주소 바인딩은 루프백으로 · 주석 줄은 값이 아님) — 포트를 문구로 복제하지 않는다
 *  ② 준비 확인은 유한하다 — 둘 다 뜨면 바로, 늦게 뜨면 기다리고, 안 뜨면 시한에 어느 쪽인지 돌려준다(성공으로 표시 안 함)
 *  ③ 브라우저는 열 수 있는 자리에서만(SSH·화면 없는 리눅스는 주소만)
 *  ④ 배선 — onboard 가 준비·doctor 결과로 완료를 판정하고, 대시보드를 첫 행동으로, 텔레그램은 설정했을 때만 보조로 · doctor·마법사 문구
 *
 * 등급: **실행**(리프 모듈 · 가짜 HTTP 서버) + 배선(소스).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const listen = (handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: string }> =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: String((server.address() as AddressInfo).port) }));
  });

export const check: RegressionCheck = {
  name: "onboard-lands-on-dashboard",
  guards: "온보딩이 doctor 결과·서비스 준비와 무관하게 «완료» 를 찍고 텔레그램으로 안내하던 것 — 대시보드가 주 화면이다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const m = await import("../../core/onboard-ready.js");

    // ⓪ 주소를 기본 브라우저로 여는 명령 — Windows 는 explorer 가 아니라 FileProtocolHandler(2026-10-21: codex-auth 가 탐색기를 띄웠다)
    const oauthUrl = "https://auth.example/oauth/authorize?response_type=code&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcb&scope=openid%20profile&state=s";
    const win = m.browserOpenCommand(oauthUrl, "win32");
    const mac = m.browserOpenCommand(oauthUrl, "darwin");
    const lin = m.browserOpenCommand(oauthUrl, "linux");
    out.push(assert("⓪ 주소 열기: Windows = `rundll32 url.dll,FileProtocolHandler <주소>`(explorer 아님 — 탐색기가 뜨던 것) · 맥 open · 리눅스 xdg-open · 주소는 한 인자 그대로 · 파일·폴더 열기(systemOpener)는 explorer 그대로",
      win.cmd === "rundll32" && JSON.stringify(win.args) === JSON.stringify(["url.dll,FileProtocolHandler", oauthUrl]) &&
        mac.cmd === "open" && JSON.stringify(mac.args) === JSON.stringify([oauthUrl]) && lin.cmd === "xdg-open" && m.systemOpener("win32") === "explorer" &&
        // 배선 — 실제로 여는 함수가 이 명령을 쓴다(순수 함수만 맞고 여는 쪽이 옛 explorer 를 부르면 소용없다)
        /const \{ cmd, args \} = browserOpenCommand\(url, platform\);\s*execFile\(cmd, args,/.test(readSourceSync("src/core/onboard-ready.ts")),
      { win, mac, lin }));

    // ① 주소
    const urls = {
      default: m.dashboardUrlFromEnv("TIGUCLAW_PROVIDER=codex\n# DASHBOARD_PORT=12345\n"),
      custom: m.dashboardUrlFromEnv('DASHBOARD_PORT="18080"\n'),
      anyHost: m.dashboardUrlFromEnv("DASHBOARD_HOST=0.0.0.0\nDASHBOARD_PORT=18081\n"),
      v6: m.dashboardUrlFromEnv("DASHBOARD_HOST=::1\n"),
    };
    // 데몬과 같은 해석 — 줄 끝 주석·공백·export·같은 키 두 번(마지막이 이김)(레드팀 B F1)
    //  ★순서는 홈 .env → (윈도우만) 설치 때 실행 환경 → 레포 .env (재검토 P1 — 맥·리눅스 서비스엔 셸 환경이 안 닿고, 윈도우도 홈이 이긴다)
    //  ★홈의 빈 값(`KEY=`)은 레포를 막고 기본값이 된다(재검토 P2 — loadEnvFile 은 이미 있는 키를 안 덮는다)
    const get = m.daemonEnvLookup({ HTTP_BRIDGE_PORT: "19011", DASHBOARD_HOST: " 10.0.0.9 " }, "DASHBOARD_PORT=18080 # mine\nDASHBOARD_PORT=18090\nHTTP_BRIDGE_PORT=17999\nHTTP_BRIDGE_HOST=::1\nTZ=\n", "DASHBOARD_HOST=10.0.0.5\nTZ=Asia/Seoul\nLANG_X=repo\n");
    const parsed = {
      dash: m.dashboardUrl(get), health: m.bridgeHealthUrl(get), comment: m.dashboardUrlFromEnv("DASHBOARD_PORT=18080 # mine\n"),
      emptyHomeBlocksRepo: get("TZ"), repoFallback: get("LANG_X"),
    };
    out.push(assert("① 데몬과 같은 .env 해석(주석·중복 키) · 홈이 실행 환경을 이김 · 홈에 없으면 실행 환경(공백 정리) · 홈의 빈 값은 레포를 막음 · 레포 폴백",
      parsed.comment === "http://127.0.0.1:18080" && parsed.dash === "http://10.0.0.9:18090" && parsed.health === "http://[::1]:17999/health" &&
        parsed.emptyHomeBlocksRepo === undefined && parsed.repoFallback === "repo", parsed));
    // 설치본 해석 — 맥·리눅스는 셸 값을 안 본다(유닛은 TIGUCLAW_HOME·RUNTIME·PATH 만 넘긴다) · 윈도우는 설치 때 붙잡은
    //  `win-service-env.json` 을 홈 다음·레포 앞에 둔다(셸 값이 아니다 — 레포가 정한 키는 붙잡지 않으므로, 재검토 2차 P2)
    const envDir = mkdtempSync(path.join(tmpdir(), "onboard-env-"));
    try {
      const home = path.join(envDir, "home");
      mkdirSync(home);
      writeFileSync(path.join(home, ".env"), "DASHBOARD_HOST=127.0.0.1\nHTTP_BRIDGE_HOST=127.0.0.1\n");
      writeFileSync(path.join(envDir, ".env"), "DASHBOARD_PORT=18200\n");
      const look = (platform: NodeJS.Platform) => m.installedEnvLookup(path.join(home, ".env"), envDir, platform);
      const savedFile = path.join(home, "win-service-env.json");
      writeFileSync(savedFile, JSON.stringify({ HTTP_BRIDGE_PORT: "19000", DASHBOARD_HOST: "10.9.9.9" }));
      const installed = {
        mac: m.dashboardUrl(look("darwin")), macHealth: m.bridgeHealthUrl(look("darwin")),
        // 레포가 정한 포트는 붙잡히지 않았으므로 레포 값 · 붙잡은 브리지 포트는 레포보다 앞 · 홈이 정한 호스트는 붙잡은 값을 이김
        win: m.dashboardUrl(look("win32")), winHealth: m.bridgeHealthUrl(look("win32")),
        winCorrupt: "", noFiles: m.dashboardUrl(m.installedEnvLookup(path.join(envDir, "none", ".env"), path.join(envDir, "none"), "win32")),
      };
      writeFileSync(savedFile, "{not json");
      installed.winCorrupt = m.bridgeHealthUrl(look("win32"));
      out.push(assert("① 설치본 해석 — 맥·리눅스는 붙잡은 값도 셸도 안 봄 · 윈도우는 붙잡은 값이 레포 앞·홈 뒤 · 깨진 파일은 없는 것으로 · 파일이 없어도 기본값",
        installed.mac === "http://127.0.0.1:18200" && installed.macHealth === "http://127.0.0.1:17011/health" &&
          installed.win === "http://127.0.0.1:18200" && installed.winHealth === "http://127.0.0.1:19000/health" &&
          installed.winCorrupt === "http://127.0.0.1:17011/health" && installed.noFiles === "http://127.0.0.1:17010", installed));
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
    out.push(assert("① 대시보드 주소가 설정을 따른다 — 기본 17010 · 바꾼 포트 · 모든 주소 바인딩은 루프백 · IPv6 괄호 · 주석 줄은 값이 아님",
      urls.default === "http://127.0.0.1:17010" && urls.custom === "http://127.0.0.1:18080" && urls.anyHost === "http://127.0.0.1:18081" && urls.v6 === "http://[::1]:17010",
      urls));

    // ② 준비 확인
    let healthUp = false;
    const bridge = await listen((req, res) => {
      if (req.url === "/health" && healthUp) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
      res.writeHead(503); res.end();
    });
    const dash = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); });
    try {
      setTimeout(() => { healthUp = true; }, 300);
      const late = await m.waitForServiceReady({ bridgePort: bridge.port, dashboardUrl: `http://127.0.0.1:${dash.port}`, timeoutMs: 5000, intervalMs: 50 });
      const deadPort = String(Number(dash.port) + 1 === Number(bridge.port) ? Number(dash.port) + 2 : Number(dash.port) + 1);
      const t0 = Date.now();
      // ★자기 시한 — 시한을 안 지키는 판정이 들어오면 이 검사가 매달리지 않고 빨갛게 끝난다(변이 실측: 무한 대기로 러너가 멈춤).
      const stop = new AbortController();
      const downR = await within(4000, "안 뜨는 대시보드 준비 확인", m.waitForServiceReady({ bridgePort: bridge.port, dashboardUrl: `http://127.0.0.1:${deadPort}`, timeoutMs: 400, intervalMs: 50, signal: stop.signal }));
      stop.abort();
      const down = "timedOut" in downR ? { daemon: false, dashboard: false, waitedMs: -1, timedOut: downR.timedOut } : downR.value;
      const downMs = Date.now() - t0;
      out.push(assert("② 늦게 뜬 데몬은 기다려 준비로 · 안 뜨는 대시보드는 시한 안에 «그쪽이 안 됨» 으로 끝난다(무한 대기·허위 성공 없음)",
        late.daemon && late.dashboard && down.daemon && !down.dashboard && !("timedOut" in down) && downMs < 4000,
        { late, down: { ...down, waitedMs: downMs } }));
    } finally {
      bridge.server.close();
      dash.server.close();
    }

    // ③ 브라우저
    const open = {
      mac: m.canOpenBrowser({}, "darwin"),
      win: m.canOpenBrowser({}, "win32"),
      ssh: m.canOpenBrowser({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "darwin"),
      headlessLinux: m.canOpenBrowser({}, "linux"),
      desktopLinux: m.canOpenBrowser({ DISPLAY: ":0" }, "linux"),
    };
    out.push(assert("③ 브라우저는 열 수 있는 자리에서만 — 맥·윈도우·화면 있는 리눅스는 열고, SSH·화면 없는 리눅스는 주소만",
      open.mac && open.win && !open.ssh && !open.headlessLinux && open.desktopLinux, open));

    // ④ 배선
    const cli = stripComments(readSourceSync("src/cli.ts"));
    const body = cli.slice(cli.indexOf("const onboard = async"), cli.indexOf("const USAGE"));
    const wiring = {
      doctorRcUsed: /const doctorRc = runNpm\("doctor"\);/.test(body) && /doctorRc !== 0/.test(body),
      readyGates: /waitForServiceReady\(/.test(body) && /!ready\.daemon \|\| !ready\.dashboard/.test(body),
      failReturns1: /Setup is not finished[\s\S]{0,400}return 1;/.test(body),
      dashboardFirst: body.indexOf("dashboardUrl}") > -1 && body.indexOf("dashboardUrl}") < body.indexOf("Telegram is set up too"),
      telegramOnlyIfSet: /envKeyFromBody\(envBody, "TELEGRAM_BOT_TOKEN"\) !== undefined\)\s*\{\s*console\.log\("   Telegram is set up too/.test(body),
      noUnconditionalBot: !/Send your bot a message on Telegram/.test(body),
    };
    const doctor = stripComments(readSourceSync("src/scripts/doctor.ts"));
    const init = stripComments(readSourceSync("src/scripts/init.ts"));
    const texts = {
      doctorTelegramNotFailure: !/"disabled ❌ \(no TELEGRAM_BOT_TOKEN\)"/.test(doctor),
      doctorNextIsDashboard: /Next step: open \$\{dashboardUrl\(/.test(doctor),
      // 데몬이 안 떴으면 선택 단계(외부 대시보드 토큰·스케줄)보다 먼저(재검토 P5) · 막는 문제가 남았으면 대시보드 안내보다 먼저(레드팀 B F4)
      doctorNextDaemonFirst: /\} else if \(!health\.up\) \{\s*nextStep = "Next step: start the service/.test(doctor) &&
        doctor.indexOf("} else if (!health.up) {") < doctor.indexOf("Next step (optional): to use an external dashboard") &&
        /nextStep = issues\.length > 0\s*\?\s*"Next step: fix the problems listed above/.test(doctor),
      // 대시보드를 꺼 둔 설치엔 대시보드를 권하지 않는다(재검토 P3) · health 는 onboard 와 같은 주소 규칙(재검토 P4)
      doctorDashboardOffAware: /!moduleActivityJudge\(\)\("dashboard"\)\s*\?\s*"Next step: all set — the dashboard module is turned off/.test(doctor),
      // doctor 도 onboard 와 같은 해석으로 health·대시보드 주소를 만든다(재검토 2차 P1 — 셸 값을 두드려 onboard 를 «안 끝났다» 로 만들었다)
      doctorHealthFollowsHost: /const svc = installedEnvLookup\(homeEnvPath\(\), process\.cwd\(\)\);/.test(doctor) &&
        /daemonHealth\(bridgeHealthUrl\(svc\)\)/.test(doctor) && /dashboardUrl\(svc\)/.test(doctor) &&
        !/localhost:\$\{port\}\/health/.test(doctor) && !/process\.env\.(HTTP_BRIDGE_PORT|DASHBOARD_PORT)/.test(doctor),
      // install.sh — onboard 가 돌다 멈췄으면 «설정만 남았다» 가 아니라 «고치고 다시»(레드팀 B F3)
      installSaysStopped: /RAN_ONBOARD=1/.test(readSourceSync("install.sh")) && /Setup stopped before finishing/.test(readSourceSync("install.sh")),
      initSkipMentionsDashboard: /skip this to use the web dashboard/.test(init) && !/only use the CLI/.test(init),
    };
    // init 의 «다음 단계»(아스트라 «초보자 설치 검토» 3번) — onboard 가 부르면 자동 진행만 · 단독이면 provider·텔레그램·주소가 설정대로
    const viaOnboard = m.initNextSteps({ provider: "claude-sub", telegram: true, dashboardUrl: "http://127.0.0.1:18080", fromOnboard: true }).join("\n");
    const alone = (provider: string, telegram: boolean): string =>
      m.initNextSteps({ provider, telegram, dashboardUrl: "http://127.0.0.1:18080", fromOnboard: false }).join("\n");
    const steps = { viaOnboard, sub: alone("claude-sub", false), codex: alone("codex", true), key: alone("anthropic", false) };
    out.push(assert("④ init 다음 단계 — onboard 에서 불리면 수동 단계 없음 · 구독은 claude-auth · codex 는 codex-auth · API 키는 로그인 없음 · 텔레그램은 설정했을 때만 · 주소는 설정대로",
      !/daemon:install|doctor|Telegram/.test(viaOnboard) && /continues automatically/.test(viaOnboard) &&
        /claude-auth/.test(steps.sub) && !/codex-auth|skipping the OAuth/.test(steps.sub) && !/Telegram/.test(steps.sub) &&
        /codex-auth/.test(steps.codex) && /send your bot a message/.test(steps.codex) &&
        /no sign-in step/.test(steps.key) && [steps.sub, steps.codex, steps.key].every((t) => t.includes("http://127.0.0.1:18080") && !t.includes("17010")),
      steps));
    const initWired = {
      initUsesSteps: /initNextSteps\(\{/.test(init) && /installedEnvLookup\(ENV_PATH, process\.cwd\(\)\)/.test(init) && /TIGUCLAW_FROM_ONBOARD === "1"/.test(init),
      // 화면에 찍는 줄만 — .env 템플릿 주석의 기본 포트 안내는 설정 설명이라 맞다
      noHardcodedPort: !/console\.log\([^\n]*127\.0\.0\.1:17010/.test(init),
      onboardFlagsInit: /runNpm\("init", \{ TIGUCLAW_FROM_ONBOARD: "1" \}\)/.test(body),
      onboardSharesLookup: /const get = installedEnvLookup\(ENV_PATH, process\.cwd\(\)\);/.test(body),
    };
    out.push(assert("④ init 은 공용 해석·다음 단계 함수를 쓰고 · onboard 는 init 에 «이어서 간다» 를 알린다 · onboard 와 init 이 같은 .env 해석",
      Object.values(initWired).every(Boolean), initWired));
    out.push(assert("④ onboard 는 서비스 준비·doctor 결과로 완료를 판정하고(못 되면 1) · 대시보드가 첫 행동 · 텔레그램은 설정했을 때만 보조",
      Object.values(wiring).every(Boolean), wiring));
    out.push(assert("④ doctor 는 텔레그램 미설정을 실패로 찍지 않고 다음 단계로 대시보드를 · 마법사는 텔레그램 생략을 대시보드로 설명",
      Object.values(texts).every(Boolean), texts));
    return out;
  },
};
