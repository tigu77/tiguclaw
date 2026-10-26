/**
 * 회귀: **보내는 쪽이 egress 를 끌 수 있다** (2026-09-02 정태님:
 * *"아직 텔레그램에 [probe:cache] 메시지가 온다 이건 수정안했었나"*).
 *
 * ★배경: egress 채널은 «서버 설정 ∪ 메시지가 실어온 것» 이다. 그 합집합은 2026-08-10 에
 *  «서버가 스스로 만드는 발화(매니저 완료·스케줄·파일감시)도 fan-out 을 타게» 하려고
 *  넣었고 그 자체는 옳다 — 몇 시간짜리 매니저 완료가 안 와서 생긴 규칙이다.
 *  그런데 그 대가로 **끌 방법이 사라졌다**: 설정에 telegram 이 있으면 프로그램이 띄운
 *  턴까지 전부 사용자 폰으로 간다. 실측으로 하루에 라벨 붙은 발신 21건 중 18건이 개발
 *  프로브였다.
 *
 * ★**한 방향만** 연다 — `noEgress` 는 «덜 보낸다» 만 할 수 있다. 같은 규범이 오늘
 *  플러그인 `readOnly` 에도 있다(조이는 건 되고 푸는 건 안 된다).
 * ★**자동 판정을 안 하는 이유**: 세션 이름으로 «기계» 를 가려내는 건 손목록이고
 *  ([[feedback_hand_maintained_lists]]), 무엇보다 스케줄 실패 알림처럼 **정말 가야 하는
 *  것**을 조용히 막는다. 보내는 쪽이 자기 의도를 안다.
 *
 * 등급: **판정**(코어 배선 + 브리지 통로) — 실제 배달은 채널 플러그인이라 여기선 «합집합이
 * 비워지는가» 를 본다.
 */
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "egress-can-be-declined",
  guards:
    "egress 가 «설정 ∪ 메시지» 합집합이라 설정에 telegram 이 있으면 프로그램이 띄운 턴까지 전부 사용자 폰으로 가고 끌 방법이 없던 것(실측: 라벨 붙은 발신 21건 중 18건이 개발 프로브) (2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    const idx = readSourceSync("src/index.ts");
    const types = readSourceSync("src/channels/types.ts");
    const chat = readSourceSync("plugins/http-bridge/routes-chat.ts");
    const core = readSourceSync("src/core/egress-targets.ts");
    // ★글자 대조에서 동작으로 (2026-10-26 변이 사냥) — 종전엔 `index.ts` 의 합집합 블록 글자만 봐서, 해석 호출에서 `msg.egressChannels ?? …` 로
    //  `noEgress` 를 넘어서는 변이가 전체 초록으로 살아남았다. 합성을 `egress-targets.ts` 로 옮겨 진짜 함수를 부른다.
    const { resolveTurnEgressTargets } = await import("../../core/egress-targets.js");
    let settingsReads = 0;
    const declined = await resolveTurnEgressTargets(
      { channel: "http-bridge", threadKey: "dashboard:probe", noEgress: true, egressChannels: ["telegram"] },
      () => { settingsReads += 1; return ["telegram"]; },
      { getOutbound: () => ({ deliver: async () => {}, defaultOutboundTarget: () => "owner" }), getSessionMeta: () => null },
    );
    const at = core.indexOf("export const resolveTurnEgressTargets");
    const blk = at < 0 ? "" : core.slice(at, at + 600);

    return [
      assert(
        "★배선 블록을 찾았다(0이면 아래 이름 판정은 미검사다)",
        blk !== "",
        blk === "" ? "★못 찾음" : `${blk.length}자`,
      ),
      assert(
        "★★`noEgress` 면 메시지가 실어온 채널도 **서버 설정도** 안 탄다 — 대상 0 · 설정은 읽지도 않는다",
        declined.length === 0 && settingsReads === 0,
        `대상 ${declined.length}개 · 설정 읽음 ${settingsReads}회 (기대 0·0)`,
      ),
      assert(
        "★핸들러가 이 함수로 egress 를 정한다(배선)",
        /resolveTurnEgressTargets\(msg, /.test(idx),
        /resolveTurnEgressTargets\(msg, /.test(idx) ? "배선 확인" : "★핸들러가 다른 길로 정한다",
      ),
      assert(
        "★계약이 타입에 있다 — 채널 무관(브리지만의 것이 아니다)",
        /noEgress\?:\s*boolean/.test(types),
        /noEgress/.test(types) ? "타입 있음" : "★타입 없음",
      ),
      assert(
        "★★브리지가 **`true` 일 때만** 싣는다 — 없으면 종전대로(회귀 0)",
        /body\.noEgress === true \? \{ noEgress: true \} : \{\}/.test(chat),
        /body\.noEgress/.test(chat) ? "true 에만" : "★조건 없음",
      ),
      assert(
        "★★세션 이름으로 «기계» 를 가려내지 **않는다** — 손목록이고, 스케줄 실패 알림을 조용히 막는다",
        !/startsWith\("worker:"\)|startsWith\("agent:"\)|startsWith\("probe/.test(blk),
        /startsWith\("(worker|agent|probe)/.test(blk) ? "★이름 판정이 들어왔다" : "이름 판정 0",
      ),
    ];
  },
};
