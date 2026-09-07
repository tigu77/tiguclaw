/**
 * claude 구독 한도 — **CLI 한테 물어본다** (2026-09-07 정태님).
 *
 * ★정태님: *"그냥 cli 통해서 얻어오면 안되는거야? / 되는걸로 가져오기만 하면 되는건데 /
 *  꼭 엔드포인트를 고집할 필요는 없지."* 맞다. 나는 조회 엔드포인트(`/api/oauth/usage`)를
 *  하루 종일 팠는데 **성공 0회**였다 — 인증은 통과하는데(가짜 토큰은 401) 매 시각 경계마다
 *  429 를 주고, 창이 열린 직후 33초에 물어도 꽉 찬 한 시간을 되돌려줬다. 되는 길을 찾는 게
 *  일이었지 그 문을 여는 게 일이 아니었다.
 *
 * ★**공짜다 — 토큰을 안 쓴다.** 실측(`--output-format json` 이 스스로 보고한 회계):
 *    num_turns 0 · total_cost_usd 0 · duration_api_ms 0 · input/output/cacheRead 0
 *  슬래시 명령이라 모델을 안 거친다. 2초 걸린다.
 *
 * ★**글자를 읽는다** — 그게 이 방식의 값이자 약점이다. 모양이 바뀌면 못 읽고, 그러면
 *  «모름» 이 된다(지어내지 않는다). 그래서 못 읽었을 때 **원문 첫 줄을 로그에 남긴다** —
 *  다음 사람이 로그만 보고 «모양이 바뀌었구나» 를 알 수 있게.
 *
 * ★**모델별 창은 안 싣는다**(`Current week (Fable)`). 이름이 영어라 한국어 화면에 그대로
 *  새고, 우리 `UsageWindow` 는 이름을 나르지 않는다(창 길이로 이름을 만든다). 사용자가 묻는
 *  축은 «시간 한도 · 주간 한도» 둘이고, 그 둘은 여기서 다 나온다.
 *
 * ★의존성 0을 지킨다 — `node:child_process` 는 빌트인이다.
 */
const FIVE_HOUR = 18_000;
const SEVEN_DAY = 604_800;

/**
 * `resets Sep 7 at 5:59pm (Asia/Seoul)` → epoch ms.
 * ★해가 없다 — 창이 최대 7일이므로 «많이 지난 과거면 내년» 으로 푼다.
 * ★괄호 안 시간대는 **이 기계의 시간대**다(CLI 가 로컬로 찍는다). 그래서 로컬 파싱이 맞다.
 *  못 읽으면 생략한다 — 리셋 시각은 있으면 좋은 것이지 없으면 안 되는 것이 아니다.
 */
const parseReset = (text, now) => {
  const m = /resets\s+([A-Z][a-z]{2}\s+\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (m === null) return undefined;
  let hour = Number(m[2]) % 12;
  if (m[4].toLowerCase() === "pm") hour += 12;
  const y = new Date(now).getFullYear();
  const at = Date.parse(`${m[1]} ${y} ${String(hour).padStart(2, "0")}:${m[3] ?? "00"}:00`);
  if (!Number.isFinite(at)) return undefined;
  // 30일 넘게 과거로 읽혔으면 해가 넘어간 것이다(12월 → 1월).
  return at < now - 30 * 86_400_000 ? Date.parse(`${m[1]} ${y + 1} ${String(hour).padStart(2, "0")}:${m[3] ?? "00"}:00`) : at;
};

/** `Current session: 32% used · resets …` 줄들 → 우리 창 모양. */
export const parseUsageText = (text, now) => {
  const windows = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*Current (session|week)(\s*\([^)]*\))?\s*:\s*(\d{1,3})%\s*used/i.exec(line);
    if (m === null) continue;
    const scope = (m[2] ?? "").toLowerCase();
    // 모델별 주간 창은 건너뛴다 — 이름을 나를 자리가 없고, 영어 이름이 화면에 샌다.
    if (scope !== "" && !scope.includes("all models")) continue;
    const used = Number(m[3]);
    if (!Number.isFinite(used)) continue;
    const resetAt = parseReset(line, now);
    windows.push({
      windowSeconds: m[1].toLowerCase() === "session" ? FIVE_HOUR : SEVEN_DAY,
      remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  }
  return windows;
};

/** 하위 프로세스를 띄워 stdout 을 받는다. 실패·시한초과는 `undefined`. */
const run = async (cmd, args, ms) => {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    void (async () => {
    let p;
    try {
      // ★`USER` 를 반드시 채운다 — **없으면 CLI 가 자기 자격을 못 찾는다**(macOS 키체인을
      //  사용자 이름으로 연다). 실측으로 이거 하나였다: 좁은 env 에서 `auth status` 가
      //  `loggedIn:false` 였는데 `USER` 만 넣으니 `true` 가 됐다(LOGNAME·TMPDIR 은 무관).
      //  launchd 로 뜬 데몬 env 엔 `USER` 가 없어서, 화면엔 «대기 중» 만 뜨고 로그엔
      //  «한도 줄을 못 찾음 — Total cost: $0.0000» 이 찍혔다(구독이 아니라 API 로 읽혀
      //  비용 요약이 온 것이다).
      // ★목록이 아니라 **파생**이다 — 환경에 있으면 그걸, 없으면 OS 에게 묻는다.
      const { userInfo } = await import("node:os");
      const user = process.env.USER ?? process.env.LOGNAME ?? userInfo().username;
      // ★★그리고 **우리 자격을 물려주지 않는다** — 이게 하루를 태운 진짜 원인이다.
      //  데몬은 `.env` 의 `CLAUDE_CODE_OAUTH_TOKEN` 을 `process.env` 로 올리고, 하위
      //  프로세스가 그걸 상속한다. 그런데 그 토큰(`claude setup-token` 산출물)을 본 CLI 는
      //  **구독으로 자기를 안 본다**(실측: `authMethod oauth_token · subscriptionType None`)
      //  → `/usage` 가 한도 대신 «Total cost: $0.0000» 비용 요약을 준다.
      //  ★같은 사실이 엔드포인트 쪽 수수께끼도 푼다: 그 토큰이 구독 자격이 아니라서
      //   `/api/oauth/usage` 가 하루 종일 거절한 것이다(성공 0회). 「시간당 1회 제한」이
      //   아니었다 — 내가 그렇게 읽었을 뿐이다.
      //  ★그래서 **비운 채로** 띄운다. 그러면 CLI 는 자기 자격(대화형 로그인)을 쓴다.
      //   그것도 없는 기계면 로그인 안 된 상태가 되고, 그때는 한도 줄을 못 찾아 «모름» 이
      //   된다 — 그게 맞는 답이다.
      const env = { ...process.env, USER: user };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    // ★반드시 시한을 둔다 — 하위 프로세스가 매달리면 화면이 통째로 멈춘다.
    const t = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* 이미 죽었다 */
      }
      resolve(undefined);
    }, ms);
    p.on("error", () => {
      clearTimeout(t);
      resolve(undefined);
    });
    p.on("close", () => {
      clearTimeout(t);
      resolve(out);
    });
    })();
  });
};

/**
 * `claude` 가 어디 있나 — **두 자리만 본다**.
 *
 * ★데몬은 launchd 로 뜬다. 실측한 그 PATH 는
 *  `…/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` 인데 실제 `claude` 는
 *  `~/.local/bin/claude` 에 있다 — **그냥 `spawn("claude")` 는 ENOENT** 였고, 화면엔
 *  «대기 중» 만 뜨고 이유는 안 보였다.
 * ★처음엔 «로그인 셸에게 물어보자»(`$SHELL -lc 'command -v claude'`)로 갔다. 목록을 손으로
 *  안 들어도 되니 그게 옳아 보였는데 **실측에서 안 됐다** — 이 기계의 `.zshrc` 는 PATH 를
 *  세우기 전 줄에서 걸린다(비대화형에선 그 `source` 가 실패한다). 셸 설정에 기대는 방법은
 *  기계마다 다르게 깨지고, 깨져도 «CLI 가 없다» 로만 보인다. 그래서 버렸다.
 * ★남은 둘은 각각 이유가 있다: **PATH**(정상 환경이면 여기 있다) · **`~/.local/bin`**
 *  (Claude Code 네이티브 설치기가 놓는 자리). 목록이 늘어나기 시작하면 그건 이 방법이
 *  틀렸다는 신호다([[feedback_hand_maintained_lists]]) — 그때는 사용자가 경로를 지정하게
 *  하는 쪽이 맞다.
 * ★한 프로세스에 한 번만 정한다.
 */
let resolvedCmd;
const resolveClaude = async (log) => {
  if (resolvedCmd !== undefined) return resolvedCmd;
  const { existsSync } = await import("node:fs");
  const home = process.env.HOME ?? "";
  for (const c of ["claude", home === "" ? "" : `${home}/.local/bin/claude`]) {
    if (c === "") continue;
    // PATH 후보(`claude`)는 실행해봐야 안다 — `--version` 이 가장 싸다.
    const ok = c.includes("/") ? existsSync(c) : (await run(c, ["--version"], 8_000)) !== undefined;
    if (ok) {
      resolvedCmd = c;
      return resolvedCmd;
    }
  }
  resolvedCmd = null;
  log?.("`claude` 를 못 찾음(PATH · ~/.local/bin) — CLI 경로는 건너뛴다");
  return resolvedCmd;
};

/**
 * CLI 를 띄워 `/usage` 를 받는다. 못 하면 `undefined`(모름) — 던지지 않는다.
 * ★CLI 가 없거나 로그인이 안 돼 있을 수 있다. 그건 결함이 아니라 그냥 이 길이 없는 것이다.
 */
export const fetchUsageViaCli = async (log) => {
  const now = Date.now();
  let raw;
  try {
    const cmd = await resolveClaude(log);
    if (cmd === null) return undefined;
    raw = await run(cmd, ["-p", "/usage", "--output-format", "json"], 25_000);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw === "") {
    log?.("CLI 조회 실패 — `claude` 를 못 띄웠거나 시한 초과");
    return undefined;
  }
  let text;
  try {
    text = JSON.parse(raw).result;
  } catch {
    log?.(`CLI 응답이 JSON 이 아니다 — ${raw.slice(0, 80)}`);
    return undefined;
  }
  const windows = parseUsageText(text, now);
  if (windows.length === 0) {
    // ★못 읽었으면 **원문 첫 줄**을 남긴다 — 모양이 바뀐 것을 로그만으로 알 수 있게.
    log?.(`CLI 출력에서 한도 줄을 못 찾음 — 첫 줄: ${String(text ?? "").split("\n")[0]?.slice(0, 100)}`);
    return undefined;
  }
  log?.(
    `CLI 로 창 ${windows.length}개 — ` +
      windows.map((w) => `${w.windowSeconds}초:${Math.round(w.remainingPercent)}%남음`).join(" "),
  );
  return { windows, measuredAt: now };
};
