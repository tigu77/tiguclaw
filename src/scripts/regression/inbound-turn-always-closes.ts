/**
 * 회귀: **켠 진행 표시는 반드시 꺼진다** — 슬래시 명령이 «작업 중» 을 남기지 않는다
 * (2026-09-01 사용자 신고: *"텔레그램에서 `/sessions` 실행하면 대시보드에서 계속 작업중"*).
 *
 * ★계약은 하나다: 대시보드의 진행 표시는 **`channel.message.in` 으로 켜지고**
 *  **`channel.message.out` · `llm.turn_done` · `llm.turn_error` 로 꺼진다**
 *  (`packages/dashboard/js/axis1-options.js` 의 `markTurnActive`/`markTurnDone`).
 *  슬래시 명령은 **LLM 미경유**라 `turn_done` 이 없다 → `out` 을 안 내면 영영 안 꺼진다.
 *  (15분 stale 스윕이 걷을 때까지 «작업 중» 이 돈다.)
 *
 * ★**이건 재발이다.** 2026-07-10 에 `/status` 로 같은 것을 겪고 `replyCommand`(reply + out
 *  동시 발행)로 닫았는데, `presentOptions` 경로는 **그 통로를 안 거쳤다** — 채널 클로저라
 *  (cli=stdout · telegram=`ctx.reply`) 버스를 안 탄다. 부류가 닫힌 게 아니라 한 갈래만
 *  닫혀 있었다. 그래서 이번엔 **«직접 호출이 0» 이라는 판정**으로 막는다: 응답 통로를
 *  두 개(`replyCommand`·`presentAndClose`)로 고정하고, 원시 호출이 새로 생기면 빨개진다.
 *
 * ★이름을 열거하지 않는다([[feedback_hand_maintained_lists]]) — 명령 목록이 아니라
 *  **«원시 `msg.presentOptions(` 가 헬퍼 밖에 있나»** 를 본다. 새 명령이 생겨도 저절로 덮인다.
 *
 * 등급: **동작**(발행 계약을 실행으로 확인) + **판정**(원시 호출 0).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "inbound-turn-always-closes",
  guards:
    "슬래시 명령이 대시보드 «작업 중» 을 켜놓고 안 끄던 것 — `presentOptions` 는 채널 클로저라 버스를 안 타고 슬래시는 LLM 미경유라 turn_done 도 없다. 2026-07-10 에 /status 로 같은 것을 겪고 replyCommand 로 닫았는데 그 통로를 안 거치는 갈래가 남아 있었다(사용자 신고 2026-09-01)",
  run: async (): Promise<Assertion[]> => {
    const src = readFileSync(path.join(REPO, "src/index.ts"), "utf8");

    // ① 원시 호출은 **헬퍼 안의 한 줄뿐**이어야 한다.
    const rawCalls = [...src.matchAll(/msg\.presentOptions\(/g)].length;
    // ② 그 한 줄이 실제로 헬퍼(`presentAndClose`) 안에 있나 — 헬퍼가 사라지고 원시 호출만
    //    남는 되돌림을 잡는다.
    const helperAt = src.indexOf("const presentAndClose");
    const rawAt = src.indexOf("msg.presentOptions(");
    const helperEnd = helperAt < 0 ? -1 : src.indexOf("\n};", helperAt);

    // ③ 헬퍼가 out 을 실제로 발행하나(성공했을 때만).
    const helperBody = helperAt < 0 || helperEnd < 0 ? "" : src.slice(helperAt, helperEnd);
    const publishesOut = /type:\s*"channel\.message\.out"/.test(helperBody);
    const onlyOnOk = /if\s*\(!r\.ok\)\s*return r;/.test(helperBody);

    // ④ 같은 계약의 형제 — `replyCommand` 도 out 을 낸다(이게 2026-07-10 의 처방이다).
    const replyAt = src.indexOf("const replyCommand");
    const replyEnd = replyAt < 0 ? -1 : src.indexOf("\n};", replyAt);
    const replyPublishes =
      replyAt >= 0 && replyEnd >= 0 &&
      /type:\s*"channel\.message\.out"/.test(src.slice(replyAt, replyEnd));

    return [
      assert(
        "★★원시 `msg.presentOptions(` 는 **헬퍼 안 한 곳뿐**이다 — 새 호출이 생기면 그 명령이 «작업 중» 을 남긴다",
        rawCalls === 1,
        `원시 호출 ${rawCalls}곳(1이어야)`,
      ),
      assert(
        "★그 한 곳이 `presentAndClose` 안에 있다 — 헬퍼를 지우고 원시 호출만 남기는 되돌림을 잡는다",
        helperAt >= 0 && helperEnd > helperAt && rawAt > helperAt && rawAt < helperEnd,
        helperAt < 0 ? "★헬퍼가 없다" : `헬퍼 ${helperAt}~${helperEnd} · 호출 ${rawAt}`,
      ),
      assert(
        "★★헬퍼가 `channel.message.out` 을 **발행**한다 — 이게 진행 표시를 끄는 유일한 신호다(슬래시는 turn_done 이 없다)",
        publishesOut,
        publishesOut ? "발행함" : "★안 냄 — 켠 것을 끄는 게 없다",
      ),
      assert(
        "★렌더 실패면 발행하지 않는다 — 실패는 텍스트 폴백(`replyCommand`)이 받고, 거기서 닫힌다(이중 발행 0)",
        onlyOnOk,
        onlyOnOk ? "성공에만 발행" : "★실패해도 발행한다",
      ),
      assert(
        "★형제 통로 `replyCommand` 도 out 을 낸다 — 2026-07-10 처방이 살아 있나(둘이 같은 계약이다)",
        replyPublishes,
        replyPublishes ? "발행함" : "★replyCommand 가 out 을 안 낸다 — 부류가 통째로 열렸다",
      ),
    ];
  },
};
