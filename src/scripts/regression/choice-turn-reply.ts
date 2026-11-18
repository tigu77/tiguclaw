/**
 * 회귀: **선택지 턴의 빈 답·앞 설명 유실·저장 건너뛰기** (2026-11-17,
 * [검토·구현 정본](../../../docs/decisions/2026-11-17-empty-reply-after-suggestion/REPORT.md) §7·§12).
 *
 * 사고(회사돌쇠 인계, 운영 원문 미확보): 선택지를 띄운 뒤 다음 메시지 제안 태그만 남긴 턴이 ①빈 채널 답·빈 송신 이벤트·«[세션라벨]» 만 있는
 *  텔레그램 사본으로 나갔고(A), ②선택지 앞에 쓴 설명이 최종 답·대화 기록·사본에서 빠졌으며(B), ③정제 후 빈 글이라 저장 단계를 통째로
 *  건너뛰어 Codex/OpenAI 는 그 턴의 사용자 질문·도구 기록이, Claude 는 새 세션 id 가 남지 않았다(C).
 * 이 검사가 지키는 것(세 어댑터, 모델 경계만 가짜 — 자식 `_choice-turn-reply-child.ts`):
 *  - 선택지 + 태그만 / 완전 무본문: 채널 답·송신 이벤트·사본·`chat_log` 0 · `turn_done`·제안·선택지 카드 유지 · Codex 추가 모델 호출 0 ·
 *    **태그 유무와 무관하게** 사용자 질문·도구 기록·세션 연결 저장 → 다음 턴이 잇는다(Claude resume · Codex 이력 · OpenAI 이력)
 *  - 설명 → 선택지 → 태그만: 설명이 최종 답(채널·기록·사본 1, 사본이 원본 행을 찾음), Codex 이력에 설명 중복 0
 *  - 정정·철회·대체(supersedes)·해설: 낡은 글 재노출 0 · 같은 message.id 다중 블록은 온전히 · steering 앞 턴 설명 유지
 *  - 현 정책 유지: «선택지 뒤 짧은 본문» 은 짧은 본문만 · «예고 → 작업 → 태그만» 은 Codex 재촉 경로 / Claude·OpenAI 송신 0
 *  - 예외 유지: 내부 호출 저장·`turn_done` 0 · 첨부만 응답은 첨부 1·빈 글 송신 0
 *  - 발송 판정은 실제 나갈 글(`replyText`): 훅 글만 있어도 보낸다 · 전송 실패는 그대로 던진다
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import { internalTextHelpersSource } from "./_mini-dom.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const EXPLAIN = "커맨드 초안입니다.\n- 이름: build\n- 실행문: npm run build";
const REPO = path.resolve(HERE, "../../..");

/** 대시보드 이력 병합(`history-render.js` 의 `groupMergedItems`)을 그대로 돌린다 — 새로고침 뒤 그려질 단위(텍스트 버블·메시지·도구 카드). */
const historyUnits = (() => {
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/history-render.js"), "utf8");
  const gm = /const groupMergedItems = \([\s\S]*?\n {6}\};/.exec(src);
  const cb = /const canonicalBodyFor = \([\s\S]*?\n {6}\};/.exec(src);
  if (gm === null || cb === null) return undefined;
  const ctx: R = {};
  vm.createContext(ctx);
  vm.runInContext(`const renderedMsgKeys = new Set(); const msgKey = (ts, role) => ts + "|" + role;
    ${internalTextHelpersSource()} ${cb[0]} ${gm[0]} this.group = groupMergedItems;`, ctx);
  return (h: R): R[] => ctx.group(h.entries, h.activities) as R[];
})();
/** 그려질 비서 글 — 텍스트 세그먼트 버블 + 일반 비서 메시지(선택지 등 kind 행 제외). */
const assistantBubbles = (units: R[]): string[] =>
  units.flatMap((u) => (u.kind === "text" ? [String(u.act?.text ?? "")] : u.kind === "msg" && u.entry?.role === "assistant" && !u.entry?.kind ? [String(u.entry?.text ?? "")] : []));

export const check: RegressionCheck = {
  name: "choice-turn-reply",
  guards:
    "선택지 뒤 제안 태그만 남은 턴이 빈 답·라벨만 있는 텔레그램 사본으로 나가고, 선택지 앞 설명이 기록에서 빠지고, 그 턴의 질문·도구 기록·세션 연결이 저장되지 않던 것(2026-11-17 회사돌쇠 인계)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);

    // ── 공통 발송(어댑터 무관) — 실제 `deliverTurnReply` ─────────────────────────
    const { deliverTurnReply } = await import("../../core/entry/reply-command.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const { needsClosingReport } = await import("../../core/llm-runtime/adapters/_turn-completion.js");
    const { withInlineSuggestion } = await import("../../core/next-message-suggestion.js");
    const bus = getEventBus();
    const deliver = async (outText: string, replyText: string, failReply = false): Promise<R> => {
      const tk = `regr:choice-deliver:${Math.random()}`;
      const r: R = { replies: [] as string[], outs: [] as string[], copies: 0, suggest: 0 };
      const off = bus.subscribe((ev) => {
        const p = ev.payload as { threadKey?: string; text?: string } | undefined;
        if (ev.type === "channel.message.out" && p?.threadKey === tk) r.outs.push(p.text ?? "");
      });
      try {
        await deliverTurnReply({
          msg: { channel: "cli", threadKey: tk, reply: async (t: string) => { if (failReply) throw new Error("회귀: 전송 실패"); r.replies.push(t); } },
          out: { text: outText } as never,
          replyText,
          bus,
          turnMarkable: () => true,
          fanOut: async () => { r.copies += 1; },
          suggest: () => { r.suggest += 1; },
        });
      } catch (e) {
        r.err = e instanceof Error ? e.message : String(e);
      } finally {
        (off as (() => void) | undefined)?.();
      }
      return r;
    };
    const dEmpty = await deliver("", "");
    const dBlank = await deliver("", " \n\t");
    const dHook = await deliver("", "\n\n훅이 덧붙인 안내");
    const dFail = await deliver("본문", "본문", true);
    out.push(assert(
      "★A 보낼 글(`replyText`)이 비거나 공백뿐이면 채널 답·송신 이벤트·사본 0 · 제안은 유지(1)",
      dEmpty.replies.length === 0 && dEmpty.outs.length === 0 && dEmpty.copies === 0 && dEmpty.suggest === 1 &&
        dBlank.replies.length === 0 && dBlank.outs.length === 0 && dBlank.copies === 0 && dBlank.suggest === 1,
      show({ dEmpty, dBlank }),
    ));
    out.push(assert(
      "★A 판정은 `out.text` 가 아니라 실제로 나갈 글 — 본문이 비어도 Stop 훅 글이 있으면 채널 답·송신 이벤트·사본 1",
      dHook.replies.length === 1 && dHook.replies[0].includes("훅이 덧붙인 안내") && dHook.outs.length === 1 && dHook.copies === 1 && dHook.suggest === 1,
      show(dHook),
    ));
    out.push(assert(
      "A 전송 실패는 생략으로 바꾸지 않고 그대로 던진다(제안·사본 0)",
      dFail.err === "회귀: 전송 실패" && dFail.copies === 0 && dFail.suggest === 0,
      show(dFail),
    ));
    const closing = {
      optionsOnly: needsClosingReport({ text: "", finalText: "", toolCallsSinceText: 1, toolNamesSinceText: ["prompt_options"] }),
      withWork: needsClosingReport({ text: "", finalText: "", toolCallsSinceText: 2, toolNamesSinceText: ["find_skills", "prompt_options"] }),
      noTools: needsClosingReport({ text: "", finalText: "", toolCallsSinceText: 0, toolNamesSinceText: [] }),
    };
    out.push(assert(
      "Codex 마무리 판정: 보일 글 없이 선택지만 돌았으면 정상 종료(재촉 0) · 작업 도구가 섞이면 재촉 · 무도구 무글은 재촉",
      closing.optionsOnly === false && closing.withWork === true && closing.noTools === true,
      show(closing),
    ));
    out.push(assert(
      "기록 모양: 본문이 빈 턴의 제안은 태그만(앞 빈 줄 없음)",
      withInlineSuggestion("", "좋아") === "<next-message>좋아</next-message>" && withInlineSuggestion("본문", "좋아") === "본문\n\n<next-message>좋아</next-message>",
      withInlineSuggestion("", "좋아"),
    ));

    // ── 매니저 완료 재주입 — 선택지만 띄우고 본문 없이 끝난 정상 턴에 raw 안전망이 또 나가지 않는다(실제 `onWorkerComplete`) ──
    {
      const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
      const { __resetJobsForTest, onWorkerComplete, registerJob, registerWorkerHandler } = await import("../../core/worker-jobs.js");
      const CH = "regr-choice-complete";
      const drive = async (mode: "optionsOnly" | "optionsFail" | "silent"): Promise<R> => {
        __resetJobsForTest();
        const raws: string[] = [];
        let cards = 0;
        registerChannelOutbound(CH, {
          deliver: async (_t: unknown, text: string) => { raws.push(text); },
          defaultOutboundTarget: async () => "regr-target",
          presentOptionsTo: async () => { cards += 1; return mode === "optionsFail" ? { ok: false, error: "회귀: 렌더 실패" } : { ok: true }; },
        } as never);
        registerWorkerHandler(async (msg) => {
          if (mode !== "silent") await msg.presentOptions?.("결과를 반영할까요?", [{ label: "예", value: "예" }, { label: "아니요", value: "아니요" }]);
          // 진입점의 마지막 단계와 같은 함수 — 본문이 비었으니 채널 답을 내지 않는다.
          await deliverTurnReply({ msg: msg as never, out: { text: "" } as never, replyText: "", bus, turnMarkable: () => true, fanOut: async () => {}, suggest: () => {} });
        });
        const jobId = registerJob({ label: "회귀 선택지 잡", task: "일", threadKey: `${CH}:1`, channel: CH, channelUserId: "regr-user" });
        await onWorkerComplete(jobId, { result: "결과물" });
        return { raws: raws.length, cards };
      };
      const ok = await drive("optionsOnly");
      const fail = await drive("optionsFail");
      const silent = await drive("silent");
      out.push(assert(
        "★매니저 완료 재주입: 선택지 카드가 뜬 무본문 정상 턴엔 raw 안전망 0 · 카드 렌더 실패나 아무것도 안 낸 턴엔 안전망 1(일괄 제거 아님)",
        ok.cards === 1 && ok.raws === 0 && fail.cards === 1 && fail.raws === 1 && silent.cards === 0 && silent.raws === 1,
        show({ ok, fail, silent }),
      ));
    }

    // ── 세 어댑터 실제 경로 ────────────────────────────────────────────────
    for (const adapter of ["claude", "codex", "openai"] as const) {
      const child = await spawnWithin(180_000, `choice-turn-${adapter}`, ["--import", "tsx", path.join(HERE, "_choice-turn-reply-child.ts"), adapter], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" },
      });
      const line = child.out.trim().split("\n").filter((l) => l.startsWith('{"rows"')).pop();
      if (line === undefined) {
        out.push(assert(`자식(${adapter})이 결과를 낸다`, false, child.timedOut ? "timeout" : child.err.slice(-800)));
        continue;
      }
      const d = JSON.parse(line) as { rows: R[]; next: R; steer?: R };
      const row = (n: string): R => d.rows.find((r) => r.scene === n) ?? { missing: n };
      const noSend = (r: R): boolean => r.err === undefined && r.replies?.length === 0 && r.outEvents?.length === 0 && r.copies?.length === 0 && r.chatLog?.length === 0;
      // 턴 종료·제안·카드 + **사용량**(본문이 비어도 `turn_done` 에 입력·출력 토큰이 남는다 — 독립 사냥 M14).
      const kept = (r: R): boolean => r.turnDone === 1 && r.suggestCalls === 1 && r.renders === 1 &&
        r.turnUsage?.length === 1 && r.turnUsage[0].input > 0 && r.turnUsage[0].output > 0;
      const saved = (r: R, q: string): boolean =>
        typeof r.threadSid === "string" && r.threadSid !== "" &&
        (adapter === "claude"
          ? r.jsonlIndexed >= 1
          : r.transcripts.some((t: R) => t.role === "user" && t.content === q) && r.transcripts.some((t: R) => t.role === "assistant") &&
            r.items.includes("call:prompt_options"));
      const tag = row("optTag"), empty = row("optEmpty");
      out.push(assert(
        `★[${adapter}] 선택지 + 제안 태그만: 송신 0(채널·이벤트·사본·chat_log) · turn_done·제안·카드 유지 · 질문·도구·세션 저장${adapter === "codex" ? " · 추가 모델 호출 0" : ""}`,
        noSend(tag) && kept(tag) && tag.suggestion === "둘 다 만들어줘" && tag.choiceEnd === true && saved(tag, "질문-optTag") &&
          (adapter !== "codex" || tag.modelCalls === 2),
        show(tag),
      ));
      out.push(assert(
        `★[${adapter}] 선택지 + 완전 무본문: 태그 있을 때와 같은 저장(질문·도구·세션) · 송신 0 · 정상 종료${adapter === "codex" ? " · 추가 모델 호출 0(빈 응답 처리 안 감)" : ""}`,
        noSend(empty) && kept(empty) && empty.suggestion === null && empty.choiceEnd === true && saved(empty, "질문-optEmpty") &&
          (adapter !== "codex" || empty.modelCalls === 2),
        show(empty),
      ));
      const ex = row("explainOpt");
      out.push(assert(
        `★[${adapter}] 설명 → 선택지 → 태그만: 설명이 최종 답 — 채널·송신·사본·chat_log 각 1, 사본이 원본 행을 찾음 · 제안 분리${adapter === "codex" ? " · 이력 항목에 설명 중복 0" : ""}`,
        ex.outText === EXPLAIN && ex.replies.length === 1 && ex.replies[0] === EXPLAIN && ex.outEvents.length === 1 && ex.copies.length === 1 &&
          ex.chatLog.length === 1 && ex.chatLog[0] === EXPLAIN && ex.copyOriginalRows[0] === EXPLAIN && ex.suggestion === "이대로 만들어줘" &&
          (adapter !== "codex" || !ex.items.some((i: string) => i.startsWith("msg:커맨드 초안"))),
        show(ex),
      ));
      if (historyUnits === undefined) out.push(assert("대시보드 이력 병합 함수를 찾는다(history-render.js)", false, `groupMergedItems/canonicalBodyFor 추출 실패: ${String(historyUnits)}`));
      else {
        const exB = assistantBubbles(historyUnits(ex.history));
        const tagB = assistantBubbles(historyUnits(tag.history));
        const emptyB = assistantBubbles(historyUnits(empty.history));
        out.push(assert(
          `★[${adapter}] 새로고침 이력(실제 조회 → 대시보드 병합): 설명 버블 정확히 1개(활동 조각·정본 중복 0) · 무본문 선택지 턴은 비서 글 버블 0(빈 말풍선 0)`,
          exB.filter((t) => t.includes("커맨드 초안입니다")).length === 1 && exB.every((t) => t.trim() !== "" && !t.includes("next-message")) &&
            tagB.every((t) => t.trim() !== "" && !t.includes("next-message")) && emptyB.length === 0 &&
            tagB.filter((t) => t.trim() !== "").length === 0,
          show({ exB, tagB, emptyB }),
        ));
      }
      const body = row("bodyTag"), corr = row("corrected"), short = row("shortAfter");
      out.push(assert(
        `[${adapter}] 대조 — 본문 + 제안은 그대로 1건 · 정정 뒤 답은 정정만(철회한 앞 글 재노출 0) · 선택지 뒤 짧은 본문은 짧은 본문만(현 정책)`,
        body.outText === "완료했습니다." && body.replies.length === 1 && body.chatLog.length === 1 &&
          corr.outText === "정정: B 입니다." && !corr.replies.join("").includes("먼저 A") &&
          short.outText === "골라 주세요." && short.replies.length === 1 && !short.replies[0].includes("커맨드 초안"),
        show({ body, corr, short }),
      ));
      const pw = row("promiseWork");
      out.push(assert(
        adapter === "codex"
          ? "[codex] 예고 → 작업 도구 → 태그만: 태그만은 보고가 아니다 — 기존 재촉 경로(호출 3)로 받은 글이 답"
          : `[${adapter}] 예고 → 작업 도구 → 태그만: 예고를 답으로 올리지 않는다 — 송신 0 · turn_done 1 · 제안 1(대체 문구 생성 0)`,
        adapter === "codex"
          ? pw.outText === "결과: 정상입니다." && pw.modelCalls === 3 && pw.replies.length === 1
          : noSend(pw) && pw.turnDone === 1 && pw.suggestCalls === 1 && pw.outText === "" && pw.choiceEnd === false,
        show(pw),
      ));
      const pwo = row("promiseWorkOpt");
      out.push(assert(
        adapter === "codex"
          ? "★[codex] 예고 → 작업 도구+선택지 → 태그만: 작업 도구가 섞였으니 정상 선택지 종료가 아니다 — 기존 재촉 경로(호출 3)로 받은 글이 답, 예고 재노출 0"
          : `★[${adapter}] 예고 → 작업 도구+선택지 → 태그만: 예고를 답으로 올리지 않는다(독립 사냥 M15) — 송신 0 · 정상 선택지 종료 아님`,
        adapter === "codex"
          ? pwo.outText === "결과: 정상입니다." && pwo.modelCalls === 3 && !pwo.replies.join("").includes("확인하겠습니다")
          : noSend(pwo) && pwo.outText === "" && pwo.choiceEnd === false && pwo.turnDone === 1,
        show(pwo),
      ));
      const internal = row("internalOpt");
      out.push(assert(
        `[${adapter}] 내부 호출은 선택지 턴 모양이어도 저장·turn_done 0(바깥 가드 그대로)`,
        internal.turnDone === 0 && internal.transcripts.length === 0 && internal.threadSid === null,
        show(internal),
      ));
      const n = d.next;
      out.push(assert(
        adapter === "claude"
          ? "★[claude] 새 세션에서 무본문 선택지로 끝난 턴 → 다음 턴이 그 세션을 resume"
          : `★[${adapter}] 무본문 선택지 턴 → 다음 요청 이력에 그 질문${adapter === "codex" ? "·선택지 호출" : ""}이 실리고 빈 비서 글 메시지는 없다`,
        n.err === undefined &&
          (adapter === "claude"
            ? n.resume === "sess-optEmpty"
            : n.historyHasQuestion === true && n.emptyAssistantMsgs === 0 && (adapter !== "codex" || n.historyCalls.includes("prompt_options"))),
        show(n),
      ));
      if (adapter === "claude") {
        const same = row("sameId"), sup = row("superseded"), att = row("attachOnly");
        out.push(assert(
          "★[claude] 같은 message.id 로 블록이 나뉘어 와도 설명 전체가 답 · supersedes 로 대체된 설명은 되살리지 않음(송신 0) · 첨부만 응답은 첨부 1·빈 글 송신 0",
          same.outText === "설명 앞부분, 설명 뒷부분." &&
            noSend(sup) && sup.choiceEnd === true && !String(sup.outText).includes("철회될") &&
            att.attachSent === 1 && noSend(att) && att.turnDone === 1,
          show({ same, sup, att }),
        ));
        out.push(assert(
          "★[claude] 이어 받기 — 앞 턴(설명 → 선택지 → 태그만) 확정도 같은 선택: 설명과 뒤 턴 답이 둘 다 남는다",
          typeof d.steer?.visible === "string" && d.steer.visible.includes(EXPLAIN) && d.steer.visible.includes("두 번째 답") && !d.steer.visible.includes("next-message"),
          show(d.steer),
        ));
      }
      if (adapter === "codex") {
        const cr = (d as { cross?: R }).cross ?? {};
        out.push(assert(
          "★[codex→claude·openai] 교차 재생 — Codex 가 저장한 무본문 선택지 턴을 다른 어댑터가 다음 턴에 읽어도 사용자 질문은 보이고 빈 비서 글은 0",
          cr.claude?.err === undefined && cr.claude?.hasQuestion === true && cr.claude?.emptyAssistantLines === 0 &&
            cr.openai?.err === undefined && cr.openai?.hasQuestion === true && cr.openai?.emptyAssistantMsgs === 0,
          show(cr),
        ));
        const ct = row("commentaryTag");
        out.push(assert(
          "★[codex] 같은 응답에 해설 + 태그만 최종 답 — 해설도 태그도 답이 아니다 → 앞 설명이 답(재촉 0)",
          ct.outText === EXPLAIN && !ct.replies.join("").includes("작성 메모") && ct.modelCalls === 2,
          show(ct),
        ));
      }
    }
    return out;
  },
};
