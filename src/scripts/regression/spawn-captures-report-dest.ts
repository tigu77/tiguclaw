/**
 * 회귀: **텔레그램에서 띄운 백그라운드 작업의 결과 보고가 그 대화방으로 간다** (2026-09-26).
 *
 * ★사고(회사돌쇠, 정태님 텔레그램): 15:41 «프론티어에게 아이디어를 요청했습니다» → 결과 보고가
 *  **오지 않았다** → 16:13 물으니 «이미 끝났고 바로 앞 메시지에 정리해 드렸다». 모델은 보고했고
 *  기억도 하는데 텔레그램엔 없다.
 * ★뿌리: 보고 좌표를 스폰 시점에 캡처하는 판정이 **매니저 발사부에만** 있었고 서브에이전트
 *  발사부(spawn_agent)엔 없었다. 세션 id 가 `dashboard:*` 인 대화에서 텔레그램으로 띄우면
 *  완료 때 폴백이 **세션 id 를 chatId 로** 써서 전송이 실패하고, raw 안전망도 같은 좌표라
 *  같이 실패한다.
 *
 * 지키는 것:
 *  ① 캡처한 좌표로 띄운 잡의 완료 보고가 **그 chatId** 로 나간다(실제 `onWorkerComplete`).
 *  ② 발사부 **전부**가 같은 판정(`spawnNotifyDest`)을 거친다 — 목록을 손으로 적지 않고
 *     capabilities 의 `registerJob(`·`startWorkerJob(` 호출을 소스에서 찾아 센다.
 *  ③ ★캡처가 없어도 **세션 id 를 chatId 로 쓰지 않는다**(근본) — 폴백은 `telegramTargetFor` 하나:
 *     세션이 마지막으로 받은 텔레그램 chatId, 모르면 null(→ 채널 기본 = 소유자 chat).
 *     매니저 통지·자가 업데이트 통지가 같은 판정을 쓰는지, `?? threadKey` 가 다시 안 생겼는지.
 *  ④ (2026-09-26 적대 검토 F1·F2) **매니저가 띄운 서브는 매니저의 보고 좌표를 물려받는다** — 실제
 *     매니저 러너(runWorkerJob)로 돌려, 매니저가 먼저 끝난 뒤 온 서브 보고가 어디로 가나 본다.
 *     스케줄 매니저(종전: `scheduler` 로 미배달) · DM 매니저인데 세션의 마지막 방이 그룹(종전: 그룹으로).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import {
  __resetJobsForTest,
  onWorkerComplete,
  registerJob,
  registerWorkerHandler,
  spawnNotifyDest,
} from "../../core/worker-jobs.js";
import { initStore, saveSession, setSessionChannelMeta, telegramTargetFor } from "../../store/sessions.js";
import { notifyDestFromCoords } from "../../core/self-update.js";
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import { getJob } from "../../core/worker-jobs.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const CHAT = "4242";
const SESSION = "dashboard:regr-spawn-dest";

const drive = async (withCapture: boolean, session = SESSION): Promise<string[]> => {
  __resetJobsForTest();
  const targets: string[] = [];
  registerChannelOutbound("telegram", {
    deliver: async (target) => {
      targets.push(String(target));
      return { messageIds: [targets.length] };
    },
    defaultOutboundTarget: async () => "owner-default",
  });
  registerWorkerHandler(async (msg) => {
    await msg.reply("서브 결과를 정리해 보고합니다");
  });
  const parent = { channel: "telegram", threadKey: session, ...(withCapture ? { channelAddress: CHAT } : {}) };
  const jobId = registerJob({
    kind: "agent",
    label: "프론티어",
    task: "아이디어",
    threadKey: parent.threadKey,
    channel: "telegram",
    channelUserId: parent.threadKey,
    detached: true,
    notifyDest: spawnNotifyDest(parent),
  });
  await onWorkerComplete(jobId, { result: "아이디어 셋" });
  unregisterChannelOutbound("telegram");
  return targets;
};

/** 매니저(runWorkerJob)가 서브를 띄우고 **먼저 끝난** 뒤 서브 보고가 나가는 좌표. */
// ★고아가 되는 실제 경로: 취소(cancel*)는 자손까지 끊지만 매니저 **실패**는 자식을 안 끊는다.
const orphanChild = async (mgr: { threadKey: string; channel: string; dest: { channel: "telegram"; target: string } }): Promise<{ targets: string[]; mgrInputDest: unknown }> => {
  __resetJobsForTest();
  const targets: string[] = [];
  registerChannelOutbound("telegram", {
    deliver: async (target) => { targets.push(String(target)); return { messageIds: [900 + targets.length] }; },
    defaultOutboundTarget: async () => "owner-default",
  });
  registerWorkerHandler(async (msg) => { await msg.reply("보고합니다"); });
  const mgrId = registerJob({ kind: "worker", label: "매니저", task: "서브를 띄워라", threadKey: mgr.threadKey, channel: mgr.channel as never, channelUserId: mgr.threadKey, notifyDest: mgr.dest });
  let childId = "";
  let mgrInputDest: unknown;
  runWorkerJob(getJob(mgrId) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
    mgrInputDest = input.notifyDest;
    childId = registerJob({ kind: "agent", label: "서브", task: "조사", threadKey: input.threadKey, channel: input.channel as never, channelUserId: input.threadKey, detached: true, notifyDest: spawnNotifyDest(input) });
    // 매니저가 **실패**로 끝난다(시간 초과·모델 오류) — 취소와 달리 자식은 계속 돈다 → 고아.
    throw new Error("매니저 모델 오류(검사용)");
  });
  const deadline = Date.now() + 10000;
  while (getJob(mgrId)?.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  targets.length = 0; // 매니저 자신의 보고는 뺀다 — 여기서 보는 건 고아가 된 서브의 보고다
  if (childId !== "") await onWorkerComplete(childId, { result: "서브 결과" });
  unregisterChannelOutbound("telegram");
  return { targets, mgrInputDest };
};

/** 제품 소스에 텔레그램 폴백으로 세션 id 를 쓰는 식이 남았나(주석 제외). */
const threadKeyAsChatId = (): string[] => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== "scripts" && e.name !== "node_modules") walk(dir + e.name + "/"); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const src = readFileSync(dir + e.name, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/extractTelegramChatId\([^)]*\)\s*\?\?\s*\w*[tT]hreadKey\b/.test(src)) hits.push(e.name);
    }
  };
  walk(fileURLToPath(new URL("../../", import.meta.url)));
  walk(fileURLToPath(new URL("../../../plugins/", import.meta.url)));
  return hits;
};

/** capabilities 의 잡 등록 호출마다 그 인자 객체에 spawnNotifyDest( 가 있는가. */
const spawnSites = (): { file: string; ok: boolean }[] => {
  const dir = fileURLToPath(new URL("../../core/llm-runtime/capabilities/", import.meta.url));
  const out: { file: string; ok: boolean }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(dir + f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of src.matchAll(/\b(?:registerJob|startWorkerJob)\(\{/g)) {
      // 인자 객체 끝까지(중괄호 균형)
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === "{") depth++;
        else if (src[end] === "}" && --depth === 0) break;
      }
      out.push({ file: f, ok: /notifyDest:\s*spawnNotifyDest\(/.test(src.slice(m.index!, end)) });
    }
  }
  return out;
};

export const check: RegressionCheck = {
  name: "spawn-captures-report-dest",
  guards:
    "텔레그램에서 띄운 서브에이전트의 결과 보고가 세션 id(dashboard:*)를 chatId 로 써서 전송 실패로 사라지던 것 — 보고 좌표 캡처가 매니저 발사부에만 있었다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    initEventBus();
    const captured = await drive(true);
    const uncaptured = await drive(false);
    const sites = spawnSites();
    // ③ 캡처 없는 잡 — 세션 메타가 있으면 그 chatId, 없으면 채널 기본(null → defaultOutboundTarget)
    const KNOWN = "dashboard:regr-spawn-known";
    saveSession({ channel: "http-bridge", threadKey: KNOWN, claudeSessionId: "regr", model: null, systemPromptHash: null });
    setSessionChannelMeta({ channel: "http-bridge", threadKey: KNOWN, lastChannel: "telegram", lastChannelTarget: "7777" });
    const viaMeta = await drive(false, KNOWN);
    const coordsKnown = notifyDestFromCoords("telegram", KNOWN).target;
    const coordsUnknown = notifyDestFromCoords("telegram", SESSION).target;
    const legacy = telegramTargetFor("tg:555");
    const leftovers = threadKeyAsChatId();
    // ④ 고아 서브 — 스케줄 매니저 / DM 매니저(세션의 마지막 방은 그룹)
    const sched = await orphanChild({ threadKey: "scheduler:regr-7", channel: "scheduler", dest: { channel: "telegram", target: "SCHED_CHAT" } });
    const GROUPY = "dashboard:regr-orphan-dm";
    saveSession({ channel: "http-bridge", threadKey: GROUPY, claudeSessionId: "regr", model: null, systemPromptHash: null });
    setSessionChannelMeta({ channel: "http-bridge", threadKey: GROUPY, lastChannel: "telegram", lastChannelTarget: "-100GROUP" });
    const dm = await orphanChild({ threadKey: GROUPY, channel: "telegram", dest: { channel: "telegram", target: "OWNER_DM" } });
    return [
      assert("④ 매니저 턴 입력에 잡의 보고 좌표가 실린다(이 턴의 사람 도달 좌표)", JSON.stringify(sched.mgrInputDest) === JSON.stringify({ channel: "telegram", target: "SCHED_CHAT" }), sched.mgrInputDest),
      assert("★④ 스케줄 매니저가 먼저 끝나도 서브 보고는 스케줄의 텔레그램 방으로 간다(종전: scheduler 로 미배달)", sched.targets.length > 0 && sched.targets.every((t) => t === "SCHED_CHAT"), sched.targets),
      assert("★④ DM 에서 띄운 매니저의 서브 보고는 그 DM 으로 간다 — 세션의 마지막 방(그룹)이 아니다", dm.targets.length > 0 && dm.targets.every((t) => t === "OWNER_DM"), dm.targets),
      assert("★③ 캡처가 없으면 세션이 마지막으로 받은 텔레그램 chatId 로 간다", viaMeta.length > 0 && viaMeta.every((t) => t === "7777"), viaMeta),
      assert("★③ 그것도 모르면 세션 id 가 아니라 채널 기본 좌표로 간다", uncaptured.length > 0 && uncaptured.every((t) => t === "owner-default"), uncaptured),
      assert("③ 자가 업데이트 통지도 같은 판정(메타 chatId · 모르면 null)", coordsKnown === "7777" && coordsUnknown === null, { coordsKnown, coordsUnknown }),
      assert("③ 옛 tg:<chatId> 키는 그대로 풀린다", legacy === "555", legacy),
      assert("★③ 제품 소스에 `extractTelegramChatId(..) ?? threadKey` 가 다시 생기지 않았다", leftovers.length === 0, leftovers),
      assert("★① 캡처한 좌표로 띄운 잡의 결과 보고는 그 chatId 로만 간다", captured.length > 0 && captured.every((t) => t === CHAT), captured),
      assert("★② capabilities 의 잡 등록이 둘 이상 발견된다(없으면 아래는 공짜 초록)", sites.length >= 2, sites),
      assert("★② 모든 발사부가 spawnNotifyDest 로 보고 좌표를 캡처한다", sites.every((s) => s.ok), sites),
    ];
  },
};
