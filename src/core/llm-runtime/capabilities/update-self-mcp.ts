/**
 * 영역 A/B 공통 — tiguclaw 자가 업데이트 in-process MCP server (factory).
 *
 * 진실 소스 / 패턴 동형:
 *  - `send-file-mcp.ts` / `prompt-options-mcp.ts` — per-turn factory + 양 어댑터
 *    동형 등록(parity). send_file 이 채널 raw(telegram sendDocument)를 추상 도구로
 *    노출하듯, update_self 는 *배포 시퀀스*(git pull + typecheck 게이트 + 재시작)를
 *    추상 도구로 노출한다. 단일 도구를 claude·codex-oauth·openai-agents 가 동형 등록.
 *  - architect contract `_workspace/self-update_architect.md` §6 R1~R4.
 *
 * 한 줄:
 *  사용자가 "tiguclaw 를 최신으로 업데이트해줘" 하면 비서가 (확인 후) `update_self` 를
 *  호출 → 공유 결정론 루틴 `runSelfUpdate({ notify })` 가 git pull·게이트·재시작을 한 번에
 *  수행하고, 그 `SelfUpdateResult` 를 사람말 content 로 렌더한다.
 *
 * ★위험 로직 0 (핵심 불변식):
 *  - git/npm/tsc/롤백/재시작 같은 위험 로직은 **이 파일에 단 한 줄도 없다** — 전부
 *    `runSelfUpdate`(src/core/self-update.ts) 안에 닫혀 LLM 손을 안 탄다(원칙 #2 하드게이트:
 *    claude·codex 어느 쪽이 호출해도 바이트 단위 동일 실행). 이 파일은 *호출 + 사람말 렌더 +
 *    notify 좌표 운반* 만 한다.
 *  - 재시작 콜백은 넘기지 않는다 — restart=데몬 전역이라 부팅 시 박힌 모듈 레지스트리
 *    (setSelfUpdateRestart)로 일어난다(self-update.ts). 도구는 notify 좌표만 운반.
 *
 * LLM-agnostic (parity):
 *  - 도구 description·렌더 문안은 어댑터 분기 0. 한쪽 어댑터만 등록 = #2 차단이라
 *    send_file 과 1:1 동형으로 3 어댑터 동일 등록.
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  runSelfUpdate,
  type SelfUpdateNotifyDest,
  type SelfUpdateResult,
} from "../../self-update.js";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

/**
 * SelfUpdateResult → 사람말 content (architect R3 — status 별 4가지, 어댑터 분기 0).
 * 슬래시(/update)의 formatSelfUpdateResult 와 의미 동형 — 둘 다 동일 루틴 결과를 렌더.
 */
const renderResult = (r: SelfUpdateResult): string => {
  switch (r.status) {
    case "up-to-date": {
      const v = r.to ?? r.from;
      return v !== undefined
        ? `이미 최신 버전입니다 (${v}). 변경 사항이 없어 재시작하지 않습니다.`
        : "이미 최신 버전입니다. 변경 사항이 없어 재시작하지 않습니다.";
    }
    case "updating": {
      const span =
        r.from !== undefined && r.to !== undefined
          ? `${r.from}→${r.to}`
          : "최신";
      const files =
        r.changedFiles !== undefined ? `, ${r.changedFiles}개 파일` : "";
      const npm = r.ranNpmInstall === true ? ", 의존성 갱신" : "";
      const sec = Math.round((r.restartInMs ?? 5000) / 1000);
      return (
        `업데이트 적용했습니다 (${span}${files}${npm}). typecheck 게이트 통과. ` +
        `약 ${sec}초 뒤 재시작되고, 끝나면 알려드릴게요.`
      );
    }
    case "busy":
      return "이미 업데이트가 진행 중입니다. 잠시 후 완료 알림이 옵니다.";
    case "failed": {
      const rolled =
        r.rolledBack === true
          ? "직전 버전으로 롤백했습니다(데몬 정상)."
          : "데몬은 그대로 정상 동작합니다.";
      const detail =
        r.error !== undefined && r.error !== "" ? ` {${r.error}}` : "";
      return `업데이트 실패:${detail} ${rolled}`;
    }
    default:
      // 미래 status 추가 대비 graceful (TS exhaustiveness 폴백).
      return "업데이트 처리를 마쳤습니다.";
  }
};

/**
 * update-self MCP server factory — 완료 통지 좌표(notify)를 클로저로 받는다. 도구
 * `update_self`(인자 없음 또는 optional `confirm`). 위험 로직 0 — runSelfUpdate 위임만.
 *
 * @param notify 완료(재시작 후 부팅) 통지를 보낼 generic 좌표. 어댑터가 현재 turn 의
 *   channel/threadKey 에서 도출해 넘긴다. 미지정 가능(통지 best-effort → cli 폴백).
 *
 * 양 어댑터(claude=mcpServers map / codex·openai=adaptClaudeMcpServer bridge)가 동형으로
 * 등록 → parity (원칙 1·2). 등록 가드는 command-tools 와 동일(depth 0 && workerDepth 0)
 * 로 어댑터가 적용 — 매니저/서브에이전트가 자가 업데이트를 트리거하지 못하게(재귀 차단).
 */
export const createUpdateSelfMcpServer = (
  notify?: SelfUpdateNotifyDest,
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "update-self",
    version: "1.0.0",
    tools: [
      tool(
        "update_self",
        "사용자가 tiguclaw 를 최신으로 업데이트/업그레이드해달라고 할 때 사용. git pull + 의존성 + typecheck 게이트 후 데몬을 재시작합니다(게이트 실패 시 자동 롤백). 코드 교체·재시작이 일어나니 사용자 확인 후 호출하세요.",
        {
          confirm: z
            .boolean()
            .optional()
            .describe(
              "사용자 확인 여부(선택). 의미상 표식일 뿐 — 호출 자체가 실행을 의미합니다. 실행 전 사용자 승인을 받으세요.",
            ),
        },
        async () => {
          // ★호출 + 렌더만. restart 는 부팅 시 박힌 레지스트리(setSelfUpdateRestart)로
          //  일어난다 — 도구는 데몬 전역 restartDaemon 을 알 필요 없음. notify 좌표만 운반.
          const r = await runSelfUpdate(
            notify !== undefined ? { notify } : {},
          );
          return okText(renderResult(r));
        },
      ),
    ],
  });
