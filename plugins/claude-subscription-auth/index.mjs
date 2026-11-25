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
import { claudeSubscriptionAuthenticated } from "./auth-probe.mjs";
const token = () => (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
/** 토큰 → 표지(해시 앞부분) — `startService` 가 `node:crypto` 를 싣는다(이 파일은 정적 import 를 하지 않는다 · 빌트인은 의존성이 아니다). */
let hashOf;
/**
 * **지금 토큰의 표지** (2026-11-21) — 같은 토큰이면 같고 바뀌면 다르다. 토큰이 없으면 `""`. 토큰 값은 어디에도 남기지 않는다.
 * ★코어가 턴 사용률을 토큰에 귀속하는 방식(`rate-limit-view.ts` 의 해시 앞부분)과 같다.
 */
const credentialKey = () => {
  const t = token();
  return t === "" || hashOf === undefined ? "" : hashOf(t);
};

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
let lastOk; // { at, value } — `heldFor` 자격의 것
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
/** 파일의 숫자가 지금 토큰으로 물은 엔드포인트 값이라는 표식 — 이 표식이 없는 파일(출시본·이전 후보)의 숫자는 되살리지 않는다. */
const ENDPOINT_SRC = "endpoint";
const loadCache = async () => {
  if (cachePath === undefined) return;
  try {
    const { readFileSync } = await import("node:fs");
    const j = JSON.parse(readFileSync(cachePath, "utf8"));
    if (typeof j.notBefore === "number") notBefore = j.notBefore; // 서버의 시계 — 자격과 무관하게 지킨다
    // ★숫자·판정은 **그 답을 얻은 자격**의 것이다(2026-11-21) — 꺼진 사이 토큰이 바뀌었거나 표지가 없는 옛 파일이면 쓰지 않는다.
    if (j.key !== heldFor) return;
    if (typeof j.refusedAfterWaiting === "number") refusedAfterWaiting = j.refusedAfterWaiting;
    // CLI 를 띄운 주기(`cliOrgMemo`)도 재시작 너머로 — 안 그러면 재시작 직후 조회가 CLI 를 다시 띄운다(종전엔 CLI 성공값이 파일에 있어 접혔다).
    //  지났는지는 여기서 가르지 않는다 — 주기 게이트(`fetchClaudeUsageInner`)·`refreshAfterNow` 한 곳이 정한다.
    if (typeof j.cliAt === "number" && j.cliAt > 0) {
      cliOrgMemo = { at: j.cliAt, org: typeof j.cliOrg === "string" ? j.cliOrg : undefined };
    }
    // ★숫자는 **지금 토큰으로 물은 엔드포인트 값**이라고 적힌 파일에서만(`src`) 되살린다 — 표식 없는 파일은 CLI 숫자를 담았을 수 있다
    //  (2026-11-21 남은 차단 #1: CLI 숫자는 계정을 확인할 수 없어 쓰지 않는다).
    if (j.src === ENDPOINT_SRC && j.value !== null && typeof j.value === "object" && typeof j.at === "number") {
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
        key: heldFor,
        refusedAfterWaiting,
        at: lastOk?.at ?? 0,
        value: lastOk?.value ?? null,
        src: ENDPOINT_SRC, // `lastOk` 에 담기는 숫자는 엔드포인트 값뿐이다(CLI 분기는 담지 않는다)
        cliAt: cliOrgMemo?.at ?? 0,
        cliOrg: cliOrgMemo?.org ?? null,
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
 * 이 기계의 Claude Code 가 구독으로 로그인돼 있지 않다(CLI 가 한도 대신 비용 요약을 줬다) — 2026-10-08.
 * ★그때 엔드포인트도 이 설치의 토큰으론 안 열린다(구독 자격이 아니다). 그래서 «잠시 뒤 다시» 가 아니라 «조회할 수 없다» 고
 *  말한다 — 안 그러면 「N분 뒤 다시 시도」가 영원히 뜬다(오지 않을 약속).
 * ★«CLI 에 로그인하면 표시된다» 고는 하지 않는다(2026-11-21) — CLI 숫자는 계정을 확인할 수 없어 쓰지 않으므로(CLI 분기) 그 약속도 오지 않는다.
 */
let cliNeedsLogin = false;
let textHost; // 문장의 언어는 **부를 때마다** host.locale 에서 읽는다 — 켤 때 한 번 읽으면 설정을 바꿔도 안 따라간다(2026-10-09 적대 검토).
const needsLoginUsage = (now) => ({
  windows: [],
  measuredAt: now,
  unavailable: true,
  reason: say(textHost ?? {}, "needsLogin"),
});
/** 이번에 새 값을 못 얻었을 때 — 마지막 성공값, 없으면 (로그인 안 됨이면) 로그인 안내, 아니면 «그때 다시». 429·오류·대기 어디서 멈춰도 같은 답. */
const fallback = (now, until) => lastOk?.value ?? (cliNeedsLogin ? needsLoginUsage(now) : pending(now, until));

/**
 * **진행 중인 조회 하나를 나눠 쓴다** (2026-09-09, 적대 검토 P1).
 *
 * ★연타 하한(`FORCE_MIN_GAP_MS`)은 `lastOk.at` 을 보는데 그 값은 **조회가 끝난 뒤에야**
 *  갱신된다. 그래서 **직렬 연타만** 막고 동시 요청은 전부 통과했다 — 실측: `?force=1` 을
 *  20개 동시에 보내면 `claude -p /usage` 프로세스가 **20개** 뜨고 12개만으로도 합계
 *  RSS 4GB 였다. 주석은 *"CLI 를 무한히 spawn 하지 않는다"* 고 선언해 놓고 안 지켰다.
 * ★고칠 자리는 하한이 아니라 **여기**다: 이미 묻고 있으면 그 약속을 그대로 돌려준다.
 */
let inflight; // { key, p } — 그 조회의 자격 표지와 약속

/**
 * **새로고침이 실제로 새로 묻는 시각** (2026-10-09 정태님: «그동안은 안 눌리게 막는 게 낫겠다»).
 * ★CLI 가 있으면 연타 하한만 건다. CLI 를 다시 띄우는 주기(`CLI_ORG_EVERY_MS`)는 **조회 안에서** 지킨다 — 주기 안의 🔄 는 CLI 를 띄우지 않고
 *  지금 자격의 확인된 값(턴 실측·엔드포인트 성공값)만 다시 읽는다(`fetchClaudeUsageInner` 의 주기 분기). 그래서 버튼까지 주기만큼 막을 이유가 없다 —
 *  막으면 그 사이 도착한 같은 자격의 턴 값도 못 읽었다(2026-11-25 아스트라 종합 인계 1-1: 첫 CLI «확인 불가» 뒤 최대 10분).
 *  CLI 가 없으면 남는 건 조여 있는 엔드포인트뿐이라, 서버가 정한 대기 시각과 5분 간격까지는 눌러도 같은 값이다(종전 그대로).
 */
let lastAttemptAt = 0;
/**
 * 마지막으로 🔄(강제 조회)를 **받아들인** 시각 — 연타 하한은 외부 조회 시각(`lastAttemptAt`)이 아니라 이 시각에서도 잰다(2026-11-25 구현 검토 G1).
 * 주기 안 🔄 는 CLI·엔드포인트를 안 부르고 확인된 값만 읽어 `lastAttemptAt` 이 안 바뀐다 — 그 값만 보면 두 번째 🔄 부터 하한이 이미 지나 있었다.
 * `lastAttemptAt` 은 접기(`lastAnswer`)도 정하므로 여기서 덮지 않고 따로 둔다.
 */
let lastForceAt = 0;
/** 마지막으로 돌려준 답(성공이 아니어도) — 서버 쪽 연타 하한. 성공값이 없으면 `lastOk` 하한이 안 걸려 누를 때마다 CLI·엔드포인트를 다시 불렀다. */
let lastAnswer;
let cliModRef;
const refreshAfterNow = () => {
  const floor = Math.max(lastAttemptAt, lastForceAt) + FORCE_MIN_GAP_MS;
  if (cliModRef?.cliAvailable?.() ?? true) return floor;
  return Math.max(floor, notBefore, lastOk !== undefined ? lastOk.at + MIN_GAP_MS : 0);
};
const withRefreshAfter = (v) => (v === undefined ? v : { ...v, refreshAfter: refreshAfterNow() });

/**
 * **지금 쥔 답들의 자격** (2026-11-20 정태님 «인증이 완료되면 한도 게이지도 갱신»).
 * ★토큰이 바뀌면(화면 붙여넣기·발급기·터미널 — 어느 길이든 데몬 env 가 바뀐다) 앞서 쥔 답은 다른 자격의 것이다: 마지막 성공값은 옛
 *  토큰으로 물은 엔드포인트 값이고, «기다려도 안 열린다» 판정도 옛 토큰에 대한 것이다. 그래서 접는 창(30초·연타 5초) 안이어도
 *  버리고 새로 묻는다. ★서버가 정한 대기(`notBefore`)는 남긴다 — 우리가 정한 캐시가 아니라 엔드포인트의 시계다(위 머리말).
 * ★턴 사용률은 여기서 거르지 않는다 — 코어가 이미 지금 토큰의 것만 준다(`claudeUsageFromTurns` → `rate-limit-view.ts`).
 */
let heldFor = ""; // startService 가 켤 때의 표지를 넣는다(파일 캐시도 이 표지일 때만 쓴다).
const forgetIfCredentialChanged = (key) => {
  if (key === heldFor) return;
  heldFor = key;
  lastOk = undefined;
  lastAnswer = undefined;
  lastAttemptAt = 0;
  lastForceAt = 0;
  refusedAfterWaiting = 0;
  // 옛 자격에서 CLI 가 실패·«로그인 필요» 였다는 기억도 그 시도의 것이다 — 새 자격은 CLI 를 다시 묻는다(실행기가 정말 없으면 한 번 더 실패할 뿐).
  cliDead = false;
  cliNeedsLogin = false;
  // 토큰과 함께 CLI 로그인도 바꿨을 수 있다 — 계정 대조를 옛 메모로 하지 않고, 바뀌기 전에 시작한 조직 조회의 답도 메모에 안 쓴다.
  cliOrgMemo = undefined;
  cliOrgGen += 1;
  noteUsage("자격이 바뀌었다 — 이전 자격의 한도 답을 버리고 새로 묻는다");
  void saveCache();
};

const fetchClaudeUsage = async (force = false) => {
  const key = credentialKey();
  forgetIfCredentialChanged(key);
  if (force) lastForceAt = Date.now();
  // ★**같은 자격의** 조회만 나눠 쓴다 — 다시 인증한 뒤의 요청이 옛 토큰으로 돌던 조회의 답을 받지 않게.
  if (inflight !== undefined && inflight.key === key) return inflight.p;
  const p = fetchClaudeUsageInner(force, key)
    .then((v) => {
      // 도는 사이 다른 자격의 조회가 시작됐으면(`heldFor` 가 바뀌었으면) 담지도 돌려주지도 않는다 — 옛 요청은 «모름»(CLI 분기와 같다).
      //  기다리는 동안 공용 상태는 새 자격의 것이 된다: 실패 경로의 `fallback`(마지막 성공값·판정, 검토 3-3)도, 여기 붙는 `refreshAfter`
      //  (검토 3-2)도 새 자격의 것이라 옛 요청의 답에 실으면 다른 자격의 값이 된다(2026-11-21). 그래서 반환 경로마다가 아니라 여기 한 곳에서 가른다.
      if (key !== heldFor) return undefined;
      if (v !== undefined) lastAnswer = v;
      return withRefreshAfter(v);
    })
    .finally(() => {
      if (inflight?.p === p) inflight = undefined;
    });
  inflight = { key, p };
  return p;
};

/**
 * **이 설치의 토큰이 어느 조직인가** — 모델 목록 조회(무료)의 응답 머리 `anthropic-organization-id` (2026-10-10 실측: CLI `auth status` 의
 * `orgId` 와 같은 값). 토큰마다 한 번만 묻는다. 못 알아내면 `undefined`(모름). ★CLI 숫자의 귀속 근거가 아니라 «다른 계정» 문구에만 쓴다(아래 CLI 분기).
 */
let tokenOrg; // { token, org }
const tokenOrgId = async () => {
  const t = token();
  if (t === "") return undefined;
  if (tokenOrg !== undefined && tokenOrg.token === t) return tokenOrg.org;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { Authorization: `Bearer ${t}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "tiguclaw" },
      // 시한 — 응답 머리가 안 오면 공유 조회(inflight)가 통째로 묶여 모든 한도 조회가 기다렸다(적대 검토 F8). 아래 엔드포인트와 같은 5초.
      signal: AbortSignal.timeout(5000),
    });
    // ★성공 응답의 머리만 이 토큰의 조직이다 — 실패 응답(401·5xx·429)의 머리는 귀속 근거로 쓰지 않는다(기억도, 이번 비교도).
    //  기억하지 않는 것은 «조직 없음» 으로 굳으면 그 토큰이 영영 비교를 건너뛰었기 때문이다(릴리스 검토 F8).
    const org = res.ok ? (res.headers.get("anthropic-organization-id") ?? undefined) : undefined;
    if (org !== undefined) tokenOrg = { token: t, org };
    return org;
  } catch {
    return undefined;
  }
};
/**
 * CLI 로그인 조직 — **이번 조회에서** 묻는다(«다른 계정» / «확인 불가» 문구용). 앞서 물어 둔 조직은 그때의 로그인이다(G2).
 * ★CLI `/usage` 숫자의 귀속 근거는 아니다 — 별개 프로세스라 그 사이 재로그인을 가를 수 없다(아래 CLI 분기, 2026-11-21 남은 차단 #1).
 * ★`cliOrgMemo` 는 **CLI 를 띄우는 주기**다 — 마지막 확인에서 `CLI_ORG_EVERY_MS` 안이면 CLI 를 띄우지 않고
 *  지금 자격의 확인된 값으로 답한다(새로고침마다 CLI 를 한 번 더 띄우지 않게 한 F10④ 의 예산 그대로 — 실행을 늘리지 않는다).
 */
const CLI_ORG_EVERY_MS = 10 * 60_000;
let cliOrgMemo; // { at, org } — 마지막으로 CLI 조직을 물은 때(주기)와 그 답(문구 힌트로만)
let cliOrgGen = 0; // 자격이 바뀔 때마다 오른다 — 그 전에 시작한 조회는 메모에 쓰지 않는다
const cliOrgNow = async () => {
  const gen = cliOrgGen;
  const org = await cliModRef?.fetchCliOrgId?.(noteUsage);
  if (gen === cliOrgGen) cliOrgMemo = { at: Date.now(), org };
  return org;
};
/** 턴에서 받은 값은 이 시간 안이면 그대로 쓴다 — 그 뒤엔 CLI 에 다시 묻는다(턴이 없으면 사용률도 안 온다). */
const TURN_FRESH_MS = 30 * 60_000;
const fromTurns = () => {
  const u = textHost && typeof textHost.claudeUsageFromTurns === "function" ? textHost.claudeUsageFromTurns() : undefined;
  return u && Array.isArray(u.windows) && u.windows.length > 0 ? { windows: u.windows, measuredAt: u.measuredAt } : undefined;
};
/**
 * CLI 숫자를 못 쓸 때의 답 — **지금 자격의 확인된 값 중 가장 최근 것**: 턴 실측(코어가 지금 토큰 것만 준다)과 마지막 성공값(지금 토큰으로
 * 물은 엔드포인트 — 토큰이 바뀌면 비운다 · CLI 숫자는 담지 않는다). 둘 다 없으면 «확인 불가»·«다른 계정» 과 이유. **판정하는 그 순간에** 읽는다 —
 * 조직 조회를 기다리는 사이 도착한 턴 값을 놓치지 않게(G5). 새로 묻지는 않는다(엔드포인트 호출을 늘리지 않는다 — G4).
 */
const verifiedOrUnknown = (now, key, differs) => {
  const t = fromTurns();
  const ok = key === heldFor ? lastOk?.value : undefined;
  const newest = t === undefined ? ok : ok === undefined || !((ok.measuredAt ?? 0) > t.measuredAt) ? t : ok;
  return newest ?? { windows: [], measuredAt: now, unavailable: true, reason: say(textHost ?? {}, differs ? "accountMismatch" : "accountUnverified") };
};

/** `key` — 이 조회를 시작할 때의 자격 표지. 도는 사이 바뀌면(`heldFor` ≠ key) 답은 돌려주되 성공값·판정으로 담지 않는다. */
const fetchClaudeUsageInner = async (force = false, key = heldFor) => {
  const now = Date.now();
  // ★토큰 자신의 사용률(턴에서 받은 값)이 최근이면 그게 정답이다 — CLI 는 다른 계정일 수 있다(2026-10-10).
  const turns = fromTurns();
  if (turns !== undefined && now - turns.measuredAt < TURN_FRESH_MS) {
    noteUsage(describeWindows(turns.windows, "턴"));
    return turns;
  }
  // ★중복 접기만 한다(30초). 새로고침을 눌렀으면 연타 하한만 남긴다.
  const gap = force ? FORCE_MIN_GAP_MS : DEDUP_MS;
  if (lastOk !== undefined && now - lastOk.at < gap) return lastOk.value;
  if (lastAnswer !== undefined && now - lastAttemptAt < gap) return lastAnswer;
  // ★새로고침이면 CLI 를 다시 묻는다 — 로그인한 뒤 🔄 를 눌렀는데 재시작 전까지 안 바뀌면 «했는데 안 된다» 가 된다.
  if (force) cliDead = false;
  if (!cliDead && cliOrgMemo !== undefined && now - cliOrgMemo.at < CLI_ORG_EVERY_MS) {
    // ★CLI 는 이 주기에 이미 띄웠다 — 다시 띄우지 않고 확인된 값으로 답한다(G2).
    //  문구만 마지막 확인을 따른다(«다른 계정» / «확인 불가»).
    const known = tokenOrg !== undefined && tokenOrg.token === token() ? tokenOrg.org : undefined;
    return verifiedOrUnknown(now, key, known !== undefined && cliOrgMemo.org !== undefined && known !== cliOrgMemo.org);
  }
  if (!cliDead) {
    cliModRef = await import("./usage-cli.mjs");
    lastAttemptAt = now;
    const viaCli = await cliModRef.fetchUsageViaCli(noteUsage);
    // ★CLI 를 기다리는 사이 자격이 바뀌었으면 이 조회는 여기서 멈춘다 — 공용 상태(판정·시도 시각)를 쓰지 않고, 새 토큰으로 엔드포인트까지
    //  가지도 않는다(새 자격의 조회는 따로 돈다). 부른 쪽(옛 화면 요청)은 «모름» 을 받는다.
    //  ★지금 토큰만이 아니라 **공용 상태의 주인**(`heldFor`)도 본다 — B 로 조회한 뒤 토큰만 A 로 돌아오면(새 조회 전) 토큰은 같아도
    //   성공값·판정은 B 의 것이다(2026-11-21 최종 검토 — 늦은 A 의 CLI 가 B 의 성공값을 돌려주고 B 의 판정을 바꿨다).
    if (credentialKey() !== key || heldFor !== key) return undefined;
    cliNeedsLogin = viaCli?.needsLogin === true;
    if (viaCli !== undefined && viaCli.needsLogin !== true) {
      // ★현재 계정으로 확인된 값만 쓴다(2026-11-21 정태님 «이후에도 확인된 값만 쓰자» — 10-10 의 «모르면 막지 않는다» 를 대체).
      //  인증 직후·이후 조회·🔄 가 모두 같은 규칙이다. 확인된 값 = 턴 실측(지금 토큰 — 낡았어도 측정 시각과 함께)·엔드포인트 성공값.
      //  조직은 문구용으로만 이번에 묻는다(`cliOrgNow` — 앞서 물어 둔 조직은 지금 로그인의 근거가 아니다, G2).
      const [tokOrg, cliOrg] = await Promise.all([tokenOrgId(), cliOrgNow()]);
      // 조직을 기다리는 사이 자격이 바뀌었으면 멈춘다(위 CLI 대기와 같다) — 아래 답은 판정 순간의 턴 값을 읽으므로 새 토큰의 값이 옛 요청의 답이 된다.
      if (credentialKey() !== key) return undefined;
      // ★★조직이 같아도 CLI 숫자는 쓰지 않는다(2026-11-21 정태님 — 남은 차단 #1). `/usage` 와 `auth status` 는 **별개 프로세스**라,
      //  그 사이 CLI 가 다시 로그인하면(B 로 `/usage` → A 로 재로그인 → `auth status` A) 플러그인이 보는 값이 진짜 같은 계정일 때와
      //  똑같다 — 숫자에 계정 식별자가 붙어 오지 않으니 뒤의 조직으로 그 숫자의 출처를 확인할 길이 없다(앞뒤로 물어도 A→B→A 는 못 가른다).
      //  그래서 CLI 숫자는 표시·성공값·파일 캐시 어디에도 담지 않고, 지금 자격의 확인된 값(턴 실측·엔드포인트 성공값)이 없으면
      //  «확인 불가» 다. 대가: 같은 계정이어도 CLI 숫자만 있으면 표시하지 못한다. 조직 대조는 문구(«다른 계정» / «확인 불가»)에만 쓴다.
      //  CLI 조회 자체(주기·`needsLogin`·실행기 판정)와 호출 수는 그대로다.
      const differs = tokOrg !== undefined && cliOrg !== undefined && tokOrg !== cliOrg;
      // 로그엔 받은 CLI 창을 그대로 싣는다(리셋 유무 포함 — 쓰지 않은 숫자도 모양이 바뀌었는지는 로그로 알아야 한다).
      noteUsage(
        `${describeWindows(viaCli.windows ?? [], "CLI")} — ` +
          (differs
            ? "CLI 로그인 계정이 이 설치의 토큰 계정과 다르다 — CLI 한도를 쓰지 않는다"
            : `CLI 한도는 계정 식별자 없이 와서 이 설치의 계정 것인지 확인할 수 없다(토큰 조직 ${tokOrg === undefined ? "모름" : "앎"} · CLI 조직 ${cliOrg === undefined ? "모름" : "앎"}) — CLI 한도를 쓰지 않는다`),
      );
      // CLI 주기를 파일에 남긴다 — **기다리지 않는다**: 기다리는 사이 다른 자격이 상태를 바꾸면 이 답(턴 선택·`refreshAfter`)이 그 자격의 것이 된다.
      //  못 남기면 재시작 뒤 CLI 를 한 번 더 띄울 뿐이다(`forgetIfCredentialChanged` 와 같은 쓰기).
      void saveCache();
      return verifiedOrUnknown(Date.now(), key, differs);
    }
    // 이 프로세스가 사는 동안은 다시 안 띄운다(재시작하면 다시 본다). ★«로그인 안 됨» 은 CLI 가 **있는** 것이다 — 죽은 것으로 치면
    //  로그인한 뒤에도 🔄 를 누르기 전까지 «로그인이 필요합니다» 가 남는다(2026-10-09 적대 검토). 다시 묻는 빈도는 위 하한이 정한다.
    if (!cliNeedsLogin) cliDead = true;
  }
  // ↓ 여기부터는 **엔드포인트 경로**다 — CLI 가 없거나 못 읽었을 때만 온다.
  // ★5분 바닥은 **여기**가 제자리다(위 CLI 는 공짜라 안 건다). 마지막 성공이 5분 안이면
  //  굳이 조여 있는 엔드포인트를 또 때리지 않는다 — 429 를 부르는 건 이 길이다.
  if (lastOk !== undefined && now - lastOk.at < MIN_GAP_MS) return lastOk.value;
  if (now < notBefore) {
    noteUsage(`대기 중 — ${Math.ceil((notBefore - now) / 1000)}초 남음`);
    return fallback(now, notBefore); // 서버가 쉬라고 한 동안은 마지막 값
  }
  try {
    const t = token();
    if (t === "") {
      noteUsage("토큰 없음 — 조회 안 함");
      return undefined;
    }
    lastAttemptAt = now;
    // «기다렸다가 거절됐나» 는 **보낼 때** 판정한다 — 다른 자격의 조회가 겹쳐 그사이 `notBefore` 를 바꿀 수 있다.
    const sentAfterWaiting = notBefore > 0;
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
      if (sentAfterWaiting && key === heldFor) refusedAfterWaiting += 1;
      const ra = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      // 더 긴 대기를 줄이지 않는다 — 겹친 조회의 늦은 답이 서버가 정한 더 먼 시각을 당기면 대기 중에 다시 두드린다.
      notBefore = Math.max(notBefore, now + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : MIN_GAP_MS));
      await saveCache(); // ★재시작해도 이 시계를 지킨다 — 헛되이 두드리면 창이 더 밀린다.
      //  ★**기다린다** — 내구성이 목적인데 쓰기를 안 기다리면 그 사이 재시작에 날아간다.
      noteUsage(
        `429 조회 제한 — retry-after ${Number.isFinite(ra) ? `${ra}초` : "미제공"}, ` +
          `${new Date(notBefore).toISOString()} 이후 재시도. ` +
          `계정 한도가 아니다(모델 호출은 그대로 된다)`,
      );
      return fallback(now, notBefore); // «한도 도달» 이 아니다 — 조회만 조인 것이다.
    }
    if (!res.ok) {
      noteUsage(`HTTP ${res.status} — 마지막 성공값(${lastOk === undefined ? "없음" : "있음"})으로 답한다`);
      // ★CLI 도 «로그인 안 됨» 이었으면 기다려도 안 바뀐다 — 「잠시 뒤 다시」 대신 로그인 안내(집 윈도우 실측: CLI 비용 요약 + 403).
      //  429(조회 제한)는 위에서 서버 시계를 따르므로 여기 오지 않는다.
      return fallback(now, now + MIN_GAP_MS);
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
    if (key === heldFor) {
      lastOk = { at: now, value };
      refusedAfterWaiting = 0; // 한 번 되면 그 판정은 무효다.
    }
    await saveCache();
    noteUsage(describeWindows(windows, "엔드포인트"));
    return value;
  } catch (e) {
    noteUsage(`조회 실패 — ${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 120)}`);
    return fallback(Date.now(), Date.now() + MIN_GAP_MS); // 마지막으로 아는 것
  }
};

/**
 * 사용자에게 보이는 문구 — 설정 언어(`host.locale`)로 고른다(2026-10-01, 종전엔 한국어 고정). 모르는 언어는 영어,
 * 한국어 설정이면 한국어. 로그(`host.log`)는 운영자용이라 그대로 둔다.
 */
const TEXT = {
  ko: {
    needsLogin: "이 설치의 한도를 조회할 수 없습니다 — Claude 대화에서 사용률을 받으면 표시됩니다.",
    accountMismatch: "이 기계의 Claude CLI 가 이 설치의 인증과 다른 계정으로 로그인돼 있어 한도를 표시할 수 없습니다 — Claude 대화에서 사용률을 받으면 표시됩니다.",
    accountUnverified: "이 기계의 Claude CLI 한도가 이 설치의 인증 계정 것인지 확인할 수 없어 표시하지 않습니다 — Claude 대화에서 사용률을 받으면 표시됩니다.",
    label: "구독 토큰 발급",
    summaryWeb: "새 탭에서 Claude 에 로그인하면 코드가 나옵니다. 그 코드를 아래에 붙여넣으면 발급·저장까지 끝납니다(재시작 없음).",
    hintWeb: "로그인 뒤 나온 코드 (이미 받은 토큰도 됩니다)",
    summaryConsole: "발급기를 새 창으로 띄웠습니다 — 열린 브라우저에서 Claude 에 로그인하면 그 창이 토큰을 받아 자동으로 저장합니다(재시작 없음). 자동 저장이 안 되면 창에 나온 토큰(sk-ant-…)을 아래에 붙여넣으세요.",
    summaryTerminal: "이 기계에선 화면 안에서 발급기를 띄울 수 없습니다 — 아래 명령을 그 기계 터미널에서 실행하면 발급·저장까지 됩니다(재시작 없음). 이미 받은 토큰이 있으면 붙여넣으세요.",
    hintTerminal: "발급된 토큰 (sk-ant- 로 시작합니다)",
  },
  en: {
    needsLogin: "Limits for this install can't be looked up — they'll appear once a Claude conversation reports usage.",
    accountMismatch: "The Claude CLI on this machine is signed in to a different account than this install's credential, so limits can't be shown — they'll appear once a Claude conversation reports usage.",
    accountUnverified: "Couldn't confirm that the Claude CLI's limits on this machine belong to this install's account, so they aren't shown — they'll appear once a Claude conversation reports usage.",
    label: "Get subscription token",
    summaryWeb: "Sign in to Claude in the new tab and you'll get a code. Paste that code below to issue and save the token (no restart).",
    hintWeb: "Code shown after sign-in (an existing token works too)",
    summaryConsole: "The issuer opened in a new window — sign in to Claude in the browser it opens and that window saves the token automatically (no restart). If it can't, paste the token (sk-ant-…) shown there below.",
    summaryTerminal: "This machine can't run the issuer inside the dashboard — run the command below in a terminal on that machine to issue and save a token (no restart). If you already have a token, paste it.",
    hintTerminal: "Issued token (starts with sk-ant-)",
  },
};
const say = (host, key) => (String(host.locale ?? "").toLowerCase().startsWith("ko") ? TEXT.ko : TEXT.en)[key];

export default class ClaudeSubscriptionAuth {
  async startService(_bus, host) {
    if (host === undefined) return; // 옛 런타임(호스트 미전달)에선 조용히 아무것도 안 한다.
    logSink = (m) => host.log(m); // 왜 사용량이 비었는지는 **로그에만** 남는다(위 noteUsage).
    textHost = host;
    // ★조회 시계를 재시작 너머로 — 안 그러면 배포할 때마다 한 시간을 새로 태운다.
    cachePath = `${host.dataDir}/usage-cache.json`;
    const { createHash } = await import("node:crypto");
    hashOf = (t) => createHash("sha256").update(t).digest("hex").slice(0, 12);
    heldFor = credentialKey();
    await loadCache();
    const r = host.registerAuthProvider({
      provider: "claude-subscription",
      isAuthenticated: claudeSubscriptionAuthenticated,
      // 한도가 얼마나 남았나 — 상세를 열 때만(배경 폴링 0). 위 `fetchClaudeUsage` 주석 참조.
      getUsage: fetchClaudeUsage,
      // 화면이 «이미 인증된 상태의 재인증» 을 알아보는 표지 — 한도 캐시가 묶인 **같은** 표지다(라우트가 다시 감춰 내보낸다).
      credentialTag: credentialKey,
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
       * ★발급은 번들 `claude setup-token` 이 하는데 **TTY 가 필요**하다(09-05 실측: 비TTY 면 출력 0, `script -q` 는 부모에
       *  TTY 가 없으면 실패). 09-30 에 python `pty.fork()` 는 부모 TTY 없이도 된다는 걸 확인해 코어가 그 길로 띄운다
       *  (`llm-runtime/claude-token-issue.ts`). 못 띄우는 기계에선 종전 두 길 — 터미널 한 줄 · 토큰 붙여넣기.
       * ★저장은 `host.saveClaudeToken` 으로 한다 — 이 파일이 **아무것도 import 하지 않는** 성질을
       *  지키기 위해서다(그게 이 플러그인이 홈으로 옮겨 살아남는 근거다). 확인·쿨다운 해제도 그쪽이 한다.
       */
      login: {
        // 화면이 목록을 받을 때의 설정 언어로(getter) — 이 플러그인은 아무것도 import 하지 않으므로 문구는 여기 둔다.
        get label() { return say(host, "label"); },
        // ★화면에서 끝까지 (2026-09-30 정태님 — «복사해서 터미널에서 하라는 건 아니지»). 코어가 발급기를 가짜 터미널로
        //  띄워 로그인 주소를 준다 → 새 탭에서 로그인 → 나온 코드를 붙여넣으면 발급·확인·저장·반영까지 끝난다.
        //  못 띄우는 기계(Windows·python3 없음)나 옛 코어면 종전 방식(그 기계 터미널 한 줄 + 토큰 붙여넣기)으로.
        begin: async () => {
          const r = typeof host.beginClaudeTokenIssue === "function" ? await host.beginClaudeTokenIssue() : { ok: false, reason: "" };
          if (r.ok && r.console === true) {
            // 윈도우 — 발급기가 새 콘솔 창에서 브라우저를 연다. 그 창에 나온 토큰을 붙여넣으면 끝.
            return { summary: say(host, "summaryConsole"), pasteHint: say(host, "hintTerminal"), needsRestart: false };
          }
          if (r.ok) {
            return {
              summary: say(host, "summaryWeb"),
              openUrl: r.url,
              pasteHint: say(host, "hintWeb"),
              needsRestart: false,
            };
          }
          if (r.reason) host.log(`화면 발급을 못 띄워 터미널 방식으로 안내합니다: ${r.reason}`);
          return {
            summary: say(host, "summaryTerminal"),
            command: "npm run claude-auth",
            pasteHint: say(host, "hintTerminal"),
            needsRestart: false,
          };
        },
        // ★붙여넣은 글을 **그대로** 코어에 넘긴다 (2026-09-29). 여기서 한 줄만 집었더니 줄바꿈으로 잘린
        //  토큰 앞 조각이 저장돼 모든 턴이 401 이었고, 값을 확인하지 않은 채 «돕니다» 라고 답했다.
        //  이어 붙이기·확인·저장·쿨다운 해제는 터미널 `claude-auth` 와 같은 코어 한 곳이 한다.
        finish: async (pasted) => host.saveClaudeToken(String(pasted ?? "")),
      },
    });
    if (!r.ok) host.log(`구독 인증을 못 켰습니다: ${r.error}`);
    else if (token() === "") {
      host.log("구독 인증 허용됨 — 다만 CLAUDE_CODE_OAUTH_TOKEN 이 아직 없습니다(API 키는 그대로 됩니다).");
    }
  }
  async stop() {}
}
