/**
 * **OpenAI 호환 게이트웨이 표면** — `/v1/models`·`/v1/chat/completions` 가 쓰는 조립기들.
 *
 * ★`index.ts` 에서 떼어냈다 (2026-08-30). 234줄이 **한 관심사**다 — 외부 클라이언트가 우리를
 *  OpenAI 로 보이게 하는 변환(모델 목록·메시지 평탄화·도구 스키마·이미지 첨부). 브리지의
 *  나머지(대시보드 API)와 독자가 다르다.
 *
 * ★인증도 다르다 — `/v1/*` 는 브리지 role 표가 아니라 **자기 게이트웨이 토큰**으로 가른다
 *  (그래서 role 표 밖인 것이 정당하다. 회귀 `bridge-role-table-complete` 가 그 예외를 지킨다).
 */
import { parseModelSpec, parseModelSpecList, resolveTier, specLabel } from "../../src/core/llm-runtime/index.js";
import type { ModelSpec } from "../../src/core/llm-runtime/index.js";
import { loadGatewayConfig, loadModelProfiles } from "../../src/core/settings.js";

interface GatewayRuntime {
  /** 활성 여부(= 토큰 있음 AND settings.enabled). false 면 /v1/* 는 404. */
  enabled: boolean;
  /** 인증 토큰(빈 문자열이면 비활성). */
  token: string;
  /** 기본 모델 풀 raw 문자열(콤마) — 요청 model 미매칭 시 폴백. */
  poolRaw: string;
  /** 동시 처리 상한(초과 429). */
  maxConcurrency: number;
}
export const resolveGatewayRuntime = (): GatewayRuntime => {
  const cfg = loadGatewayConfig();
  const tokenEnvName = cfg?.tokenEnv ?? "LLM_GATEWAY_TOKEN";
  const token = process.env[tokenEnvName]?.trim() ?? "";
  // settings 섹션 부재 = 레거시(토큰만으로 판정) / 존재 = enabled 플래그가 킬스위치.
  const enabled = token !== "" && (cfg === undefined || cfg.enabled);
  const poolRaw =
    cfg?.models !== undefined && cfg.models.length > 0
      ? cfg.models.join(",")
      : (process.env.LLM_GATEWAY_MODELS ?? process.env.REGION_A_MODELS ?? "");
  const envCap = Number(process.env.LLM_GATEWAY_MAX_CONCURRENCY);
  const maxConcurrency =
    cfg?.maxConcurrency ??
    (Number.isInteger(envCap) && envCap > 0 ? envCap : 4);
  return { enabled, token, poolRaw, maxConcurrency };
};

// 요청 model → tiguclaw 스펙. `tier:high|mid|low` / `provider:model` / 그 외=기본 풀 폴백.
export const resolveGatewaySpecs = (model: unknown, poolRaw: string): ModelSpec[] => {
  const m = typeof model === "string" ? model.trim() : "";
  if (m.startsWith("tier:")) {
    const t = resolveTier(m.slice("tier:".length));
    if (t.length > 0) return t;
  }
  const direct = parseModelSpec(m);
  if (direct !== null) return [direct];
  return parseModelSpecList(poolRaw);
};

// ── GET /v1/models (ADR 2026-07-25) — 사용 가능 모델 id 목록. ★왕복(round-trip) 보장:
//   프로파일/티어는 `tier:<name>` 로 노출(resolveGatewaySpecs 가 tier: 접두만 resolveTier 를
//   타므로 — 순수 이름을 그대로 노출하면 클라가 body.model 에 넣었을 때 조용히 기본 풀로 치환
//   되는 기존 갭을 광고하는 꼴). 직접 풀 스펙은 specLabel(provider:model) 로 대칭 노출. ──
const GATEWAY_MODELS_CREATED = Math.floor(Date.now() / 1000); // 부팅 1회 고정(매요청 Date.now()면 클라 캐시 무효화).
const GATEWAY_TIER_ENV: Record<string, string> = {
  high: "MODEL_TIER_HIGH",
  mid: "MODEL_TIER_MID",
  low: "MODEL_TIER_LOW",
  nano: "MODEL_TIER_NANO",
};
export const buildModelsListResponse = (poolRaw: string): {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
} => {
  const seen = new Set<string>();
  const data: Array<{ id: string; object: "model"; created: number; owned_by: string }> = [];
  const add = (id: string, owner: string): void => {
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    data.push({ id, object: "model", created: GATEWAY_MODELS_CREATED, owned_by: owner });
  };
  // 1) 명명 프로파일 → tier:<name>
  try {
    for (const name of Object.keys(loadModelProfiles())) add(`tier:${name}`, "tiguclaw");
  } catch {
    /* settings 파싱 실패 — 프로파일 스킵(부재 graceful) */
  }
  // 2) 레거시 티어 — MODEL_TIER_* env 가 실제로 채워진 것만(빈 풀=어댑터 디폴트라 제외).
  for (const [tier, envKey] of Object.entries(GATEWAY_TIER_ENV)) {
    const v = process.env[envKey];
    if (typeof v === "string" && v.trim() !== "") add(`tier:${tier}`, "tiguclaw");
  }
  // 3) 직접 풀 스펙 — settings gateway.models ?? env (resolveGatewaySpecs 폴백과 동일 소스).
  for (const spec of parseModelSpecList(poolRaw)) {
    const label = specLabel(spec);
    add(label, label.includes(":") ? label.slice(0, label.indexOf(":")) : "tiguclaw");
  }
  return { object: "list", data };
};

// OpenAI messages content 의 image_url 파트 → ingestAttachments 입력 shape (vision, ADR 2026-07-25).
//   v1 은 `data:<mime>;base64,<payload>` 인라인만 지원 — http(s) URL 다운로드는 SSRF 표면이라
//   스코프아웃(후속). 텍스트 파트·기타는 무시(flattenChatMessages 가 텍스트 담당).
export const extractGatewayImageAttachments = (
  messages: Array<{ content?: unknown }>,
): Array<{ filename: string; mimeType: string; dataBase64: string }> => {
  const out: Array<{ filename: string; mimeType: string; dataBase64: string }> = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part === null ||
        typeof part !== "object" ||
        (part as { type?: unknown }).type !== "image_url"
      ) {
        continue;
      }
      const urlRaw = (part as { image_url?: { url?: unknown } }).image_url?.url;
      if (typeof urlRaw !== "string") continue;
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(urlRaw);
      if (m === null) continue; // data: URI 만 (http URL = 스코프아웃).
      const ext = (m[1].split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
      out.push({ filename: `image.${ext}`, mimeType: m[1], dataBase64: m[2] });
    }
  }
  return out;
};

// OpenAI chat message shape — 게이트웨이가 받는 요청 messages[] 원소. tool_calls/tool_call_id
// 는 함수콜 패스스루(ADR 2026-07-25 §Decision-5, role:"assistant"/"tool" 직렬화)에서만 읽힘.
export interface GatewayChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

// OpenAI messages[] → (system override, user text). system 은 override 로, 나머지는 순서대로
// 이어붙임. ★role:"assistant"(tool_calls 있음)/"tool"(결과) 는 텍스트로 서술 직렬화한다 —
// 게이트웨이는 매 요청 새 threadKey(gateway:<uuid>) 라 무상태(어댑터 세션 resume 없음) →
// 이건 진짜 네이티브 멀티턴 tool state 재현이 아니라 "과거 tool 호출 기록"의 프롬프트 문자열
// 재구성일 뿐이다(설계 §2-b 최소안, 과대약속 금지). 모델은 이 서술을 컨텍스트로만 인지한다.
export const flattenChatMessages = (
  messages: GatewayChatMessage[],
): { system: string; text: string } => {
  const sys: string[] = [];
  const turns: string[] = [];
  // tool_call_id → 호출 시점 함수명(role:"tool" 결과를 그 함수명과 함께 서술하기 위한 역참조 맵).
  const toolCallNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (typeof tc?.id === "string" && tc.id !== "") {
          toolCallNames.set(tc.id, tc.function?.name ?? "tool");
        }
      }
    }
  }
  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "user";
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((c) =>
                typeof c === "object" && c !== null && "text" in c
                  ? String((c as { text?: unknown }).text ?? "")
                  : "",
              )
              .join("")
          : "";
    if (role === "system") {
      sys.push(content);
    } else if (role === "user") {
      turns.push(content);
    } else if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // 과거 함수콜 turn — 실행 없이 "이렇게 불렀었다"만 서술(2-b 최소안).
      const calls = msg.tool_calls
        .map((tc) => `[assistant called ${tc.function?.name ?? "tool"}(${tc.function?.arguments ?? ""})]`)
        .join("\n");
      turns.push(content !== "" ? `${calls}\n${content}` : calls);
    } else if (role === "tool") {
      const name =
        typeof msg.tool_call_id === "string" ? (toolCallNames.get(msg.tool_call_id) ?? "tool") : "tool";
      turns.push(`[tool result for ${name}]\n${content}`);
    } else {
      turns.push(`[${role}]\n${content}`);
    }
  }
  return { system: sys.join("\n\n"), text: turns.join("\n\n") };
};

// OpenAI tools[]/tool_choice → externalTools 패스스루(ADR 2026-07-25 §Decision-5). 실행은
//   tiguclaw 가 하지 않는다 — 모델이 고른 의도만 그대로 caller(게이트웨이 클라이언트)에 반환.
//   body.tools 부재/빈 배열 = 미주입(현행, 회귀 0).
export const parseGatewayTools = (
  body: Record<string, unknown>,
): {
  externalTools?: Array<{ name: string; description?: string; parameters: unknown }>;
  externalToolChoice?: "auto" | "none" | "required" | { name: string };
} => {
  const rawTools = body.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) return {};
  // ★`tool_choice:"none"` = **절대 부르지 마라**(OpenAI 계약). 스키마를 아예 안 넘기는 게
  //  가장 확실한 집행이다 — 모델에게 "부르지 마"라고 부탁하는 것보다 부를 수단을 안 주는 게
  //  낫다. 실측(2026-08-09): 넘겨만 두면 `none` 인데도 tool_calls 가 나왔다(계약 위반).
  if (body.tool_choice === "none") return {};
  const externalTools: Array<{ name: string; description?: string; parameters: unknown }> = [];
  for (const t of rawTools) {
    if (t === null || typeof t !== "object") continue;
    if ((t as { type?: unknown }).type !== "function") continue;
    const fn = (t as { function?: unknown }).function;
    if (fn === null || typeof fn !== "object") continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string" || name === "") continue;
    const description = (fn as { description?: unknown }).description;
    externalTools.push({
      name,
      ...(typeof description === "string" ? { description } : {}),
      parameters: (fn as { parameters?: unknown }).parameters ?? {},
    });
  }
  if (externalTools.length === 0) return {}; // 전부 무효 항목이면 미주입(안전 degrade).
  const rawChoice = body.tool_choice;
  let externalToolChoice: "auto" | "none" | "required" | { name: string } | undefined;
  if (rawChoice === "auto" || rawChoice === "none" || rawChoice === "required") {
    externalToolChoice = rawChoice;
  } else if (rawChoice !== null && typeof rawChoice === "object") {
    const fnName = (rawChoice as { function?: { name?: unknown } }).function?.name;
    if (typeof fnName === "string" && fnName !== "") externalToolChoice = { name: fnName };
  }
  // ★특정 함수 강제(`tool_choice:{type:"function",function:{name}}`) — 어댑터에 "그것만
  //  불러라" 를 시킬 수단이 없으므로 **노출을 그 하나로 좁혀서** 집행한다(`none` 과 같은
  //  방식: 부탁이 아니라 수단 제한). 그 위에 아래 응답부가 required 판정을 얹어, 안 부르면
  //  에러가 된다. 실측(2026-08-09): 그전엔 조용히 무시돼 **다른 함수가 호출됐다**
  //  (set_voxel_layers 를 강제했는데 clear_scene 이 왔다).
  if (externalToolChoice !== undefined && typeof externalToolChoice === "object") {
    const only = externalTools.filter((t) => t.name === externalToolChoice.name);
    // 목록에 없는 이름을 강제하면 조용히 무시하지 않고 그대로 알린다(클라 실수를 숨기지 않는다).
    if (only.length === 0) return { externalTools, externalToolChoice };
    return { externalTools: only, externalToolChoice: "required" as const };
  }
  return { externalTools, ...(externalToolChoice !== undefined ? { externalToolChoice } : {}) };
};

// ── 이력 도구 스텝(기능 B, 2026-07-09) — chat_log 메시지 window 와 같은 ts 범위의 영속
// llm.activity(start·tool, 매니저·서브·게이트웨이 제외)를 복원용으로 반환. 도구 스텝은 events 에
// 이미 영속되나 chat-history 는 메시지만 줬다 → 새로고침 시 도구 사용이 사라져 보였음. 이제
// 여기서 함께 반환하고 대시보드가 메시지와 시간순 인터리브 렌더. best-effort(실패=빈 배열). ──
