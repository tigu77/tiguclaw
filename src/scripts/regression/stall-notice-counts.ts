/**
 * 회귀: **무진전 재개 알림이 요청별 재시도와 작업 누적을 가른다 · 다음 사건을 로그로 판정할 수 있다** (2026-10-05).
 *
 * 사고(회사돌쇠 10-05): 같은 매니저가 iteration 79·87·88 에서 각각 5분 무진전으로 재개했는데 알림이 셋 다 «(1/2)» 였다 — 어댑터의
 * 재시도 횟수는 **요청마다** 1부터 다시 센다. 그리고 그 5분 동안 무엇이 왔는지(생존 신호·추론 조각·SSE 주석)가 로그에 없어,
 * 정체인지 긴 추론인지 가를 수 없었다(맥 돌쇠 9~10월 spinning 19건도 같은 공백). 이벤트 종류별 개수는 정상 종료 때만 집계됐다.
 *
 * ① 어댑터 — 실제 스톨 루프를 자식 프로세스에서 돈다(`_codex-stall-notice-child.ts`, 노브를 import 전에 줄여야 해서).
 * ② 매니저 알림 — 실제 구독자에 이벤트를 흘려 알림 문구·누적·중복 무시를 본다(가짜 채널로 받는다).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import { __resetJobsForTest, registerJob, registerWorkerHandler, stallNoticeText } from "../../core/worker-jobs.js";
import { assert, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

type Turn = { stalls: { attempt?: number; maxRetries?: number; stallId?: string; kind?: string; events?: Record<string, number>; lastProgressKind?: string; noProgressMs?: number }[]; logs: string[]; outcome: string };

export const check: RegressionCheck = {
  name: "stall-notice-counts",
  guards:
    "무진전 재개 알림이 요청마다 «1/2» 로 다시 세져 같은 작업이 몇 번 멈췄는지 안 보이던 것 + 멈춘 요청에 무엇이 왔는지 로그에 없어 정체와 긴 추론을 못 가르던 것",
  run: async (): Promise<Assertion[]> => {
    // ① 어댑터
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_codex-stall-notice-child.ts");
    const r = await spawnWithin(90_000, "무진전 재개 e2e", ["--import", "tsx", child], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}";
    const turns = ((): Record<string, Turn> => { try { return (JSON.parse(line) as { turns?: Record<string, Turn> }).turns ?? {}; } catch { return {}; } })();
    const t = (k: string): Turn => turns[k] ?? { stalls: [], logs: [], outcome: "missing" };
    const allLogs = Object.values(turns).flatMap((x) => x.logs).join("\n");

    // ② 매니저 알림 — 실제 구독자(registerWorkerHandler 가 부팅 때 거는 것)
    __resetJobsForTest();
    const CH = "regr-stall";
    const sent: string[] = [];
    registerChannelOutbound(CH, { deliver: async (_t, text) => { sent.push(text); }, defaultOutboundTarget: async () => "regr-target" });
    registerWorkerHandler(async () => {});
    const jobId = registerJob({ label: "회귀 작업", task: "x", threadKey: `${CH}:1`, channel: CH, channelUserId: "u" });
    const warns: string[] = [];
    const ow = console.warn;
    console.warn = (...a: unknown[]) => { const s = a.map(String).join(" "); if (s.includes("[job-stall]")) warns.push(s); else ow(...a); };
    const emit = (p: Record<string, unknown>) => getEventBus().publish({ type: "llm.stream_stall", ts: Date.now(), payload: { threadKey: `worker:${jobId}`, maxRetries: 2, noProgressMs: 300_000, ...p } });
    const settle = () => new Promise((res) => setTimeout(res, 30));
    try {
      emit({ attempt: 1, stallId: "a", kind: "spinning", lastChunkAgoMs: 2_000, events: { "response.in_progress": 40 } }); await settle();
      emit({ attempt: 2, stallId: "b", kind: "spinning", lastChunkAgoMs: 2_000 }); await settle();
      emit({ attempt: 2, stallId: "b", kind: "spinning", lastChunkAgoMs: 2_000 }); await settle(); // 같은 사건이 두 번 — 세지 않는다
      emit({ attempt: 1, stallId: "c", kind: "dead", lastChunkAgoMs: -1 }); await settle(); // 다음 요청 — 요청별은 1부터, 누적은 계속
      // 첫 이벤트 하나만 받고 끊김(청크 ≥1 이라 spinning) — 마지막 신호가 오래전이면 «응답 없음» 이 사실이다
      emit({ attempt: 1, stallId: "d", kind: "spinning", lastChunkAgoMs: 299_000 }); await settle();
    } finally {
      console.warn = ow;
    }
    const nums = (s: string) => /this request (\d)\/2 · (\d+) retr(?:y|ies) so far/.exec(s)?.slice(1).join(",");
    const lognums = (s: string) => /이번 요청 (\d)\/2 · 작업 누적 (\d+)회/.exec(s)?.slice(1).join(",");

    return [
      assert(
        "★같은 요청이 연달아 멈추면 이번 요청 1/2 → 2/2, 세 번째에 끝나면 «재시도 결과=완료» · 다음 요청은 다시 1/2",
        t("twice").stalls.map((s) => s.attempt).join(",") === "1,2" && t("twice").logs.some((l) => l.includes("재시도 결과=완료")) &&
          t("next").stalls.map((s) => s.attempt).join(",") === "1" && t("twice").outcome === "returned",
        { twice: t("twice").stalls.map((s) => s.attempt), next: t("next").stalls.map((s) => s.attempt), err: r.err.slice(-300) },
      ),
      assert(
        "★답 조각이 한계보다 오래 흘러도 진전이다(재개 0) · 생존 신호·추론 조각·SSE 주석만 오면 무진전",
        t("progress").stalls.length === 0 && t("progress").outcome === "returned" && t("twice").stalls.every((s) => s.kind === "spinning"),
        { progress: t("progress").stalls.length },
      ),
      assert(
        "★백오프 중 취소는 재개가 아니다 — 알림 이벤트 없음 · «재시도 결과=취소» · 취소가 그대로 올라온다",
        t("cancel").stalls.length === 0 && t("cancel").outcome === "cancelled" && t("cancel").logs.some((l) => l.includes("재시도 결과=취소")),
        { stalls: t("cancel").stalls.length, outcome: t("cancel").outcome },
      ),
      assert(
        "★멈춘 요청에 무엇이 왔는지 종류·개수가 로그와 이벤트에 남는다 — 본문(추론 조각 내용)은 안 남는다 · 재시도마다 고유 id",
        /이벤트=\[[^\]]*in_progress×\d[^\]]*reasoning_summary_text\.delta×\d[^\]]*\(주석\)×\d/.test(allLogs) && /진전=이 시도엔 없음/.test(allLogs) &&
          (t("twice").stalls[0]?.events?.["response.in_progress"] ?? 0) > 0 && !allLogs.includes("THINKING-SECRET") &&
          !JSON.stringify(turns).includes("THINKING-SECRET") && new Set(t("twice").stalls.map((s) => s.stallId)).size === 2,
        allLogs.split("\n").find((l) => l.includes("이벤트=")) ?? allLogs.slice(0, 200),
      ),
      assert(
        "★재시도한 요청이 어떻게 끝났는지 늘 한 줄 — 소진(세 번 다 멈춤) · 재시도 도중 취소도 «실패(취소)» 로(종전엔 결과 줄이 없었다)",
        t("exhaust").stalls.map((s) => s.attempt).join(",") === "1,2" && t("exhaust").logs.some((l) => l.includes("재시도 결과=소진")) && t("exhaust").outcome !== "returned" &&
          t("cancelInRetry").logs.some((l) => l.includes("재시도 결과=실패(취소)")) && t("cancelInRetry").outcome === "cancelled",
        { exhaust: t("exhaust").logs.filter((l) => l.includes("codex-stall")), cancelInRetry: t("cancelInRetry").logs.filter((l) => l.includes("codex-stall")), outcome: t("cancelInRetry").outcome },
      ),
      assert(
        "★진전 뒤 멈추면 마지막 진전 종류가 로그·이벤트에 남는다(정체와 긴 추론을 가르는 핵심 값) · 이벤트가 무진전 한계를 싣는다(알림의 «N min»)",
        t("afterText").logs.some((l) => /마지막진전=text \d+s 전/.test(l)) && t("afterText").stalls[0]?.lastProgressKind === "text" &&
          t("afterText").stalls[0]?.noProgressMs === 700,
        { logs: t("afterText").logs.filter((l) => l.includes("진전")).map((l) => l.slice(0, 160)), stall: t("afterText").stalls[0] },
      ),
      assert(
        "★매니저 알림: 이번 요청 n/2 · 이 작업 누적 n회 — 같은 사건은 한 번만 · 다음 요청은 1부터 누적은 계속 · 로그와 같은 숫자",
        sent.map(nums).join(" ") === "1,1 2,2 1,3 1,4" && warns.map(lognums).join(" ") === "1,1 2,2 1,3 1,4",
        { sent: sent.map(nums), warns: warns.map(lognums) },
      ),
      assert(
        "알림이 사실대로·영어로 — 신호는 오는데 진전 없음(spinning)을 «멈췄다» 고 하지 않는다 · 응답 없음(dead)은 그렇게 · 서버 고정 문구에 한국어 없음",
        sent[0]?.includes("still sending signals but no answer or tool call has come for 5 min") === true && !/stopped|stalled/i.test(sent[0]!) &&
          sent[2]?.includes("no response has come for 5 min") === true &&
          sent[3]?.includes("no response has come for 5 min") === true && !sent[3]!.includes("still sending signals") &&
          stallNoticeText("x", { attempt: 1, maxRetries: 2, total: 1, kind: "trickle" }).includes("streaming for too long") &&
          sent.every((x) => !/[가-힣]/.test(x.replace("회귀 작업", ""))),
        sent,
      ),
    ];
  },
};
