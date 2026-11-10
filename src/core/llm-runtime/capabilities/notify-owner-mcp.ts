/**
 * `request_owner_intervention` 도구 — 소환자의 결정·조치가 필요한 상황을 기존 알림 코어로 전달한다.
 *
 * 설계: `docs/decisions/2026-10-23-notify-owner-design.md` §6. 판단은 코어(`job-notice.ts` 판정 · `worker-jobs.ts` 배달) 한 곳이고,
 * 여기는 도구 껍데기다. ★팩토리가 **자기 잡이 없거나 설정이 꺼져 있으면(기본 — 2026-11-02 `jobs.notifyOwner.enabled`) `undefined`** 를 돌려준다(메인 턴·엔드포인트 턴) — «이 턴에 자기 잡이 있나» 는
 * 사다리(`REACH`)로 못 적는 정체 판정이라 여기 한 곳에 둔다. 어댑터는 `send-file` 과 같은 모양으로 붙인다(있으면 등록).
 * ★접지 않는다(`onDemand` 미적용) — «막혔을 때» 떠올려야 하는 도구라 이름만 두면 안 쓰인다. 대신 설명을 짧게(설계 Q8).
 */
import { coreMcpServer } from "./_core-server.js";
import { z } from "zod";
import { tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { getJob, notifyOwner, parentJobIdOf } from "../../worker-jobs.js";
import { KEEP_WORKING, NOTICE_CAP_PER_JOB } from "../../job-notice.js";
import type { RegionASdkInput } from "../types.js";
import { loadNotifyOwnerEnabled } from "../../settings.js";

/** 도구 이름 — 회귀가 노출을 대조하는 정본. */
export const NOTIFY_OWNER_TOOL = "request_owner_intervention";

export const NOTIFY_OWNER_DESCRIPTION =
  "상위 결정·조치가 필요한 막힘 또는 중대 사고·위험한 오정보를 **당신을 띄운 쪽(소환자)**에 알리고 개입을 요청합니다. " +
  "situation에 현재 상황, intervention에 소환자에게 필요한 결정·조치를 적으세요. 두 필드는 모두 비공백 문자열입니다. " +
  "상위가 판단하는 데 필요한 상황과 요청할 결정·조치를 간결하게 전달하세요. " +
  "유효한 승인 안에서 스스로 해결할 수 있는 일·정해진 일·진행·완료·단순 준수 신고에는 쓰지 않습니다. " +
  KEEP_WORKING + ` 같은 내용은 한 번만, 작업당 ${NOTICE_CAP_PER_JOB}회까지.`;

/**
 * 이 턴에 **자기 잡**(실행 중인 작업자 좌표 `worker:`/`agent:<id>`)이 있을 때만 서버를 만든다. 메인·엔드포인트 턴은 `undefined`.
 * ★메인이 대상이 아닌 이유: 메인의 소환자는 사용자이고, 사용자에게는 이미 평문 답·`prompt_options` 가 있다(같은 일의 두 번째 길이 된다).
 */
export const createNotifyOwnerMcpServer = (
  input: Pick<RegionASdkInput, "threadKey">,
): McpSdkServerConfigWithInstance | undefined => {
  const threadKey = typeof input.threadKey === "string" ? input.threadKey : "";
  const own = parentJobIdOf(threadKey);
  if (own === undefined || getJob(own)?.status !== "running") return undefined;
  // ★설정으로 켠 때만(2026-11-02, 기본 꺼짐 — `jobs.notifyOwner.enabled`). 시도마다 새로 읽는다 → 재시작 없이 다음 작업자 시도부터 반영.
  //  신원 판정 **뒤**에 두어 메인 턴은 파일을 읽지 않는다. 켜진 채 시작한 턴이 도는 중에 끄면 이미 등록된 도구는 코어 `notifyOwner` 가 거절한다.
  if (!loadNotifyOwnerEnabled()) return undefined;
  return coreMcpServer({
    name: "notify-owner",
    version: "1.0.0",
    tools: [
      tool(
        NOTIFY_OWNER_TOOL,
        NOTIFY_OWNER_DESCRIPTION,
        {
          situation: z.string().min(1).regex(/\S/).describe("현재 상황 — 소환자의 결정·조치가 필요한 막힘 또는 중대 사고·위험한 오정보."),
          intervention: z.string().min(1).regex(/\S/).describe("소환자에게 필요한 결정·조치."),
        },
        // SDK schema를 우회하는 직접 호출도 빈 필드를 받지 않는다. 의미 필터는 두지 않는다.
        async (args) => {
          if (typeof args?.situation !== "string" || args.situation.trim() === "" ||
              typeof args?.intervention !== "string" || args.intervention.trim() === "") {
            return { isError: true, content: [{ type: "text" as const, text: `situation과 intervention은 모두 비공백 문자열이어야 합니다. ${KEEP_WORKING}` }] };
          }
          // 정규화·중복·3회·전달 판정은 기존 코어 한 곳에서 한다.
          const message = `상황: ${args.situation.trim()}\n필요 개입: ${args.intervention.trim()}`;
          return { content: [{ type: "text" as const, text: notifyOwner(threadKey, message) }] };
        },
      ),
    ],
  });
};
