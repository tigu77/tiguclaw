/**
 * 모델 설정 도구 — `set_model_reasoning` (2026-08-18).
 *
 * 사용자: *"코덱스 특정 모델 에포트 설정하려면 티구클로한테 솔 중간으로 설정해달라고 하면
 * 되나?"* → 되긴 했다. **`settings.json` 을 손으로 편집하는 방식으로.** 설정을 쓰는 함수는
 * 넷(`setDefaultProfile`·`setEgressChannels`·`setSuggestionEnabled`·`setModuleDisabled`)이나
 * 있었지만 **전부 대시보드 엔드포인트로만** 나가 있었고, 비서에게 준 적은 한 번도 없다.
 * 그래서 비서는 JSON 을 직접 편집할 수밖에 없었다 — 키 형식을 맞추는 것도, 기존 키를 안
 * 날리는 것도 전부 모델의 손끝에 달린 일이 된다.
 *
 * ★그래서 범위를 **이 한 키로 좁혔다.** "설정을 고치는 범용 도구" 는 만들지 않는다:
 *  `settings.json` 에는 `selfDevelopment`(본체 수정 게이트)·게이트웨이 설정처럼 **일부러
 *  코드가 아니라 사람이 쥐고 있는** 값이 있다. 범용 writer 는 그것들까지 모델 손에 쥐여준다.
 *  [[project_self_dev_flag_gate]] 가 "하드 게이트 금지" 인 것과 같은 이유로, 반대쪽도 참이다 —
 *  **줄 이유가 없는 권한은 안 준다.**
 *
 * ★LLM 무관(원칙 #2): 키가 `provider:model` 이라 codex·anthropic·openai 어디든 같은 도구로
 *  적는다. 세 어댑터가 전부 `resolveReasoningEffort` 하나를 읽으므로 배선도 하나다.
 *
 * ★판정을 **순수 함수로 뽑아** 내보낸다(`resolveModelKey`·`applyModelReasoning`). 도구 핸들러
 *  안에 두면 검사가 문자열 grep 밖에 못 하고, 그러면 지키는 게 없다
 *  ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못 놓인 것").
 */
import path from "node:path";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  loadModelProfiles,
  loadModelReasoning,
  setModelReasoning,
} from "../../settings.js";
import { catalogModelKeys, resolveReasoningEffort } from "../model-catalog.js";

const okText = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

/**
 * 이 설치가 아는 `provider:model` 전부 — 카탈로그 ∪ 프로파일 풀 ∪ 이미 적힌 reasoning 키.
 *
 * ★셋을 합치는 이유는 각각이 **혼자서는 빈다**: 카탈로그는 그 provider 인증이 없으면 통째로
 *  비고(실측: 개발돌쇠 홈은 anthropic 10개뿐 codex 0개), 프로파일은 사용자가 쓰는 것만 담고,
 *  reasoning 키는 이미 손댄 것만 있다. 어느 하나를 진실 소스로 삼으면 그게 빈 기계에서
 *  이름 해석이 조용히 죽는다.
 */
export const knownModelKeys = (cwd: string = process.cwd()): string[] => {
  const keys = new Set<string>();
  for (const k of catalogModelKeys()) keys.add(k);
  try {
    for (const p of Object.values(loadModelProfiles(cwd))) {
      for (const spec of p.pool) {
        const s = spec.trim();
        if (s.includes(":")) keys.add(s);
      }
    }
  } catch {
    /* 프로파일 읽기 실패 = 그 출처만 비는 것(never throw) */
  }
  for (const k of loadModelReasoning(cwd).keys()) keys.add(k);
  return [...keys];
};

export type KeyResolution =
  | { kind: "key"; key: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown" };

/**
 * 사람이 부르는 이름 → `provider:model`. "솔 중간으로" 의 **"솔"** 을 여기서 푼다.
 *
 * 순서: `:` 가 있으면 그대로(정확 지정을 이기지 않는다) → 모델명 완전일치 → 부분일치.
 * 후보가 여럿이면 **고르지 않고 되묻는다** — 엉뚱한 모델의 강도를 바꾸는 건 조용한 오답이다.
 */
export const resolveModelKey = (input: string, keys: string[]): KeyResolution => {
  const q = input.trim();
  if (q === "") return { kind: "unknown" };
  if (q.includes(":")) return { kind: "key", key: q };
  const modelOf = (k: string): string => k.slice(k.indexOf(":") + 1);
  const exact = keys.filter((k) => modelOf(k) === q);
  if (exact.length === 1) return { kind: "key", key: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  const lower = q.toLowerCase();
  const partial = keys.filter((k) => modelOf(k).toLowerCase().includes(lower));
  if (partial.length === 1) return { kind: "key", key: partial[0]! };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };
  return { kind: "unknown" };
};

/**
 * 실제 적용 — 해석 → 쓰기 → **결과를 다시 읽어** 보고한다.
 *
 * ★쓰고 나서 `resolveReasoningEffort` 를 다시 부르는 게 핵심이다. 우리는 **홈**
 *  `settings.json` 에 쓰지만 읽기는 홈+프로젝트 병합이라, 프로젝트 층에 같은 키가 있으면
 *  우리 쓰기는 **아무 효과가 없다**. 안 재보면 "설정했습니다" 라고 말해놓고 아무 일도 안
 *  일어난다 — 이 레포가 반복해서 당한 부류다([[feedback_gate_must_actually_run]] 의 반대편:
 *  했다고 말하는 것과 된 것은 다르다).
 */
export const applyModelReasoning = (args: {
  model: string;
  effort?: string;
  cwd?: string;
}): { ok: boolean; text: string } => {
  const cwd = args.cwd ?? process.cwd();
  const keys = knownModelKeys(cwd);
  const r = resolveModelKey(args.model, keys);
  if (r.kind === "ambiguous") {
    return {
      ok: false,
      text:
        `'${args.model}' 이 ${r.candidates.length}개 모델에 맞습니다 — 하나로 지정하세요:\n` +
        r.candidates.map((c) => `- ${c}`).join("\n"),
    };
  }
  if (r.kind === "unknown") {
    return {
      ok: false,
      text:
        `'${args.model}' 에 맞는 모델을 못 찾았습니다.\n` +
        (keys.length === 0
          ? "이 설치가 아는 모델이 하나도 없습니다(카탈로그 미조회 · 프로파일 없음) — `provider:model` 로 정확히 지정하세요."
          : `아는 모델:\n${keys.map((k) => `- ${k}`).join("\n")}`),
    };
  }

  const key = r.key;
  const sep = key.indexOf(":");
  const provider = key.slice(0, sep);
  const model = key.slice(sep + 1);
  if (provider === "" || model === "") {
    return { ok: false, text: `키 형식이 아닙니다: '${key}' (provider:model)` };
  }

  const before = resolveReasoningEffort(provider, model, cwd);
  const raw = args.effort?.trim() ?? "";
  const want = raw === "" ? undefined : raw;
  setModelReasoning(key, want);
  const after = resolveReasoningEffort(provider, model, cwd);

  // ★쓴 뒤에도 **덮어쓰기 층이 남아 있나.** 홈은 방금 우리가 썼으므로, 남아 있다면 그건
  //  프로젝트 층(`<cwd>/.tiguclaw/settings.json`)이다. 이 한 줄이 "카탈로그 기본으로
  //  돌아갔다" 와 "프로젝트가 덮어서 안 먹었다" 를 가른다 — 종전엔 `after !== want` 하나로
  //  둘을 뭉쳐서, ①정상 해제에도 **매번** 경고가 떴고(want=undefined vs 카탈로그 기본은
  //  항상 다르다 = 배경소음) ②정작 프로젝트가 덮은 진짜 경우엔 "…이거나 …이거나" 라고
  //  구분 못 하는 척했다. 구분할 수 있는데 안 하고 있었다(적대 검토 F2).
  const stillOverridden = loadModelReasoning(cwd).get(key);

  const notes: string[] = [];
  if (!keys.includes(key)) {
    notes.push(
      `⚠️ '${key}' 는 카탈로그·프로파일 어디에도 없는 이름입니다 — 오타라면 그 모델을 쓸 때 백엔드가 400 을 냅니다.`,
    );
  }
  // ★프로젝트 층이 이기는 경우 — 쓰긴 썼는데 효과가 없다. 조용히 넘기면 안 된다.
  if (stillOverridden !== undefined && stillOverridden !== want) {
    notes.push(
      want === undefined
        ? `⚠️ 해제했지만 유효값은 여전히 '${after ?? "(없음)"}' 입니다 — 프로젝트 설정(${path.join(cwd, ".tiguclaw/settings.json")})이 같은 키를 들고 있습니다. 거기서 지워야 실제로 풀립니다.`
        : `⚠️ 홈 설정에 '${want}' 를 썼지만 실제 유효값은 '${after ?? "(없음)"}' 입니다 — 프로젝트 설정(${path.join(cwd, ".tiguclaw/settings.json")})이 같은 키로 덮고 있습니다. 그쪽을 고쳐야 합니다.`,
    );
  }

  // ★머리말은 **실제로 된 것**만 말한다. 종전엔 해제 시 무조건 "이제 카탈로그 기본을
  //  따릅니다" 라고 했는데, 프로젝트 층이 덮고 있으면 그건 거짓이었다 — 모델은 머리말을
  //  요약해 "해제했습니다" 라고 보고하고 사용자는 다음 턴에도 옛 강도로 돌게 된다.
  const head =
    want === undefined
      ? `${key} 추론 강도 **해제** (${before ?? "(없음)"} → ${after ?? "(없음)"}` +
        (stillOverridden !== undefined
          ? " · ★프로젝트 설정이 덮고 있어 아직 안 풀렸습니다)"
          : after === undefined
            ? " · 이제 백엔드 기본을 따릅니다)"
            : " · 이제 카탈로그 기본을 따릅니다)")
      : `${key} 추론 강도 **${want}** (이전: ${before ?? "(없음)"})`;
  return {
    ok: true,
    text: [head, "다음 턴부터 반영됩니다(재시작 불요).", ...notes].join("\n"),
  };
};

export const createModelSettingsMcpServer = (
  cwd: string,
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "model-settings",
    version: "1.0.0",
    tools: [
      tool(
        "set_model_reasoning",
        "특정 모델의 **추론 강도**(reasoning effort)를 설정합니다 — 홈 settings.json 의 `models.reasoning`. " +
          "model 은 `provider:model`(예: codex:gpt-5.6-sol) 이 정확하지만, 짧은 이름도 풀어줍니다(예: 'sol' → codex:gpt-5.6-sol). " +
          "여럿에 맞으면 후보를 돌려주니 그때 정확히 지정하세요. " +
          "**effort 를 비우면 해제**(그 모델의 설계 기본값으로 복귀)입니다. " +
          "값은 벤더 등급 문자열 그대로 넘깁니다(codex: low·medium·high·xhigh·max 등 모델마다 다름 / anthropic: low·medium·high·xhigh·max) — " +
          "우리는 검증하지 않으니 지원 안 하는 값이면 그 모델을 쓸 때 백엔드가 400 을 냅니다. " +
          "저장 즉시 다음 턴부터 반영됩니다(재시작 불요). " +
          "★강도를 올리면 출력·비용·지연이 함께 오릅니다(실측: sol 을 설계 기본 low 로 명시했더니 출력 −37%) — 사용자가 요청한 게 아니면 올리기 전에 확인하세요.",
        {
          model: z
            .string()
            .min(1)
            .describe("provider:model 또는 짧은 이름(sol, terra, opus …)"),
          effort: z
            .string()
            .optional()
            .describe("강도 문자열. 비우거나 생략하면 **해제**(기본값 복귀)"),
        },
        async (args) => {
          try {
            const r = applyModelReasoning({
              model: args.model,
              ...(args.effort !== undefined ? { effort: args.effort } : {}),
              cwd,
            });
            return r.ok ? okText(r.text) : errText(r.text);
          } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    ],
  });
