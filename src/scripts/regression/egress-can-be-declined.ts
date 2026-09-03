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
    const at = idx.indexOf("const egressFromSettings");
    const blk = at < 0 ? "" : idx.slice(at, at + 700);

    return [
      assert(
        "★배선 블록을 찾았다(0이면 아래는 미검사다)",
        blk !== "",
        blk === "" ? "★못 찾음" : `${blk.length}자`,
      ),
      assert(
        "★★`noEgress` 면 **설정값도** 안 탄다 — 메시지 쪽만 비우면 설정에 telegram 이 있는 한 그대로 간다(그게 원래 결함이다)",
        /msg\.noEgress === true \? \[\] : readEgressChannels\(\)/.test(blk),
        /readEgressChannels/.test(blk) ? "설정도 차단" : "★설정이 그대로 합쳐진다",
      ),
      assert(
        "★★합집합 자체가 **빈 배열**이 된다 — 좌표 해석·활동 표시까지 통째로 no-op",
        /noEgress === true\s*\?\s*\[\]/.test(blk.replace(/\s+/g, " ")),
        /\[\]/.test(blk) ? "빈 배열" : "★합집합이 남는다",
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
