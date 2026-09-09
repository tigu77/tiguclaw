/**
 * Claude **구독** 인증을 이 설치에서 허용한다.
 *
 * ★왜 플러그인인가 (2026-09-01, 정태님 확정). Business 판은 구독을 빼고, 꼭 필요하면 기업이
 *  **설치라는 명시적·귀속 가능한 행위**로 책임을 가져간다. 그 «되돌리는 길» 이 성립하려면
 *  코드가 앱 트리 밖에 있어야 한다 — 앱 트리는 `/update` 가 소스에서 다시 지어 되살린다.
 *  홈(`<home>/plugins/`)은 레포 밖이라 살아남는다.
 *
 * ★**어댑터가 아니라 인증만** 여기 있다. claude 어댑터는 SDK 의존이라 코어에 남는다(홈
 *  플러그인엔 `node_modules` 가 없다 — 폴더에 `npm i` 하면 실측 247MB). 여기가 하는 일은
 *  «이 설치에서 구독 토큰을 인증으로 인정한다» 는 **선언** 하나이고, 그건 env 문자열을 보는
 *  게 전부라 **의존성이 0**이다. 그래서 이 파일은 아무것도 import 하지 않는다.
 *
 * ★**없는 상태가 안전한 상태다.** 이 플러그인이 없으면 `CLAUDE_CODE_OAUTH_TOKEN` 이
 *  `.env` 에 있어도 데몬은 구독으로 안 돈다. API 키(`ANTHROPIC_API_KEY`)는 레지스트리를
 *  안 지나므로 **그대로 산다** — 능력 손실이 아니라 비용 차이다.
 *
 * ★이건 격리가 아니라 **책임 경계**다. 격리가 0이라 마음먹은 운영자는 우회할 수 있다.
 *  막는 것은 «아무도 모르게 구독으로 돌아가는 것» 이다.
 */
const token = () => (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();

/**
 * 한도가 **얼마나 남았나** — 전용 엔드포인트 (2026-09-07).
 *
 * ★★**정직하게: 이 엔드포인트가 우리에게 200 을 준 적이 한 번도 없다** (2026-09-07).
 *  `GET https://api.anthropic.com/api/oauth/usage` 가 `five_hour`·`seven_day` 를 사용률과
 *  함께 준다는 것은 **참조본에서 본 모양**이고, 우리 토큰으로는 **성공 0회**다(전체 로그
 *  grep 결과 0). 아래 `toWindow` 가 읽는 필드 이름은 그래서 **관측이 아니라 기대**다.
 *  ★처음엔 이걸 "조회만 조인 것" 이라고 적었는데, 그건 한 번은 됐다가 막힌 상태를 전제한
 *   말이라 틀렸다. 잰 것만 적으면 이렇다:
 *     - 가짜 토큰 → **401**(`OAuth access token is invalid`)
 *     - 우리 토큰 → **429** + `retry-after` ≈ 3600, **매번**
 *   즉 인증은 통과하는데 창이 열린 적이 없다.
 * ★★**왜인지 나중에 알았다** — 이 토큰(`claude setup-token` 산출물)은 **구독 자격으로
 *  안 잡힌다.** 실측: 그 토큰을 준 채로 CLI 를 띄우면 `authMethod oauth_token ·
 *  subscriptionType **None**` 이다. 한도 조회는 구독자에게만 열리므로 그래서 거절이었다.
 *  「시간당 1회 제한」이 아니었다 — 내가 `retry-after` 를 보고 그렇게 읽었을 뿐이다.
 *  아래 유지되는 대기·판정 로직은 **다른 계정·다른 토큰 종류**를 위한 폴백으로 남긴다.
 * ★그래서 이 경로는 **되면 좋고 아니면 «모름»** 이다. 대안은 매 턴 공짜로 오는
 *  `rate_limit_event`(코어 `rate-limit-view.ts`) — 사용률은 없지만 걸린 창과 리셋 시각은
 *  준다. 이 경로가 계속 안 열리면 그쪽으로 간다.
 *
 * ★★**캐시 길이를 우리가 정하지 않는다 — 서버가 말해준 대로 쉰다.** 이 엔드포인트는
 *  폴링 방지용으로 따로 조여 있어서, 짧게 물으면 `429 + retry-after` 가 온다(실측:
 *  첫 호출에 `retry-after: 3569`). ★그때 «계정이 막혔다» 가 **아니다** — 같은 순간
 *  모델 호출은 정상이었고 쿨다운도 없었다. 조회만 조인 것이다. 그래서 429 를 «한도 도달»
 *  로 읽으면 거짓말이 된다.
 * ★임계를 직감으로 고르지 않는 방법이 이것이다([[project_prompt_prefix_cache_position]]).
 *
 * ★★**시계를 재시작 너머로 들고 간다** (2026-09-07). 실측: 이 엔드포인트는 **거절당한
 *  요청도 시계를 되감는다** — `retry-after 162초` 를 보고 3분 뒤 다시 물었더니 **3196초**로
 *  튀었다. 즉 «한 시간에 한 번» 이고, 헛되이 두드리면 그 한 시간이 계속 미뤄진다.
 *  그런데 `notBefore`·`lastOk` 가 메모리에만 있어서 **데몬을 재시작할 때마다 처음부터**
 *  물었고, 개발 기계는 하루에도 여러 번 배포한다 — 그래서 화면이 영영 «모름» 이었다
 *  (정태님: *"클로드는 구독 플러그인에 표시가 안되는데?"*). 파일로 남긴다.
 * ★캐시는 **리셋 시각을 지나면 버린다** — 그 숫자는 이미 없는 창에 대한 말이라, 오래됐다는
 *  것보다 «틀렸다» 는 게 문제다.
 * ★`node:fs` 는 **빌트인**이라 이 파일의 «의존성 0» 성질을 안 깬다(그 성질이 지키려는 것은
 *  `node_modules` 없는 홈에서도 돈다는 것이다 — 빌트인은 거기 있다).
 *
 * ★실패는 조용하다 — 못 가져오면 `undefined`(모름). 마지막 성공값이 있으면 그걸 준다.
 * ★의존성 0 을 지킨다 — 이 파일은 아무것도 import 하지 않는다(위 머리말 참조).
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/**
 * **엔드포인트 경로**의 최소 간격. 429 가 오면 그건 `retry-after`(`notBefore`)로 덮인다.
 *
 * ★**CLI 경로엔 안 건다** (2026-09-09 정태님). 종전엔 이 게이트가 `fetchClaudeUsage` 첫
 *  줄에 있어 **공짜 경로까지 5분 막았다** — 그런데 CLI 는 이 파일 스스로가 *"토큰을 0 쓴다
 *  (슬래시 명령이라 모델을 안 거친다 — num_turns 0 · cost 0)"* 라고 적어둔 길이다. 429 를
 *  걱정해야 하는 건 아래 엔드포인트뿐이고, 거기엔 서버가 정한 `notBefore` 가 따로 있다.
 */
const MIN_GAP_MS = 5 * 60_000;
/** 중복 접기 — 화면 한 번 여는 동안의 재렌더·연타를 접는 것뿐이다(codex 와 같은 값). */
const DEDUP_MS = 30_000;
/** 강제 갱신의 연타 하한 — CLI 를 무한히 spawn 하지 않는다. */
const FORCE_MIN_GAP_MS = 5_000;
let lastOk; // { at, value }
let notBefore = 0; // 이 시각 전에는 안 묻는다(429 가 정한다).
/**
 * ★**시키는 대로 기다렸는데도 거절당한 횟수** (2026-09-07).
 *  그냥 «실패 N회» 가 아니다 — 서버가 «이 시각 뒤에 와라» 라고 한 그 시각을 지나서 물었는데
 *  또 거절당한 것만 센다. 그건 «지금 붐빈다» 가 아니라 **«너에겐 안 열린다»** 는 뜻이다.
 *  둘이 되면 화면이 «잠시 뒤 다시» 대신 «이 계정에선 안 됩니다» 라고 말한다 — 안 그러면
 *  「19분 뒤 다시 시도」가 영원히 떠 있고, 그건 모름이 아니라 거짓 약속이다.
 */
let refusedAfterWaiting = 0;

/** `<home>/plugins/claude-subscription-auth/usage-cache.json` — startService 가 넣는다. */
let cachePath;
const loadCache = async () => {
  if (cachePath === undefined) return;
  try {
    const { readFileSync } = await import("node:fs");
    const j = JSON.parse(readFileSync(cachePath, "utf8"));
    if (typeof j.notBefore === "number") notBefore = j.notBefore;
    if (typeof j.refusedAfterWaiting === "number") refusedAfterWaiting = j.refusedAfterWaiting;
    if (j.value !== null && typeof j.value === "object" && typeof j.at === "number") {
      // 리셋을 지난 값은 버린다 — 이미 없는 창에 대한 숫자다.
      const earliest = Math.min(
        ...(j.value.windows ?? []).map((w) => (typeof w.resetAt === "number" ? w.resetAt : Infinity)),
      );
      if (!(earliest < Date.now())) lastOk = { at: j.at, value: j.value };
    }
  } catch {
    /* 없거나 깨졌으면 그냥 처음부터 — 캐시는 편의지 진실이 아니다 */
  }
};
const saveCache = async () => {
  if (cachePath === undefined) return;
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(cachePath.slice(0, cachePath.lastIndexOf("/")), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        notBefore,
        refusedAfterWaiting,
        at: lastOk?.at ?? 0,
        value: lastOk?.value ?? null,
      }),
    );
  } catch {
    /* 못 남겨도 동작은 그대로 — 다음 재시작이 한 번 더 물을 뿐이다 */
  }
};

/**
 * ★**왜 실패했는지 로그에만 남긴다** (2026-09-07).
 *
 * 실측: 429 가 계속 오는데 화면은 그냥 «한도 줄이 없음» 이었고 로그도 0줄이라, **조회가
 * 조인 것인지 이 제공자가 원래 사용량을 안 주는 것인지 구분할 수가 없었다.** 로그가 1차
 * 진단면인 곳(원격 불가한 설치본)에서는 그게 곧 «못 잡는다» 다.
 *
 * ★반복은 세고 안 반복한다 — 같은 이유가 계속 찍히면 배경소음이 되고, 그러면 진짜 신호가
 *  묻힌다. 이유가 바뀔 때만 찍고, 같은 이유는 횟수만 다음 줄에 실린다.
 * ★수치를 실어라 — 상태코드·서버가 말한 대기초·다음 시도 시각. «실패함» 만으론 못 고친다.
 */
let logSink; // startService 가 넣는다(의존성 0 을 지키려 import 대신 주입).
let lastReason = "";
let sameCount = 0;
const noteUsage = (reason) => {
  if (reason === lastReason) {
    sameCount += 1;
    return;
  }
  const tail = sameCount > 0 ? ` (직전 «${lastReason}» ${sameCount + 1}회)` : "";
  lastReason = reason;
  sameCount = 0;
  logSink?.(`[usage] claude-subscription: ${reason}${tail}`);
};

/**
 * `resets_at` 을 밀리초로 — 문자열(ISO)·숫자(초 또는 밀리초) 전부 받는다.
 * 못 읽으면 `undefined`(리셋은 있으면 좋은 것이지 없으면 안 되는 것이 아니다).
 */
export const parseResetAt = (v) => {
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // 1e12 미만 = 초 단위(2001-09-09 이전 밀리초는 실용상 없다).
    return v < 1e12 ? v * 1000 : v;
  }
  return undefined;
};

/**
 * 창을 로그 한 줄로 — **리셋 유무를 반드시 싣는다** (2026-09-08).
 *
 * ★사고: 회사돌쇠 v0.50.0 에서 «남은 %는 뜨는데 리셋 시각만 안 뜬다» 가 났는데, 로그엔
 *  퍼센트만 적혀 있어 **화면을 보기 전까지 아무도 몰랐다.** 리셋은 별도 필드를 별도
 *  규칙으로 읽으므로 **혼자 실패할 수 있는데**, 그 실패에 흔적이 없었다.
 *  ★두 경로(CLI·엔드포인트)가 같은 문장을 쓰게 여기 한 곳에 둔다 — 두 벌로 지으면
 *   어느 경로였는지 로그로 못 가른다([[feedback_logs_must_stand_alone]]).
 */
const describeWindows = (ws, via) =>
  `창 ${ws.length}개(${via}) — ` +
  ws
    .map(
      (w) =>
        `${w.windowSeconds}초:${Math.round(w.remainingPercent ?? -1)}%남음` +
        (w.resetAt === undefined ? "/리셋★없음" : "/리셋있음"),
    )
    .join(" ");

export const toWindow = (w, seconds) => {
  if (w === null || typeof w !== "object") return undefined;
  const used = typeof w.utilization === "number" ? w.utilization : undefined;
  // ★**모양을 하나로 못 박지 않는다** (2026-09-08). 종전엔 문자열만 받아서, 저쪽이 숫자로
  //  주면 `resetAt` 만 조용히 빠졌다 — 퍼센트는 그대로 나오므로 화면엔 «남은 양은 보이는데
  //  리셋은 없는» 반쪽이 뜨고, 로그엔 아무것도 안 남는다(회사돌쇠 v0.50.0 증상).
  //  ★우리 형제 제공자(`codex-subscription-auth`)는 **숫자**로 읽는다 — 같은 뜻의 필드를
  //   두 플러그인이 다른 모양으로만 받고 있었던 것 자체가 신호였다.
  //  초/밀리초는 크기로 가른다(2001년보다 작으면 초다). 손 목록 아니고 단위 판정이다.
  const resetAt = parseResetAt(w.resets_at);
  if (used === undefined && !Number.isFinite(resetAt)) return undefined;
  return {
    windowSeconds: seconds,
    // 저쪽은 «쓴 비율», 우리 표현은 «남은 비율» — 사용자가 묻는 것이 그것이다.
    ...(used !== undefined ? { remainingPercent: Math.max(0, Math.min(100, 100 - used * 100)) } : {}),
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
  };
};

/**
 * «못 쟀다 + 언제 다시 잰다» — 화면이 «모름» 대신 «대기 중» 이라고 말할 수 있게.
 * ★아무 말도 안 하면 사용자는 «이 제공자는 원래 안 알려주나» 로 읽는다(정태님이 화면을
 *  보내며 *"아무것도 안떠"*). 숫자를 지어내는 것과 이유를 말해주는 것은 다르다.
 */
const pending = (now, at) =>
  refusedAfterWaiting >= 2 && lastOk === undefined
    ? { windows: [], measuredAt: now, unavailable: true }
    : { windows: [], measuredAt: now, retryAt: at };

/**
 * ★**되는 길을 먼저 쓴다** (2026-09-07 정태님: *"꼭 엔드포인트를 고집할 필요는 없지"*).
 *  아래 엔드포인트 경로는 하루 종일 **성공 0회**였다. CLI 의 `/usage` 는 2초에 답하고
 *  **토큰을 0** 쓴다(슬래시 명령이라 모델을 안 거친다 — `num_turns 0 · cost 0`).
 *  그래서 순서가 이렇다: **CLI → (없거나 못 읽으면) 엔드포인트 → 모름.**
 * ★CLI 가 없거나 로그인이 안 된 설치도 있다. 그건 결함이 아니라 그 길이 없는 것이고,
 *  그때 아래 엔드포인트가 여전히 시도한다(다른 계정에선 열릴 수도 있다).
 */
let cliDead = false; // CLI 가 없다고 판명되면 매번 2초를 태우지 않는다.

/**
 * **진행 중인 조회 하나를 나눠 쓴다** (2026-09-09, 적대 검토 P1).
 *
 * ★연타 하한(`FORCE_MIN_GAP_MS`)은 `lastOk.at` 을 보는데 그 값은 **조회가 끝난 뒤에야**
 *  갱신된다. 그래서 **직렬 연타만** 막고 동시 요청은 전부 통과했다 — 실측: `?force=1` 을
 *  20개 동시에 보내면 `claude -p /usage` 프로세스가 **20개** 뜨고 12개만으로도 합계
 *  RSS 4GB 였다. 주석은 *"CLI 를 무한히 spawn 하지 않는다"* 고 선언해 놓고 안 지켰다.
 * ★고칠 자리는 하한이 아니라 **여기**다: 이미 묻고 있으면 그 약속을 그대로 돌려준다.
 */
let inflight;

const fetchClaudeUsage = async (force = false) => {
  if (inflight !== undefined) return inflight;
  inflight = fetchClaudeUsageInner(force).finally(() => {
    inflight = undefined;
  });
  return inflight;
};

const fetchClaudeUsageInner = async (force = false) => {
  const now = Date.now();
  // ★중복 접기만 한다(30초). 새로고침을 눌렀으면 연타 하한만 남긴다.
  const gap = force ? FORCE_MIN_GAP_MS : DEDUP_MS;
  if (lastOk !== undefined && now - lastOk.at < gap) return lastOk.value;
  if (!cliDead) {
    const { fetchUsageViaCli } = await import("./usage-cli.mjs");
    const viaCli = await fetchUsageViaCli(noteUsage);
    if (viaCli !== undefined) {
      noteUsage(describeWindows(viaCli.windows ?? [], "CLI"));
      lastOk = { at: now, value: viaCli };
      refusedAfterWaiting = 0;
      await saveCache();
      return viaCli;
    }
    cliDead = true; // 이 프로세스가 사는 동안은 다시 안 띄운다(재시작하면 다시 본다).
  }
  // ↓ 여기부터는 **엔드포인트 경로**다 — CLI 가 없거나 못 읽었을 때만 온다.
  // ★5분 바닥은 **여기**가 제자리다(위 CLI 는 공짜라 안 건다). 마지막 성공이 5분 안이면
  //  굳이 조여 있는 엔드포인트를 또 때리지 않는다 — 429 를 부르는 건 이 길이다.
  if (lastOk !== undefined && now - lastOk.at < MIN_GAP_MS) return lastOk.value;
  if (now < notBefore) {
    noteUsage(`대기 중 — ${Math.ceil((notBefore - now) / 1000)}초 남음`);
    return lastOk?.value ?? pending(now, notBefore); // 서버가 쉬라고 한 동안은 마지막 값
  }
  try {
    const t = token();
    if (t === "") {
      noteUsage("토큰 없음 — 조회 안 함");
      return undefined;
    }
    const res = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${t}`,
        "User-Agent": "tiguclaw",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 429) {
      // ★서버가 «언제 다시 오라» 고 말해준다 — 그걸 그대로 따른다.
      // ★그런데 **그 시각을 지나서 물었는데 또 거절**이면 얘기가 다르다 — 붐비는 게 아니라
      //  안 열리는 것이다. 여기 도달했다는 건 이미 `notBefore` 를 지났다는 뜻이다.
      if (notBefore > 0) refusedAfterWaiting += 1;
      const ra = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      notBefore = now + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : MIN_GAP_MS);
      await saveCache(); // ★재시작해도 이 시계를 지킨다 — 헛되이 두드리면 창이 더 밀린다.
      //  ★**기다린다** — 내구성이 목적인데 쓰기를 안 기다리면 그 사이 재시작에 날아간다.
      noteUsage(
        `429 조회 제한 — retry-after ${Number.isFinite(ra) ? `${ra}초` : "미제공"}, ` +
          `${new Date(notBefore).toISOString()} 이후 재시도. ` +
          `계정 한도가 아니다(모델 호출은 그대로 된다)`,
      );
      return lastOk?.value ?? pending(now, notBefore); // «한도 도달» 이 아니다 — 조회만 조인 것이다.
    }
    if (!res.ok) {
      noteUsage(`HTTP ${res.status} — 마지막 성공값(${lastOk === undefined ? "없음" : "있음"})으로 답한다`);
      return lastOk?.value ?? pending(now, now + MIN_GAP_MS);
    }
    const j = await res.json();
    const windows = [
      toWindow(j?.five_hour, 18000),
      toWindow(j?.seven_day, 604800),
    ].filter((w) => w !== undefined);
    if (windows.length === 0) {
      noteUsage(`200 인데 창이 0개 — 응답 모양이 바뀌었나(키: ${Object.keys(j ?? {}).join(",")})`);
      return lastOk?.value ?? pending(now, now + MIN_GAP_MS);
    }
    const value = { windows, measuredAt: now };
    lastOk = { at: now, value };
    refusedAfterWaiting = 0; // 한 번 되면 그 판정은 무효다.
    await saveCache();
    noteUsage(describeWindows(windows, "엔드포인트"));
    return value;
  } catch (e) {
    noteUsage(`조회 실패 — ${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 120)}`);
    return lastOk?.value ?? pending(Date.now(), Date.now() + MIN_GAP_MS); // 마지막으로 아는 것
  }
};

export default class ClaudeSubscriptionAuth {
  async startService(_bus, host) {
    if (host === undefined) return; // 옛 런타임(호스트 미전달)에선 조용히 아무것도 안 한다.
    logSink = (m) => host.log(m); // 왜 사용량이 비었는지는 **로그에만** 남는다(위 noteUsage).
    // ★조회 시계를 재시작 너머로 — 안 그러면 배포할 때마다 한 시간을 새로 태운다.
    cachePath = `${host.dataDir}/usage-cache.json`;
    await loadCache();
    const r = host.registerAuthProvider({
      provider: "claude-subscription",
      isAuthenticated: () => token() !== "",
      // 한도가 얼마나 남았나 — 상세를 열 때만(배경 폴링 0). 위 `fetchClaudeUsage` 주석 참조.
      getUsage: fetchClaudeUsage,
      getAccessToken: async () => {
        const t = token();
        if (t === "") {
          throw new Error(
            "claude 구독 토큰이 없습니다 — `npm run claude-auth` 로 CLAUDE_CODE_OAUTH_TOKEN 을 발급하세요.",
          );
        }
        return t;
      },
      /**
       * ★**여기는 «끝까지» 가 안 된다 — 그래서 그렇게 말한다** (2026-09-05 실측).
       *  발급은 번들 `claude setup-token` 이 하는데 그건 **TTY 가 필요**하다: 비TTY 로 돌리면
       *  12초간 출력이 0이고, `script -q` 로 PTY 를 붙이는 무의존 우회도 부모에 TTY 가
       *  없으면 실패한다(`tcgetattr/ioctl`). codex 처럼 «버튼 한 번» 이라고 적으면 그건
       *  거짓말이 된다.
       * ★대신 두 길을 연다: 그 기계 **터미널 한 줄**(화면이 복사 버튼과 함께 보여준다)과,
       *  이미 받은 토큰 **붙여넣기**. 폰에서도 후자로 끝낼 수 있다.
       * ★저장은 `host.saveAuthEnv` 로 한다 — 이 파일이 **아무것도 import 하지 않는** 성질을
       *  지키기 위해서다(그게 이 플러그인이 홈으로 옮겨 살아남는 근거다).
       */
      login: {
        label: "구독 토큰 발급",
        begin: async () => ({
          summary:
            "Claude Code 실행기가 토큰을 발급합니다. 이 발급기는 터미널이 필요해서(실측) " +
            "여기서 끝까지는 안 됩니다 — 아래 명령을 그 기계 터미널에서 돌리고, 나온 토큰을 붙여넣으세요.",
          command: "npm run claude-auth",
          pasteHint: "발급된 토큰 (sk-ant- 로 시작합니다)",
          needsRestart: false,
        }),
        finish: async (pasted) => {
          const t = String(pasted ?? "").trim();
          // ★모양만 본다(접두는 우리 redact 규칙이 이미 아는 것과 같다). 유효성은 상류가
          //  정하는 것이라 여기서 단정하지 않는다 — 다만 빈 값·따옴표 사고는 막는다.
          const token = (/\bsk-ant-[A-Za-z0-9._-]{20,}\b/.exec(t) ?? [])[0] ?? "";
          if (token === "") {
            return { ok: false, message: "토큰을 못 찾았습니다 — `sk-ant-` 로 시작하는 값을 붙여넣으세요." };
          }
          const w = await host.saveAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: token });
          if (!w.ok) return { ok: false, message: w.error ?? "저장 실패" };
          return { ok: true, message: "토큰을 홈 .env 에 저장했습니다 — 다음 턴부터 구독으로 돕니다." };
        },
      },
    });
    if (!r.ok) host.log(`구독 인증을 못 켰습니다: ${r.error}`);
    else if (token() === "") {
      host.log("구독 인증 허용됨 — 다만 CLAUDE_CODE_OAUTH_TOKEN 이 아직 없습니다(API 키는 그대로 됩니다).");
    }
  }
  async stop() {}
}
