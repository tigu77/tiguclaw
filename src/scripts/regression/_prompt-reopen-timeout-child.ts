/**
 * `prompt-answer-reopens-on-queue-cancel` ⑩ 의 자식 — 브리지 시한은 **import 시점**에 env 로 정해지므로(`route-ctx.ts`) 짧은 시한은 새 프로세스에서만 잰다.
 * 진짜 `handleMessages` + 진짜 직렬 큐: 막힌 큐 뒤의 선택지 답 POST 가 504 로 끝난 **뒤** 큐 취소 → 질문이 다시 열리는가.
 */
import http from "node:http";
import { claimPromptAnswer, issuePromptId, reopenPromptAnswer } from "../../core/prompt-answer-claims.js";
import { cancelQueuedTurn, enqueueThreadTurn } from "../../core/worker-jobs.js";

type Msg = { threadKey: string; correlationId?: string; promptAnswerId?: string };

const main = async (): Promise<void> => {
  const { handleMessages } = (await import(new URL("../../../plugins/http-bridge/routes-chat.ts", import.meta.url).href)) as { handleMessages: (c: unknown) => Promise<void> };
  let ran = 0;
  const T = "dashboard:regr-reopen-timeout";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMessages({
      req, res, url, pathname: url.pathname, channelName: "http-bridge", bus: null, sseClients: new Set(),
      channelHandler: (m: Msg) => enqueueThreadTurn(m.threadKey, async () => { ran += 1; }, {
        id: m.correlationId,
        ...(m.promptAnswerId !== undefined ? { onCancel: () => { reopenPromptAnswer(m.promptAnswerId!); } } : {}),
      }),
    } as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const pid = issuePromptId(T);
  let release = (): void => {};
  void enqueueThreadTurn(T, () => new Promise<void>((r) => { release = r; }));
  const r = await fetch(`http://127.0.0.1:${port}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "A", threadKey: T, correlationId: "cid-timeout", promptId: pid }) });
  const body = (await r.json().catch(() => ({}))) as { accepted?: boolean; running?: boolean };
  const cancel = cancelQueuedTurn(T, "cid-timeout");
  const reclaim = claimPromptAnswer(pid);
  release();
  await new Promise((res) => setTimeout(res, 50));
  server.close();
  console.log(JSON.stringify({ status: r.status, accepted: body.accepted === true, running: body.running === true, cancel, reclaim, ran }));
  process.exit(0);
};
void main();
