/** /model 메뉴의 상태·대상·오류·기존 채널 선택지 왕복. 부모가 격리 홈을 제공한다. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "../../channels/types.js";
import { initStore, closeStore, getDb, getSessionModelOverride, getSessionModelProfile, setSessionModelOverride, setSessionModelProfile, clearSessionModelOverride, SESSION_STORAGE_CHANNEL as C } from "../../store/sessions.js";
import { setChannelSessionBinding } from "../../store/channel-session.js";
import { handleModelMenu, renderSessionModelStatus } from "../../core/entry/model-command.js";
import { applySessionModelProfile, listSessionModelProfiles, resolveSessionModelSelection } from "../../core/session-model-selection.js";
import { assert, fakeNetwork, loadPluginModule, type Assertion } from "./_framework.js";
import { getEventBus } from "../../core/eventbus.js";

const out: Assertion[] = [];
const home = process.env.TIGUCLAW_HOME!;
const check = (name: string, ok: boolean, detail = ""): void => { out.push(assert(name, ok, detail)); };
const settings = (profiles: Record<string, unknown>) => writeFile(path.join(home, "settings.json"), JSON.stringify({ locale: "ko", models: { default: "base", profiles } }));
const profiles: Record<string, unknown> = {
  base: { pool: ["codex:gpt-base"] },
  alternate: { description: "선택", pool: [{ model: "codex:gpt-selected", reasoning: "high" }, "openai:second"], fallback: ["base"] },
};
for (let i = 0; i < 10; i++) profiles[`추가${i}`] = { pool: ["codex:gpt-extra"] };
const longName = "긴이름".repeat(80);
profiles[longName] = { pool: ["codex:gpt-long"] };
let network = 0;
globalThis.fetch = fakeNetwork((async () => { network++; throw new Error("network forbidden"); }) as typeof fetch);
const events: string[] = [];
getEventBus().subscribe((e) => events.push(e.type));
let options: Array<{ label: string; value: string }> = [];
let text = "";
const replies: string[] = [];
const msg = {
  channel: "telegram", channelUserId: "user-1", channelAddress: "chat-1", threadKey: "dashboard:model-test", text: "/model",
  reply: async (s: string) => { replies.push(s); },
  presentOptions: async (q: string, o: typeof options) => { text = q; options = o; return { ok: true }; },
} as IncomingMessage;
const run = (value: string, m = msg) => handleModelMenu(m, value.replace(/^\/model\s*/, ""));
const open = async () => { await handleModelMenu(msg, ""); return options.find((o) => o.label === "alternate")!.value; };

try {
  await settings(profiles);
  initStore();
  setChannelSessionBinding("telegram", "chat-1", "dashboard:model-test");
  setSessionModelProfile(C, msg.threadKey, "alternate");
  check("표시·router 공유: 저장 프로파일 pool·reasoning이며 fallback 프로파일 미확장", renderSessionModelStatus(msg).includes("codex:gpt-selected [high] → openai:second") && resolveSessionModelSelection(C, msg.threadKey).pool.length === 2);
  setSessionModelOverride(C, msg.threadKey, "codex:gpt-direct");
  const status = renderSessionModelStatus(msg);
  check("raw > 프로파일: 저장값과 실제 적용풀 구분", status.includes("alternate") && status.includes("직접 지정") && resolveSessionModelSelection(C, msg.threadKey).source === "raw" && resolveSessionModelSelection(C, msg.threadKey).pool[0]?.model === "gpt-direct");
  const oldPool = resolveSessionModelSelection(C, msg.threadKey).pool;
  const pick = await open();
  check("메뉴는 원래 선택을 변경하지 않는다", getSessionModelOverride(C, msg.threadKey) === "codex:gpt-direct" && text.includes(msg.threadKey) && options.length === 10);
  for (const [name, changed] of [
    ["다른 사용자", { channelUserId: "other" }], ["다른 채팅", { channelAddress: "other" }],
    ["다른 채널", { channel: "http-bridge" }], ["다른 세션", { threadKey: "dashboard:other" }],
  ] as const) {
    await run(pick, { ...msg, ...changed });
    check(`${name}은 nonce를 알아도 변경하지 않는다`, getSessionModelOverride(C, msg.threadKey) === "codex:gpt-direct" && replies.at(-1)!.includes("변경하지 않았습니다"));
  }
  setChannelSessionBinding("telegram", "chat-1", "dashboard:switched");
  await run(pick); // explicit reply session은 옛 키, 방 바인딩은 바뀌었다.
  check("옛 explicit 답글 세션이어도 방 전환을 탐지", getSessionModelOverride(C, msg.threadKey) !== null && replies.at(-1)!.includes("변경하지 않았습니다"));
  const replySessionPick = await open(); // 답글 세션 A와 방 바인딩 B가 달라도 새 메뉴는 유효.
  await run(replySessionPick);
  check("답글 대상 A·방 B가 그대로면 A만 선택, raw 원자해제", getSessionModelProfile(C, msg.threadKey) === "alternate" && getSessionModelOverride(C, msg.threadKey) === null && getSessionModelProfile(C, "dashboard:switched") === null);
  check("기존 진행 중에 캡처된 풀은 소급 변경 없음", oldPool[0]?.model === "gpt-direct");
  setSessionModelOverride(C, msg.threadKey, "codex:after");
  await run(replySessionPick);
  check("성공 후 중복 클릭은 새 raw를 지우지 않는다", getSessionModelOverride(C, msg.threadKey) === "codex:after" && replies.at(-1)!.includes("변경하지 않았습니다"));
  clearSessionModelOverride(C, msg.threadKey);
  check("기존 reset은 raw만 해제하여 세션 프로파일 보존", resolveSessionModelSelection(C, msg.threadKey).source === "profile");
  setSessionModelOverride(C, msg.threadKey, "codex:default-clears-raw");
  await open();
  await run(options[0]!.value);
  check("기본값 사용은 raw/profile 둘 다 해제", getSessionModelProfile(C, msg.threadKey) === null && getSessionModelOverride(C, msg.threadKey) === null && resolveSessionModelSelection(C, msg.threadKey).source === "default");
  const stale = await open(); await open(); await run(stale);
  check("새 메뉴 발행은 같은 대상의 옛 메뉴를 무효화", replies.at(-1)!.includes("변경하지 않았습니다"));
  const expired = await open(); const now = Date.now; Date.now = () => now() + 16 * 60_000;
  try { await run(expired); } finally { Date.now = now; }
  check("15분 초과 메뉴는 적용하지 않는다", replies.at(-1)!.includes("변경하지 않았습니다"));
  const deleted = await open(); const reduced = { ...profiles }; delete reduced.alternate; await settings(reduced); await run(deleted);
  check("발급 후 삭제된 프로파일은 상속으로 오인하지 않고 거절", getSessionModelProfile(C, msg.threadKey) === null && replies.at(-1)!.includes("변경하지 않았습니다"));
  await settings(profiles);
  setSessionModelProfile(C, msg.threadKey, "removed");
  check("삭제된 저장 프로파일은 전역 폴백으로 명시", renderSessionModelStatus(msg).includes("전역 기본을 사용합니다") && resolveSessionModelSelection(C, msg.threadKey).source === "default");
  const failPick = await open();
  setSessionModelOverride(C, msg.threadKey, "codex:preserve");
  getDb().exec("CREATE TEMP TRIGGER fail_override_delete BEFORE DELETE ON session_model_override BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await run(failPick);
  check("두번째 저장 실패는 profile 변경까지 rollback하며 성공 응답 아님", getSessionModelProfile(C, msg.threadKey) === "removed" && getSessionModelOverride(C, msg.threadKey) === "codex:preserve" && replies.at(-1)!.includes("실패"));
  getDb().exec("DROP TRIGGER fail_override_delete");
  await run(failPick);
  check("저장 실패 뒤 재시도도 원자 적용", getSessionModelProfile(C, msg.threadKey) === "alternate" && getSessionModelOverride(C, msg.threadKey) === null);
  await open(); const next = options.find((o) => o.value.startsWith("/model page"))!.value; await run(next);
  check("페이지를 넘기면 긴 이름도 짧은 선택 명령·라벨", options.some((o) => o.label.startsWith("긴이름")) && options.every((o) => o.label.length <= 60 && Buffer.byteLength(o.value) < 64));
  await run(options.find((o) => o.label.startsWith("긴이름"))!.value);
  check("긴 이름 선택은 전체 이름으로 저장", getSessionModelProfile(C, msg.threadKey) === longName);
  await handleModelMenu({ ...msg, presentOptions: async () => ({ ok: false, error: "test send failure" }) }, "");
  check("선택지 전송 실패는 텍스트 명령으로 폴백", replies.at(-1)!.includes("/model select"));
  await run("/model select broken");
  check("깨진 메뉴 명령은 raw 지정으로 통과하지 않는다", replies.at(-1)!.includes("변경하지 않았습니다"));
  check("기존 raw/reset 명령은 기존 핸들러에 넘긴다", !await handleModelMenu(msg, "codex:gpt-legacy") && !await handleModelMenu(msg, "reset"));

  // 실제 Telegram 옵션 렌더: 긴 이름을 callback_data에 싣지 않는다. 네트워크는 가짜 send로 대체.
  const tg = await loadPluginModule<{ renderOptions: (...args: unknown[]) => Promise<unknown> }>("../../../plugins/telegram-channel/index.ts");
  await open();
  let keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  await tg.renderOptions(async (_q: string, extra: { reply_markup: { inline_keyboard: typeof keyboard } }) => { keyboard = extra.reply_markup.inline_keyboard; return { message_id: 1 }; }, text, options, { replyToSession: msg.threadKey });
  check("Telegram 실제 렌더는 짧은 callback으로 기존 일반옵션 파이프라인 사용", keyboard.length === options.length && keyboard.flat().every((o) => Buffer.byteLength(o.callback_data) <= 64 && !o.callback_data.includes("alternate")));

  // 실제 대시보드 route: JSON body를 읽고 공유 선택 함수를 거쳐 응답한다.
  const routes = await loadPluginModule<{ handleGetModelProfiles: (ctx: unknown) => Promise<void>; handleSetSessionProfile: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-settings.ts");
  let response: Record<string, unknown> = {}; let code = 0;
  const ctx = (body = {}) => ({ req: Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} }), res: { writeHead: (n: number) => { code = n; }, end: (s: string) => { response = JSON.parse(s); } }, channelName: "http-bridge" });
  await routes.handleGetModelProfiles(ctx());
  check("대시보드와 같은 목록·기본 정렬", JSON.stringify((response.profiles as Array<{ name: string }>).map((p) => p.name)) === JSON.stringify(listSessionModelProfiles().profiles.map((p) => p.name)) && code === 200);
  setSessionModelOverride(C, msg.threadKey, "codex:dash-direct");
  await routes.handleSetSessionProfile(ctx({ threadKey: msg.threadKey, profile: "alternate" }));
  check("대시보드 선택도 raw 해제·프로파일 저장 공유", code === 200 && getSessionModelOverride(C, msg.threadKey) === null && getSessionModelProfile(C, msg.threadKey) === "alternate", JSON.stringify({code,response,raw:getSessionModelOverride(C,msg.threadKey),profile:getSessionModelProfile(C,msg.threadKey)}));
  setSessionModelOverride(C, msg.threadKey, "codex:keep");
  await routes.handleSetSessionProfile(ctx({ threadKey: msg.threadKey, profile: "unknown" }));
  check("대시보드 삭제/미존재 선택은 400·raw 보존", code === 400 && getSessionModelOverride(C, msg.threadKey) === "codex:keep");
  for (const alias of ["", "default", "base"]) {
    applySessionModelProfile(C, msg.threadKey, "alternate");
    await routes.handleSetSessionProfile(ctx({ threadKey: msg.threadKey, profile: alias }));
    check(`대시보드 기존 상속 alias ${alias || '(빈값)'} 보존`, code === 200 && getSessionModelProfile(C, msg.threadKey) === null, JSON.stringify({code,response,profile:getSessionModelProfile(C,msg.threadKey)}));
  }
  // 이름이 default인 비기본 프로파일도 대시보드 목록과 같게 노출한다(선택시 기존 alias 의미는 유지).
  await settings({ base: profiles.base, default: { pool: ["codex:alias"] }, alternate: profiles.alternate });
  await handleModelMenu(msg, "");
  const aliasOption = options.find((o) => o.label === "default");
  check("비기본 default 이름도 대시보드와 동일하게 목록 노출", aliasOption !== undefined);
  if (aliasOption !== undefined) {
    setSessionModelProfile(C, msg.threadKey, "alternate");
    setSessionModelOverride(C, msg.threadKey, "codex:alias-direct");
    await run(aliasOption.value);
    check("default 이름 선택도 기존 상속 alias 의미 유지", getSessionModelProfile(C, msg.threadKey) === null && getSessionModelOverride(C, msg.threadKey) === null);
  }
  check("조회·페이지·선택·확인 전체 네트워크0/LLM0", network === 0 && !events.some((e) => e.startsWith("llm.")), `network=${network} llm=${events.filter((e) => e.startsWith("llm.")).length}`);
} catch (e) {
  check("실행 중 예외 없음", false, e instanceof Error ? e.stack : String(e));
} finally {
  closeStore();
}
console.log("MODEL_MENU_RESULT=" + JSON.stringify(out));
