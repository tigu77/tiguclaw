/**
 * 회귀: 매니저 완료 턴은 **보고만 하지 않는다** — 맡긴 임무를 같이 싣고, 덜 됐으면 이어서 끝내라고 말한다 (2026-10-02).
 *
 * 사고: 새벽 위키 루틴의 매니저가 날짜 오판으로 검증·커밋을 멈추고 done 으로 끝났다. 메인은 «중단 판단은 잘못됐다» 고
 * 정확히 짚고도 보고만 하고 끝냈다 — 완료 문구가 «사용자에게 보고하세요» 뿐이었고, 맡긴 임무가 없어 «다 했나» 를 잴
 * 재료도 없었다. 정태님: *"문제가 생겨서 멈췄으면 다시 수정하고 반영해서 임무를 완수하면 되는데 왜 그걸 안 했지"*.
 *
 * 같은 날 적대 검토가 그 변경이 키운 결함을 짚었다 — 여기서 함께 잰다:
 *  P-1 완료 턴이 실패해 보낸 **오류 안내**가 «전달됨» 으로 세져 raw 안전망이 꺼졌다(결과 소실).
 *  P-2 작업자가 끝난 **뒤** 온 사용자 지시가 완료 턴에 안 실리고 그 턴 **뒤에** 통지됐다(«커밋 마» 를 모른 채 커밋).
 *  P-5 먼저 끝난 매니저의 하위 결과가 메인으로 올 때 «맡긴 임무» 가 누구의 지시인지 안 밝혔다.
 *  P-6 맡긴 임무를 크기 제한 없이 실었다.
 *
 * 등급: `onWorkerComplete` 를 스텁 핸들러·스텁 채널로 **실제로 돌려** 메인이 받는 글과 안전망 발화를 본다.
 *  모델이 그 글로 실제로 이어 가는지는 회귀 밖이다(라이브 모델 — 커밋 메시지의 실측).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import { replyCommand } from "../../core/entry/reply-command.js";
import { __resetJobsForTest, markCancelled, markDone, onWorkerComplete, registerJob, registerWorkerHandler } from "../../core/worker-jobs.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "regr-judge";
const TASK = "회귀-임무-원문: 위키를 정리하고 검증한 뒤 커밋·푸시까지 하라";
const RESULT = "회귀-결과: 날짜 충돌로 커밋·푸시는 하지 않았다";

type Run = { prompt: string; raws: string[] };

/** 잡 하나를 끝까지 — 스텁 핸들러가 `onTurn` 대로 답한다. raws = 채널로 나간 raw 통지(안전망). */
const drive = async (opts: {
  task?: string;
  late?: string[];
  onTurn: (msg: IncomingMessage) => Promise<void>;
  threadKey?: string;
  before?: () => void;
  error?: string;
  cancel?: boolean;
}): Promise<Run> => {
  __resetJobsForTest();
  const raws: string[] = [];
  // 메인의 답장도 같은 채널로 나간다 — 안전망 통지만 센다(답장 표식은 거른다).
  registerChannelOutbound(CH, { deliver: async (_t, text) => { if (text !== "회귀-답장") raws.push(text); }, defaultOutboundTarget: async () => "regr-target" });
  let prompt = "";
  registerWorkerHandler(async (msg) => {
    prompt = msg.text;
    await opts.onTurn(msg);
  });
  opts.before?.();
  const jobId = registerJob({ label: "회귀 위키 정리", task: opts.task ?? TASK, threadKey: opts.threadKey ?? `${CH}:1`, channel: CH, channelUserId: "regr-user" });
  if (opts.cancel === true) markCancelled(jobId, "사용자 요청");
  await onWorkerComplete(jobId, opts.error !== undefined ? { error: opts.error } : { result: RESULT }, opts.late ?? []);
  return { prompt, raws };
};

export const check: RegressionCheck = {
  name: "completion-turn-judges-mission",
  guards: "매니저가 덜 끝내고 done 으로 끝나면 메인이 원인을 짚고도 보고만 하고 멈추던 것 · 그 완료 턴이 실패하면 결과가 사라지던 것 · 늦게 온 지시를 모른 채 이어 하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const ok = await drive({ onTurn: async (m) => { await m.reply("회귀-답장"); } });
    const head = ok.prompt.split("\n")[0] ?? "";
    out.push(
      assert("★완료 턴에 맡긴 임무 원문과 결과가 같이 실린다(«다 했나» 를 잴 재료)", ok.prompt.includes(TASK) && ok.prompt.includes(RESULT), ok.prompt.slice(0, 300)),
      assert("★머리말이 «보고하세요» 로 결론을 정해 두지 않는다", head.startsWith("〔백그라운드 작업 완료 알림") && !head.includes("보고하세요"), head),
      assert(
        "기본은 보고 · 덜 됐거나 멈췄으면 보고로 끝내지 말고 원인 확인 후 이어서 끝냄(길면 다시 맡기고 짧게) · 결정 필요하면 물음 · 같은 이유 반복이면 접근 변경",
        ok.prompt.includes("다 하지 못했거나 중간에 멈췄다면 보고로 끝내지 마세요") && ok.prompt.includes("멈춘 원인을 확인") &&
          ok.prompt.includes("길면 다시 맡긴 뒤") && ok.prompt.includes("결정·승인이 필요한 일") && ok.prompt.includes("같은 이유로 또 멈췄으면"),
        ok.prompt.slice(-700),
      ),
      assert("메인이 답하면 raw 안전망은 안 뜬다", ok.raws.length === 0, ok.raws),
    );

    // P-1 — 완료 턴이 실패해 오류 안내만 보냈다(진입점 catch 와 같은 길: replyCommand + turnFailed)
    const failed = await drive({ onTurn: async (m) => { await replyCommand(m, "⚠️ 회귀-오류", { turnFailed: true }); } });
    out.push(assert(
      "★완료 턴이 실패해 보낸 오류 안내는 «전달» 이 아니다 — raw 안전망이 결과를 대신 보낸다",
      failed.raws.some((t) => t.includes(RESULT)),
      failed.raws,
    ));

    // P-1 배선 — 진입점 catch 가 그 표식을 단다(데몬을 띄워야 실행되는 자리라 자리 판정)
    const entry = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../index.ts"), "utf8");
    // 완료 턴이 결과를 못 전한 채 끝나는 진입점 응답 셋 — 오류·작업 카드 중지(🛑)·훅 차단 — 이 전부 실패 표식을 단다
    const failReplies = [
      entry.match(/replyCommand\(msg, formatRegionAError\(detail\)[^;]*;/)?.[0] ?? "(오류 응답 없음)",
      entry.match(/replyCommand\(msg, "🛑 진행 중이던 작업을 중지했어요\."[^;]*;/)?.[0] ?? "(🛑 응답 없음)",
      entry.match(/replyCommand\(msg, `요청이 훅에 의해 차단되었습니다[^;]*;/)?.[0] ?? "(훅 차단 응답 없음)",
    ];
    out.push(assert("진입점의 오류·🛑 중지·훅 차단 응답이 실패 표식(turnFailed)을 단다", failReplies.every((r) => r.includes("{ turnFailed: true }")), failReplies));

    // P-2 — 작업자가 끝난 뒤 온 지시
    const late = await drive({ late: ["회귀-늦은-지시: 커밋은 하지 마"], onTurn: async (m) => { await m.reply("회귀-답장"); } });
    out.push(
      assert("★늦게 온 지시가 완료 턴에 실린다(«먼저 따르라») · 메인이 답하면 «반영 안 됨» 통지는 따로 안 간다", late.prompt.includes("회귀-늦은-지시") && late.prompt.includes("먼저 따르세요") && late.raws.length === 0, { raws: late.raws, tail: late.prompt.slice(-200) }),
    );
    const lateSilent = await drive({ late: ["회귀-늦은-지시2"], onTurn: async () => {} });
    out.push(assert("완료 턴이 침묵하면 raw 안전망이 결과와 함께 늦은 지시도 «반영 안 됨» 으로 **한 번** 알린다", lateSilent.raws.length === 1 && lateSilent.raws[0]!.includes(RESULT) && lateSilent.raws[0]!.includes("회귀-늦은-지시2"), lateSilent.raws));
    // 메인 완료 턴으로 안 가는 길(실패 직행) — 늦은 지시는 여기서 따로 통지된다(종전엔 레지스트리 두 곳이 각자 했다)
    const lateFailed = await drive({ error: "회귀-오류", late: ["회귀-늦은-지시3"], onTurn: async (m) => { await m.reply("회귀-답장"); } });
    out.push(assert("★실패로 끝나 메인 턴이 안 열리면 늦은 지시를 «반영 안 됨» 으로 따로 알린다(빠뜨리지도 겹치지도 않게)", lateFailed.raws.filter((t) => t.includes("회귀-늦은-지시3")).length === 1 && lateFailed.prompt === "", lateFailed.raws));

    // P-5 — 먼저 끝난 매니저의 하위 작업 결과가 메인으로 환원
    let parentId = "";
    const child = await drive({
      before: () => {
        parentId = registerJob({ label: "회귀-부모-매니저", task: "상위 임무", threadKey: `${CH}:1`, channel: CH, channelUserId: "regr-user" });
        markDone(parentId, "부모 보고");
      },
      get threadKey() { return `worker:${parentId}`; },
      onTurn: async (m) => { await m.reply("회귀-답장"); },
    });
    out.push(assert("★먼저 끝난 매니저의 하위 결과면 «누가 맡긴 하위 작업인지» 밝힌다", child.prompt.includes("매니저 '회귀-부모-매니저' 가 맡긴 하위 작업"), child.prompt.slice(0, 300)));

    // P-6 — 맡긴 임무는 앞·끝을 남기고 바운드
    const longTask = `머리-${"가".repeat(9_000)}-꼬리-커밋·푸시`;
    const big = await drive({ task: longTask, onTurn: async (m) => { await m.reply("회귀-답장"); } });
    out.push(assert("긴 임무는 앞(목표)·끝(후처리)을 남기고 가운데를 접는다", big.prompt.includes("머리-") && big.prompt.includes("-꼬리-커밋·푸시") && big.prompt.includes("자 생략") && big.prompt.length < longTask.length, big.prompt.length));
    const edge = await drive({ task: "가".repeat(4_000), onTurn: async (m) => { await m.reply("회귀-답장"); } });
    out.push(assert("정확히 4,000자 임무는 접지 않는다(경계)", edge.prompt.includes("가".repeat(4_000)) && !edge.prompt.includes("자 생략"), edge.prompt.length));
    // 취소로 끝났는데 늦은 지시가 왔다 — 취소 턴에도 실리고, «새로 시작하지 마라» 가 그 지시와 부딪치지 않는다
    const cancelLate = await drive({ cancel: true, error: "aborted", late: ["회귀-늦은-지시4: 대신 B 를 해 줘"], onTurn: async (m) => { await m.reply("회귀-답장"); } });
    out.push(assert(
      "취소 완료 턴에도 늦은 지시가 실리고, «새로 시작 금지» 는 그 지시가 원하는 경우를 열어 둔다",
      cancelLate.prompt.includes("회귀-늦은-지시4") && cancelLate.prompt.includes("아래 지시가 원하는 게 아니면 새로 시작하지 마세요") && cancelLate.raws.length === 0,
      { tail: cancelLate.prompt.slice(-260), raws: cancelLate.raws },
    ));
    return out;
  },
};
