/**
 * **held-out 게이트** — 상류 SDK 가 계약을 넓히면 운다 (2026-08-06).
 *
 * ★왜 이게 다른 검사와 종류가 다른가: 이 스위트의 나머지는 전부 **held-in** 이다 —
 *  우리가 짠 코드를, 우리가 세운 가정으로 검사한다. 그래서 **가정 자체가 틀리면 코드와
 *  검사가 같이 틀린 채로 초록이다.** 이틀 사이 두 번 그랬다:
 *   ①2026-08-05 SDK 0.3 이 assistant usage 를 `message_start` 스냅샷으로 바꿔 outputTokens 가
 *     1로 붕괴 — 타입체크·회귀 472건·실제 턴 성공이 **전부 통과**했고 벤치 A/B 하나가 잡았다.
 *   ②2026-08-06 `result` 가 "스트림당 1회" 에서 "턴당 1회" 로 바뀌어 남의 턴 텍스트가 답변에
 *     섞였다 — 회귀 510건 전부 초록인 채로 **사용자가 신고해서** 잡혔다.
 *
 * 그래서 진실 소스를 **우리 밖**에 둔다: SDK 가 스스로 선언한 `SDKMessage` union. 우리가 쓴
 * 문장이 아니므로 우리 착각이 섞이지 않는다. 아래 BASELINE 과 달라지면 — 늘든 줄든 — 운다.
 * 목록을 손으로 관리하는 게 아니라 **스냅샷 + 차이 게이트**다(lockfile 과 같은 형태). 갱신은
 * 의도적 행위이고 git diff 에 남는다.
 *
 * ★이 게이트가 못 잡는 것을 분명히 해둔다: **순수 의미 드리프트**(같은 필드가 다른 것을
 *  뜻하게 되는 것 — 위 ①이 그랬다)는 타입이 안 바뀌므로 여기 안 걸린다. 그건 실제 왕복이
 *  필요하다(`probe:` 계열, API 키 소모). 업그레이드 절차에서 그걸 별도로 돌려라.
 *
 * 비용 0 — 파일 하나 읽기, 네트워크·모델 호출 없음.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * 2026-08-06 `@anthropic-ai/claude-agent-sdk` 0.3.222 기준 스냅샷.
 * ★늘었으면 **읽어보고** 갱신해라 — 새 메시지 종류는 대개 새 동작을 뜻한다(0.3 의
 *  task_* 4종이 곧 "알림이 턴을 자동으로 연다" 였고, 그게 사고였다).
 */
const BASELINE: readonly string[] = [
  "SDKAPIRetryMessage", "SDKAssistantMessage", "SDKAuthStatusMessage",
  "SDKBackgroundTasksChangedMessage", "SDKCommandsChangedMessage",
  "SDKCompactBoundaryMessage", "SDKControlRequestProgressMessage",
  "SDKConversationResetMessage", "SDKElicitationCompleteMessage",
  "SDKFilesPersistedEvent", "SDKHookProgressMessage", "SDKHookResponseMessage",
  "SDKHookStartedMessage", "SDKInformationalMessage", "SDKLocalCommandOutputMessage",
  "SDKMemoryRecallMessage", "SDKMirrorErrorMessage", "SDKModelRefusalFallbackMessage",
  "SDKModelRefusalNoFallbackMessage", "SDKNotificationMessage",
  "SDKPartialAssistantMessage", "SDKPermissionDeniedMessage", "SDKPluginInstallMessage",
  "SDKPromptSuggestionMessage", "SDKRateLimitEvent", "SDKResultMessage",
  "SDKSessionStateChangedMessage", "SDKStatusMessage", "SDKSystemMessage",
  "SDKTaskNotificationMessage", "SDKTaskProgressMessage", "SDKTaskStartedMessage",
  "SDKTaskUpdatedMessage", "SDKThinkingTokensMessage", "SDKToolProgressMessage",
  "SDKToolUseSummaryMessage", "SDKUserMessage", "SDKUserMessageReplay",
  "SDKWorkerShuttingDownMessage",
];

/** SDK 가 선언한 union 멤버를 그대로 읽는다(우리 해석 0). */
const readUnion = async (): Promise<string[] | null> => {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  let dts: string;
  try {
    const req = createRequire(import.meta.url);
    // package "exports" 가 ./package.json 을 안 열어주므로 엔트리에서 경로를 만든다.
    const entry = req.resolve("@anthropic-ai/claude-agent-sdk");
    const path = await import("node:path");
    dts = await readFile(
      path.join(path.dirname(entry), "sdk.d.ts"),
      "utf8",
    );
  } catch {
    return null;
  }
  const m = /export declare type SDKMessage =([^;]+);/.exec(dts);
  if (m === null) return null;
  return m[1]!
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .sort();
};

export const check: RegressionCheck = {
  name: "sdk-contract-surface",
  guards:
    "상류 SDK 가 메시지 계약을 넓혔는데 우리 소비가 옛 가정에 머물러, 모든 검사가 초록인 채로 동작이 깨지던 것",
  run: async (): Promise<Assertion[]> => {
    const actual = await readUnion();
    if (actual === null) {
      return [
        assert(
          "SDK 타입 선언을 읽는다(못 읽으면 이 축은 죽은 게이트다)",
          false,
          "sdk.d.ts 미발견 또는 SDKMessage union 파싱 실패 — 경로·형식 변경 의심",
        ),
      ];
    }
    const base = new Set(BASELINE);
    const now = new Set(actual);
    const added = actual.filter((n) => !base.has(n));
    const removed = BASELINE.filter((n) => !now.has(n));

    return [
      assert(
        "★SDK 가 새 메시지 종류를 추가하지 않았다(추가됐으면 새 동작이다 — 읽고 baseline 갱신)",
        added.length === 0,
        added.length === 0
          ? `${actual.length}종 일치`
          : `신규 ${added.length}종: ${added.join(", ")}`,
      ),
      assert(
        "SDK 가 우리가 알던 메시지 종류를 없애지 않았다(소비 코드가 죽은 분기가 된다)",
        removed.length === 0,
        removed.length === 0 ? "없음" : `사라짐: ${removed.join(", ")}`,
      ),
    ];
  },
};
