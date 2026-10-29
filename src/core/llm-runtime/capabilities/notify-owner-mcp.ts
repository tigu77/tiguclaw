/**
 * `notify_owner` 도구 — 작업자(매니저·서브에이전트)가 **소환자만 풀어 줄 수 있는 것**을 한 줄 알리고 계속 일한다 (2026-10-25).
 *
 * 설계: `docs/decisions/2026-10-23-notify-owner-design.md` §6. 판단은 코어(`job-notice.ts` 판정 · `worker-jobs.ts` 배달) 한 곳이고,
 * 여기는 도구 껍데기다. ★팩토리가 **자기 잡이 없으면 `undefined`** 를 돌려준다(메인 턴·엔드포인트 턴) — «이 턴에 자기 잡이 있나» 는
 * 사다리(`REACH`)로 못 적는 정체 판정이라 여기 한 곳에 둔다. 어댑터는 `send-file` 과 같은 모양으로 붙인다(있으면 등록).
 * ★접지 않는다(`onDemand` 미적용) — «막혔을 때» 떠올려야 하는 도구라 이름만 두면 안 쓰인다. 대신 설명을 짧게(설계 Q8).
 */
import { coreMcpServer } from "./_core-server.js";
import { z } from "zod";
import { tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { getJob, notifyOwner, parentJobIdOf } from "../../worker-jobs.js";
import { NOTICE_CAP_PER_JOB, NOTICE_MAX_CHARS } from "../../job-notice.js";
import type { RegionASdkInput } from "../types.js";

/** 도구 이름 — 회귀가 노출을 대조하는 정본. */
export const NOTIFY_OWNER_TOOL = "notify_owner";

export const NOTIFY_OWNER_DESCRIPTION =
  "실행 중에 **당신을 띄운 쪽(소환자)만 풀어 줄 수 있는 것**이 생기면 한 줄로 알립니다 — 공유 자원을 다른 쪽이 쥐고 있음(잠금·실행 중인 앱), " +
  "사용자 결정이 필요함, 맡은 범위 밖의 일이 필요함. **보내고 바로 계속 일하세요 — 답을 기다리지 않습니다.** 답이 오면 다음 판단 시점에 " +
  "지시로 들어옵니다. 무엇이 막혔고·무엇을 하면 풀리는지를 쓰세요. ★정해진 일·스스로 정할 수 있는 것은 묻지 말고 하세요. 진행 보고용이 " +
  `아닙니다(진행은 하네스가 알립니다). 같은 내용은 한 번만, 작업당 ${NOTICE_CAP_PER_JOB}회까지.`;

/**
 * ★이번 릴리스 보류(2026-10-29 사용자 «일단 이번 릴리즈에 노티파이 오너 도구를 막자») — 세 어댑터의 메인·매니저·서브 턴이 모두 이 팩토리
 * 하나로 등록을 정하므로 여기 한 줄이 노출·실행 진입을 함께 막는다. 정의·배달 코드·이력은 그대로 둔다(재활성화 = 이 줄 삭제 + 회귀 원복).
 * 설계: `docs/decisions/2026-10-29-notify-owner-release-hold.md`.
 */
const RELEASE_HOLD = true;

/**
 * 이 턴에 **자기 잡**(실행 중인 작업자 좌표 `worker:`/`agent:<id>`)이 있을 때만 서버를 만든다. 메인·엔드포인트 턴은 `undefined`.
 * ★메인이 대상이 아닌 이유: 메인의 소환자는 사용자이고, 사용자에게는 이미 평문 답·`prompt_options` 가 있다(같은 일의 두 번째 길이 된다).
 */
export const createNotifyOwnerMcpServer = (
  input: Pick<RegionASdkInput, "threadKey">,
): McpSdkServerConfigWithInstance | undefined => {
  if (RELEASE_HOLD) return undefined;
  const threadKey = typeof input.threadKey === "string" ? input.threadKey : "";
  const own = parentJobIdOf(threadKey);
  if (own === undefined || getJob(own)?.status !== "running") return undefined;
  return coreMcpServer({
    name: "notify-owner",
    version: "1.0.0",
    tools: [
      tool(
        NOTIFY_OWNER_TOOL,
        NOTIFY_OWNER_DESCRIPTION,
        {
          message: z
            .string()
            .describe(`한 줄(${NOTICE_MAX_CHARS}자 이내) — 무엇이 막혔고, 소환자가 무엇을 하면 풀리는지.`),
        },
        // never-throw — 배달 실패는 «기록만» 으로 돌려준다(작업자 턴을 깨지 않는다).
        async (args) => ({ content: [{ type: "text" as const, text: notifyOwner(threadKey, args.message) }] }),
      ),
    ],
  });
};
