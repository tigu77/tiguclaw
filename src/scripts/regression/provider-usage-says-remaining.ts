/**
 * 회귀: **한도가 얼마나 남았나** — 표현·비대칭·조용한 실패 (2026-09-07 정태님).
 *
 * 사용자가 묻는 축은 둘뿐이다: *"주간 한도가 얼마나 남았나 · 시간 한도가 얼마나 남았나."*
 * «어디서 토큰을 많이 쓰나» 는 **다른 문제**라 여기 안 들어온다(정태님 판정).
 *
 * ★**「쓴 양」이 아니라 「남은 양」이다.** provider 는 `used_percent`/`utilization` 로 주지만
 *  그건 저쪽 사정이고, 행동을 정하는 것은 «얼마나 남았나» 다(지금 더 돌릴까 / 기다릴까).
 *
 * ★**모르면 안 그린다.** 0 이나 100 으로 뭉개면 그 숫자로 판단하게 된다. provider 마다
 *  아는 것이 다르고(실측), 그 차이를 지어내서 메우면 안 된다.
 *
 * ★그리고 **429 를 «한도 도달» 로 읽으면 거짓말이 된다** — 실측(2026-09-07): 조회
 *  엔드포인트가 `429 retry-after: 3569` 를 냈는데, **같은 순간 모델 호출은 정상**이었고
 *  쿨다운도 없었다(claude 5시간 87% 남음). 조회만 조인 것이다.
 */
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readFileSync } from "node:fs";

/**
 * ★문장 만들기는 **대시보드**에 산다(코어도 플러그인도 아니다) — 카탈로그가 거기 있고,
 *  플러그인이 만들면 영어 화면에 한국어가 샌다. 그래서 검사도 그 파일을 실제로 돌린다:
 *  브라우저 전역(`i18n`)만 주입해 순수 함수 셋을 꺼낸다.
 */
const loadDashFns = (): {
  formatUsageLine: (u: unknown, now?: number) => string;
  usageWindowLabel: (s: unknown) => string;
  usageUntilLabel: (at: unknown, now: number) => string;
  usagePendingLine: (u: unknown, now?: number) => string;
} => {
  const src = readFileSync(
    new URL("../../../packages/dashboard/js/view-plugins.js", import.meta.url),
    "utf8",
  );
  // 필요한 세 함수만 떼어 돌린다(파일 전체는 DOM 을 만진다).
  const start = src.indexOf("function usageWindowLabel");
  const end = src.indexOf("\n\n", src.indexOf("return parts.join", start));
  const body = src.slice(start, end);
  // ko 카탈로그로 채운다 — 자리표시자 치환은 대시보드 i18n 과 같은 규약(`{name}`).
  const cat = JSON.parse(
    readFileSync(new URL("../../../locales/ko.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const i18n = (k: string, v?: Record<string, unknown>): string => {
    let out = cat[k] ?? k;
    for (const [n, val] of Object.entries(v ?? {})) out = out.split(`{${n}}`).join(String(val));
    return out;
  };
  return new Function(
    "i18n",
    `${body}\nreturn { formatUsageLine, usageWindowLabel, usageUntilLabel, usagePendingLine };`,
  )(i18n) as ReturnType<typeof loadDashFns>;
};
const { formatUsageLine, usageWindowLabel, usageUntilLabel, usagePendingLine } = loadDashFns();
const formatUsage = (u: unknown, now?: number): string | undefined => {
  const s = formatUsageLine(u, now);
  return s === "" ? undefined : s;
};
const windowLabel = (sec: number | undefined): string => usageWindowLabel(sec);
const untilLabel = (at: number | undefined, now: number): string | undefined => {
  const s = usageUntilLabel(at, now);
  return s === "" ? undefined : s;
};

/**
 * ★«못 쟀다» 는 답엔 **창이 없어야 한다** (2026-09-07 3라운드 P4).
 *
 * 2라운드에서 이 성질을 codex 의 반복 호출 한 곳에만 달았더니, claude 의 `unavailable`
 * 가지가 그대로 뚫렸다 — `windows:[{remainingPercent:100}]` 를 담으면 화면이
 * «이 계정에선 한도 조회가 안 됩니다» 대신 **«5시간 100% 남음»** 을 그린다
 * (`rows.length > 0` 이 대기·불가 문장을 억누른다).
 * ★그래서 판정을 **한 곳에** 두고 두 provider·세 경로에 전부 건다. 성질이 한 자리에 있으면
 *  다음 provider 가 생겨도 같은 문을 지난다([[feedback_hand_maintained_lists]]).
 */
const saysNothingMeasured = (v: unknown): boolean => {
  const u = v as { windows?: unknown[]; retryAt?: number; unavailable?: boolean } | undefined;
  if (u === undefined) return true; // 아예 «모름» — 그것도 지어내지 않은 것이다.
  const marked = typeof u.retryAt === "number" || u.unavailable === true;
  return marked ? (u.windows ?? []).length === 0 : true;
};

export const check: RegressionCheck = {
  name: "provider-usage-says-remaining",
  guards:
    "구독 한도를 부딪힌 뒤에만 알던 것 + 「쓴 양」과 「남은 양」이 섞이는 것 + 모르는 값을 0으로 뭉개는 것 + 조회 엔드포인트의 429 를 «계정 한도 도달» 로 잘못 읽는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);

    // ── ① 두 창을 «남은 양» 으로 말한다 ───────────────────────────────────────
    const both = formatUsage(
      {
        windows: [
          { windowSeconds: 18000, remainingPercent: 56, resetAt: now + 2 * 3600_000 },
          { windowSeconds: 604800, remainingPercent: 19, resetAt: now + 5 * 86400_000 },
        ],
        measuredAt: now,
      },
      now,
    );
    out.push(
      assert(
        "★★두 창을 «남은 %» 로 말한다 — 사용자가 묻는 것이 그것이다",
        both !== undefined && both.includes("56% 남음") && both.includes("19% 남음"),
        both ?? "★null",
      ),
    );
    out.push(
      assert(
        "창 이름이 초에서 파생된다(5시간·주간을 손으로 나열하지 않는다)",
        windowLabel(18000) === "5시간" && windowLabel(604800) === "주간",
        `18000→${windowLabel(18000)} · 604800→${windowLabel(604800)}`,
      ),
    );

    // ── ② 모르면 안 그린다 — 0% 로 뭉개지 않는다 ─────────────────────────────
    const noPct = formatUsage(
      { windows: [{ windowSeconds: 18000, resetAt: now + 3600_000 }], measuredAt: now },
      now,
    );
    out.push(
      assert(
        "★사용률을 모르면 «0%» 라고 하지 않는다 — 리셋만 말한다(claude 가 실제로 이 상태였다)",
        noPct !== undefined && !noPct.includes("%") && noPct.includes("리셋"),
        noPct ?? "★null",
      ),
    );
    out.push(
      assert(
        "아는 게 하나도 없으면 아무 말도 안 한다(빈 줄을 그리지 않는다)",
        formatUsage({ windows: [], measuredAt: now }, now) === undefined &&
          formatUsage(undefined, now) === undefined,
        `빈 창=${formatUsage({ windows: [], measuredAt: now }, now)} · undefined=${formatUsage(undefined, now)}`,
      ),
    );

    // ── ③ 남은 시간을 사람이 읽는 말로 ───────────────────────────────────────
    //  이 레포는 «약 8118분 후»(5.6일) 로 데인 적이 있다.
    const cases: Array<[string, number, string]> = [
      ["2시간 뒤", now + 2 * 3600_000, "2시간 뒤"],
      ["30분 뒤", now + 30 * 60_000, "30분 뒤"],
      ["5일 뒤", now + 5 * 86400_000, "5일 뒤"],
      ["지났음", now - 1000, "곧"],
    ];
    const wrong = cases.filter(([, at, want]) => untilLabel(at, now) !== want);
    out.push(
      assert(
        "리셋까지 남은 시간을 읽을 수 있는 말로 낸다(«8118분 후» 같은 숫자 금지)",
        wrong.length === 0,
        cases.map(([n, at]) => `${n}→${untilLabel(at, now)}`).join(" · "),
      ),
    );

    // ── ④ ★비대칭을 지어내지 않는다 — provider 계약이 옵셔널이다 ─────────────
    const srcHost = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../core/plugins/host.ts", import.meta.url), "utf8"),
    );
    out.push(
      assert(
        "★`getUsage` 는 옵셔널이다 — 모르는 provider 가 억지로 숫자를 내지 않아도 된다",
        /getUsage\?\((force\?: boolean)?\)/.test(srcHost),
        /getUsage\?\((force\?: boolean)?\)/.test(srcHost) ? "옵셔널 선언" : "★필수로 선언됨",
      ),
    );

    // ── ⑤ ★429 는 «계정 한도» 가 아니다 — retry-after 를 따른다 ──────────────
    const claudeSrc = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../../plugins/claude-subscription-auth/index.mjs", import.meta.url),
        "utf8",
      ),
    );
    const honorsRetryAfter =
      /res\.status === 429/.test(claudeSrc) && /retry-after/.test(claudeSrc);
    out.push(
      assert(
        "★★조회가 429 를 받으면 **서버가 말한 `retry-after` 만큼** 쉰다 — 우리가 임계를 정하지 않는다",
        honorsRetryAfter,
        honorsRetryAfter ? "429 → retry-after 준수" : "★직접 고른 간격으로 재시도한다",
      ),
    );
    // ★창을 «429 블록 안» 으로 잡는다 — 첫 판은 200자 창이었는데 429 판정과 반환문 사이가
    //  그보다 길어서 **변이가 통과했다**(실측). 거리로 재면 코드가 몇 줄만 길어져도 눈이 먼다.
    //  블록 자체를 떼어 그 안에 `limitReached: true` 가 있는지 본다.
    const i429 = claudeSrc.indexOf("res.status === 429");
    const block429 = i429 < 0 ? "" : claudeSrc.slice(i429, claudeSrc.indexOf("\n    }", i429) + 6);
    const noFalseLimit = i429 >= 0 && !/limitReached\s*:\s*true/.test(block429);
    out.push(
      assert(
        "★429 를 «한도 도달» 로 보고하지 않는다 — 실측상 같은 순간 모델 호출은 정상이었다",
        noFalseLimit,
        i429 < 0
          ? "★429 처리를 못 찾음"
          : noFalseLimit
            ? `429 블록 ${block429.length}자 · limitReached 없음`
            : "★조회 실패를 계정 한도로 읽는다(거짓 보고)",
      ),
    );

    // ── ⑥ 배경 폴링이 없다 — 상세를 열 때만 ─────────────────────────────────
    const codexSrc = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../../plugins/codex-subscription-auth/usage.ts", import.meta.url),
        "utf8",
      ),
    );
    const noTimer = !/setInterval|setTimeout/.test(codexSrc) && !/setInterval/.test(claudeSrc);
    out.push(
      assert(
        "★배경 폴링을 안 한다 — 사용자가 안 볼 때 외부를 때리지 않는다",
        noTimer,
        noTimer ? "타이머 0" : "★주기 조회가 생겼다",
      ),
    );


    // ── ★왜 비었는지 로그에 남는가 — **돌려서** 본다 (2026-09-07) ────────────────
    //  실측으로 이 구멍을 만났다: claude 가 429 로 계속 막혀 화면에 한도 줄이 안 떴는데
    //  **로그가 0줄**이라, «이 제공자가 원래 사용량을 안 준다» 와 «지금 조회가 막혔다» 를
    //  구분할 수가 없었다. 원격이 안 되는 설치본에선 로그가 1차 진단면이라 그게 곧
    //  «못 잡는다» 다([[feedback_logs_must_stand_alone]]).
    //  ★소스에 `log(` 가 있는지 세지 않는다 — 그건 문자열 검사고, 문장을 옮기면 조용히
    //   눈이 먼다(바로 위 429 검사가 거리로 재다가 변이에 뚫린 것과 같은 부류다).
    //   `fetch` 를 갈아끼우고 **실제로 실패시켜** 로그가 나오는지 본다.
    const fakeRes = (r: unknown) => async () => r as never;
    const usageMod = new URL(
      "../../../plugins/codex-subscription-auth/usage.ts",
      import.meta.url,
    ).href;
    const realFetch = globalThis.fetch;
    let codexFailLog: string[] = [];
    let codexOkLog: string[] = [];
    let okValue: unknown;
    try {
      // 실패 경로 — 매 import 가 새 모듈이라야 모듈 지역 캐시가 안 섞인다(쿼리로 가른다).
      const m1 = (await import(`${usageMod}?fail`)) as {
        setUsageLogSink: (f: (m: string) => void) => void;
        fetchCodexUsage: (g: () => Promise<string>) => Promise<unknown>;
      };
      m1.setUsageLogSink((m) => codexFailLog.push(m));
      globalThis.fetch = fakeRes({ ok: false, status: 503 });
      await m1.fetchCodexUsage(async () => "t");

      // 성공 경로 — 성공도 남긴다(성공이 안 남으면 «한 번이라도 됐나» 를 못 본다).
      const m2 = (await import(`${usageMod}?ok`)) as typeof m1;
      m2.setUsageLogSink((m) => codexOkLog.push(m));
      globalThis.fetch = fakeRes({
        ok: true,
        json: async () => ({
          rate_limit: { primary_window: { used_percent: 44, limit_window_seconds: 18_000 } },
        }),
      });
      okValue = await m2.fetchCodexUsage(async () => "t");
    } finally {
      globalThis.fetch = realFetch;
    }

    const failLine = codexFailLog.join(" | ");
    out.push(
      assert(
        "★조회가 실패하면 **왜인지** 로그에 남는다(상태코드까지) — 화면의 침묵만으로는 못 가른다",
        codexFailLog.length === 1 && /503/.test(failLine),
        codexFailLog.length === 0 ? "★로그 0줄 — 조용히 «모름»만 남는다" : failLine,
      ),
    );
    const okLine = codexOkLog.join(" | ");
    out.push(
      assert(
        "성공도 로그에 남는다(«한 번이라도 됐나» 를 로그만으로 알 수 있게)",
        codexOkLog.length === 1 && /56/.test(okLine),
        codexOkLog.length === 0 ? "★성공은 안 남는다" : okLine,
      ),
    );
    out.push(
      assert(
        "그 로그가 **남은 %** 를 말한다(쓴 % 가 아니다 — 로그에서도 축이 같아야 읽는 사람이 안 헷갈린다)",
        /56/.test(okLine) && !/44%남음/.test(okLine),
        okLine,
      ),
    );
    out.push(
      assert(
        "로그를 남겨도 반환값은 그대로다(로깅이 동작을 안 바꾼다)",
        (okValue as { windows?: unknown[] })?.windows?.length === 1,
        JSON.stringify(okValue),
      ),
    );


    // ── ★조회 시계가 **재시작을 넘긴다** (2026-09-07 정태님 신고) ─────────────────
    //  신고: *"클로드는 구독 플러그인에 표시가 안되는데?"* 근본은 우리 코드가 아니라
    //  **쓰는 법**이었다 — 이 엔드포인트는 «한 시간에 한 번» 인데 **거절당한 요청도 시계를
    //  되감는다**(실측: retry-after 162초 → 3분 뒤 재시도하니 3196초). `notBefore` 가
    //  메모리에만 있어서 배포할 때마다 처음부터 물었고, 그때마다 한 시간이 새로 밀렸다.
    //  ★소스에 `writeFileSync` 가 있는지 세지 않는다 — **두 번 띄워서** 두 번째가 정말
    //   안 묻는지 본다(그게 이 기능의 전부다).
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const dataDir = await fsp.mkdtemp(`${os.tmpdir()}/usage-clock-`);
    const modUrl = new URL("../../../plugins/claude-subscription-auth/index.mjs", import.meta.url).href;
    const hostFor = (): { dataDir: string; log: (m: string) => void; registerAuthProvider: (p: Record<string, unknown>) => { ok: true } } & {
      captured?: Record<string, unknown>;
    } => {
      const h = {
        dataDir,
        log: () => {},
        registerAuthProvider: (p: Record<string, unknown>) => {
          (h as { captured?: Record<string, unknown> }).captured = p;
          return { ok: true as const };
        },
      };
      return h;
    };
    let firstCalls = 0;
    let secondCalls = 0;
    let persisted = "";
    const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // ★**CLI 가 없는 기계**를 재현한다 — `PATH` 와 `HOME` 을 둘 다 비운다(플러그인이 보는
    //  자리가 그 둘이다). 이 세 묶음이 재는 것은 «엔드포인트 경로의 시계» 이고, 진짜
    //  `claude` 를 띄우면 (a) 매 실행 4.4초가 들고 (b) 통과 이유가 «가짜 토큰이라 CLI 도
    //  실패해서» 라는 **우연**이 된다. 우연히 초록인 검사는 게이트가 아니다
    //  ([[feedback_gate_must_actually_run]]).
    //  ★`PATH` 만 비웠다가 `~/.local/bin` 갈래를 더하자 다시 진짜 CLI 가 떴다 — 격리는
    //   «지금 코드가 보는 자리 전부» 를 덮어야 한다.
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    try {
      process.env.PATH = "";
      process.env.HOME = "";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-fake";
      // ① 첫 기동 — 429 를 받고 시계를 세운다.
      const P1 = (await import(`${modUrl}?clock1`)).default as new () => {
        startService: (b: unknown, h: unknown) => Promise<void>;
      };
      const h1 = hostFor();
      await new P1().startService(null, h1);
      globalThis.fetch = (async () => {
        firstCalls += 1;
        return {
          status: 429,
          ok: false,
          headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "1800" : null) },
        };
      }) as never;
      await (h1.captured?.getUsage as () => Promise<unknown>)();
      persisted = await fsp.readFile(`${dataDir}/usage-cache.json`, "utf8").catch(() => "");

      // ② 재시작 — 같은 자리를 물려받으면 **묻지 않아야 한다**.
      const P2 = (await import(`${modUrl}?clock2`)).default as typeof P1;
      const h2 = hostFor();
      await new P2().startService(null, h2);
      globalThis.fetch = (async () => {
        secondCalls += 1;
        return { status: 429, ok: false, headers: { get: () => null } };
      }) as never;
      await (h2.captured?.getUsage as () => Promise<unknown>)();
    } finally {
      globalThis.fetch = realFetch;
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fsp.rm(dataDir, { recursive: true, force: true });
    }

    out.push(
      assert(
        "429 가 정한 대기 시각을 **파일에 남긴다**(메모리에만 두면 배포마다 날아간다)",
        /"notBefore":\s*\d{10,}/.test(persisted),
        persisted === "" ? "★파일 없음" : persisted.slice(0, 120),
      ),
    );
    out.push(
      assert(
        "★★재시작해도 그 시계를 지킨다 — 두 번째 기동은 **묻지 않는다**. 거절당한 요청도 서버 시계를 되감으므로, 헛되이 두드리면 사용자는 영영 «모름» 을 본다",
        firstCalls === 1 && secondCalls === 0,
        `첫 기동 ${firstCalls}회 · 재시작 뒤 ${secondCalls}회` +
          (secondCalls === 0 ? "" : " ★또 물었다 — 창이 그만큼 더 밀린다"),
      ),
    );


    // ── ★리셋을 지난 캐시는 **버린다** (2026-09-07 변이로 발견한 구멍) ────────────
    //  오래된 게 문제가 아니라 **틀린 게** 문제다: 「56% 남음」은 이미 끝난 창에 대한
    //  말이고, 창이 돌면 실제 남은 양은 전혀 다르다. 낡은 값을 최신인 척 보여주는 것은
    //  이 레포가 여러 번 데인 부류라, 안 보여주는 쪽이 맞다.
    const stale = await fsp.mkdtemp(`${os.tmpdir()}/usage-stale-`);
    let staleAnswer: unknown = "미실행";
    try {
      process.env.PATH = "";
      process.env.HOME = "";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-fake";
      await fsp.writeFile(
        `${stale}/usage-cache.json`,
        JSON.stringify({
          notBefore: 0, // 대기 중이 아니다 — 그래서 캐시가 유일한 답변원이다.
          at: Date.now() - 86_400_000,
          value: {
            windows: [{ windowSeconds: 18_000, remainingPercent: 56, resetAt: Date.now() - 3_600_000 }],
            measuredAt: Date.now() - 86_400_000,
          },
        }),
      );
      const P = (await import(`${modUrl}?stale`)).default as new () => {
        startService: (b: unknown, h: unknown) => Promise<void>;
      };
      const h = {
        dataDir: stale,
        log: () => {},
        captured: undefined as Record<string, unknown> | undefined,
        registerAuthProvider: (pp: Record<string, unknown>) => {
          h.captured = pp;
          return { ok: true as const };
        },
      };
      await new P().startService(null, h);
      // 조회는 실패시킨다 — 그러면 «마지막으로 아는 것» 만이 답이 될 수 있다.
      globalThis.fetch = (async () => ({ status: 500, ok: false, headers: { get: () => null } })) as never;
      staleAnswer = await (h.captured?.getUsage as () => Promise<unknown>)();
    } finally {
      globalThis.fetch = realFetch;
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fsp.rm(stale, { recursive: true, force: true });
    }
    // ★판정은 «창을 안 준다» 다 — **반환 타입이 아니다**. 처음엔 `=== undefined` 로 못박았는데,
    //  나중에 «못 쟀다 + 언제 다시» 를 나르게 되자(`retryAt`) 동작은 그대로인데 검사만
    //  빨개졌다. 검사가 지키려는 것은 **옛 숫자를 안 내놓는 것**이지 어떤 값으로 답하느냐가
    //  아니다([[feedback_gate_must_actually_run]] 의 형제 — 성질을 봐야지 문장을 보면 안 된다).
    const staleWindows = ((staleAnswer as { windows?: unknown[] } | undefined)?.windows ?? []).length;
    out.push(
      assert(
        "★리셋 시각이 지난 캐시는 안 쓴다 — 끝난 창의 «56% 남음» 은 낡은 게 아니라 틀린 것이다",
        staleAnswer === undefined || staleWindows === 0,
        staleWindows === 0 ? "옛 창을 안 내놓는다" : `★옛 값을 그대로 냈다: ${JSON.stringify(staleAnswer)}`,
      ),
    );


    // ── ★막대가 **0px 로 접히지 않는다** (2026-09-07 헤드리스로 실제로 봤다) ──────
    //  이 상자는 데스크톱에서도 **235px** 뿐이다(이름 46 + 값 59 + 리셋 106 + 간격 24).
    //  넷을 한 줄에 두면 남는 폭이 0이라, 줄어드는 칸인 막대가 0px 이 됐다 — 그러면
    //  «막대가 없다» 로 읽히고, 두 창 중 하나만 막대가 보여 더 이상해 보였다.
    //  ★고침은 막대를 좁히는 게 아니라 **리셋을 아랫줄로 내리는 것**이다. 좁히면 다음
    //   문구에서 또 넘친다(컴포저에서 같은 교훈을 이미 샀다).
    //  ★주석을 지운 본문만 본다 — 주석 안의 규칙을 세면 다 지워도 초록이 된다(이 레포가
    //   헤더 검사에서 정확히 그렇게 데였다).
    const dashCss = readFileSync(
      new URL("../../../packages/dashboard/app.css", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const barMin = /\.usage-win-bar \{[^}]*min-width:\s*(\d+)px/.exec(dashCss);
    out.push(
      assert(
        "★막대에 최소 폭이 있다 — 0px 막대는 «없다» 로 읽힌다(실제로 그렇게 그려졌다)",
        barMin !== null && Number(barMin[1]) > 0,
        barMin === null ? "★min-width 없음 — 좁은 칸에서 접힌다" : `min-width:${barMin[1]}px`,
      ),
    );
    const resetOwnLine = /\.usage-win-reset \{[^}]*flex:\s*0 0 100%/.test(dashCss);
    out.push(
      assert(
        "★리셋은 항상 아랫줄이다(flex-basis 100%) — 폭에 따라 붙었다 떨어졌다 하면 화면마다 모양이 다르다",
        resetOwnLine,
        resetOwnLine ? "flex:0 0 100%" : "★같은 줄에 두려 한다 — 막대가 그만큼 접힌다",
      ),
    );
    const wraps = /\.usage-win \{[^}]*flex-wrap:\s*wrap/.test(dashCss);
    out.push(
      assert(
        "창 줄이 감길 수 있다(안 그러면 아랫줄로 내릴 자리가 없다)",
        wraps,
        wraps ? "flex-wrap:wrap" : "★nowrap — 리셋이 옆으로 삐져나간다",
      ),
    );


    // ── ★「모른다」와 「아무 말도 안 한다」는 다르다 (2026-09-07 정태님 화면) ──────
    //  정태님이 claude 플러그인 화면을 보내며 *"아무것도 안떠"*. 우리 눈엔 «모르니까 안
    //  그린다» 가 맞았는데, 사용자 눈엔 **«이 제품은 그걸 안 해주는구나»** 였다. 그 답이
    //  로그에만 있었다 — 로그는 우리 것이지 사용자 것이 아니다.
    //  ★그렇다고 숫자를 지어내지 않는다. 말하는 것은 **이유와 시각**뿐이다.
    const pendingAt = now + 29 * 60_000;
    const pendingLine = usagePendingLine({ windows: [], measuredAt: now, retryAt: pendingAt }, now);
    out.push(
      assert(
        "★못 쟀으면 «대기 중 · 언제 다시» 라고 말한다(빈 자리는 «원래 안 준다» 로 읽힌다)",
        pendingLine !== "" && /29/.test(pendingLine),
        pendingLine === "" ? "★아무 말도 안 한다" : pendingLine,
      ),
    );
    out.push(
      assert(
        "★대기 문장은 숫자를 지어내지 않는다(«%» 가 없다)",
        !/%/.test(pendingLine),
        pendingLine,
      ),
    );
    const noRetry = usagePendingLine({ windows: [], measuredAt: now }, now);
    out.push(
      assert(
        "다시 시도할 시각을 모르면 여전히 아무 말도 안 한다 — 할 말이 없으면 안 한다",
        noRetry === "",
        noRetry === "" ? "빈 줄" : `★지어낸 문장: ${noRetry}`,
      ),
    );
    const hasWindows = usagePendingLine(
      { windows: [{ windowSeconds: 18_000, remainingPercent: 56 }], measuredAt: now, retryAt: pendingAt },
      now,
    );
    out.push(
      assert(
        "잰 값이 있으면 대기 문장을 안 붙인다(둘 다 뜨면 서로 반대말이 된다)",
        hasWindows === "",
        hasWindows === "" ? "안 붙는다" : `★같이 뜬다: ${hasWindows}`,
      ),
    );

    // ── ★배관: 화면이 읽는 이름을 라우트가 싣는가 (양끝 확인) ────────────────────
    //  화면만 고치면 조용히 안 뜬다 — 이 값은 플러그인 → 라우트 → 화면 셋을 지난다.
    const routeSrc = readFileSync(
      new URL("../../../plugins/http-bridge/routes-auth.ts", import.meta.url),
      "utf8",
    );
    const dashSrc = readFileSync(
      new URL("../../../packages/dashboard/js/view-plugins.js", import.meta.url),
      "utf8",
    );
    for (const field of ["retryAt", "limitReached"]) {
      const carried = new RegExp(`\\b${field}\\b`).test(routeSrc);
      const read = new RegExp(`usage\\.${field}|info\\.usage\\.${field}`).test(dashSrc);
      out.push(
        assert(
          `★라우트가 \`${field}\` 를 실어 나른다 — 화면이 읽는데 라우트가 빼면 조용히 안 뜬다`,
          !read || carried,
          `화면 읽음=${read} · 라우트 실음=${carried}` +
            (read && !carried ? " ★여기서 끊긴다" : ""),
        ),
      );
    }


    // ── ★«기다려도 안 된다» 는 «잠시 뒤 다시» 와 다르다 (2026-09-07) ──────────────
    //  실측: claude 조회 엔드포인트는 창이 열린 직후 33초에 물어도 꽉 찬 한 시간을
    //  되돌려줬고, 하루 종일 성공 0회였다. 그 상태에서 「19분 뒤 다시 시도」가 계속 뜨면
    //  그건 모름이 아니라 **거짓 약속**이다 — 사용자가 기다리기만 한다.
    const gone = usagePendingLine({ windows: [], measuredAt: now, unavailable: true }, now);
    out.push(
      assert(
        "★«이 계정에선 안 된다» 를 말할 수 있다(영영 «잠시 뒤 다시» 로 끌지 않는다)",
        gone !== "" && !/\d+\s*(분|시간|일)/.test(gone),
        gone === "" ? "★아무 말도 안 한다" : gone,
      ),
    );
    const both2 = usagePendingLine(
      { windows: [], measuredAt: now, unavailable: true, retryAt: now + 29 * 60_000 },
      now,
    );
    out.push(
      assert(
        "★둘 다 있으면 «안 된다» 가 이긴다 — 시각을 곁들이면 다시 기다리게 된다",
        both2 === gone,
        both2,
      ),
    );
    const routeCarries = /\bunavailable\b/.test(routeSrc);
    out.push(
      assert(
        "★라우트가 `unavailable` 을 실어 나른다(화면만 고치면 조용히 안 뜬다)",
        routeCarries,
        routeCarries ? "라우트 통과" : "★여기서 끊긴다",
      ),
    );


    // ── ★판정 자체를 **돌려서** 본다: 시키는 대로 기다렸는데 또 거절 ─────────────
    //  손으로 고른 «N회 실패» 가 아니다 — 서버가 «이 시각 뒤에 와라» 라고 한 그 시각을
    //  지나서 물었는데 또 거절당한 창만 센다. 그건 «지금 붐빈다» 가 아니라 «너에겐 안
    //  열린다» 는 뜻이고, 그 구분이 문구를 가른다.
    const gdir = await fsp.mkdtemp(`${os.tmpdir()}/usage-gone-`);
    let goneAnswer: unknown = "미실행";
    let stillPending: unknown = "미실행";
    try {
      process.env.PATH = "";
      process.env.HOME = "";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-fake";
      const boot = async (refused: number): Promise<unknown> => {
        await fsp.writeFile(
          `${gdir}/usage-cache.json`,
          JSON.stringify({ notBefore: Date.now() - 1000, refusedAfterWaiting: refused, at: 0, value: null }),
        );
        const P = (await import(`${modUrl}?gone${refused}`)).default as new () => {
          startService: (b: unknown, h: unknown) => Promise<void>;
        };
        const h = {
          dataDir: gdir,
          log: () => {},
          captured: undefined as Record<string, unknown> | undefined,
          registerAuthProvider: (pp: Record<string, unknown>) => {
            h.captured = pp;
            return { ok: true as const };
          },
        };
        await new P().startService(null, h);
        globalThis.fetch = (async () => ({
          status: 429,
          ok: false,
          headers: { get: () => "3600" },
        })) as never;
        return await (h.captured?.getUsage as () => Promise<unknown>)();
      };
      stillPending = await boot(0); // 처음 거절 → 아직 «잠시 뒤 다시»
      goneAnswer = await boot(1); // 이미 한 창을 기다려봤다 → 이번이 둘째
    } finally {
      globalThis.fetch = realFetch;
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fsp.rm(gdir, { recursive: true, force: true });
    }
    const isGone = (v: unknown): boolean => (v as { unavailable?: boolean })?.unavailable === true;
    out.push(
      assert(
        "첫 거절은 아직 «잠시 뒤 다시» 다 — 한 번 붐볐다고 «안 된다» 고 하면 성급하다",
        !isGone(stillPending) && (stillPending as { retryAt?: number })?.retryAt !== undefined,
        JSON.stringify(stillPending),
      ),
    );
    out.push(
      assert(
        "★★못 쟀다는 답(대기·불가)엔 **창이 없다** — 있으면 화면이 그 숫자를 그려서 지어낸 값이 실측인 척 뜬다",
        saysNothingMeasured(stillPending) && saysNothingMeasured(goneAnswer),
        `대기=창 ${((stillPending as { windows?: unknown[] })?.windows ?? []).length}개 · 불가=창 ${((goneAnswer as { windows?: unknown[] })?.windows ?? []).length}개`,
      ),
    );
    out.push(
      assert(
        "★★기다렸는데도 거절당한 창이 둘이면 «이 계정에선 안 된다» 로 바꾼다 — 안 그러면 「잠시 뒤 다시」가 영원히 뜬다",
        isGone(goneAnswer),
        isGone(goneAnswer) ? "unavailable" : `★여전히 대기라고 말한다: ${JSON.stringify(goneAnswer)}`,
      ),
    );


    // ── ★되는 길: CLI 의 `/usage` 를 읽는다 (2026-09-07 정태님) ──────────────────
    //  조회 엔드포인트는 하루 종일 성공 0회였는데, CLI 슬래시 명령은 2초에 답하고
    //  **토큰을 0** 쓴다(스스로 보고한 회계: num_turns 0 · cost 0 · input 0).
    //  ★대신 **글자를 읽는다** — 그래서 이 검사가 중요하다. 모양이 바뀌면 못 읽는데,
    //   못 읽는 것 자체는 괜찮다(«모름»). 나쁜 것은 **잘못 읽는 것**이다.
    //  ★아래 문자열은 실제 출력을 그대로 박은 것이다(2026-09-07 실행).
    const CLI_OUT = [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 32% used · resets Sep 7 at 5:59pm (Asia/Seoul)",
      "Current week (all models): 45% used · resets Sep 9 at 7:59pm (Asia/Seoul)",
      "Current week (Fable): 2% used · resets Sep 9 at 7:59pm (Asia/Seoul)",
      "",
      "Last 24h · 683 requests · 188 sessions",
      "  86% of your usage came from subagent-heavy sessions",
    ].join("\n");
    const cliMod = (await import(
      new URL("../../../plugins/claude-subscription-auth/usage-cli.mjs", import.meta.url).href
    )) as { parseUsageText: (t: string, now: number) => { windows?: unknown }[] };
    const parsed = cliMod.parseUsageText(CLI_OUT, Date.UTC(2026, 8, 7, 6, 0, 0)) as {
      windowSeconds?: number;
      remainingPercent?: number;
      resetAt?: number;
    }[];
    out.push(
      assert(
        "★CLI 출력에서 창 **둘**을 읽는다(시간 한도·주간 한도 — 사용자가 묻는 축 그대로)",
        parsed.length === 2 &&
          parsed[0]?.windowSeconds === 18_000 &&
          parsed[1]?.windowSeconds === 604_800,
        JSON.stringify(parsed.map((w) => w.windowSeconds)),
      ),
    );
    out.push(
      assert(
        "★«32% used» 를 «68% 남음» 으로 뒤집는다(저쪽은 쓴 양, 우리 축은 남은 양)",
        parsed[0]?.remainingPercent === 68 && parsed[1]?.remainingPercent === 55,
        `${parsed[0]?.remainingPercent} · ${parsed[1]?.remainingPercent}`,
      ),
    );
    out.push(
      assert(
        "모델별 창(`Current week (Fable)`)은 안 싣는다 — 이름이 영어라 한국어 화면에 샌다",
        parsed.length === 2,
        `창 ${parsed.length}개`,
      ),
    );
    const reset0 = parsed[0]?.resetAt;
    out.push(
      assert(
        "리셋 시각을 읽는다(`resets Sep 7 at 5:59pm`) — 해가 없으니 창 길이로 푼다",
        typeof reset0 === "number" && new Date(reset0).getMinutes() === 59,
        reset0 === undefined ? "★못 읽음" : new Date(reset0).toISOString(),
      ),
    );
    const junk = cliMod.parseUsageText("모양이 바뀐 출력\nsession usage: unknown", Date.now());
    out.push(
      assert(
        "★모양이 바뀌면 «모름» 이다 — 못 읽는 건 괜찮고 **잘못 읽는 게** 나쁘다",
        junk.length === 0,
        junk.length === 0 ? "빈 결과" : `★지어냈다: ${JSON.stringify(junk)}`,
      ),
    );


    // ── ★«대기 중» 이 **캐시 창 안에서도** 유지된다 (2026-09-07 적대 검토 P1) ────────
    //  실측으로 잡힌 결함: 실패를 캐시에 담을 때 `undefined` 를 넣고 **반환만** `?? pending`
    //  했더니, 캐시 적중 분기(`return cached.value`)가 그 폴백을 **우회**했다. 그래서
    //  첫 열기엔 «5분 뒤 다시 시도» 가 뜨고 **두 번째 열기엔 아무것도 안 떴다** —
    //  그 문장을 읽은 사람이 가장 하기 쉬운 행동이 «다시 열어보기» 라, 재현이 쉬운 쪽이다.
    //  ★그래서 한 번이 아니라 **연달아 세 번** 부른다. 한 번만 재는 검사는 이걸 못 본다.
    const failMod = new URL(
      "../../../plugins/codex-subscription-auth/usage.ts",
      import.meta.url,
    ).href;
    const repeated: unknown[] = [];
    try {
      const m = (await import(`${failMod}?cachefail`)) as {
        fetchCodexUsage: (g: () => Promise<string>) => Promise<unknown>;
      };
      globalThis.fetch = (async () => ({ ok: false, status: 503 })) as never;
      for (let i = 0; i < 3; i += 1) repeated.push(await m.fetchCodexUsage(async () => "t"));
    } finally {
      globalThis.fetch = realFetch;
    }
    //  ★«못 쟀다» 는 답에 **창이 있으면 안 된다** (2026-09-07 2R #9). `retryAt` 만 보던
    //   판은, 실패 경로가 `windows:[{remainingPercent:100}]` 를 함께 담아도 초록이었다 —
    //   그러면 화면이 대기 문장 대신 **«5시간 100% 남음»** 을 그린다(`rows.length > 0` 이
    //   대기 줄을 억누른다). 비공식 엔드포인트가 막히는 건 설계상 정상 경로라, 막힐 때마다
    //   지어낸 숫자가 뜨는 셈이다. 이 레포가 가장 싫어하는 부류(지어낸 값을 실측인 척)다.
    const allPending = repeated.every(
      (v) => typeof (v as { retryAt?: number })?.retryAt === "number" && saysNothingMeasured(v),
    );
    out.push(
      assert(
        "★★못 쟀다는 말이 **연달아 열어도** 유지된다 — 캐시가 실패를 담으면 두 번째부터 화면이 다시 침묵한다",
        repeated.length === 3 && allPending,
        allPending
          ? "3회 전부 retryAt 유지"
          : `★${repeated.map((v) => { const u = v as { retryAt?: number; windows?: unknown[] }; return u?.retryAt === undefined ? "표식없음" : `창${(u.windows ?? []).length}개`; }).join("→")}`,
      ),
    );

    // ★★**엔드포인트 창도 리셋을 읽는다 — 모양이 셋이다** (2026-09-08).
    //  사고: 회사돌쇠 v0.50.0 에서 «남은 %는 뜨는데 리셋만 안 뜬다». 퍼센트와 리셋은
    //  **다른 필드를 다른 규칙으로** 읽어서 **혼자 실패할 수 있는데**, 종전 판정은
    //  `typeof === "string"` 하나뿐이었다 — 저쪽이 숫자로 주면 조용히 반쪽이 된다.
    //  ★형제 제공자(codex)는 같은 뜻의 필드를 **숫자**로 읽고 있었다. 한 레포 안에서
    //   같은 개념을 두 모양으로만 받는 것 자체가 신호였다.
    {
      const ep = (await import(
        new URL("../../../plugins/claude-subscription-auth/index.mjs", import.meta.url).href
      )) as {
        parseResetAt: (v: unknown) => number | undefined;
        toWindow: (w: unknown, s: number) => { remainingPercent?: number; resetAt?: number } | undefined;
      };
      const iso = "2026-09-08T10:30:00.000Z";
      const ms = Date.parse(iso);
      const shapes: [string, unknown, number | undefined][] = [
        ["ISO 문자열", iso, ms],
        ["초(unix)", Math.floor(ms / 1000), ms],
        ["밀리초(unix)", ms, ms],
        ["빈 문자열", "", undefined],
        ["쓰레기", "언젠가", undefined],
        ["0", 0, undefined],
      ];
      const bad = shapes.filter(([, v, want]) => ep.parseResetAt(v) !== want);
      out.push(
        assert(
          "★★`resets_at` 을 **ISO·초·밀리초** 셋 다 읽고, 못 읽는 값은 undefined 다(0% 로 뭉개지 않는다)",
          bad.length === 0,
          bad.length === 0
            ? `${shapes.length}종 전부 정합`
            : `★어긋남: ${bad.map(([n]) => n).join(", ")}`,
        ),
      );
      // ★**관측이 조용히 사라지지 않게** — 이 줄이 없어서 «반쪽» 을 화면 보기 전엔
      //  아무도 몰랐다. 지우는 변이가 스위트를 통과했으므로(실측) 여기서 못 박는다.
      //  두 경로(CLI·엔드포인트)가 **같은 문장**을 쓰는 것도 같이 지킨다 — 두 벌이면
      //  어느 길로 왔는지 로그로 못 가른다.
      const ixSrc = readSourceSync("plugins/claude-subscription-auth/index.mjs");
      const hasReset = /리셋★없음/.test(ixSrc) && /리셋있음/.test(ixSrc);
      const bothPaths =
        /describeWindows\([^)]*"CLI"\)/.test(ixSrc) &&
        /describeWindows\([^)]*"엔드포인트"\)/.test(ixSrc);
      out.push(
        assert(
          "★★사용량 로그가 **리셋 유무**를 싣고, CLI·엔드포인트 두 경로가 같은 문장을 쓴다 — 없으면 «퍼센트는 뜨는데 리셋만 없는» 반쪽을 화면 보기 전엔 아무도 모른다",
          hasReset && bothPaths,
          `리셋표기=${hasReset} 양쪽경로=${bothPaths}`,
        ),
      );
      // ★★**실행기 찾기는 코어 한 곳** (근본 수정). 이 플러그인이 자기 판을 들고 있던
      //  동안 결함이 셋 났다: 윈도우에서 확장자 없는 `claude` 를 가리킴 · `.cmd` 를
      //  띄우려 켠 셸이 공백 있는 사용자 경로를 쪼갬 · 빈 `HOME` 이 프로필 후보를 지움.
      //  셋 다 «찾기» 를 직접 하지 않으면 애초에 안 생긴다. 그래서 증상이 아니라
      //  **자리**를 검사한다 — 두 번째 판이 다시 생기면 여기서 운다.
      // ★**주석을 빼고 본다.** 첫 판이 이 파일의 «종전엔 $HOME/.local/bin 을 뒤졌다» 는
      //  **설명 문장**을 코드로 세어 빨개졌다 — 검사 대상은 코드이지 그걸 설명하는 글이
      //  아니다([[feedback_gate_must_actually_run]]).
      const { stripComments } = await import("./_wiring.js");
      const cliSrc = stripComments(
        readSourceSync("plugins/claude-subscription-auth/usage-cli.mjs"),
      );
      const owns = [
        ["env 홈 탐색", /process\.env\.(HOME|USERPROFILE)/],
        ["셸 실행", /shell:\s*true/],
        ["경로 후보 하드코딩", /\.local\/bin/],
      ].filter(([, re]) => (re as RegExp).test(cliSrc)).map(([n]) => n as string);
      out.push(
        assert(
          "★★실행기 찾기를 **직접 하지 않는다** — `findBundledClaude()`(코어)에 위임한다. 같은 판단이 두 곳이면 갈리고, 실제로 윈도우 결함 셋이 그 갈림에서 났다",
          /findBundledClaude/.test(cliSrc) && owns.length === 0,
          `findBundledClaude=${/findBundledClaude/.test(cliSrc)} · 자기 탐색 ${owns.length}종${owns.length ? `(${owns.join(",")})` : ""}`,
        ),
        assert(
          "★코어 쪽 판정은 플랫폼을 본다(`win32` → `claude.exe`) — 이게 위임의 값이다",
          /win32.*claude\.exe/.test(readSourceSync("src/core/claude-cli.ts")),
          (readSourceSync("src/core/claude-cli.ts").match(/const binName[^;]*;/) ?? [
            "★binName 없음",
          ])[0].slice(0, 90),
        ),
      );

      const w = ep.toWindow({ utilization: 0.23, resets_at: Math.floor(ms / 1000) }, 18_000);
      out.push(
        assert(
          "★★숫자로 온 리셋이 창까지 도달한다 — 퍼센트만 살아 화면이 «반쪽» 이 되지 않는다",
          w?.remainingPercent === 77 && w?.resetAt === ms,
          JSON.stringify(w),
        ),
      );
    }

    return out;
  },
};
export default check;
