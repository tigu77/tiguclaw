/**
 * `choice-turn-reply` 의 자식 — **선택지 턴의 최종 답·발송·저장을 실제 경로로 돌린다** (2026-11-17,
 * `docs/decisions/2026-11-17-empty-reply-after-suggestion/REPORT.md` §7·§12).
 *
 * 각 어댑터의 **모델 경계만** 가짜다(claude = 가짜 SDK `withFakeClaudeQuery` · codex = 가짜 네트워크 · openai = 회귀 모델 주입) —
 *  그 위는 실제 어댑터 → 실제 퍼사드(`runRegionA`: 정제·`turn_done`·저장) → 실제 `deliverTurnReply`(채널 답·사본·제안은 스텁) →
 *  실제 이벤트 적재(`chat_log`) → 격리 저장소 재조회 → **다음 턴 요청**(Claude resume · Codex/OpenAI 이력 입력)까지. 모델 호출·외부 송신 0.
 *
 * 장면(모델이 차례로 내는 응답 — 글·도구):
 *   optTag       선택지 → 제안 태그만                 · optEmpty  선택지 → 글 없음(완전 무본문)
 *   explainOpt   설명+선택지 → 제안 태그만             · bodyTag   본문 + 제안(대조)
 *   corrected    설명+작업 도구 → 정정 + 태그(철회한 앞 글이 되살아나지 않아야)
 *   promiseWork  예고+작업 도구 → 태그만 (Codex 는 기존 재촉 경로 → 그다음 응답이 글)
 *   shortAfter   설명+선택지 → «골라 주세요» + 태그(현 정책: 짧은 본문만 — 앞 설명 복구 안 함)
 *   (claude 전용) sameId: 같은 message.id 다중 블록 · superseded: 대체된 설명 · attachOnly: 첨부만
 * 출력: 마지막 줄 JSON `{ rows: [...], next: {...} }`.
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";
process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key"; // 인증 판정 통과용(가짜 SDK 라 쓰이지 않는다)

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork, loadPluginModule } from "./_framework.js";

type Step = { text?: string; tool?: string; id?: string; uuid?: string; supersedes?: string[]; phase?: "commentary" | "final_answer" };
type Scene = { name: string; steps: Step[][] };
const adapter = process.argv[2] as "claude" | "codex" | "openai";
assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, `choice-turn-${adapter}-`));
const { initStore, getDb } = await import("../../store/sessions.js");
initStore();
const { getEventBus } = await import("../../core/eventbus.js");
const { startEventPersistence } = await import("../../core/event-persist.js");
const RT = await import("../../core/llm-runtime/index.js");
const { deliverTurnReply } = await import("../../core/entry/reply-command.js");
const { getRecentChatLog } = await import("../../store/chat-log.js");
// ★리터럴 지정자로 plugins/ 를 import 하지 않는다(rootDir=src 빌드가 죽는다 — `src-stays-inside-src`). 공용 우회 `loadPluginModule`.
const { historyActivities } = await loadPluginModule<{ historyActivities: (entries: Array<{ ts: number }>, scopeThreadKey?: string, upperBounded?: boolean) => unknown[] }>("../../../plugins/http-bridge/history-activities.js");
const bus = getEventBus();
startEventPersistence(bus);

const TAG = (s: string): string => `<next-message>${s}</next-message>`;
const EXPLAIN = "커맨드 초안입니다.\n- 이름: build\n- 실행문: npm run build";

/** 응답 하나 = 차례(step 묶음). 같은 응답 안 여러 step 은 Claude 에선 프레임 여러 개(같은 message.id), Codex/OpenAI 에선 출력 항목 여러 개. */
const SCENES: Scene[] = [
  { name: "optTag", steps: [[{ tool: "prompt_options" }], [{ text: TAG("둘 다 만들어줘") }]] },
  { name: "optEmpty", steps: [[{ tool: "prompt_options" }], []] },
  { name: "explainOpt", steps: [[{ text: EXPLAIN }, { tool: "prompt_options" }], [{ text: TAG("이대로 만들어줘") }]] },
  { name: "bodyTag", steps: [[{ text: `완료했습니다.\n\n${TAG("다음 것도 해줘")}` }]] },
  { name: "corrected", steps: [[{ text: "먼저 A 라고 봤습니다." }, { tool: "WORK" }], [{ text: `정정: B 입니다.\n\n${TAG("B 로 진행해줘")}` }]] },
  { name: "promiseWork", steps: [[{ text: "확인하겠습니다." }, { tool: "WORK" }], [{ text: TAG("결과 알려줘") }], [{ text: `결과: 정상입니다.\n\n${TAG("고마워")}` }]] },
  { name: "shortAfter", steps: [[{ text: EXPLAIN }, { tool: "prompt_options" }], [{ text: `골라 주세요.\n\n${TAG("1번")}` }]] },
  // 예고 → 작업 도구 + 선택지(같은 응답) → 태그만 — 작업 도구가 섞였으니 예고를 답으로 올리지 않는다(B1 «그 뒤 도구가 종료 도구뿐» 의 경계).
  { name: "promiseWorkOpt", steps: [[{ text: "확인하겠습니다." }, { tool: "WORK" }, { tool: "prompt_options" }], [{ text: TAG("좋아") }], [{ text: `결과: 정상입니다.\n\n${TAG("고마워")}` }]] },
];
const CLAUDE_ONLY: Scene[] = [
  // 같은 응답(message.id m1)이 블록 하나씩 세 프레임으로 온다 — 설명은 두 조각을 이어야 온전하다.
  { name: "sameId", steps: [[{ text: "설명 앞부분, ", id: "m1" }, { text: "설명 뒷부분.", id: "m1" }, { tool: "prompt_options", id: "m1" }], [{ text: TAG("좋아") }]] },
  // 거절 폴백 — 앞 설명 프레임(u1)을 뒤 프레임이 대체(supersedes). 대체된 설명은 답 후보가 아니다.
  { name: "superseded", steps: [[{ text: "철회될 설명", id: "m1", uuid: "u1" }, { tool: "prompt_options", id: "m1", uuid: "u2" }], [{ text: TAG("좋아"), id: "m3", uuid: "u3", supersedes: ["u1"] }]] },
  { name: "attachOnly", steps: [[{ tool: "send_file" }], []] },
];
const CODEX_ONLY: Scene[] = [
  // 같은 응답에 중간 해설(commentary)과 «태그만» 최종 답 — 해설은 답이 아니고 태그만 답은 보고가 아니다 → 앞 설명이 답.
  { name: "commentaryTag", steps: [[{ text: EXPLAIN }, { tool: "prompt_options" }], [{ text: "작성 메모", phase: "commentary" }, { text: TAG("좋아"), phase: "final_answer" }]] },
];
const scenes = adapter === "claude" ? [...SCENES, ...CLAUDE_ONLY] : adapter === "codex" ? [...SCENES, ...CODEX_ONLY] : SCENES;
/** 내부 호출(분류·요약 같은 단발)은 선택지 턴 모양이어도 저장·`turn_done` 0 — 바깥 가드 그대로. */
const INTERNAL: Scene = { name: "internalOpt", steps: SCENES[1]!.steps };

let scene: Scene = SCENES[0]!;
let modelCalls = 0;
let renders = 0;
let attachSent = 0;
const presentOptions = async (): Promise<{ ok: boolean }> => { renders += 1; return { ok: true }; };
const sendAttachment = async (): Promise<{ ok: boolean }> => { attachSent += 1; return { ok: true }; };
const ATTACH = path.join(process.env.TIGUCLAW_HOME!, "report.txt");
// Claude 는 SDK 기록(jsonl)이 있어야 실제 저장 갈래(세션 id·색인·완료 표식)를 탄다 — 격리 HOME 아래 SDK 와 같은 자리에 둔다(`resolveJsonlPath`).
if (adapter === "claude") process.env.HOME = process.env.TIGUCLAW_HOME;
const writeClaudeJsonl = (sid: string, question: string): void => {
  const dir = path.join(process.env.HOME!, ".claude", "projects", path.resolve(process.env.TIGUCLAW_HOME!).replace(/[\\/:]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", uuid: `${sid}-u`, sessionId: sid, timestamp: new Date().toISOString(), message: { role: "user", content: question } },
    { type: "assistant", uuid: `${sid}-a`, sessionId: sid, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "tu", name: "mcp__prompt-options__prompt_options", input: {} }] } },
  ];
  writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
writeFileSync(ATTACH, "첨부 본문");
/** 다음 턴 관측 — Claude 는 resume 세션 id, Codex/OpenAI 는 요청에 실린 이력 항목. */
let nextProbe: { resume?: string | null; input?: unknown } = {};
let probing = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Srv = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } };
let spec: Record<string, unknown>;

if (adapter === "claude") {
  // 네트워크는 막고 «명시적 가짜» 표식만 단다 — 실모델 가드가 가짜 SDK 주입 경로만 연다(`regression-model-guard.ts`).
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async () => { throw new Error("REGRESSION_NETWORK_BLOCKED"); });
  const { withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  const fake = ((args: { options: { mcpServers?: Record<string, unknown>; resume?: string } }) => {
    if (probing) {
      nextProbe = { resume: args.options.resume ?? null };
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: args.options.resume ?? "s-probe", model: "claude-fake" };
        yield { type: "assistant", session_id: "s", parent_tool_use_id: null, message: { id: "mp", role: "assistant", model: "claude-fake", content: [{ type: "text", text: "다음 턴" }] } };
        yield { type: "result", subtype: "success", is_error: false, result: "다음 턴", num_turns: 1, session_id: args.options.resume ?? "s-probe", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    }
    modelCalls += 1;
    const sid = `sess-${scene.name}`;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: sid, model: "claude-fake" };
      let lastText = "";
      let n = 0;
      for (const resp of scene.steps) {
        n += 1;
        let respText = "";
        for (const s of resp) {
          const id = s.id ?? `m${n}`;
          const base = { type: "assistant", session_id: sid, parent_tool_use_id: null, ...(s.uuid !== undefined ? { uuid: s.uuid } : {}), ...(s.supersedes !== undefined ? { supersedes: s.supersedes } : {}) };
          if (s.text !== undefined) {
            respText += s.text;
            yield { ...base, message: { id, role: "assistant", model: "claude-fake", usage: { input_tokens: 100, output_tokens: 7 }, content: [{ type: "text", text: s.text }] } };
          }
          if (s.tool !== undefined) {
            const tool = s.tool === "WORK" ? "Read" : s.tool;
            const tuId = `tu_${n}_${tool}`;
            yield { ...base, message: { id, role: "assistant", model: "claude-fake", usage: { input_tokens: 100, output_tokens: 7 }, content: [{ type: "tool_use", id: tuId, name: tool === "prompt_options" ? "mcp__prompt-options__prompt_options" : tool === "send_file" ? "mcp__send-file__send_file" : tool, input: {} }] } };
            if (tool === "prompt_options") await (args.options.mcpServers?.["prompt-options"] as Srv).instance._registeredTools.prompt_options!.handler({ question: "만들까요?", options: [{ label: "예" }, { label: "아니요" }] }, {});
            if (tool === "send_file") await (args.options.mcpServers?.["send-file"] as Srv).instance._registeredTools.send_file!.handler({ path: ATTACH }, {});
            yield { type: "user", session_id: sid, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tuId, content: "ok" }] } };
          }
        }
        if (respText !== "") lastText = respText;
        else if (resp.length === 0) lastText = ""; // 글 없는 마지막 응답 — SDK result 는 빈 글
        // Codex 의 «재촉 뒤 응답» 장면(promiseWork 셋째 응답)은 Claude 엔 없다 — SDK 가 루프를 가져 재촉이 없다.
        if (scene.name.startsWith("promiseWork") && n === 2) break;
      }
      yield { type: "result", subtype: "success", is_error: false, result: lastText, num_turns: 1, session_id: sid, modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    })();
  }) as never;
  spec = { adapter: "claude", model: "claude-fake", provider: "anthropic" };
  const realRun = RT.runRegionA;
  (globalThis as { __run?: unknown }).__run = (input: unknown, opts: unknown) => withFakeClaudeQuery(fake, () => realRun(input as never, opts as never));
} else if (adapter === "codex") {
  const enc = new TextEncoder();
  let req = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: string, init: { body?: unknown }): Promise<Response> => {
    if (!String(url).includes("/responses")) return new Response("not found", { status: 404 });
    const raw = typeof init.body === "string" ? init.body : "";
    const body = raw !== "" ? (JSON.parse(raw) as { input?: unknown }) : {};
    if (probing) nextProbe = { input: body.input };
    else modelCalls += 1;
    req += 1;
    const resp = probing ? [{ text: "다음 턴" }] : (scene.steps[req - 1] ?? [{ text: "(대본 밖 요청)" }]);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const send = (e: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          let k = 0;
          for (const s of resp) {
            k += 1;
            if (s.text !== undefined) {
              const mid = `m${req}_${k}`;
              if (s.phase !== undefined) send({ type: "response.output_item.added", item: { type: "message", id: mid, role: "assistant", phase: s.phase } });
              send({ type: "response.output_text.delta", delta: s.text, item_id: mid });
              send({ type: "response.output_item.done", item: { type: "message", id: mid, role: "assistant", ...(s.phase !== undefined ? { phase: s.phase } : {}), content: [{ type: "output_text", text: s.text }] } });
            }
            if (s.tool !== undefined) {
              const name = s.tool === "WORK" ? "find_skills" : s.tool;
              const a = JSON.stringify(name === "prompt_options" ? { question: "만들까요?", options: [{ label: "예" }, { label: "아니요" }] } : {});
              send({ type: "response.output_item.added", item: { type: "function_call", id: `fc${req}_${k}`, call_id: `c${req}_${k}`, name } });
              send({ type: "response.function_call_arguments.delta", delta: a });
              send({ type: "response.output_item.done", item: { type: "function_call", id: `fc${req}_${k}`, call_id: `c${req}_${k}`, name, arguments: a } });
            }
          }
          // 응답 id 는 장면마다 다르게 — 어댑터가 마지막 응답 id 로 세션 id 를 만든다(장면끼리 기록이 섞이지 않게).
          send({ type: "response.completed", response: { id: `r-${probing ? "probe" : scene.name}-${req}`, usage: { input_tokens: 10, output_tokens: 5 } } });
          c.close();
        },
      }),
      { status: 200 },
    );
  });
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  spec = { adapter: "codex-oauth", model: "gpt-fake" };
  (globalThis as { __run?: unknown }).__run = (input: unknown, opts: unknown) => { req = 0; return RT.runRegionA(input as never, opts as never); };
} else {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error("REGRESSION_NETWORK_BLOCKED"); };
  const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
  let turnCalls = 0;
  injectRegressionModel({
    getResponse: async () => { throw new Error("스트림만 쓴다"); },
    async *getStreamedResponse(r: { input?: unknown }) {
      if (probing) nextProbe = { input: r.input };
      else modelCalls += 1;
      turnCalls += 1;
      const resp = probing ? [{ text: "다음 턴" }] : (scene.steps[turnCalls - 1] ?? [{ text: "(대본 밖 요청)" }]);
      yield { type: "response_started" };
      const output: unknown[] = [];
      // 글 없는 응답 — 실제 모델은 빈 메시지를 낸다(출력 항목이 아예 없으면 SDK 가 다시 묻는다).
      if (resp.length === 0) output.push({ type: "message", id: `m${turnCalls}_0`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "" }] });
      let k = 0;
      for (const s of resp) {
        k += 1;
        if (s.text !== undefined) {
          yield { type: "output_text_delta", delta: s.text };
          output.push({ type: "message", id: `m${turnCalls}_${k}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: s.text }] });
        }
        if (s.tool !== undefined) {
          const name = s.tool === "WORK" ? "find_skills" : s.tool;
          const args = name === "prompt_options" ? { question: "만들까요?", options: [{ label: "예" }, { label: "아니요" }] } : {};
          output.push({ type: "function_call", id: `fc${turnCalls}_${k}`, callId: `c${turnCalls}_${k}`, name, arguments: JSON.stringify(args), status: "completed" });
        }
      }
      yield { type: "response_done", response: { id: `r${turnCalls}`, usage: { inputTokens: 200000, outputTokens: 1, totalTokens: 200001, requests: 1 }, output } };
    },
  });
  spec = { adapter: "openai", model: "gpt-regression", provider: "openai" };
  (globalThis as { __run?: unknown }).__run = (input: unknown, opts: unknown) => { turnCalls = 0; return RT.runRegionA(input as never, opts as never); };
}
const runTurn = (globalThis as { __run?: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).__run!;

const seen: Array<{ type: string; tk?: string; text?: string; kind?: string; inputTokens?: number; outputTokens?: number }> = [];
bus.subscribe((ev) => {
  const p = (ev.payload ?? {}) as { threadKey?: string; text?: string; kind?: string; inputTokens?: number; outputTokens?: number };
  if (["llm.turn_done", "channel.message.out", "llm.activity"].includes(ev.type)) {
    seen.push({ type: ev.type, tk: p.threadKey, text: p.text, kind: p.kind, ...(ev.type === "llm.turn_done" ? { inputTokens: p.inputTokens, outputTokens: p.outputTokens } : {}) });
  }
});

const rows: Record<string, unknown>[] = [];
for (const s of [...scenes, INTERNAL]) {
  scene = s;
  const internal = s === INTERNAL;
  modelCalls = 0;
  renders = 0;
  attachSent = 0;
  const tk = `dashboard:choice-${adapter}-${s.name}`;
  if (adapter === "claude") writeClaudeJsonl(`sess-${s.name}`, `질문-${s.name}`);
  // 진입점처럼 사용자 발화를 먼저 적재한다 — 이력 조회(`/chat-history`)가 그 턴의 행과 활동을 함께 돌려주는 재료.
  if (!internal) bus.publish({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: tk, text: `질문-${s.name}` } });
  const before = seen.length;
  let out: Record<string, unknown> = {};
  let err: string | undefined;
  try {
    out = await runTurn(
      { channel: "http-bridge", threadKey: tk, text: `질문-${s.name}`, cwd: process.env.TIGUCLAW_HOME, presentOptions, sendAttachment, ...(internal ? { internal: true } : {}) },
      { specs: [spec] },
    );
  } catch (e) {
    err = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  const replies: string[] = [];
  const copies: string[] = [];
  /** 사본이 짚은 원본 좌표가 대화 기록 행을 찾나(사본 답글 → 원본 행) — 사본마다 그 좌표의 `chat_log` 행 본문. */
  const copyOriginals: Array<{ threadKey: string; ts: number }> = [];
  let suggestCalls = 0;
  if (err === undefined && !internal) {
    await deliverTurnReply({
      msg: { channel: "http-bridge", threadKey: tk, reply: async (t: string) => { replies.push(t); } },
      out: out as never,
      replyText: String(out.text ?? ""),
      bus,
      turnMarkable: () => true,
      fanOut: async (text: string, original: { threadKey: string; ts: number }) => { copies.push(text); copyOriginals.push(original); },
      suggest: () => { suggestCalls += 1; },
    });
  }
  await new Promise((r) => setTimeout(r, 150)); // 델타·적재 타이머
  const ev = seen.slice(before).filter((e) => e.tk === tk);
  const sid = typeof out.sessionId === "string" ? out.sessionId : "";
  const tr = getDb().prepare("SELECT id, role, content FROM transcripts WHERE claude_session_id = ? ORDER BY id").all(sid) as Array<{ id: number; role: string; content: string }>;
  const items = tr.filter((r) => r.role === "assistant").flatMap((r) => (getDb().prepare("SELECT item FROM turn_items WHERE transcript_id = ? ORDER BY seq").all(r.id) as Array<{ item: string }>).map((x) => JSON.parse(x.item) as Record<string, unknown>));
  const thread = getDb().prepare("SELECT claude_session_id AS sid FROM threads WHERE channel_thread_id = ?").get(tk) as { sid?: string } | undefined;
  rows.push({
    scene: s.name,
    ...(err !== undefined ? { err } : {}),
    outText: out.text ?? null,
    suggestion: out.nextSuggestion ?? null,
    choiceEnd: out.choiceEnd === true,
    modelCalls,
    renders,
    attachSent,
    turnDone: ev.filter((e) => e.type === "llm.turn_done").length,
    // 그 턴의 사용량(`turn_done` 에 실린 마지막 호출 입력·출력) — 본문이 비어도 남아야 한다.
    turnUsage: ev.filter((e) => e.type === "llm.turn_done").map((e) => ({ input: e.inputTokens ?? null, output: e.outputTokens ?? null })),
    replies,
    copies,
    outEvents: ev.filter((e) => e.type === "channel.message.out").map((e) => e.text ?? ""),
    suggestCalls,
    chatLog: (getDb().prepare("SELECT role, text FROM chat_log WHERE thread_key = ? AND role = 'assistant' AND (kind IS NULL OR kind = '') ORDER BY id").all(tk) as Array<{ text: string }>).map((r) => r.text),
    transcripts: tr.map((r) => ({ role: r.role, content: r.content })),
    items: items.map((i) => (i.type === "message" ? `msg:${String(i.text).slice(0, 40)}` : i.type === "function_call" ? `call:${String(i.name)}` : String(i.type))),
    threadSid: thread?.sid ?? null,
    // 새로고침 이력 재료 — `/chat-history` 와 같은 두 조회(`getRecentChatLog` + `historyActivities`). 부모가 대시보드 병합 함수로 그린다.
    history: (() => {
      const entries = getRecentChatLog({ limit: 50, threadKey: tk });
      return { entries, activities: historyActivities(entries, tk, false) };
    })(),
    jsonlIndexed: (getDb().prepare("SELECT COUNT(*) AS n FROM transcript_index WHERE thread_key = ?").get(tk) as { n: number }).n,
    copyOriginalRows: copyOriginals.map((o) => (getDb().prepare("SELECT text FROM chat_log WHERE thread_key = ? AND ts = ? AND role = 'assistant'").get(o.threadKey, o.ts) as { text?: string } | undefined)?.text ?? null),
  });
}

// ── (claude) 이어 받기 — 앞 턴이 «설명 → 선택지 → 태그만» 이고 줄 선 메시지의 턴이 뒤따른다. 앞 턴 확정도 마감과 같은 선택(B1)이어야 설명이 남는다.
let steer: Record<string, unknown> | undefined;
if (adapter === "claude") {
  const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  const { createSteeringChannel } = await import("../../core/steering.js");
  const { visibleReply } = await import("../../core/next-message-suggestion.js");
  const steering = createSteeringChannel();
  steering.push({ text: "두 번째", raw: "두 번째", ts: Date.now() });
  const sid = "sess-steer";
  const fq = ((args: { prompt: unknown }) => {
    const it = typeof args.prompt === "string" ? undefined : (args.prompt as AsyncIterable<{ uuid?: string }>)[Symbol.asyncIterator]();
    return (async function* () {
      if (it !== undefined) await it.next(); // 초기 사용자 메시지
      yield { type: "system", subtype: "init", session_id: sid, model: "claude-fake" };
      yield { type: "assistant", session_id: sid, parent_tool_use_id: null, message: { id: "s1", role: "assistant", model: "claude-fake", content: [{ type: "text", text: EXPLAIN }] } };
      yield { type: "assistant", session_id: sid, parent_tool_use_id: null, message: { id: "s1", role: "assistant", model: "claude-fake", content: [{ type: "tool_use", id: "tu_s", name: "mcp__prompt-options__prompt_options", input: {} }] } };
      yield { type: "user", session_id: sid, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_s", content: "ok" }] } };
      const r = it === undefined ? undefined : await it.next();
      const u = r === undefined || r.done === true ? undefined : r.value.uuid;
      yield { type: "assistant", session_id: sid, parent_tool_use_id: null, message: { id: "s2", role: "assistant", model: "claude-fake", content: [{ type: "text", text: TAG("좋아") }] } };
      yield { type: "result", subtype: "success", is_error: false, result: TAG("좋아"), num_turns: 1, session_id: sid, modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      yield { type: "system", subtype: "init", session_id: sid, model: "claude-fake" };
      yield { type: "assistant", session_id: sid, parent_tool_use_id: null, ...(u !== undefined ? { user_message_uuid: u, user_message_uuids: [u] } : {}), message: { id: "s3", role: "assistant", model: "claude-fake", content: [{ type: "text", text: "두 번째 답" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "두 번째 답", num_turns: 1, session_id: sid, modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    })();
  }) as never;
  try {
    const o = (await withFakeClaudeQuery(fq, () => runClaude({ text: "첫 질문", threadKey: "dashboard:choice-claude-steer", channel: "cli", steering, cwd: process.env.TIGUCLAW_HOME } as never))) as { text?: string };
    steer = { visible: visibleReply(String(o.text ?? "")).text };
  } catch (e) {
    steer = { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

// ── 다음 턴 — 무본문 선택지 턴(optEmpty)이 다음 턴에 이어지나 ─────────────────────────────
//  Claude: 그 턴에 새로 시작한 세션 id 로 resume 하나 · Codex/OpenAI: 다음 요청 이력에 사용자 질문·선택지 호출이 실리고 빈 비서 글은 없나.
probing = true;
const nextTk = `dashboard:choice-${adapter}-optEmpty`;
let nextErr: string | undefined;
try {
  await runTurn({ channel: "http-bridge", threadKey: nextTk, text: "예", cwd: process.env.TIGUCLAW_HOME, presentOptions, sendAttachment }, { specs: [spec] });
} catch (e) {
  nextErr = (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
probing = false;
const inputItems = Array.isArray(nextProbe.input) ? (nextProbe.input as Array<Record<string, unknown>>) : [];
const textOf = (it: Record<string, unknown>): string => {
  const c = it.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? (c as Array<{ text?: unknown }>).map((x) => (typeof x.text === "string" ? x.text : "")).join("") : "";
};
const next = {
  ...(nextErr !== undefined ? { err: nextErr } : {}),
  resume: nextProbe.resume ?? null,
  historyHasQuestion: inputItems.some((it) => it.role === "user" && textOf(it).includes("질문-optEmpty")),
  historyCalls: inputItems.filter((it) => it.type === "function_call").map((it) => String(it.name)),
  emptyAssistantMsgs: inputItems.filter((it) => it.role === "assistant" && (it.type === "message" || it.type === undefined) && textOf(it).trim() === "").length,
};
// ── (codex) 교차 재생 — Codex 가 저장한 무본문 선택지 턴(본문 빈 비서 행 = 도구 항목 그릇)을 **다른 어댑터**가 다음 턴에 읽는다.
//  Claude(교차 이력 글) · OpenAI(글 이력) 둘 다 사용자 질문은 보이고 빈 비서 글은 없어야 한다. 저장 코드(`appendApiTurn`)는 OpenAI 도 같다.
let cross: Record<string, unknown> | undefined;
if (adapter === "codex") {
  cross = {};
  const { withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  let claudePrompt = "";
  const fq = ((args: { prompt: unknown }) => {
    claudePrompt = typeof args.prompt === "string" ? args.prompt : "(스트리밍 입력)";
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s-cross", model: "claude-fake" };
      yield { type: "assistant", session_id: "s-cross", parent_tool_use_id: null, message: { id: "mc", role: "assistant", model: "claude-fake", content: [{ type: "text", text: "교차 턴" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "교차 턴", num_turns: 1, session_id: "s-cross", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    })();
  }) as never;
  try {
    await withFakeClaudeQuery(fq, () => RT.runRegionA({ channel: "http-bridge", threadKey: nextTk, text: "클로드로 이어서", cwd: process.env.TIGUCLAW_HOME } as never, { specs: [{ adapter: "claude", model: "claude-fake", provider: "anthropic" }] } as never));
    cross.claude = {
      hasQuestion: claudePrompt.includes("사용자: 질문-optEmpty"),
      emptyAssistantLines: (claudePrompt.match(/다른 응답\(예: codex\):[ \t]*(\n|$)/g) ?? []).length,
    };
  } catch (e) {
    cross.claude = { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
  const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
  let openaiInput: unknown;
  injectRegressionModel({
    getResponse: async () => { throw new Error("스트림만 쓴다"); },
    async *getStreamedResponse(r: { input?: unknown }) {
      openaiInput = r.input;
      yield { type: "response_started" };
      yield { type: "response_done", response: { id: "r-cross", usage: { inputTokens: 200000, outputTokens: 1, totalTokens: 200001, requests: 1 }, output: [{ type: "message", id: "m-cross", role: "assistant", status: "completed", content: [{ type: "output_text", text: "교차 턴" }] }] } };
    },
  });
  try {
    await RT.runRegionA({ channel: "http-bridge", threadKey: nextTk, text: "오픈AI로 이어서", cwd: process.env.TIGUCLAW_HOME } as never, { specs: [{ adapter: "openai", model: "gpt-regression", provider: "openai" }] } as never);
    const items = Array.isArray(openaiInput) ? (openaiInput as Array<Record<string, unknown>>) : [];
    cross.openai = {
      hasQuestion: items.some((it) => it.role === "user" && textOf(it).includes("질문-optEmpty")),
      emptyAssistantMsgs: items.filter((it) => it.role === "assistant" && textOf(it).trim() === "").length,
    };
  } catch (e) {
    cross.openai = { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}
console.log(JSON.stringify({ rows, next, ...(steer !== undefined ? { steer } : {}), ...(cross !== undefined ? { cross } : {}) }));
process.exit(0);
