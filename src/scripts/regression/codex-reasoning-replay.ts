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
        // action 없는 검색 항목은 다듬을 수 없다 — 재주입하지 않고 안전하게 빠진다(적대 검토 F6: 검사를 넓히면 다듬기가 던져 요청이 실패)
        const badSearch = await parse([{ type: "response.completed", response: { status: "completed", output: [reasoning, { type: "web_search_call", id: "ws_x", status: "completed" }, message, call] } }]);
        const r = await spawnWithin(60000, "추론 상태 실제 어댑터", ["--import", "tsx", fileURLToPath(new URL("./_codex-reasoning-replay-child.ts", import.meta.url))]);
        const capped = await spawnWithin(60000, "한도 마무리 미실행 호출", ["--import", "tsx", fileURLToPath(new URL("./_codex-reasoning-replay-child.ts", import.meta.url)), "cap"]);
        const capLine = capped.out.split(/\r?\n/).find(l => l.startsWith("REPLAY_RESULT "));
        const capResult = capLine ? JSON.parse(capLine.slice(14)) : {};
        const line = r.out.split(/\r?\n/).find(l => l.startsWith("REPLAY_RESULT "));
        const result = line ? JSON.parse(line.slice(14)) : {};
        // 웹 검색이 섞인 응답(2026-10-12 맥돌쇠 2시간 반복): 다음 요청에 추론과 검색 항목(id·출처 목록 뺀 공식 모양)을 싣고,
        //  검색 도구가 없는 마무리 요청엔 검색 항목을 뺀다(서버가 «response protection is unavailable» 로 거부 — 실측).
        const runSearch = async (extra: string[]) => {
            const s = await spawnWithin(60000, "웹 검색 섞인 응답", ["--import", "tsx", fileURLToPath(new URL("./_codex-reasoning-replay-child.ts", import.meta.url)), "search", ...extra]);
            const l = s.out.split(/\r?\n/).find(x => x.startsWith("SEARCH_RESULT "));
            return { line: l ?? s.err.slice(-800), r: l ? JSON.parse(l.slice(14)) : {} };
        };
        // 상한 마무리(검색 항목을 거른 사본을 보내는 요청)가 끊겼을 때 이어 쓰기 본문이 사본에도 실리는가(적대 검토 F3)
        const fc = await spawnWithin(60000, "상한 마무리 중 끊김", ["--import", "tsx", fileURLToPath(new URL("./_codex-flush-cut-child.ts", import.meta.url))]);
        const fcLine = fc.out.split(/\r?\n/).find(x => x.startsWith("FLUSH_CUT "));
        const fcR = fcLine ? JSON.parse(fcLine.slice(10)) : {};
        const searchNormal = await runSearch([]);
        const searchCap = await runSearch(["cap"]);
        const retried = await spawnWithin(60000, "재시도 사용량 관측", ["--import", "tsx", fileURLToPath(new URL("./_codex-reasoning-replay-child.ts", import.meta.url)), "retry"]);
        const retryLine = retried.out.split(/\r?\n/).find(l => l.startsWith("RETRY_USAGE "));
        const retryUsage = retryLine ? JSON.parse(retryLine.slice(12)) : [];
        return [
            assert("실제 503 재시도 후 성공은 관측 토큰만 합산하고 미보고 1회 보존·다음 실행 격리", retryUsage[0]?.unreportedRequests === 1 && retryUsage[0]?.inputTokensTotal === 40 && retryUsage[0]?.requestUsageEntries?.length === 2 && retryUsage[1]?.unreportedRequests === 0, retryLine ?? retried.err.slice(-1000)),
            assert("한도 때문에 실행하지 않은 호출을 다음 요청에 남기지 않음", capResult.capNoOrphan === true, capLine ?? capped.err.slice(-1000)),
            assert(
                "★웹 검색이 섞인 반복도 다음 요청에 추론과 검색 항목을 싣는다 — 검색 항목은 id·출처 목록 없이 {type,status,action}",
                searchNormal.r.reasoningKept === true && searchNormal.r.searchKept === true && searchNormal.r.searchTool === true &&
                    searchNormal.r.searchShape === JSON.stringify({ type: "web_search_call", status: "completed", action: { type: "search", query: "리야드 공항" } }),
                searchNormal.line,
            ),
            assert(
                "★검색 도구가 없는 마무리 요청(tools:[])엔 검색 항목을 싣지 않는다(서버 거부) — 그 앞 요청엔 실려 있었고, 추론은 남는다",
                searchCap.r.cap === true && searchCap.r.searchKept === true && searchCap.r.flushNoTools === true &&
                    searchCap.r.flushHasSearch === false && searchCap.r.flushHasReasoning === true,
                searchCap.line,
            ),
            assert(
                "★상한 마무리 중 끊기면 이어 쓰기 재전송에 흘린 글과 «이어서 쓰세요» 가 실리고 검색 항목은 여전히 빠진다",
                fcR.flushNoTools === true && fcR.retryNoTools === true && fcR.retryHasPartial === true && fcR.retryHasNudge === true && fcR.retryHasSearch === false,
                fcLine ?? fc.err.slice(-800),
            ),
            assert("action 없는 검색 항목이 섞이면 재주입하지 않는다(기존 재구성으로 안전하게)", replay(badSearch) === undefined, replay(badSearch)),
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
