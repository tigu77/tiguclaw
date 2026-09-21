/**
 * 답글이 **발원 세션을 못 찾은 순간**이 로그에 남는가 (2026-09-21 정태님 신고).
 *
 * 잡는 회귀 — 안 고치면 무엇이 안 되나:
 * 텔레그램에서 «다른 세션의 답» 에 답글을 달면 그 세션으로 가야 하는데, 매핑이 없으면
 * **조용히 현재 세션으로** 떨어진다. 종전엔 **성공만** 찍어서, 로그로는
 * 「답글이 아니었다」와 「답글인데 매핑이 없었다」가 **구분되지 않았다.**
 * ★회사돌쇠·회사PC 는 원격으로 DB 를 못 본다 — 로그가 **유일한 진단면**이다
 * ([[feedback_logs_must_stand_alone]]). 그래서 이 줄이 없으면 신고를 확인할 수가 없다.
 *
 * 등급: **동작 검사** — 실제 `resolveReplyRouting`·실제 `deliverOutbound` 를 돌리고
 * **찍힌 줄을 읽는다.**
 * ★2026-09-22 개정: 종전 판은 «동작 검사» 라고 **적어놓고** 소스를 `readFile` + 정규식으로
 *  봤다. 분기를 `if (false && …)` 로 죽여도 문자열이 남아 4,335건이 초록이었다(실측).
 *  등급 표기가 거짓이었던 것이다. 판정을 모듈로 꺼내(`plugins/telegram-channel/reply-routing.ts`)
 *  이제 **부른다** — «검사가 껄끄러우면 코드가 잘못 놓인 것».
 */
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

/** console.log/warn 을 가로채 실제로 찍힌 줄을 모은다. */
const capture = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const lines: string[] = [];
  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  console.log = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return lines;
};

export const check: RegressionCheck = {
  name: "reply-routing-miss-is-logged",
  guards:
    "답글이 발원 세션을 못 찾아 조용히 현재 세션으로 떨어지던 것 — 성공만 찍혀서 로그로는 «답글이 아님» 과 구분이 안 됐다 · 보냈는데 매핑을 못 남긴 것도 무기록이던 것 · 첨부 답글은 라우팅도 로그도 없던 것",
  run: async () => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const {
      findSessionForOutboundMessage,
      recordOutboundMessage,
      countOutboundMessageMappings,
      OUTBOUND_MESSAGE_MAP_MAX_ROWS,
    } = await import("../../store/outbound-messages.js");

    // ── ① 조회가 실제로 미스를 낸다(전제) ────────────────────────────────────
    const miss = findSessionForOutboundMessage("telegram", "chat-1", 999_999);
    out.push(assert("★전제 — 없는 message_id 는 null 이다(아래는 이때의 이야기다)", miss === null, String(miss)));

    recordOutboundMessage("telegram", "chat-1", 4720, "dashboard:origin-a", Date.now());
    out.push(
      assert(
        "기록한 id 는 발원 세션으로 찾힌다(성공 경로는 그대로)",
        findSessionForOutboundMessage("telegram", "chat-1", 4720) === "dashboard:origin-a",
        String(findSessionForOutboundMessage("telegram", "chat-1", 4720)),
      ),
    );

    // ── ② **판정 수치**가 실제로 뽑힌다 — 미스 로그가 이걸 싣는다 ─────────────
    //  ★0건이면 «기록 자체가 안 되는 것» · 상한 근처면 «오래돼 잘린 것» 으로 갈린다.
    //   수치 없이 "못 찾았다"만 찍으면 다음 수가 안 나온다.
    //  ★`null` = **조회 실패**(0 과 다르다). 타입으로 갈라놨으므로 여기서도 구분해 읽는다.
    const n = countOutboundMessageMappings();
    out.push(
      assert(
        "★미스 로그가 실을 **판정 수치**가 뽑힌다(건수·상한 · 조회 실패는 null 로 구분)",
        n !== null && n >= 1 && OUTBOUND_MESSAGE_MAP_MAX_ROWS > 0,
        `${n === null ? "조회 실패(null)" : `${n}건`} / 상한 ${OUTBOUND_MESSAGE_MAP_MAX_ROWS}`,
      ),
    );

    // ── ③ ★**판정 함수를 실제로 돌린다** — 찍힌 줄을 읽는다 ────────────────────
    const { resolveReplyRouting } = await loadPluginModule<{
      resolveReplyRouting: (
        chatId: string,
        repliedMsgId: number | undefined,
        boundSession: string,
        kind: "text" | "attachment",
      ) => {
        repliedSession: string | null;
        sessionId: string;
        routedSession: string | null;
      };
    }>("../../../plugins/telegram-channel/reply-routing.ts");

    // ③-a 답장인데 매핑이 없다 → 미스 줄 + 판정 수치. 세션은 현재 세션으로 떨어진다.
    const missLines = await capture(() => {
      const r = resolveReplyRouting("chat-1", 999_999, "dashboard:default", "text");
      out.push(
        assert(
          "★매핑이 없으면 **현재 세션**으로 떨어진다(기존 동작 — 조용한 폴백 자체는 유지)",
          r.sessionId === "dashboard:default" && r.repliedSession === null && r.routedSession === null,
          JSON.stringify(r),
        ),
      );
    });
    const missLine = missLines.find((l) => l.includes("발원 세션을 못 찾았습니다"));
    out.push(
      assert(
        "★★답글인데 못 찾은 경우를 **로그로 남긴다**(성공만 찍지 않는다)",
        missLine !== undefined,
        `찍힌 줄 ${missLines.length}개: ${missLines.join(" | ").slice(0, 300)}`,
      ),
    );
    out.push(
      assert(
        "★그 줄이 **판정 수치**를 같이 싣는다(건수·상한 — 다음 수가 갈린다)",
        missLine !== undefined && /매핑 [\d,]+건\/상한 [\d,]+건/.test(missLine),
        missLine ?? "(미스 줄 없음)",
      ),
    );
    out.push(
      assert(
        "★그 줄에 **어느 인입 경로**인지가 실린다 — 텍스트/첨부가 구분돼야 신고를 잰다",
        missLine !== undefined && missLine.includes("telegram(text)"),
        missLine ?? "(미스 줄 없음)",
      ),
    );

    // ③-b **첨부 경로도 같은 함수**를 지난다 — 종전엔 라우팅도 로그도 0줄이었다.
    const attachLines = await capture(() => {
      const r = resolveReplyRouting("chat-1", 4720, "dashboard:default", "attachment");
      out.push(
        assert(
          "★★첨부 답글도 **발원 세션으로 라우팅된다**(사진+캡션 답글이 활성 세션으로 새던 것)",
          r.sessionId === "dashboard:origin-a" && r.routedSession === "dashboard:origin-a",
          JSON.stringify(r),
        ),
      );
    });
    out.push(
      assert(
        "★첨부 경로의 성공도 **경로 표식과 함께** 남는다",
        attachLines.some((l) => l.includes("telegram(attachment)") && l.includes("발원 세션으로 라우팅")),
        attachLines.join(" | ").slice(0, 300) || "(0줄)",
      ),
    );

    // ③-c 갈리지 않은 답글은 **조용하다** — 로그도 라벨 신호도 없다(배경소음 금지).
    const quiet = await capture(() => {
      const r = resolveReplyRouting("chat-1", 4720, "dashboard:origin-a", "text");
      out.push(
        assert(
          "★묶인 세션과 같으면 «갈림» 이 아니다 — 라벨 신호를 안 만든다",
          r.routedSession === null && r.sessionId === "dashboard:origin-a",
          JSON.stringify(r),
        ),
      );
    });
    out.push(
      assert(
        "★안 갈린 답글엔 줄을 안 찍는다(매 답글마다 찍으면 배경소음이다)",
        quiet.length === 0,
        quiet.join(" | ").slice(0, 200) || "0줄",
      ),
    );

    // ③-d 답장이 아니면 **아무 줄도 없다** — 「답글이 아님」과 「답글인데 미스」의 구분.
    const notReply = await capture(() => {
      resolveReplyRouting("chat-1", undefined, "dashboard:default", "text");
    });
    out.push(
      assert(
        "★답장이 아니면 조용하다 — 이 구분이 이 로그의 존재 이유다",
        notReply.length === 0,
        notReply.join(" | ").slice(0, 200) || "0줄",
      ),
    );

    // ── ④ 보냈는데 매핑을 못 남긴 경우 — **실제로 `deliverOutbound` 를 돌린다** ──
    const { registerChannelOutbound, unregisterChannelOutbound } = await import(
      "../../core/channel-outbound.js"
    );
    const { deliverOutbound } = await import("../../core/outbound.js");
    let nextId = 900_001;
    registerChannelOutbound("regr-miss", {
      deliver: async () => ({ messageIds: [nextId++] }),
      defaultOutboundTarget: async () => "chat-miss",
    });
    try {
      // ④-a 좌표는 있는데 **발원 세션이 없다** → 사유와 횟수가 남는다.
      const skip = await capture(async () => {
        await deliverOutbound({
          channel: "regr-miss",
          target: "chat-miss",
          text: "세션 없이",
          label: "regr-labelA",
        });
      });
      const skipLine = skip.find((l) => l.includes("답장 매핑을 못 남겼습니다"));
      out.push(
        assert(
          "★★보냈는데 매핑을 못 남기면 **사유와 누적 횟수**를 남긴다",
          skipLine !== undefined &&
            skipLine.includes("발원 세션 미지정") &&
            /이 사유·라벨 [\d,]+회/.test(skipLine),
          skipLine ?? `찍힌 줄 ${skip.length}개: ${skip.join(" | ").slice(0, 300)}`,
        ),
      );
      out.push(
        assert(
          "★그 줄이 **라벨**을 싣는다 — «누가 좌표를 안 넘기나» 가 이 로그의 질문이다",
          skipLine !== undefined && skipLine.includes("label=regr-labelA"),
          skipLine ?? "(줄 없음)",
        ),
      );

      // ④-b **같은 라벨 반복은 조용하다** — 26곳이 부르므로 매번 찍으면 배경소음.
      const repeat = await capture(async () => {
        for (let i = 0; i < 5; i++) {
          await deliverOutbound({
            channel: "regr-miss",
            target: "chat-miss",
            text: "또",
            label: "regr-labelA",
          });
        }
      });
      out.push(
        assert(
          "★그 로그는 **세서** 찍는다(같은 사유·라벨 반복은 조용하다)",
          repeat.filter((l) => l.includes("답장 매핑을 못 남겼습니다")).length === 0,
          `5회 더 보냈을 때 줄 ${repeat.filter((l) => l.includes("답장 매핑을 못 남겼습니다")).length}개`,
        ),
      );

      // ④-c ★★**새 라벨은 즉시 한 줄을 낸다** — 이게 «분모가 양성으로 차는» 것의 고침이다.
      //  한 카운터였을 땐 첫 슬롯을 정상 통지가 먹어, 진짜 결함이 #50 까지 안 나왔다
      //  (0.2회/일이면 여덟 달). 키를 (사유, 라벨)로 가르니 새 라벨이 첫 줄을 받는다.
      const fresh = await capture(async () => {
        await deliverOutbound({
          channel: "regr-miss",
          target: "chat-miss",
          text: "다른 발신처",
          label: "regr-labelB",
        });
      });
      const freshLine = fresh.find((l) => l.includes("답장 매핑을 못 남겼습니다"));
      out.push(
        assert(
          "★★**새 라벨은 앞선 양성에 묻히지 않는다** — 그 자리에서 한 줄이 나온다",
          freshLine !== undefined && freshLine.includes("label=regr-labelB"),
          freshLine ?? `줄 ${fresh.length}개: ${fresh.join(" | ").slice(0, 300)}`,
        ),
      );
      out.push(
        assert(
          "★누적 분포를 같이 싣는다 — 라벨별 수가 곧 판정이다",
          freshLine !== undefined &&
            freshLine.includes("regr-labelA") &&
            /누적: /.test(freshLine),
          freshLine ?? "(줄 없음)",
        ),
      );

      // ④-d 좌표·세션이 둘 다 있으면 **아무 줄도 없다**(정상 경로는 조용하다).
      const ok = await capture(async () => {
        await deliverOutbound({
          channel: "regr-miss",
          target: "chat-miss",
          text: "정상",
          label: "regr-labelA",
          originThreadKey: "dashboard:origin-a",
        });
      });
      out.push(
        assert(
          "정상 배달은 조용하다(매핑을 남겼으므로)",
          ok.filter((l) => l.includes("답장 매핑을 못 남겼습니다")).length === 0,
          ok.join(" | ").slice(0, 200) || "0줄",
        ),
      );
    } finally {
      unregisterChannelOutbound("regr-miss");
    }

    // ── ⑤ 인입 핸들러가 그 함수를 **지난다** ──────────────────────────────────
    //  ★여기만 소스 확인이다 — 인입 핸들러는 grammy 컨텍스트가 필요해 돌릴 수가 없다.
    //   한계를 숨기지 않고 적는다. 위 ③④ 가 **판정 자체**를 동작으로 재므로, 여기서
    //   남는 질문은 «두 핸들러가 그 판정에 닿는가» 하나뿐이다.
    const tg = await (await import("node:fs/promises")).readFile(
      new URL("../../../plugins/telegram-channel/index.ts", import.meta.url),
      "utf8",
    );
    const code = tg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const kinds = [...code.matchAll(/resolveReplyRouting\([\s\S]{0,200}?"(text|attachment)"/g)].map(
      (m) => m[1],
    );
    out.push(
      assert(
        "★★텍스트·첨부 **두 핸들러 모두** 그 판정을 지난다(첨부가 빠져 있던 것이 이번 P2다)",
        kinds.includes("text") && kinds.includes("attachment"),
        `배선된 경로: ${kinds.length === 0 ? "없음" : kinds.join(", ")}`,
      ),
    );
    return out;
  },
};
