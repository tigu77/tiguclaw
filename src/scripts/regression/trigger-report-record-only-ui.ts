/** 독립 UI/API QA: 제품 원문 실행. 운영 홈/DB/네트워크 없이 좁은 계약만 검증한다. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { Cron } from "croner";
import { bootDashboard, dashSource, DASH_JS, internalTextHelpersSource, jsonResponse, makeClock } from "./_mini-dom.js";
import { assert, assertIsolated, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

type Row = Record<string, any>;
export type SourceOverrides = Record<string, string>;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const apiSource = (): string => {
  const source = readFileSync(path.resolve(HERE, "../../../plugins/http-bridge/routes-work.ts"), "utf8");
  const found = /export const handleTimers = [\s\S]*?\n\};/.exec(source);
  if (!found) throw new Error("handleTimers actual source missing");
  return found[0].replace("export const", "const");
};
const dashboard = (overrides: SourceOverrides = {}, fetch = async (_url: string) => jsonResponse({}, 404)) => {
  const clock = makeClock();
  const dom = bootDashboard({ clock, i18n: i18nForContext, allIds: true, upTo: "channel-hints.js", fetch,
    extra: { EventSource: class { onmessage = null; onerror = null; onopen = null; addEventListener() {} close() {} } } });
  const files = JSON.parse(readFileSync(path.join(DASH_JS, "_manifest.json"), "utf8")) as string[];
  // SSE 접속 부트스트랩은 이 좁은 단위의 대상이 아니다. 렌더/이력 함수와 탭 상태는 원문 그대로 싣는다.
  for (const name of files.slice(files.indexOf("channel-hints.js"), files.indexOf("tabs.js") + 1)) {
    if (name === "sse.js") continue;
    const source = overrides[name] ?? dashSource(name);
    // 자동 부팅 호출은 분리한다. 아래 probe가 초기/탭/더보기 실제 함수를 각각 await한다.
    dom.run(name === "tabs.js" ? source.slice(0, source.indexOf("      // 과거 대화 이력을 먼저 복원한 뒤 SSE 연결")) : source, name);
  }
  dom.run(`activeThreadKey = 'dashboard:independent-qa'; currentView = 'chat';`);
  return { ...dom, clock };
};
const T = "dashboard:independent-qa";
const hidden = (ts: number, id = ts): Row => ({ id, ts, role: "assistant", threadKey: T, text: "조용한 마감", notice: true, data: { audience: "internal", recordOnly: true } });

/** 변이 주입은 읽은 제품 원문의 메모리 사본에만 한다. 기본 회귀는 언제나 디스크의 제품 원문. */
export const runIndependent = async (overrides: SourceOverrides = {}, timersSource = apiSource()): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const probe = async (name: string, f: () => Promise<void> | void) => {
    try { await f(); } catch (e) { out.push(assert(name + " (unexpected exception)", false, String(e))); }
  };
  await probe("recordOnly actual helper", () => {
    const ctx: Row = {};
    vm.createContext(ctx);
    // 공용 helper가 읽는 제품 원문을 사용하며 util 변이는 같은 원문의 판정 한 줄에만 적용한다.
    let source = internalTextHelpersSource();
    if (overrides["util.js"]) {
      const original = /const isRecordOnlyMessage = [\s\S]*?;\n/.exec(dashSource("util.js"))![0];
      const mutated = /const isRecordOnlyMessage = [\s\S]*?;\n/.exec(overrides["util.js"])![0];
      source = source.replace(original, mutated);
    }
    vm.runInContext(source + "\nthis.isHidden = isRecordOnlyMessage;", ctx);
    const cases: Array<[Row, boolean]> = [
      [hidden(1), true], [{ audience: "internal", recordOnly: true }, true],
      [{ text: "조용한 마감", notice: true }, false], [{ recordOnly: true }, false],
      [{ data: { recordOnly: true, audience: "public" } }, false],
      [{ audience: "internal", notice: true }, false], [{ data: { audience: "internal", recordOnly: "true" } }, false],
      [{ text: "", role: "assistant" }, false], [{ text: "내부 처리", role: "user" }, false],
    ];
    const got = cases.map(([value]) => ctx.isHidden(value));
    out.push(assert("internal+recordOnly 두 명시 표식만 숨김; 표식 없는 문구/빈 답/worker 내부통지 보존", cases.every(([, want], i) => got[i] === want), got));
  });
  await probe("live/history actual render", () => {
    const dom = dashboard(overrides);
    const R = (code: string): any => dom.run(code);
    R(`renderActivity({threadKey:'${T}',adapter:'codex',seq:0,kind:'tool',label:'steer_worker',detail:''},10);`);
    const before = R(`vtItems.length`);
    R(`renderChannelMessage({type:'channel.message.out',ts:20,payload:{threadKey:'${T}',text:'조용한 마감',notice:true,audience:'internal',recordOnly:true}},'t');`);
    const state = R(`(() => { const c = cardByThread.get('${T}'); return {rows:vtItems.length,closed:!!c.closed,done:c.el.classList.contains('done'),notices:vtItems.reduce((n,i)=>n+(i.node.classList.contains('sys-notice')?1:0)+i.node.querySelectorAll('.sys-notice').length,0)}; })()`);
    out.push(assert("라이브 recordOnly 마감은 행 0개 추가, 기존 작업 카드는 닫힘/완료", state.rows === before && state.closed && state.done && state.notices === 0, { before, state }));
    const shapes = [hidden(30), { ...hidden(31), role: "user" }, { ts: 32, role: "assistant", text: "조용한 마감", notice: true }, { ts: 33, role: "assistant", text: "worker 상태", notice: true, data: { audience: "internal" } }, { ts: 34, role: "assistant", text: "일반 안내", recordOnly: true }];
    const rendered = shapes.map((entry) => R(`(() => { const node=buildHistoryDiv(${JSON.stringify(entry)}); return node && {text:node.textContent,notice:node.classList.contains('sys-notice')}; })()`));
    out.push(assert("과거 마감만 null; 사용자 동일표식·표식 없는 통지·worker 내부통지·public recordOnly는 가시", rendered[0] === null && rendered.slice(1).every(Boolean) && rendered[3].notice, rendered));
  });
  await probe("history boundaries actual group", () => {
    const dom = dashboard(overrides);
    const tool = (ts: number, seq: number): Row => ({ ts, threadKey: T, seq, kind: "tool", label: "Read", model: "codex:test" });
    const entries = [hidden(30), { ts: 50, role: "assistant", threadKey: T, text: "다음 답", model: "codex:test", reasoning: "high" }];
    const units = dom.run(`groupMergedItems(${JSON.stringify(entries)},${JSON.stringify([tool(10, 0), tool(20, 1), tool(40, 2)])})`) as Row[];
    const turns = units.filter((u) => u.kind === "turn");
    out.push(assert("숨긴 마감도 도구런 경계: 2+1 분리, 다음 답 강도는 뒤 카드에만", turns.length === 2 && turns[0]?.acts.length === 2 && turns[1]?.acts.length === 1 && !turns[0]?.reasoning && turns[1]?.reasoning === "high" && !units.some((u) => u.kind === "msg" && u.entry?.ts === 30), units));
    const textUnits = dom.run(`groupMergedItems(${JSON.stringify([hidden(30), { ts: 40, role: "assistant", threadKey: T, text: "독립 다음 답" }])},${JSON.stringify([{ ts: 20, threadKey: T, seq: 0, kind: "text", text: "앞 세그먼트" }])})`) as Row[];
    out.push(assert("숨긴 마감 뒤 다른 assistant 답을 앞 세그먼트 중복으로 지우지 않음", textUnits.some((u) => u.kind === "text" && u.act.text === "앞 세그먼트") && textUnits.some((u) => u.kind === "msg" && u.entry.text === "독립 다음 답"), textUnits));
  });
  for (const mode of ["boot", "tab", "older", "same-ts", "stalled", "switched"] as const) await probe("history paging " + mode, async () => {
    const calls: string[] = [];
    const older = { id: 40, ts: mode === "same-ts" ? 100 : 40, role: "user", threadKey: T, text: "더 오래된 실제 사용자 메시지" };
    const pages = [Array.from({ length: 20 }, (_, i) => hidden(mode === "same-ts" ? 100 : 100 + i, 100 + i)), Array.from({ length: 20 }, (_, i) => hidden(mode === "same-ts" ? 100 : 60 + i, 60 + i)), [older]];
    let dom: ReturnType<typeof dashboard>;
    dom = dashboard(overrides, async (url) => {
      if (!url.startsWith("/api/chat-history?")) return jsonResponse({}, 404);
      calls.push(url);
      if (calls.length > 4) throw new Error("pagination did not terminate");
      if (mode === "switched" && calls.length === 2) dom.run("switchToken += 1; activeThreadKey='dashboard:other';");
      return jsonResponse({ entries: mode === "stalled" && calls.length > 1 ? pages[0] : pages[calls.length - 1] ?? [], activities: [] });
    });
    if (mode === "older" || mode === "same-ts" || mode === "stalled" || mode === "switched") dom.run(`setOldestCursor([{ts:300,id:300}],null);`);
    await dom.run(mode === "boot" ? "loadChatHistory()" : mode === "tab" ? `loadThreadHistory('${T}')` : "loadOlderHistory()");
    const rows = dom.run(`vtItems.filter(i=>i.node.classList.contains('channel-chat')).map(i=>({text:i.node.textContent,ts:i.ts}))`) as Row[];
    const cursor = dom.run(`({ts:oldestLoadedTs,id:oldestLoadedId,reached:reachedOldest})`);
    if (mode === "stalled") out.push(assert("전진 없는 숨김 페이지는 무한 반복하지 않음", calls.length === 2 && rows.length === 0, { calls, cursor, rows }));
    else if (mode === "switched") out.push(assert("숨김 페이지 연속 조회 중 탭 전환은 새 탭에 이전 배치를 붙이지 않음", calls.length === 2 && rows.length === 0 && cursor.ts === 100, { calls, cursor, rows }));
    else out.push(assert(mode + ": 숨김 20행 두 페이지를 건너 실제 과거 사용자 행 도달/복합커서 전진", calls.length === 3 && calls[1]!.includes("beforeId=100") && calls[2]!.includes("beforeId=60") && rows.length === 1 && rows[0]!.text.includes(older.text) && cursor.id === 40 && cursor.reached === true, { calls, cursor, rows }));
    out.push(assert(mode + ": 미니 DOM async 오류 없음", dom.clock.errors.length === 0, dom.clock.errors));
  });
  for (const mode of ["boot", "tab", "older"] as const) await probe("history budget and explicit resume " + mode, async () => {
    const calls: string[] = [];
    const visible = [401, 402, 403].map((ts) => ({ id: ts, ts, role: "user", threadKey: T, text: "보이는 과거 " + ts }));
    const pages = [0, 1, 2, 3, 4].map((p) => Array.from({ length: 20 }, (_, i) => hidden(1000 - p * 100 + i)));
    const dom = dashboard(overrides, async (url) => {
      if (!url.startsWith("/api/chat-history?")) return jsonResponse({}, 404);
      calls.push(url);
      if (calls.length > 6) throw new Error("history budget exceeded");
      return jsonResponse({ entries: pages[calls.length - 1] ?? visible, activities: [] });
    });
    if (mode === "older") dom.run(`renderHistoryBatch([{id:2000,ts:2000,role:'user',threadKey:'${T}',text:'이미 보이는 최신 대화'}],[],false); setOldestCursor([{ts:2000,id:2000}],null); setHistoryLoadState('ready');`);
    await dom.run(mode === "boot" ? "loadChatHistory()" : mode === "tab" ? `loadThreadHistory('${T}')` : "loadOlderHistory()");
    const paused = dom.run(`({ts:oldestLoadedTs,id:oldestLoadedId,reached:reachedOldest,paused:historyOlderPaused,loading:loadingOlder,rows:localChatCount,state:historyLoadState,empty:document.getElementById('chat-empty').textContent,button:!!olderHistoryButton && olderHistoryControl.style.display !== 'none' && !olderHistoryButton.disabled})`);
    out.push(assert(mode + ": 첫 fetch 포함 총 3회에서 멈춤; raw cursor/hasMore 유지·recordOnly 숨김·더보기 가시", calls.length === 3 && paused.ts === 800 && paused.id === 800 && !paused.reached && paused.paused && !paused.loading && paused.rows === (mode === "older" ? 1 : 0) && paused.state === "ready" && paused.button, { calls: [...calls], paused }));
    if (mode !== "older") out.push(assert(mode + ": 아직 hidden 이력만 읽은 상태를 빈 첫 대화와 구분; 예시 질문 없음", paused.empty.includes(i18nForContext("chat.historyPending")) && !paused.empty.includes(i18nForContext("chat.empty")) && dom.run(`document.getElementById('chat-empty').querySelectorAll('button').length`) === 0, paused));
    // 프로그램적 스크롤 가드를 풀어 실제 제품 리스너를 통과시킨다. 자동 호출 자체도 재개할 수 없어야 한다.
    dom.run(`vtProgrammatic=false; vtProgUntil=0; stream.scrollTop=0; for(let i=0;i<8;i++) stream.dispatchEvent(new CustomEvent('scroll'));`);
    await dom.run("loadOlderHistory()");
    await dom.clock.flush();
    out.push(assert(mode + ": 연속 스크롤/자동 재호출은 예산을 새로 얻지 못함", calls.length === 3 && dom.run("historyOlderPaused"), [...calls]));
    dom.run(`document.getElementById('history-load-older').click()`);
    await dom.clock.flush();
    const rows = dom.run(`vtItems.filter(i=>i.node.classList.contains('channel-chat')).map(i=>({ts:Number(i.node.dataset.ts),text:i.node.textContent}))`) as Row[];
    const resumed = dom.run(`({ts:oldestLoadedTs,id:oldestLoadedId,reached:reachedOldest,paused:historyOlderPaused,loading:loadingOlder,buttonHidden:olderHistoryControl.style.display==='none'})`);
    const expectedTs = mode === "older" ? [401, 402, 403, 2000] : [401, 402, 403];
    out.push(assert(mode + ": 명시 버튼 다음 3회로 hidden 5페이지 뒤 visible 도달; 커서 연속·ASC·중복/숨긴 행 없음", calls.length === 6 && calls[3]!.includes("beforeTs=800") && calls[3]!.includes("beforeId=800") && calls[4]!.includes("beforeId=700") && calls[5]!.includes("beforeId=600") && rows.map((r) => r.ts).join(",") === expectedTs.join(",") && rows.every((r) => !r.text.includes("조용한 마감")) && resumed.ts === 401 && resumed.id === 401 && resumed.reached && !resumed.paused && !resumed.loading && resumed.buttonHidden, { calls, rows, resumed }));
    out.push(assert(mode + ": 예산/재개 비동기 오류 없음", dom.clock.errors.length === 0, dom.clock.errors));
  });
  for (const mode of ["short", "empty", "stalled", "visible-at-cap", "failed-at-cap"] as const) await probe("history termination " + mode, async () => {
    const calls: string[] = [];
    const page = (base: number) => Array.from({ length: 20 }, (_, i) => hidden(base + i));
    const pages = mode === "short" ? [page(1000).slice(0, 4)] : mode === "empty" ? [[]] : mode === "stalled" ? [page(1000), page(1000)] : [page(1000), page(900), mode === "visible-at-cap" ? Array.from({ length: 20 }, (_, i) => ({id:800+i,ts:800+i,role:'user',threadKey:T,text:'과거 '+i})) : []];
    const dom = dashboard(overrides, async (url) => {
      if (!url.startsWith("/api/chat-history?")) return jsonResponse({}, 404);
      calls.push(url);
      if (calls.length > 3) throw new Error("termination did not stop");
      return jsonResponse({ entries: pages[calls.length - 1] ?? [], activities: [] }, mode === "failed-at-cap" && calls.length === 3 ? 503 : 200);
    });
    dom.run(`setOldestCursor([{ts:2000,id:2000}],null); setHistoryLoadState('ready');`);
    await dom.run("loadOlderHistory()");
    const state = dom.run(`({ts:oldestLoadedTs,id:oldestLoadedId,reached:reachedOldest,paused:historyOlderPaused,loading:loadingOlder,rows:localChatCount,button:!!olderHistoryControl && olderHistoryControl.style.display !== 'none'})`);
    const terminal = mode === "short" || mode === "empty";
    out.push(assert(mode + ": short/empty는 종료, stall/총3회는 cursor 유지한 사용자 재개 대기", calls.length === (terminal ? 1 : mode === "stalled" ? 2 : 3) && state.reached === terminal && state.paused === !terminal && state.button === !terminal && !state.loading && state.rows === (mode === "visible-at-cap" ? 20 : 0) && state.ts === (mode === "empty" ? 2000 : mode === "failed-at-cap" ? 900 : mode === "visible-at-cap" ? 800 : 1000), { calls: [...calls], state }));
    const before = calls.length;
    dom.run(`vtProgrammatic=false; vtProgUntil=0; stream.scrollTop=0; stream.dispatchEvent(new CustomEvent('scroll'));`);
    await dom.clock.flush();
    out.push(assert(mode + ": 종료/대기 뒤 스크롤 추가 요청 없음", calls.length === before && dom.clock.errors.length === 0, { calls, errors: dom.clock.errors }));
  });
  for (const mode of ["boot", "tab"] as const) await probe("empty first page " + mode, async () => {
    let calls = 0;
    const dom = dashboard(overrides, async (url) => {
      if (!url.startsWith("/api/chat-history?")) return jsonResponse({}, 404);
      calls += 1;
      return jsonResponse({ entries: [], activities: [] });
    });
    await dom.run(mode === "boot" ? "loadChatHistory()" : `loadThreadHistory('${T}')`);
    const state = dom.run(`({ready:historyLoadState==='ready',reached:reachedOldest,paused:historyOlderPaused,ts:oldestLoadedTs,empty:document.getElementById('chat-empty').textContent,button:!!olderHistoryControl && olderHistoryControl.style.display!=='none'})`);
    out.push(assert(mode + ": 진짜 빈 첫 페이지는 1회·ready/empty; paused 안내/더보기 없음", calls === 1 && state.ready && state.reached && !state.paused && state.ts === null && state.empty.includes(i18nForContext("chat.empty")) && !state.empty.includes(i18nForContext("chat.historyPending")) && !state.button, state));
  });
  await probe("resume duplicate and tab ownership", async () => {
    const calls: string[] = [];
    const pending: Array<(value: ReturnType<typeof jsonResponse>) => void> = [];
    let allowPending = false;
    const dom = dashboard(overrides, async (url) => {
      if (!url.startsWith("/api/chat-history?")) return jsonResponse({}, 404);
      calls.push(url);
      if (calls.length <= 3) return jsonResponse({ entries: Array.from({ length: 20 }, (_, i) => hidden(1000 - calls.length * 100 + i)), activities: [] });
      if (!allowPending) throw new Error("initial history fetch budget missing");
      return new Promise((resolve) => pending.push(resolve));
    });
    dom.run(`setOldestCursor([{ts:2000,id:2000}],null); setHistoryLoadState('ready');`);
    await dom.run("loadOlderHistory()");
    allowPending = true;
    dom.run(`document.getElementById('history-load-older').click(); document.getElementById('history-load-older').click();`);
    void dom.run("loadOlderHistory()");
    out.push(assert("더보기 재개 연타/자동 호출은 in-flight 1개; 버튼 비활성", calls.length === 4 && pending.length === 1 && dom.run("loadingOlder && olderHistoryButton.disabled"), { calls: [...calls], pending: pending.length }));
    if (calls.slice().length !== 4 || pending.slice().length !== 1) return; // 가드 결함이어도 미해결 요청을 기다리며 검사를 붙잡지 않는다.
    const nextThread = dom.run(`activeThreadKey='dashboard:next'; loadThreadHistory(activeThreadKey)`) as Promise<void>;
    const freshState = dom.run(`({paused:historyOlderPaused,button:olderHistoryControl.style.display,loading:historyLoadState})`);
    pending[1]!(jsonResponse({ entries: Array.from({ length: 20 }, (_, i) => ({ id: 5000 + i, ts: 5000 + i, role: "user", threadKey: "dashboard:next", text: "새 탭 " + i })), activities: [] }));
    await nextThread;
    const newer = dom.run("loadOlderHistory()") as Promise<void>;
    pending[0]!(jsonResponse({ entries: Array.from({ length: 20 }, (_, i) => hidden(500 + i)), activities: [] }));
    await dom.clock.flush();
    const afterStale = dom.run(`({ts:oldestLoadedTs,id:oldestLoadedId,loading:loadingOlder,paused:historyOlderPaused,disabled:olderHistoryButton.disabled,rows:localChatCount})`);
    void dom.run("loadOlderHistory()");
    out.push(assert("탭 전환은 paused UI 초기화; 이전 재개 응답/finally가 새 탭 커서·loading 소유권을 건드리지 않음", freshState.paused === false && freshState.button === "none" && freshState.loading === "loading" && calls.length === 6 && pending.length === 3 && afterStale.ts === 5000 && afterStale.id === 5000 && afterStale.loading && !afterStale.paused && afterStale.disabled && afterStale.rows === 20, { calls: [...calls], freshState, afterStale }));
    pending[2]!(jsonResponse({ entries: [{ id: 4000, ts: 4000, role: "user", threadKey: "dashboard:next", text: "새 탭 이전" }], activities: [] }));
    await newer;
    const rows = dom.run(`vtItems.filter(i=>i.node.classList.contains('channel-chat')).map(i=>Number(i.node.dataset.ts))`) as number[];
    out.push(assert("새 탭 자기 배치만 ASC로 추가·가드 해제, 옛 hidden 원문 없음", rows.length === 21 && rows[0] === 4000 && rows.slice(1).every((ts, i) => ts === 5000 + i) && dom.run("!loadingOlder && reachedOldest && !historyOlderPaused") && dom.clock.errors.length === 0, { rows, errors: dom.clock.errors }));
  });
  await probe("timers API actual source", async () => {
    const now = Date.now();
    const base = { label: "표시 이름", prompt: "PRIVATE_EXECUTION_PROMPT", destChannel: "no-send", destTarget: "PRIVATE_TARGET", lastError: "PRIVATE_ERROR", originThreadKey: T, timezone: "Asia/Seoul", cronExpr: "0 8 * * *", enabled: true, triggerType: "cron" };
    const rows: Row[] = [{ ...base, id: 1 }, { ...base, id: 2, enabled: false }, { ...base, id: 3, triggerType: "reboot" }, { ...base, id: 4, cronExpr: "bad cron", originThreadKey: null }, { ...base, id: 5, triggerType: "once", runAt: now + 600000 }];
    let body: Row = {};
    const ctx = vm.createContext({ listSchedules: () => rows, isTimer: (r: Row) => r.triggerType === "once", Cron, writeJson: (_res: unknown, status: number, result: Row) => { body = { status, ...JSON.parse(JSON.stringify(result)) }; } });
    const compiled = ts.transpileModule(timersSource + "\nthis.handle = handleTimers;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    vm.runInContext(compiled, ctx);
    await (ctx as Row).handle({ res: {} });
    const result = body.schedules as Row[];
    const by = (id: number) => result.find((r) => r.id === id);
    const keys = ["id", "label", "triggerType", "cronExpr", "timezone", "originThreadKey", "enabled", "nextRun"].sort().join(",");
    out.push(assert("API: once만 기존 timers, cron/reboot만 schedules", body.status === 200 && body.timers.length === 1 && body.timers[0].id === 5 && result.length === 4 && !by(5), body));
    out.push(assert("API: schedule 공개 필드 whitelist; prompt/target/error 누출 없음", result.every((r) => Object.keys(r).sort().join(",") === keys) && !JSON.stringify(result).includes("PRIVATE_"), result));
    out.push(assert("API: 활성 cron만 실제 Cron 미래 nextRun, 꺼짐/reboot/잘못된 cron null", typeof by(1)?.nextRun === "number" && by(1)!.nextRun > now && by(2)?.nextRun === null && by(2)?.enabled === false && by(3)?.nextRun === null && by(4)?.nextRun === null, result));
    out.push(assert("API: null origin을 발송대상으로 추정하지 않음", by(1)?.originThreadKey === T && by(4)?.originThreadKey === null, result));
    rows[0]!.originThreadKey = "dashboard:moved";
    await (ctx as Row).handle({ res: {} });
    out.push(assert("API: 다음 GET이 origin 이동 반영, 예약 입력 소비/변경 없음", body.schedules.find((r: Row) => r.id === 1)?.originThreadKey === "dashboard:moved" && rows.length === 5 && rows[1]!.enabled === false && rows[4]!.runAt === now + 600000, body));
  });
  return out;
};

export const check: RegressionCheck = {
  name: "trigger-report-record-only-ui",
  guards: "내부 recordOnly만 숨김/worker 상태·턴 경계 보존/history 총3회 예산·명시 재개·탭 소유권/API safe schedule metadata",
  run: () => runIndependent(),
};
