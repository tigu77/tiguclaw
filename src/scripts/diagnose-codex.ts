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
 * 실행: `npm run diagnose:codex`  (원격 접속 불가 인스턴스에서 사용자가 직접)
 * 부작용 0 — 도구 미등록·짧은 응답만 요청하고 결과를 저장하지 않는다.
 */
import { loadHomeEnv } from "../core/load-env.js";
import { CODEX_BASE_URL } from "../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { resolveCodexModel } from "../core/llm-runtime/adapters/openai-codex-oauth.js";
import { getAuthProvider } from "../core/llm-runtime/auth-registry.js";
import "../core/llm-runtime/auth-providers.js"; // side-effect 등록.

const LEAN_INSTRUCTIONS = "You are a helpful assistant. Answer in one short line.";
/** 실제 어댑터와 같은 무게로 맞춘다 — 그래야 A/B 가 성립한다. */
const HEAVY_INSTRUCTION_CHARS = 23_000;
const HEAVY_TOOL_COUNT = 44;

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
  label: string,
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

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers,
      body: json,
    });
  } catch (e) {
    return {
      ok: false,
      detail: `전송 실패: ${e instanceof Error ? e.message : String(e)}`,
      ms: Date.now() - t0,
    };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, detail: `HTTP ${res.status} ${txt.slice(0, 160)}`, ms: Date.now() - t0 };
  }
  if (res.body === null) return { ok: false, detail: "body 없음", ms: Date.now() - t0 };

  // SSE 를 읽어 completed / error 중 무엇으로 끝나는지만 본다(어댑터와 동일 판정 축).
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let failure = "";
  let completed = false;
  let text = "";
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
  const ms = Date.now() - t0;
  if (failure !== "") return { ok: false, detail: failure, ms };
  if (!completed) return { ok: false, detail: "completed 없이 스트림 종료", ms };
  return { ok: true, detail: `"${text.trim().slice(0, 40)}"`, ms };
};

const main = async (): Promise<void> => {
  // `--dry` — 네트워크·인증 없이 두 요청의 **무게만** 출력한다. 실제 전송 전에 A/B 가
  //  의도한 대비(가벼움 vs 실제 tiguclaw 수준)를 이루는지 확인하는 용도.
  if (process.argv.includes("--dry")) {
    const lean = JSON.stringify({
      instructions: LEAN_INSTRUCTIONS,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "1+1은?" }] }],
    });
    const heavy = JSON.stringify({
      instructions: buildHeavyInstructions(),
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "1+1은?" }] }],
      tools: buildHeavyTools(),
    });
    console.log(`LEAN  총 ${lean.length.toLocaleString()}자 (도구 0개)`);
    console.log(
      `HEAVY 총 ${heavy.length.toLocaleString()}자 ` +
        `(instructions ${HEAVY_INSTRUCTION_CHARS.toLocaleString()} + 도구 ${HEAVY_TOOL_COUNT}개 ` +
        `${JSON.stringify(buildHeavyTools()).length.toLocaleString()}자)`,
    );
    console.log("\n(실제 전송하려면 --dry 없이 실행)");
    return;
  }
  loadHomeEnv();
  const auth = getAuthProvider("codex");
  if (auth === undefined) {
    console.error("codex auth provider 없음 — 이 빌드는 codex 를 지원하지 않습니다.");
    process.exit(1);
  }
  const token = await auth.getAccessToken();
  // accountId 는 JWT payload 의 chatgpt_account_id — 없으면 헤더 생략(어댑터 동형).
  let accountId: string | undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const authClaim = payload["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: string }
      | undefined;
    accountId = authClaim?.chatgpt_account_id;
  } catch {
    /* 없으면 생략 */
  }
  const model = resolveCodexModel();

  console.log(`모델: ${model}   엔드포인트: ${CODEX_BASE_URL}`);
  console.log(
    `LEAN = 도구 0개 / instructions ${LEAN_INSTRUCTIONS.length}자   ` +
      `HEAVY = 도구 ${HEAVY_TOOL_COUNT}개 / instructions ${HEAVY_INSTRUCTION_CHARS.toLocaleString()}자\n`,
  );

  const results: Array<[string, Outcome]> = [];
  for (let round = 1; round <= 2; round++) {
    for (const heavy of [false, true]) {
      const label = `${heavy ? "HEAVY" : "LEAN "} #${round}`;
      const r = await send(label, token, accountId, model, heavy);
      results.push([label, r]);
      console.log(
        `${r.ok ? "✅" : "🔴"} ${label}  ${String(r.ms).padStart(6)}ms  ${r.detail}`,
      );
    }
  }

  const lean = results.filter(([l]) => l.startsWith("LEAN"));
  const heavy = results.filter(([l]) => l.startsWith("HEAVY"));
  const leanOk = lean.filter(([, r]) => r.ok).length;
  const heavyOk = heavy.filter(([, r]) => r.ok).length;
  console.log(`\nLEAN ${leanOk}/${lean.length} 성공   HEAVY ${heavyOk}/${heavy.length} 성공`);
  if (leanOk > 0 && heavyOk === 0) {
    console.log(
      "→ ★무게가 원인. 도구 수·instructions 크기를 줄이는 게 실효 대책입니다.",
    );
  } else if (leanOk === 0 && heavyOk === 0) {
    console.log(
      "→ 무게 무관 — 계정/클라이언트 식별 쪽입니다. 경량화로는 안 풀립니다.",
    );
  } else if (leanOk > 0 && heavyOk > 0) {
    console.log(
      "→ 지금은 둘 다 정상입니다. **실패가 나는 중에** 다시 돌려야 판정됩니다.",
    );
  } else {
    console.log("→ 혼재 — 간헐적입니다. 몇 번 더 돌려 비율을 보세요.");
  }
};

void main();
