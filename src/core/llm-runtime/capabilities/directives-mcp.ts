/**
 * **사용자 반응으로 배운 규칙을 확정 지침에 올린다** — `confirm_feedback` (2026-10-13 정태님:
 * «어떤 건 좋다 잘했다, 이렇게 하지 마라 — 이걸로 교정이 되어야 진정한 비서»).
 *
 * 설계: `docs/decisions/2026-10-13-feedback-correction.md`. 절차는 빌트인 스킬 `feedback-capture`, 결과는
 * 매 턴 실리는 `SELF_GROWTH.md`(source user), 쓰는 길은 이 도구 하나다.
 *
 * ★**코어 소유다** (같은 날 정태님 «플러그인인데 코어 소스에서 가리켜?»). 처음엔 self-growth 플러그인의
 *  데이터 도구로 냈는데, 그러면 헌법·sysprompt(코어)가 **플러그인이 내는 이름**을 가리킨다 — 플러그인을
 *  끄면 헌법이 없는 도구를 지시한다. 저장소(`store/self-growth-md`)·싣는 쪽(`formatSelfGrowthDirectives`)이
 *  이미 코어라 쓰는 길도 그 옆에 둔다. 플러그인은 자율 교훈(auto)만 쓴다.
 * ★판정은 순수 함수(`planFeedback`)로 뽑았다 — 도구 처리기 안에 두면 검사가 MCP 를 띄워야 한다.
 * ★상한은 **쓸 때** 판정한다. 확정 지침은 프롬프트 몫(4KB)을 넘으면 조용히 접힌다 — 반드시 지켜야 할 사용자 규칙을
 *  접히게 두지 않고, 넘치는 추가는 거절해 «비슷한 것과 합치자» 로 돌려보낸다. 잴 때는 **싣는 쪽과 같은 함수**
 *  (`directivePromptLine`)를 쓴다 — 두 벌이면 «쓸 때는 들어간다 했는데 실을 때는 접히는» 틈이 생긴다.
 * ★매니저·에이전트 턴엔 **등록되지 않는다**(`REACH.directives = "main"`) — 사용자 앞에서(밝히거나 물어서) 올라가야 하는데,
 *  그 턴엔 사용자가 없다. 판정은 표 한 곳에서 한다(도구 안에서 좌표를 다시 보지 않는다).
 */
import { coreMcpServer } from "./_core-server.js";
import { z } from "zod";
import { tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { DIRECTIVE_INDEX_CAP_BYTES, directivePromptLine } from "../../prompt-assembly.js";
import { BLOCK_BEGIN, BLOCK_END, deleteDirective, listDirectives, upsertDirective } from "../../../store/self-growth-md.js";
import { onDemand } from "../tool-load-policy.js";

/** 한 줄 규칙 길이 상한(글자). 길면 한 줄이 아니라 문단이고, 문단은 스킬·문서 자리다. */
export const FEEDBACK_TEXT_MAX = 200;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

type Existing = { key: string; source: string; text: string };

export type FeedbackPlan =
  | { ok: true; action: "set"; key: string; text: string; userBytes: number; userCount: number }
  | { ok: true; action: "retire"; key: string }
  | { ok: true; action: "list" }
  | { ok: false; reason: string };

/** 사용자 확정분이 프롬프트에서 차지할 바이트 — `formatSelfGrowthDirectives` 가 세는 방식 그대로(줄 + 개행). */
export const userPromptBytes = (directives: readonly Existing[]): number =>
  directives
    .filter((d) => d.source === "user")
    .reduce((n, d) => n + Buffer.byteLength(directivePromptLine(d)) + 1, 0);

/** 판정 — 무엇을 할지, 또는 왜 안 되는지. 저장은 하지 않는다. */
export const planFeedback = (
  args: Readonly<Record<string, unknown>>,
  existing: readonly Existing[],
): FeedbackPlan => {
  // ★key 는 프롬프트에 안 실린다(줄 모양 = `- [source] 본문`) — 합치기·내리기에 필요한 key 는 여기서 본다.
  if (args.action === "list") return { ok: true, action: "list" };
  const key = typeof args.key === "string" ? args.key.trim() : "";
  // ★**이미 있는 key 는 형식을 묻지 않는다** — 자율 지침 key(`failure_` + 60자 slug)는 이 형식보다 길어, 형식만 보면
  //  «그 지침 지워» 를 처리할 길이 없었다(적대 검토 F1). 형식은 **새 key** 를 만들 때만 강제한다.
  if (!KEY_RE.test(key) && !existing.some((d) => d.key === key)) {
    return { ok: false, reason: "key 는 소문자·숫자·`-`·`_` 2~64자 상황 이름입니다(예: `changelog-no-examples`)." };
  }
  const action = args.action === "retire" ? "retire" : "set";
  if (action === "retire") {
    if (!existing.some((d) => d.key === key)) return { ok: false, reason: `'${key}' 지침이 없습니다.` };
    return { ok: true, action, key };
  }
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (text === "") return { ok: false, reason: "text(한 줄 규칙)가 필요합니다." };
  if (/[\r\n]/.test(text)) return { ok: false, reason: "규칙은 한 줄이어야 합니다 — 프롬프트엔 첫 줄만 실립니다." };
  // 파일의 블록 구분자와 겹치면 파일 전체가 읽히지 않게 된다(적대 검토 F6). ★구분자 **그 자체**만 막는다 —
  //  `-->` 하나만 봐도 거절하면 «빌드 --> 재시작» 같은 평범한 화살표까지 막혔다(재검토 P-g). 값은 저장소와 같은 상수.
  if (text.includes(BLOCK_BEGIN) || text.includes(BLOCK_END)) {
    return { ok: false, reason: `규칙에 \`${BLOCK_BEGIN}\`·\`${BLOCK_END}\` 는 쓸 수 없습니다(파일 구분자입니다).` };
  }
  if ([...text].length > FEEDBACK_TEXT_MAX) {
    return { ok: false, reason: `규칙이 ${String(FEEDBACK_TEXT_MAX)}자를 넘습니다 — 한 줄로 줄이세요.` };
  }
  const next = [...existing.filter((d) => d.key !== key), { key, source: "user", text }];
  const userBytes = userPromptBytes(next);
  if (userBytes > DIRECTIVE_INDEX_CAP_BYTES) {
    return {
      ok: false,
      reason:
        `사용자 확정 지침이 상한(${String(DIRECTIVE_INDEX_CAP_BYTES)}B)을 넘습니다(이 규칙을 넣으면 ${String(userBytes)}B). ` +
        "비슷한 기존 규칙과 합쳐(같은 key 로 set) 줄이거나, 더는 안 쓰는 규칙을 retire 한 뒤 다시 시도하세요.",
    };
  }
  return { ok: true, action, key, text, userBytes, userCount: next.filter((d) => d.source === "user").length };
};

const result = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * ★판정과 쓰기를 한 줄로 세운다 — 따로 돌면 상한 직전의 두 호출이 같은 «지금 상태» 를 보고 둘 다 통과해 상한을 넘겼다
 *  (적대 검토 F4 실측: codex 는 한 응답의 도구 호출을 병렬로 돌린다). 사용자 몫을 쓰는 길은 이 도구 하나라 여기서 세우면 된다.
 */
let chain: Promise<unknown> = Promise.resolve();

/** 도구 처리 — 판정 → 저장. 검사가 MCP 없이 부를 수 있게 따로 뺐다. */
export const confirmFeedback = (
  args: Readonly<Record<string, unknown>>,
): Promise<{ text: string; isError: boolean }> => {
  const run = chain.then(() => confirmFeedbackNow(args));
  chain = run.catch(() => undefined);
  return run;
};

const confirmFeedbackNow = async (
  args: Readonly<Record<string, unknown>>,
): Promise<{ text: string; isError: boolean }> => {
  const existing = await listDirectives();
  const plan = planFeedback(args, existing);
  if (!plan.ok) return { text: plan.reason, isError: true };
  if (plan.action === "list") {
    if (existing.length === 0) return { text: "확정 지침이 없습니다.", isError: false };
    const lines = [...existing]
      .sort((a, b) => (a.source === b.source ? 0 : a.source === "user" ? -1 : 1))
      .map((d) => `- ${d.key} [${d.source}] ${d.text.split("\n")[0]}`);
    return { text: `확정 지침 ${String(existing.length)}개 (key [출처] 본문):\n${lines.join("\n")}`, isError: false };
  }
  if (plan.action === "retire") {
    return (await deleteDirective(plan.key))
      ? { text: `'${plan.key}' 지침을 내렸습니다.`, isError: false }
      : { text: `'${plan.key}' 지침을 내리지 못했습니다.`, isError: true };
  }
  const landed = await upsertDirective({ key: plan.key, text: plan.text, source: "user" }).catch(() => null);
  if (landed === null) return { text: "확정 지침 파일에 쓰지 못했습니다.", isError: true };
  return {
    text: `올렸습니다 — 다음 턴부터 적용됩니다. 사용자 확정 지침 ${String(plan.userCount)}개 · ${String(plan.userBytes)}/${String(DIRECTIVE_INDEX_CAP_BYTES)}B.`,
    isError: false,
  };
};

export const createDirectivesMcpServer = (): McpSdkServerConfigWithInstance => {
  const confirmTool = tool(
    "confirm_feedback",
    "사용자 반응에서 정리한 행동 규칙을 확정 지침(SELF_GROWTH.md — 매 턴 프롬프트에 실림)에 올리거나(set) 내린다(retire). " +
      "호불호 반응을 한 줄 규칙으로 정리해 부르세요 — 판단이 분명하면 바로 부르고 사용자에게 한 줄로 밝히고, 무엇이 문제였는지·적용 범위가 애매할 때만 먼저 «이렇게 기억할까요?» 로 확인합니다. 절차는 `feedback-capture` 스킬. " +
      "같은 취지가 이미 있으면 새 key 를 만들지 말고 그 key 로 set 해 고칩니다 — 지금 있는 지침과 key 는 action:'list' 로 봅니다. " +
      "한 프로젝트에만 해당하는 규칙은 여기 말고 그 프로젝트 문서에.",
    {
      key: z.string().optional().describe("상황 이름(소문자·숫자·-·_), 예: changelog-no-examples. list 일 때는 생략"),
      text: z
        .string()
        .optional()
        .describe("한 줄 규칙(set 일 때). 상황을 앞에: «변경 기록을 쓸 때: 예시를 넣지 않는다»"),
      action: z.enum(["set", "retire", "list"]).optional().describe("set(기본) · retire · list(지금 있는 지침과 key 보기)"),
    },
    async (args) => {
      const r = await confirmFeedback(args);
      return result(r.text, r.isError);
    },
  );
  return coreMcpServer({ name: "directives", version: "1.0.0", tools: onDemand([confirmTool]) });
};
