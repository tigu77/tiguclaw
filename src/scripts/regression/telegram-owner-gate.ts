/**
 * 회귀: **텔레그램 소유자 allowlist 가 실제로 막는다** (2026-10-09 전체 적대 검토 G4).
 *
 * 인터넷에 노출된 **유일한** 인증 게이트(`TELEGRAM_ALLOWED_USER_IDS`)인데 지키는 검사가 0이었다 —
 * 판정을 «항상 true» 로 바꾼 변이가 전체 스위트에서 살아남았다. 그 상태면 봇 이름을 아는 누구나
 * 비서에게 일을 시킨다(파일·셸·메일).
 *
 * 지키는 것 —
 *  ① 판정 함수(`isAllowedSender`) 자체: 목록 안만 통과 · 목록 밖·발신자 없음·빈 목록(잠금)은 거절
 *  ② ★배선: 진짜 `TelegramChannel` 에 진짜 update 를 흘린다 — 남의 텍스트·문서·버튼은 핸들러에 안 닿고,
 *     소유자 것은 닿는다(게이트를 지우거나 핸들러 하나에서 빠뜨리면 여기서 운다)
 *  ③ 차단된 버튼도 로딩은 풀어준다(answerCallbackQuery)
 *
 * 등급: **동작**(Bot API 는 가짜 변환기 — 네트워크 0).
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { bigDocumentUpdate, callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";

const OWNER = 111;
const STRANGER = 222;

export const check: RegressionCheck = {
  name: "telegram-owner-gate",
  guards:
    "인터넷에 노출된 유일한 인증 게이트(텔레그램 소유자 allowlist)를 «항상 true» 로 바꿔도 전체 스위트가 초록이던 것 — 남이 봇에게 일을 시킬 수 있는 상태를 아무도 못 본다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const mod = await loadTelegram();

    // ── ① 판정 함수 ──────────────────────────────────────────────
    const owners = new Set([String(OWNER)]);
    const verdicts = {
      owner: mod.isAllowedSender(OWNER, owners),
      ownerStr: mod.isAllowedSender(String(OWNER), owners),
      stranger: mod.isAllowedSender(STRANGER, owners),
      noSender: mod.isAllowedSender(undefined, owners),
      emptyList: mod.isAllowedSender(OWNER, new Set()),
    };
    out.push(
      assert(
        "판정: 목록 안만 통과 · 목록 밖·발신자 없음·빈 목록(잠금)은 거절",
        verdicts.owner && verdicts.ownerStr && !verdicts.stranger && !verdicts.noSender && !verdicts.emptyList,
        verdicts,
      ),
    );

    // ── ② 배선 — 진짜 채널에 진짜 update ─────────────────────────────
    const { channel, bot, calls } = fakeChannel(mod);
    const seen: string[] = [];
    try {
      await startWithOwners(channel, String(OWNER), async (msg) => {
        seen.push(`${msg.channelUserId}:${msg.text.slice(0, 20)}`);
      });
      await bot.handleUpdate(textUpdate(STRANGER, "남의 지시"));
      await bot.handleUpdate(bigDocumentUpdate(STRANGER));
      await bot.handleUpdate(callbackUpdate(STRANGER, "o-anything"));
      await settle();
      const strangerReached = seen.filter((s) => s.startsWith(`${STRANGER}:`));
      const answeredBlockedButton = calls.some((c) => c.method === "answerCallbackQuery");
      await bot.handleUpdate(textUpdate(OWNER, "주인 지시"));
      await bot.handleUpdate(bigDocumentUpdate(OWNER));
      await settle();
      const ownerReached = seen.filter((s) => s.startsWith(`${OWNER}:`));
      out.push(
        assert(
          "★남의 텍스트·문서·버튼은 핸들러에 안 닿는다(게이트가 미들웨어에서 막는다)",
          strangerReached.length === 0,
          `남이 닿은 건수 ${strangerReached.length} ${JSON.stringify(strangerReached)}`,
        ),
      );
      out.push(
        assert(
          "소유자의 텍스트·문서는 닿는다(대조군 — 게이트가 전부 막아서 초록인 게 아니다)",
          ownerReached.length === 2,
          `주인이 닿은 건수 ${ownerReached.length} ${JSON.stringify(ownerReached)}`,
        ),
      );
      out.push(
        assert(
          "차단된 버튼도 로딩은 풀어준다(answerCallbackQuery)",
          answeredBlockedButton,
          `API 호출: ${[...new Set(calls.map((c) => c.method))].join(",")}`,
        ),
      );
    } finally {
      await channel.stop();
    }
    return out;
  },
};
