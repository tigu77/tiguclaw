/**
 * **Claude 구독 토큰 받아들이기** — 뽑고 · 확인하고 · 저장하고 · 쿨다운을 푼다 (2026-09-29).
 *
 * ★사고(지인 설치본): 토큰이 **줄바꿈으로 잘린 채** 저장돼 모든 턴이 401 이었고, 화면은 그걸 «사용량 한도» 로
 *  보여줬다. 붙여넣기·`claude-auth` 둘 다 `sk-ant-[문자]+` 를 한 줄에서만 집어 **앞 조각만** 남겼고, 값은
 *  확인하지 않은 채 «다음 턴부터 구독으로 돕니다» 라고 답했다.
 * ★판단은 여기 한 곳이다 — 터미널(`claude-auth`)과 화면 붙여넣기(플러그인 → `host.saveClaudeToken`)가 같이 쓴다.
 *  두 벌이면 한쪽만 고쳐진다(이번 줄바꿈이 두 곳 모두에 있었다).
 */
// ★저장 모듈은 **쓸 때만** 연다 — `env-file` 은 `load-env` 를 끌고 오고, 그건 import 만으로 `.env` 를 읽는다.
//  이 파일은 모델 목록 조회(`model-catalog`)가 머리 헬퍼 때문에 여는데, 정적으로 두면 카탈로그를 여는 모든
//  스크립트가 `.env` 를 읽게 된다(회귀 `reasoning-effort-from-catalog` 가 잡았다).

const TOKEN_CHARS = /^[A-Za-z0-9._-]+$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** 상자 그리기 문자 — 터미널 UI 가 토큰을 상자 안에 그리면 줄 끝에 `│` 가 붙는다. */
const BOX = /[─-╿]/g;
const MIN_LEN = "sk-ant-".length + 20;

/** 이어 붙일 조각을 몇 개까지 볼까 — 터미널 폭 40자면 토큰(~110자)이 3~4조각이다. 여유를 둔다. */
const MAX_PIECES = 6;

/**
 * 글에서 토큰 후보를 뽑는다 — **많이 이은 것부터, 한 조각짜리까지**.
 * ★입력 모양이 둘이다(2026-09-29 적대·전체 검토):
 *  - **줄이 있는 글**(터미널 출력·CLI 붙여넣기) — 줄 단위로 잇는다. 다음 줄 **전체**가 토큰 문자일 때만 잇는다.
 *    `claude setup-token` 출력은 토큰 뒤에 영어 문장(`Store this token securely.`)이 오는데, 공백으로 가르면 그 낱말들이
 *    후보를 늘려 확인이 안 될 때 멀쩡한 토큰까지 저장을 거부했다. 줄 단위면 문장 줄은 공백이 있어 안 붙는다.
 *  - **한 줄짜리**(대시보드 붙여넣기) — 칸이 한 줄 입력이라 브라우저가 줄바꿈을 **공백으로** 넘긴다(헤드리스 Chrome 실측).
 *    그래서 공백으로 가른 조각을 잇는다. 영어 낱말이 붙을 수 있어 이은 길이마다 후보를 내고 **확인이 고른다**.
 * ★끝의 `.`·`-` 는 뗀다 — 문장 끝 마침표가 토큰에 붙었다(옛 정규식은 `\b` 로 뗐다).
 */
export const claudeTokenCandidates = (text: string): string[] => {
  const clean = text.replace(ANSI, "").replace(BOX, " ");
  const multiline = /\r?\n/.test(clean.trim());
  // 줄 모드: 한 줄 = 한 조각(앞뒤 공백 제거) · 한 줄 모드: 공백으로 가른 낱말 = 한 조각.
  const pieces = (multiline ? clean.split(/\r?\n/).map((l) => l.trim()) : clean.split(/\s+/)).filter((p) => p !== "");
  const out: string[] = [];
  const add = (c: string): void => {
    const t = c.replace(/[.-]+$/, "");
    if (t.length >= MIN_LEN && !out.includes(t)) out.push(t);
  };
  for (let i = 0; i < pieces.length; i++) {
    const at = pieces[i]!.indexOf("sk-ant-");
    if (at === -1) continue;
    const head = /^sk-ant-[A-Za-z0-9._-]*/.exec(pieces[i]!.slice(at))![0];
    const joined = [head];
    // 조각 안에서 토큰이 끝났으면(뒤에 다른 글자) 다음 조각은 이어진 게 아니다.
    if (head.length === pieces[i]!.length - at) {
      for (let j = i + 1; j < pieces.length && joined.length < MAX_PIECES; j++) {
        if (!TOKEN_CHARS.test(pieces[j]!)) break;
        joined.push(pieces[j]!);
      }
    }
    for (let n = joined.length; n >= 1; n--) add(joined.slice(0, n).join(""));
  }
  return out;
};

/** `/v1/models` 요청 머리 — 모델 목록 조회와 **같은 것**(구독 토큰은 beta 헤더가 있어야 열린다, 실측). */
export const anthropicModelsHeaders = (key: string, oauth: string): Record<string, string> => {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (key !== "") headers["x-api-key"] = key;
  else {
    headers.authorization = `Bearer ${oauth}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }
  return headers;
};

export type TokenVerdict = "ok" | "rejected" | "unknown";

/** 한 번 물어본다 — 200 = 통함 · 401 = 거부 · 그 밖(네트워크·5xx·403)은 **모름**(모르는 것을 거부로 만들지 않는다). */
export const checkClaudeToken = async (token: string): Promise<TokenVerdict> => {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: anthropicModelsHeaders("", token),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "ok";
    return res.status === 401 ? "rejected" : "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * 구독 토큰을 쓰는 쿨다운만 푼다 — 재인증 = 이전 인증 거부 판정 무효(codex 로그인과 같은 규칙).
 * ★키는 claude 어댑터를 타는 것 전부(`anthropic`·`claude`·그 어댑터를 쓰는 사용자 정의 provider — 같은 자격이다).
 *  판정·해제는 런타임의 한 루틴(`clearAuthCooldowns` — 메모리·통지 표시·DB·이벤트)이 한다. DB 가 진실이라 다른 프로세스(터미널 CLI)에서 불러도 돌고 있는 데몬에 바로 먹는다(`remainingForKey`).
 */
export const clearClaudeSubscriptionCooldowns = async (): Promise<number> => {
  try {
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { clearAuthCooldowns } = await import("./index.js");
    return clearAuthCooldowns("claude").length;
  } catch {
    return 0; // 저장소 미준비 — 인증 자체는 이미 저장됐다.
  }
};

/**
 * 뽑고 → 확인하고 → 저장하고 → 쿨다운을 푼다. 거부된 토큰은 **저장하지 않는다**.
 * ★확인을 못 했을 때(네트워크·429 등) — 거부되지 않은 후보가 **하나뿐**이면 저장하고 그렇게 말한다(검증 실패로
 *  인증을 막지 않는다). 둘 이상이면 저장하지 않는다 — 어느 쪽이 맞는지 모르는데 첫 것을 고르면 군더더기가 붙은
 *  토큰을 저장했다(적대 검토 P2 재현: `TOKEN\nDone`).
 */
export const acceptClaudeToken = async (
  raw: string,
  check: (token: string) => Promise<TokenVerdict> = checkClaudeToken,
): Promise<{ ok: boolean; message: string; savedTo?: string }> => {
  const candidates = claudeTokenCandidates(raw);
  if (candidates.length === 0) {
    return { ok: false, message: "No token found — paste the value that starts with `sk-ant-`." };
  }
  const unverified: string[] = [];
  for (const c of candidates) {
    const v = await check(c);
    if (v === "ok") return save(c, "Checked and saved the token");
    if (v === "unknown") unverified.push(c);
  }
  if (unverified.length === 1) {
    return save(unverified[0]!, "Saved the token (the check request failed, so it could not be confirmed as valid)");
  }
  if (unverified.length > 1) {
    return {
      ok: false,
      message:
        "The token is split into several pieces and the check request failed, so it is unclear which one is right — nothing was saved. " +
        "Paste it again in a moment.",
    };
  }
  return {
    ok: false,
    message:
      "Anthropic rejected this token (401) — nothing was saved. It may have been cut by a line break, or it may be an old token. " +
      "Get a new one with `npm run claude-auth`.",
  };
};

const save = async (token: string, lead: string): Promise<{ ok: boolean; message: string; savedTo: string }> => {
  const { upsertHomeEnvVars } = await import("../env-file.js");
  const savedTo = await upsertHomeEnvVars({ CLAUDE_CODE_OAUTH_TOKEN: token });
  const cleared = await clearClaudeSubscriptionCooldowns();
  // ★API 키가 같이 있으면 그쪽이 먼저 쓰일 수 있다 — «구독으로 답합니다» 라고 단언하지 않는다(적대 검토 P2).
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";
  // 재시작 없이 따라가는 기능이 이 Node 에 없으면 «다음 메시지부터» 는 거짓이다(전체 검토).
  const { credentialFollowAvailable } = await import("../credential-env.js");
  const when = credentialFollowAvailable() ? "the new token is used from the next message" : "restart the daemon to use the new token (automatic pickup is off on this Node version)";
  return {
    ok: true,
    savedTo,
    message:
      `${lead} — ${when}.` +
      (apiKey ? " Note that an API key (ANTHROPIC_API_KEY) is also set and may be used first." : "") +
      (cleared > 0 ? ` Also cleared ${cleared} Claude cooldown(s).` : ""),
  };
};
