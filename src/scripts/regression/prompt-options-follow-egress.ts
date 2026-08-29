/**
 * 회귀: **턴 중간의 질문(선택지)도 답과 같은 채널로 간다.**
 *
 * 사고 (2026-08-12, 사용자): 대시보드에서 시킨 작업 도중 비서가 선택지를 띄웠는데
 *  텔레그램으로 **안 왔다.** 답변 텍스트는 egress fan-out 을 타는데(2026-08-10 에 이미
 *  같은 부류로 한 번 고친 길), 선택지만 **인입 채널 클로저 하나**로 렌더돼서
 *  `http-bridge` 의 SSE 이벤트 = 대시보드 화면에서만 보였다.
 *  자리를 비웠을 때가 질문이 가장 필요한 순간인데 정확히 그때 안 갔다.
 *
 * 지키는 것 —
 *  ① egress 가 없으면 인입 클로저 **그대로**(래핑 0 = 회귀 0)
 *  ② 버튼을 그릴 수 있는 채널(`presentOptionsTo`)엔 버튼으로, 좌표까지 실려서
 *  ③ 못 그리는 채널엔 **텍스트(질문+번호 목록)** 로 — 아예 안 가는 것보단 낫다
 *  ④ 인입이 없어도(스케줄·매니저 완료 같은 서버 생성 턴) egress 만으로 물을 수 있다
 *  ⑤ 일부 실패해도 한 곳이라도 갔으면 ok(도구가 중복 렌더 안 하게) · 전부 실패면 ok:false
 *  ⑥ ★index.ts 가 실제로 그 클로저를 route 입력에 싣는다(배선 린트 — 안 실으면 위 전부 죽은 코드)
 *  ⑦ ★telegram 이 ctx 없이 **좌표만으로** 버튼을 그린다(이게 없으면 텔레그램은 늘 텍스트 폴백)
 */
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const OPTIONS = [
  { label: "예, 진행", value: "yes" },
  { label: "아니오", value: "no" },
];

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const { withEgressPromptOptions, formatPromptOptionsText } = await import(
    "../../core/prompt-options-egress.js"
  );
  const noDeliver = {
    deliverText: async (): Promise<void> => {
      throw new Error("텍스트 폴백이 불려선 안 되는 경로");
    },
    originThreadKey: "asking-session",
  };

  // ── ① egress 없음 = 인입 클로저 그대로 ────────────────────────────────────
  {
    const inbound = async (): Promise<{ ok: true }> => ({ ok: true });
    const wrapped = withEgressPromptOptions(inbound, [], noDeliver);
    out.push({
      name: "egress 가 없으면 인입 클로저를 그대로 쓴다(래핑 0)",
      ok: wrapped === inbound,
      got: wrapped === inbound ? "동일 참조" : "★감쌌다(불필요한 경로 신설)",
    });
  }

  // ── ②③ 버튼 채널엔 버튼(좌표 포함), 못 그리는 채널엔 텍스트 ───────────────
  {
    const seen: string[] = [];
    let buttonTarget: string | null = "(미호출)";
    let buttonSession: string | undefined;
    let inboundSawSession = false;
    let inboundCalls = 0;
    let fallbackText = "";
    const wrapped = withEgressPromptOptions(
      async (_q, _o, opts) => {
        inboundCalls++;
        inboundSawSession =
          (opts as { replyToSession?: string } | undefined)?.replyToSession !== undefined;
        return { ok: true };
      },
      [
        {
          channel: "telegram",
          target: "12345",
          outbound: {
            presentOptionsTo: async (target, _q, _o, opts) => {
              seen.push("telegram:buttons");
              buttonTarget = target;
              buttonSession = opts?.replyToSession;
              return { ok: true };
            },
          },
        },
        { channel: "slack-ish", target: "C1", outbound: {} },
      ],
      {
        deliverText: async (t, text) => {
          seen.push(`${t.channel}:text`);
          fallbackText = text;
        },
        originThreadKey: "asking-session",
      },
    );
    const r = await wrapped!("계속할까요?", OPTIONS, { note: "되돌릴 수 있어요" });
    out.push({
      name: "★버튼 채널엔 버튼으로, 해석된 좌표까지 실린다",
      ok: seen.includes("telegram:buttons") && buttonTarget === "12345",
      got: `호출=${JSON.stringify(seen)} target=${String(buttonTarget)}`,
    });
    out.push({
      name: "선택지 UI 없는 채널엔 질문+번호 목록 텍스트로 간다",
      ok:
        seen.includes("slack-ish:text") &&
        fallbackText.includes("계속할까요?") &&
        fallbackText.includes("1. 예, 진행") &&
        fallbackText.includes("2. 아니오") &&
        fallbackText.includes("되돌릴 수 있어요"),
      got: JSON.stringify(fallbackText),
    });
    out.push({
      name: "★egress 렌더에 물어본 세션이 실린다(답이 일하던 세션으로 돌아오는 근거)",
      ok: buttonSession === "asking-session",
      got: `replyToSession=${String(buttonSession)} (기대 asking-session)`,
    });
    out.push({
      name: "인입 렌더엔 세션을 안 싣는다(그 채널은 이미 그 세션에서 물었다)",
      ok: !inboundSawSession,
      got: inboundSawSession ? "★실렸다(같은 값을 두 겹으로 나른다)" : "미포함",
    });
    out.push({
      name: "인입 채널 렌더는 그대로 1회(중복·누락 0)",
      ok: inboundCalls === 1 && r.ok,
      got: `인입 ${inboundCalls}회 · 결과 ok=${r.ok}`,
    });
    out.push({
      name: "텍스트 판에 값이 아니라 라벨이 보인다",
      ok: !formatPromptOptionsText("q", OPTIONS).includes("yes"),
      got: JSON.stringify(formatPromptOptionsText("q", OPTIONS)),
    });
  }

  // ── ④ 인입이 없어도 egress 만으로 물을 수 있다(스케줄·매니저 완료 턴) ────────
  {
    let asked = 0;
    const wrapped = withEgressPromptOptions(
      undefined,
      [
        {
          channel: "telegram",
          target: "1",
          outbound: {
            presentOptionsTo: async () => {
              asked++;
              return { ok: true };
            },
          },
        },
      ],
      noDeliver,
    );
    const r = wrapped === undefined ? null : await wrapped("q", OPTIONS);
    out.push({
      name: "★인입 채널이 없는 턴(스케줄·매니저)도 egress 로 물을 수 있다",
      ok: wrapped !== undefined && asked === 1 && r?.ok === true,
      got:
        wrapped === undefined
          ? "★클로저 미생성 — 어댑터가 prompt_options 를 아예 등록 안 한다"
          : `렌더 ${asked}회 · ok=${String(r?.ok)}`,
    });
  }

  // ── ⑤ 부분 성공은 ok, 전부 실패는 ok:false ────────────────────────────────
  {
    const partial = withEgressPromptOptions(
      async () => ({ ok: false, error: "SSE 미연결" }),
      [
        {
          channel: "telegram",
          target: "1",
          outbound: { presentOptionsTo: async () => ({ ok: true }) },
        },
      ],
      noDeliver,
    );
    const p = await partial!("q", OPTIONS);
    out.push({
      name: "인입이 실패해도 한 곳이라도 갔으면 ok(도구가 중복 렌더 안 함)",
      ok: p.ok,
      got: JSON.stringify(p),
    });

    const allFail = withEgressPromptOptions(
      async () => ({ ok: false, error: "SSE 미연결" }),
      [
        {
          channel: "telegram",
          target: "1",
          outbound: {
            presentOptionsTo: async () => {
              throw new Error("chat not found");
            },
          },
        },
      ],
      noDeliver,
    );
    const f = await allFail!("q", OPTIONS);
    out.push({
      name: "전부 실패면 ok:false + 이유가 채널별로 실린다(도구가 텍스트로 폴백)",
      ok:
        !f.ok &&
        f.error.includes("SSE 미연결") &&
        f.error.includes("telegram") &&
        f.error.includes("chat not found"),
      got: JSON.stringify(f),
    });
  }

  // ── ⑥ 배선 린트 — index.ts 가 그 클로저를 route 입력에 싣는다 ──────────────
  //  실제 턴을 돌리려면 LLM·채널이 필요해서 여기선 배선 존재만 본다(동의어 우회는 못 잡음).
  {
    const src = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const wraps = src.includes("withEgressPromptOptions(");
    const feeds = /presentOptions:\s*presentOptionsForTurn/.test(src);
    out.push({
      name: "★index.ts 가 턴의 presentOptions 를 egress 로 감싼다",
      ok: wraps,
      got: wraps ? "withEgressPromptOptions 사용" : "★안 감쌈(선택지는 인입 채널에만 간다)",
    });
    out.push({
      name: "★감싼 값이 route 입력에 실린다(안 실으면 죽은 코드)",
      ok: feeds,
      got: feeds ? "route 입력에 주입 확인" : "★만들기만 하고 안 씀",
    });
  }

  // ── ⑦ telegram 이 ctx 없이 좌표만으로 버튼을 그린다 ───────────────────────
  {
    const tg = await readFile(
      new URL("../../../plugins/telegram-channel/index.ts", import.meta.url),
      "utf8",
    );
    const i = tg.indexOf("presentOptionsTo:");
    const body = i < 0 ? "" : tg.slice(i, i + 900);
    out.push({
      name: "★telegram outbound 가 presentOptionsTo 를 구현한다(ctx 없이 sendMessage)",
      ok: i >= 0 && body.includes("api.sendMessage") && body.includes("renderOptions("),
      got:
        i < 0
          ? "★미구현 — 텔레그램은 늘 텍스트 폴백으로만 간다"
          : `sendMessage=${body.includes("api.sendMessage")} 공유렌더=${body.includes("renderOptions(")}`,
    });
    // ⑧ 클릭이 물어본 세션으로 돌아간다 — 값과 세션을 함께 들고 있다가 인바운드에 싣는다.
    const carries = /storePromptOption\(o\.value, opts\?\.replyToSession\)/.test(tg);
    const feedsBack =
      /resolveSessionId\("telegram", chatId, entry\?\.session\)/.test(tg) &&
      /explicitSessionId: entry\.session/.test(tg);
    out.push({
      name: "★보기와 함께 물어본 세션을 들고 있는다",
      ok: carries,
      got: carries ? "storePromptOption(value, session)" : "★값만 저장 — 세션이 유실된다",
    });
    out.push({
      name: "★클릭이 그 세션으로 흘러간다(일하던 쪽이 답을 받는다)",
      ok: feedsBack,
      got: feedsBack ? "explicitSessionId 로 전달" : "★이 대화의 기본 세션으로 샌다",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "prompt-options-follow-egress",
  guards:
    "턴 중간의 질문(선택지)이 인입 채널에만 렌더돼, 대시보드에서 시킨 작업의 질문이 텔레그램으로 안 가던 것 — 자리를 비웠을 때가 질문이 가장 필요한 순간이다",
  run,
};
