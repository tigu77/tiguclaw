/**
 * 회귀: 워커 **취소**가 메인 비서에게 닿는다 (2026-08-15).
 *
 * 사고(사용자 지적): `cancel_worker` 로 백그라운드 작업을 껐는데 **메인 비서는 그 사실을
 * 모른다**. 이후 턴에서 "그 작업 진행 중" 이라 말하거나 그 결과를 전제로 얘기를 잇는다.
 * `onWorkerComplete` 가 `failed` 와 `cancelled` 를 한 분기로 묶어 LLM 무경유 raw 통지로
 * 직행한 뒤 `return` 했기 때문이다.
 *
 * ★그 분기 자체는 정당했다 — 결정적인 것은 **모델 풀 소진**(codex 429 + claude idle,
 *  2026-06-22 실측)이다: 같은 죽은 풀로 재주입 turn 을 돌리면 **통지마저 침묵**한다.
 *  실패엔 맞는 말이다. 그런데 취소엔 그 전제가 안 걸린다 — 사용자가 **방금 스스로 한
 *  행동**이고 그 순간 대화가 살아 있다. 즉 둘을 묶은 것이 **과잉 일반화**였다.
 *
 * ★**이 파일은 한 번 갈아엎었다** (같은 날, 적대 검토 F1·F4·F5·F6·F7). 처음 판은 5단언이
 *  전부 소스 정규식이었고 그중 셋은 **주석까지 포함한 원문**을 읽었다. 그래서:
 *    · 안전망 조건 `if (!delivered)` 를 **반전**해도 초록
 *    · 취소 분기 **앞에서 return** 해 도달을 막아도 초록(문장은 그대로 있으니까)
 *    · 취소 프롬프트 분기를 `&& false` 로 죽여도 초록(리터럴은 파일에 남으니까)
 *    · 취소 raw 문구를 **주석으로만** 남겨도 초록
 *    · 재주입 `await` 를 떼어 이중 발화를 만들어도 초록
 *  다섯 변이가 1,031건을 통과했다. **"있다" 와 "닿는다" 는 다르다** — 그래서 지금은
 *  스텁 핸들러·스텁 채널을 꽂고 `onWorkerComplete` 를 **실제로 돌려** 넷을 본다:
 *    ⓐ 재주입이 핸들러에 도달했나 ⓑ 그 텍스트가 취소로 말하나
 *    ⓒ 핸들러가 답하면 raw 안전망은 **0회** ⓓ 핸들러가 침묵하면 **정확히 1회**
 */
import { initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import {
  __resetJobsForTest,
  markCancelled,
  onWorkerComplete,
  registerJob,
  registerWorkerHandler,
} from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

// 실채널과 겹치지 않는 이름 — 레지스트리는 전역이라 실이름을 쓰면 다른 검사에 샌다.
const CH = "regr-cancel";

// 재주입 턴의 **답장**도 같은 채널로 나간다 — raw 안전망과 섞이지 않게 표식을 둔다.
// (이걸 안 가르면 "답했는데 안전망이 떴다" 는 거짓 빨간불이 난다 — 첫 실행에서 겪었다.)
const REPLY_MARK = "회귀-재주입-답장";

type Outcome = { handlerCalled: boolean; prompt: string; raws: string[] };

/** 잡 하나를 끝까지 돌린다 — 마킹 → onWorkerComplete → (재주입|raw). */
const drive = async (opts: {
  end: "cancelled" | "failed" | "done";
  handlerReplies: boolean;
}): Promise<Outcome> => {
  __resetJobsForTest();
  const raws: string[] = [];
  registerChannelOutbound(CH, {
    deliver: async (_target, text) => {
      if (text !== REPLY_MARK) raws.push(text); // 안전망 통지만 센다.
    },
    defaultOutboundTarget: async () => "regr-target",
  });

  let handlerCalled = false;
  let prompt = "";
  registerWorkerHandler(async (msg) => {
    handlerCalled = true;
    prompt = msg.text;
    if (opts.handlerReplies) await msg.reply(REPLY_MARK);
  });

  const jobId = registerJob({
    label: "회귀용 잡",
    task: "아무 일",
    threadKey: `${CH}:1`,
    channel: CH,
    channelUserId: "regr-user",
  });
  if (opts.end === "cancelled") markCancelled(jobId, "사용자 요청");
  await onWorkerComplete(
    jobId,
    opts.end === "done" ? { result: "결과물" } : { error: "aborted" },
  );
  return { handlerCalled, prompt, raws };
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  initEventBus();

  // ── ⓐⓑⓒ 취소 + 재주입 턴이 답한다 = 정상 경로 ──────────────────────────────
  const spoke = await drive({ end: "cancelled", handlerReplies: true });
  out.push(
    assert(
      "★취소가 메인 핸들러에 재주입된다(raw 직행이 아니다)",
      spoke.handlerCalled,
      spoke.handlerCalled ? "핸들러 도달" : "★메인이 취소를 모른다 — 재주입 미도달",
    ),
  );
  out.push(
    assert(
      "★재주입 텍스트가 '실패가 아니다' 라고 말한다",
      spoke.prompt.includes("실패가 아닙니다"),
      spoke.prompt.slice(0, 90).replace(/\n/g, " "),
    ),
  );
  out.push(
    assert(
      "★되돌리기·재시작을 시키지 않는다(취소는 '그만해라' 지 '원복해라' 가 아니다)",
      spoke.prompt.includes("되돌리거나 새로 시작하지 마세요"),
      spoke.prompt.includes("되돌리거나") ? "금지 문구 확인" : "★금지 문구 없음",
    ),
  );
  out.push(
    assert(
      "★재주입이 답했으면 raw 안전망은 안 뜬다(이중 발화 0)",
      spoke.raws.length === 0,
      spoke.raws.length === 0 ? "raw 0회" : `★raw ${spoke.raws.length}회 — 사용자가 두 번 듣는다`,
    ),
  );

  // ── ⓓ 취소 + 재주입 턴이 침묵한다(모델 풀 소진) = 안전망이 일한다 ────────────
  //  이 경우가 원래 분기가 지키던 것이다. 통지 미도착 0 은 협상 대상이 아니다.
  const silent = await drive({ end: "cancelled", handlerReplies: false });
  out.push(
    assert(
      "★재주입이 침묵하면 raw 안전망이 정확히 1회 뜬다(통지 미도착 0)",
      silent.raws.length === 1,
      `raw ${silent.raws.length}회`,
    ),
  );
  out.push(
    assert(
      "취소 raw 통지는 '요청대로 취소' 로 말한다(실패로 읽히지 않는다)",
      /🛑/.test(silent.raws[0] ?? "") && /요청대로 취소했어요/.test(silent.raws[0] ?? ""),
      (silent.raws[0] ?? "(없음)").slice(0, 80),
    ),
  );

  // ── ⓔ 실패는 종전대로 raw 직행 — 이번 변경이 실패 경로를 건드리지 않았다 ────
  const failed = await drive({ end: "failed", handlerReplies: true });
  out.push(
    assert(
      "★실패는 여전히 LLM 무경유 직행이다(죽은 풀로 재주입하지 않는다)",
      !failed.handlerCalled && failed.raws.length === 1,
      `핸들러 도달=${failed.handlerCalled} raw=${failed.raws.length}회`,
    ),
  );

  // ── ⓕ 성공도 같은 안전망을 탄다 — 취소를 여기 붙인 근거가 이것이다 ──────────
  const done = await drive({ end: "done", handlerReplies: true });
  out.push(
    assert(
      "성공 재주입이 답하면 raw 안전망은 안 뜬다",
      done.handlerCalled && done.raws.length === 0,
      `핸들러 도달=${done.handlerCalled} raw=${done.raws.length}회`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "cancel-reaches-main",
  guards:
    "사용자가 백그라운드 작업을 취소했는데 메인 비서가 몰라 '진행 중' 이라 말하던 것 — failed 와 한 분기로 묶여 LLM 무경유로 직행했다. ★소스 정규식판이 변이 5건을 통과해 행동 검사로 갈아엎었다",
  run,
};
