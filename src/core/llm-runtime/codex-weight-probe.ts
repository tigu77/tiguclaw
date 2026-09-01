/**
 * diagnose-codex — **가벼운 요청 vs 무거운 요청** A/B (2026-07-30).
 *
 * 왜 있나: 회사 인스턴스에서 codex 가 `error/server_is_overloaded` 로 계속 실패하는데
 * **공식 Codex CLI 는 같은 계정·같은 머신에서 정상**이었다. 크기·모델·컨텍스트·재시작·
 * `/clear` 를 전부 배제하고 남은 가설이 하나다 —
 *   "부하 시 **무겁고 낯선 요청**이 먼저 셰딩된다."
 * 우리 요청은 도구 44개(≈25KB) + instructions 23,000자로 공식 CLI 보다 훨씬 무겁고,
 * 도구 이름(`spawn_agent`·`invoke_skill`…)도 공식 CLI 가 절대 안 보내는 것들이다.
 *
 * 이 스크립트는 **같은 auth·같은 엔드포인트**로 두 요청을 번갈아 보낸다:
 *   LEAN  — 도구 0개, instructions 1줄, input 1줄
 *   HEAVY — 실제 tiguclaw 와 같은 무게(도구 N개 더미 + 긴 instructions)
 * 번갈아 2라운드 = 타이밍 우연을 배제한다.
 *
 * 판정:
 *   LEAN 성공 + HEAVY 실패 → **무게가 원인**. 도구 축소·instructions 분할이 실효 대책.
 *   둘 다 실패            → 계정·클라이언트 식별 쪽. 경량화로는 못 푼다.
 *   둘 다 성공            → 그 순간은 정상(백엔드 회복). 실패 중에 다시 돌릴 것.
 *
 * 진입점 둘 — 셸(`npm run diagnose:codex`)과 **슬래시 명령 `/diagnose`**(LLM 미경유).
 * ★후자가 핵심: 백엔드가 죽으면 비서 자신이 응답을 못 하므로, 진단은 **LLM 을 안 타야**
 *  텔레그램만 연결된 원격 인스턴스에서도 돌릴 수 있다(실사고: 회사돌쇠가 codex 단일
 *  구성이라 codex 가 죽자 '진단을 시켜볼 비서'까지 같이 죽었다).
 * 부작용 0 — 도구 미등록·짧은 응답만 요청하고 결과를 저장하지 않는다.
 */
import { CODEX_BASE_URL } from "./adapters/openai-codex-oauth-history.js";
import { resolveCodexModel } from "./adapters/openai-codex-oauth.js";
import { getAuthProvider } from "./auth-registry.js";
// ★인증 등록은 **여기서 하지 않는다** (2026-09-01). 종전엔 `import "./auth-providers.js"`
//  side-effect 였는데, 그 파일은 구독 인증을 플러그인으로 빼면서 **삭제됐다.** 그런데
//  `tsc` 는 **부작용 import 를 검사하지 않는다**(값을 import 해야 TS2307 — 실측) →
//  타입체크·빌드·회귀 2,505건이 전부 초록인 채로 남아 있었고, 이 기계에서만 **낡은
//  `dist/**/auth-providers.js`**(빌드가 dist 를 안 치운다)가 그걸 가려주고 있었다.
//  깨끗한 설치였으면 이 모듈을 부르는 순간 ERR_MODULE_NOT_FOUND 다.
//  이제 등록 주체는 번들 플러그인(`codex-subscription-auth`)이고, 데몬 경로는 부팅 때
//  이미 배선돼 있다. 플러그인 로더가 없는 단독 실행(`diagnose-codex`)은 **그쪽이**
//  부팅과 같은 배선을 만든다 — 등록을 부르는 자리를 늘리지 않는다.

const LEAN_INSTRUCTIONS = "You are a helpful assistant. Answer in one short line.";
/** 실제 어댑터와 같은 무게로 맞춘다 — 그래야 A/B 가 성립한다. */
const HEAVY_INSTRUCTION_CHARS = 23_000;
const HEAVY_TOOL_COUNT = 44;
/** 한 발당 시한 — 4발 순차라 최악 2분. 진단이 진단 대상 증상에 매달리지 않게. */
const PROBE_TIMEOUT_MS = 30_000;

const buildHeavyInstructions = (): string => {
  const unit =
    "당신은 자가호스트 AI 비서입니다. 작동 헌법·스킬 인덱스·에이전트 인덱스·모델 프로파일이 " +
    "이 아래에 이어붙습니다. 도구를 병행 호출하고, 작업이 끝날 때까지 계속 진행하세요. ";
  return unit.repeat(Math.ceil(HEAVY_INSTRUCTION_CHARS / unit.length)).slice(
    0,
    HEAVY_INSTRUCTION_CHARS,
  );
};

/** 이름·설명 길이를 실제 tiguclaw 도구와 비슷하게 — 무게 재현이 목적. */
const buildHeavyTools = (): unknown[] =>
  Array.from({ length: HEAVY_TOOL_COUNT }, (_, i) => ({
    type: "function",
    name: `diagnostic_probe_tool_${String(i).padStart(2, "0")}`,
    description:
      "진단용 더미 도구입니다. 실제 tiguclaw 도구 정의와 비슷한 길이를 갖도록 만든 " +
      "설명 문자열이며, 호출되지 않습니다. 이 요청은 무게 A/B 판정에만 사용됩니다.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어 또는 대상 경로" },
        limit: { type: "number", description: "최대 개수" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  }));

interface Outcome {
  ok: boolean;
  detail: string;
  ms: number;
}

const send = async (
  token: string,
  accountId: string | undefined,
  model: string,
  heavy: boolean,
): Promise<Outcome> => {
  const body: Record<string, unknown> = {
    model,
    instructions: heavy ? buildHeavyInstructions() : LEAN_INSTRUCTIONS,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "1+1은? 숫자만 답해." }],
      },
    ],
    stream: true,
    store: false,
    ...(heavy ? { tools: buildHeavyTools() } : {}),
  };
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  // ★시한 필수 (2026-07-31 검토 지적) — 종전엔 fetch·SSE 둘 다 무한이라, 과부하 백엔드가
  //  200 으로 열어놓고 방치하면 4발 순차 × undici 기본(300s) = 최대 20분을 매달렸다.
  //  진단 도구가 진단 대상 증상(무응답)에 그대로 걸리면 안 된다.
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers,
      body: json,
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(killer);
    const aborted = ac.signal.aborted;
    return {
      ok: false,
      detail: aborted
        ? `시한 초과(${PROBE_TIMEOUT_MS / 1000}s) — 백엔드가 응답을 안 끝냄`
        : `전송 실패: ${e instanceof Error ? e.message : String(e)}`,
      ms: Date.now() - t0,
    };
  }
  if (!res.ok) {
    clearTimeout(killer);
    const txt = await res.text().catch(() => "");
    return { ok: false, detail: `HTTP ${res.status} ${txt.slice(0, 160)}`, ms: Date.now() - t0 };
  }
  if (res.body === null) {
    clearTimeout(killer);
    return { ok: false, detail: "body 없음", ms: Date.now() - t0 };
  }

  // SSE 를 읽어 completed / error 중 무엇으로 끝나는지만 본다(어댑터와 동일 판정 축).
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let failure = "";
  let completed = false;
  let text = "";
  // ★abort 는 `reader.read()` 를 **reject** 시킨다 — 루프 상단의 `ac.signal.aborted` 검사만
  //  두면 그 자리에 영영 못 온다(도달 불가). 실측으로 확인했다: 200 으로 열고 침묵하는
  //  서버 + 1s 시한 → `reader.read() 가 throw: AbortError`.
  //  그래서 try 로 감싼다. 감싸지 않으면 예외가 프로브 밖으로 나가 **이미 모은 결과를
  //  통째로 버린다** — LEAN #1 ✅ 5s / HEAVY #1 무응답 이라는 판정의 **유일한 신호**를
  //  정확히 그 순간에 잃는다(20분 매달리는 대신 30초 만에 아무것도 없이 죽는 것).
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (d === "" || d === "[DONE]") continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(d) as Record<string, unknown>;
          } catch {
            continue;
          }
          const t = typeof ev.type === "string" ? ev.type : "";
          if (t === "response.output_text.delta" && typeof ev.delta === "string") {
            text += ev.delta;
          }
          if (t === "response.completed") completed = true;
          if ((t === "error" || t === "response.failed") && failure === "") {
            failure = JSON.stringify(ev).slice(0, 220);
          }
        }
      }
    }
  } catch (e) {
    clearTimeout(killer);
    // 시한이면 그 사실을 **결과로** 돌려준다(throw 하지 않는다 — 위 주석 참조).
    if (ac.signal.aborted) {
      return {
        ok: false,
        detail: `시한 초과(${PROBE_TIMEOUT_MS / 1000}s) — 스트림이 안 끝남` +
          `${text !== "" ? `, 그때까지 받은 텍스트 ${text.length}자` : ", 텍스트 0자"}`,
        ms: Date.now() - t0,
      };
    }
    return {
      ok: false,
      detail: `스트림 읽기 실패: ${e instanceof Error ? e.message : String(e)}`,
      ms: Date.now() - t0,
    };
  }
  clearTimeout(killer);
  const ms = Date.now() - t0;
  if (failure !== "") return { ok: false, detail: failure, ms };
  if (!completed) return { ok: false, detail: "completed 없이 스트림 종료", ms };
  return { ok: true, detail: `"${text.trim().slice(0, 40)}"`, ms };
};


export interface WeightProbeReport {
  lines: string[];
  verdict: string;
}

/**
 * A/B 본체. ★주석이 거짓이었다(2026-07-31 검토): "셸 스크립트와 슬래시 명령이 같은 함수를
 * 쓴다(판정 기준 사본 0)" 라고 적혀 있었지만, `src/scripts/diagnose-codex.ts` 는 자기
 * `send()` 사본을 갖고 있었고 이 함수를 부르지 않았다 — 그래서 시한을 여기만 넣었을 때
 * 셸 경로는 20분 매달림이 그대로였다. 지금은 **정말로** 이 함수 하나다.
 */
export const runCodexWeightProbe = async (): Promise<WeightProbeReport> => {
  const { getPaths } = await import("../paths.js");
  const home = getPaths().home;
  const hasAccess = (process.env.OPENAI_CODEX_OAUTH_TOKEN ?? "") !== "";
  const hasRefresh = (process.env.OPENAI_CODEX_OAUTH_REFRESH ?? "") !== "";
  const lines: string[] = [
    `홈: ${home}`,
    `토큰: access=${hasAccess ? "있음" : "없음"} refresh=${hasRefresh ? "있음" : "없음"}`,
  ];
  if (!hasAccess && !hasRefresh) {
    return {
      lines,
      verdict: "🔴 이 홈에 codex 토큰이 없습니다 — 데몬 로그의 `tiguclaw home:` 과 같은 홈인지 확인하세요.",
    };
  }
  const auth = getAuthProvider("codex");
  if (auth === undefined) {
    return { lines, verdict: "🔴 codex auth provider 없음 — 이 빌드는 codex 미지원." };
  }
  let token: string;
  try {
    token = await auth.getAccessToken();
  } catch (e) {
    return {
      lines,
      verdict: `🔴 토큰 획득 실패: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
    };
  }
  let accountId: string | undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as Record<string, unknown>;
    accountId = (
      payload["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined
    )?.chatgpt_account_id;
  } catch {
    /* 없으면 생략 */
  }
  const model = resolveCodexModel();
  lines.push(`모델: ${model}`);
  lines.push(
    `LEAN=도구 0개·${LEAN_INSTRUCTIONS.length}자 / HEAVY=도구 ${HEAVY_TOOL_COUNT}개·${HEAVY_INSTRUCTION_CHARS.toLocaleString()}자`,
  );

  let leanOk = 0;
  let heavyOk = 0;
  for (let round = 1; round <= 2; round++) {
    for (const heavy of [false, true]) {
      const r = await send(token, accountId, model, heavy);
      if (r.ok) heavy ? (heavyOk += 1) : (leanOk += 1);
      lines.push(
        `${r.ok ? "✅" : "🔴"} ${heavy ? "HEAVY" : "LEAN "} #${round} ${r.ms}ms ${r.detail.slice(0, 120)}`,
      );
    }
  }
  const verdict =
    leanOk > 0 && heavyOk === 0
      ? "★무게가 원인 — 도구 수·instructions 크기를 줄이는 게 실효 대책입니다."
      : leanOk === 0 && heavyOk === 0
        ? "무게 무관 — 계정/클라이언트 쪽입니다. 경량화로는 안 풀립니다."
        : leanOk > 0 && heavyOk > 0
          ? "지금은 둘 다 정상 — **실패가 나는 중에** 다시 돌려야 판정됩니다."
          : "혼재(간헐) — 몇 번 더 돌려 비율을 보세요.";
  return { lines: [...lines, `LEAN ${leanOk}/2  HEAVY ${heavyOk}/2`], verdict };
};
