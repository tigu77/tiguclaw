import { fileURLToPath } from "node:url";
import { parseCodexSse, compatibleReplayOutput, formatCodexDebugInput, type ResponseInputItem } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";
const reasoning = { type: "reasoning", id: "rs_test", summary: [], encrypted_content: "opaque-test-only" };
const message = { type: "message", id: "msg_test", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "확인 중", annotations: [] }] };
const call = { type: "function_call", id: "fc_test", call_id: "call_test", name: "Read", arguments: '{"path":"missing"}', status: "completed" };
const items = [reasoning, message, call];
const parse = async (events: unknown[]) => parseCodexSse(new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")).body!);
const replay = (value: unknown) => (value as {
    replayOutput?: unknown[];
}).replayOutput;
const events = items.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, { type: "response.output_item.done", output_index, item }]);
const completed = { type: "response.completed", response: { id: "resp_test", status: "completed", output: items } };
export const check: RegressionCheck = {
    name: "codex-reasoning-replay", guards: "같은 도구 루프에서 추론 항목 소실·출력 순서 변경·중복 재주입·실패 응답 유입",
    run: async () => {
        const full = await parse([...events, completed]);
        const absent = await parse(events);
        const failed = await parse([...events, { type: "response.failed", response: { status: "failed" } }]);
        const doneOnly = await parse([...events, { type: "response.completed", response: { id: "resp_test", status: "completed" } }]);
        const emptyOutput = await parse([...events, { type: "response.completed", response: { status: "completed", output: [] } }]);
        const incomplete = await parse([...events, { type: "response.incomplete", response: { status: "incomplete" } }]);
        const duplicate = await parse([...events, ...events, completed]);
        const lateFailure = await parse([...events, completed, { type: "error", message: "failed" }]);
        const malformed = await parse([{ type: "response.completed", response: { status: "completed", output: [{ ...reasoning, encrypted_content: 123 }, message, call] } }]);
        const malformedOutput = await parse([...events, { type: "response.completed", response: { status: "completed", output: "bad" } }]);
        const compatible = { ...full, text: "확인 중" };
        const r = await spawnWithin(60000, "추론 상태 실제 어댑터", ["--import", "tsx", fileURLToPath(new URL("./_codex-reasoning-replay-child.ts", import.meta.url))]);
        const capped = await spawnWithin(60000, "한도 마무리 미실행 호출", ["--import", "tsx", fileURLToPath(new URL("./_codex-reasoning-replay-child.ts", import.meta.url)), "cap"]);
        const capLine = capped.out.split(/\r?\n/).find(l => l.startsWith("REPLAY_RESULT "));
        const capResult = capLine ? JSON.parse(capLine.slice(14)) : {};
        const line = r.out.split(/\r?\n/).find(l => l.startsWith("REPLAY_RESULT "));
        const result = line ? JSON.parse(line.slice(14)) : {};
        const retried = await spawnWithin(60000, "재시도 사용량 관측", ["--import", "tsx", fileURLToPath(new URL("./_codex-reasoning-replay-child.ts", import.meta.url)), "retry"]);
        const retryLine = retried.out.split(/\r?\n/).find(l => l.startsWith("RETRY_USAGE "));
        const retryUsage = retryLine ? JSON.parse(retryLine.slice(12)) : [];
        return [
            assert("실제 503 재시도 후 성공은 관측 토큰만 합산하고 미보고 1회 보존·다음 실행 격리", retryUsage[0]?.unreportedRequests === 1 && retryUsage[0]?.inputTokensTotal === 40 && retryUsage[0]?.requestUsageEntries?.length === 2 && retryUsage[1]?.unreportedRequests === 0, retryLine ?? retried.err.slice(-1000)),
            assert("한도 때문에 실행하지 않은 호출을 다음 요청에 남기지 않음", capResult.capNoOrphan === true, capLine ?? capped.err.slice(-1000)),
            assert("완료 응답은 reasoning/message/function 순서를 그대로 보존", JSON.stringify(replay(full)) === JSON.stringify(items), replay(full)),
            assert("빈 completed.output은 실제 done 항목을 버리지 않음", JSON.stringify(replay(emptyOutput)) === JSON.stringify(items), replay(emptyOutput)),
            assert("미완료 응답은 추론 재사용 없음", replay(incomplete) === undefined, replay(incomplete)),
            assert("done과 completed 중복 이벤트에도 한 번만 보존", JSON.stringify(replay(duplicate)) === JSON.stringify(items), replay(duplicate)),
            assert("완료 뒤 실패 표시가 오면 재사용 없음", replay(lateFailure) === undefined, replay(lateFailure)),
            assert("잘못된 완료 배열 형식은 정상 done 항목으로 복원", JSON.stringify(replay(malformedOutput)) === JSON.stringify(items), replay(malformedOutput)),
            assert("잘못된 암호문 형식은 재사용 없음", replay(malformed) === undefined, replay(malformed)),
            assert("정상 파싱 호출·텍스트와 같은 출력만 전체 재사용", compatibleReplayOutput(compatible)?.length === 3, compatibleReplayOutput(compatible)),
            assert("도구 호출 불일치면 기존 재구성 유지", compatibleReplayOutput({ ...compatible, toolCalls: [] }) === undefined, compatibleReplayOutput({ ...compatible, toolCalls: [] })),
            assert("부분 텍스트만 있으면 기존 재구성 유지", compatibleReplayOutput({ ...compatible, text: "부분" }) === undefined, compatibleReplayOutput({ ...compatible, text: "부분" })),
            assert("디버그 입력에도 암호문은 없고 원본은 보존", !formatCodexDebugInput(items as ResponseInputItem[]).includes(reasoning.encrypted_content) && reasoning.encrypted_content === "opaque-test-only", formatCodexDebugInput(items as ResponseInputItem[])),
            assert("완료 이전 연결 종료는 추론 재사용 없음", replay(absent) === undefined, replay(absent)),
            assert("실패 응답은 추론 재사용 없음", replay(failed) === undefined, replay(failed)),
            assert("completed에 output이 없어도 done 항목에서 복원", JSON.stringify(replay(doneOnly)) === JSON.stringify(items), replay(doneOnly)),
            assert("실제 어댑터 도구 다음 요청: 추론·본문·호출·결과 순서와 단일성", result.ordered === true, line ?? r.err.slice(-1000)),
            assert("다음 독립 실행에는 직전 추론을 전달하지 않음", result.isolated === true, line),
            assert("암호문은 로그에 출력하지 않음", result.noLeak === true, line),
            assert("검증 프로세스 정상 완료", line !== undefined && !r.timedOut, line ?? r.err.slice(-1000)),
        ];
    }
};
