/**
 * 회귀: **재시작 뒤 옛 선택지 버튼이 새 질문의 값을 보내지 않는다** (2026-10-09 전체 적대 검토 P4, ffaca72e 수정의 그물).
 *
 * 사고(검토 재현): 선택지 id 가 단조 번호(`o0`,`o1`…)뿐이라 재시작하면 다시 `o0` 부터 매겨졌다. 재시작 전 메시지의
 * «보관»(o0) 버튼을 누르면 **새 질문의 o0(«전부 삭제»)** 이 사용자 발화로 들어갔다 — 누른 것과 다른 결정이 실행된다.
 *
 * 재는 것 — 모듈을 **두 번** 로드해(두 프로세스) 각자 진짜 `outbound.presentOptionsTo` 를 부르고:
 *  ① 같은 순번의 id 가 두 프로세스에서 겹치지 않는다
 *  ② 새 프로세스에 옛 id 를 누르면 «만료» 안내가 가고 핸들러에 아무것도 안 들어간다
 *  ③ 대조군 — 새 프로세스의 자기 id 는 그 값으로 들어간다
 *
 * 등급: **동작**(Bot API 는 가짜 변환기 — 네트워크 0).
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, type ApiCall } from "./_fake-telegram.js";

const OWNER = 111;

const buttonIds = (calls: ApiCall[]): string[] => {
  const last = [...calls].reverse().find((c) => c.method === "sendMessage" && c.payload.reply_markup !== undefined);
  const kb = (last?.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
  return kb.map((row) => row[0]!.callback_data);
};

export const check: RegressionCheck = {
  name: "telegram-option-id-survives-restart",
  guards:
    "텔레그램 선택지 id 가 재시작 뒤 o0 부터 다시 매겨져, 재시작 전 메시지의 버튼(«보관»)을 누르면 새 질문의 같은 번호(«전부 삭제») 값이 사용자 발화로 들어가던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { translate } = await import("../../core/i18n.js");
    const before = await loadTelegram("before-restart");
    const after = await loadTelegram("after-restart");

    const old = fakeChannel(before);
    const fresh = fakeChannel(after);
    const seen: string[] = [];
    try {
      await old.channel.outbound!.presentOptionsTo!(String(OWNER), "이 파일을 어떻게 할까요?", [{ label: "보관", value: "보관해 줘" }]);
      await fresh.channel.outbound!.presentOptionsTo!(String(OWNER), "정리할까요?", [{ label: "전부 삭제", value: "전부 삭제해 줘" }]);
      const oldId = buttonIds(old.calls)[0] ?? "";
      const freshId = buttonIds(fresh.calls)[0] ?? "";
      out.push(
        assert(
          "★두 프로세스의 첫 선택지 id 가 서로 다르다(순번만이면 둘 다 o0)",
          oldId !== "" && freshId !== "" && oldId !== freshId,
          `재시작 전 ${oldId} · 재시작 뒤 ${freshId}`,
        ),
      );
      out.push(
        assert(
          "id 가 callback_data 64바이트 안이다",
          Buffer.byteLength(oldId) <= 64 && Buffer.byteLength(freshId) <= 64,
          `${Buffer.byteLength(oldId)}B · ${Buffer.byteLength(freshId)}B`,
        ),
      );

      await startWithOwners(fresh.channel, String(OWNER), async (msg) => {
        seen.push(msg.text);
      });
      const sentBefore = fresh.calls.length;
      await fresh.bot.handleUpdate(callbackUpdate(OWNER, oldId));
      await settle();
      const replies = fresh.calls
        .slice(sentBefore)
        .filter((c) => c.method === "sendMessage")
        .map((c) => String(c.payload.text));
      const expired = translate("srv.telegram.optionsExpired");
      out.push(
        assert(
          "★새 프로세스에 옛 버튼을 누르면 «만료» 안내가 가고 아무 값도 사용자 발화로 들어가지 않는다",
          seen.length === 0 && replies.includes(expired),
          `핸들러에 들어간 것 ${JSON.stringify(seen)} · 보낸 답 ${JSON.stringify(replies)}`,
        ),
      );

      await fresh.bot.handleUpdate(callbackUpdate(OWNER, freshId));
      await settle();
      out.push(
        assert(
          "대조군 — 새 프로세스의 자기 버튼은 그 값으로 들어간다",
          seen.length === 1 && seen[0] === "전부 삭제해 줘",
          `핸들러에 들어간 것 ${JSON.stringify(seen)}`,
        ),
      );
    } finally {
      await fresh.channel.stop();
      await old.channel.stop();
    }
    return out;
  },
};
