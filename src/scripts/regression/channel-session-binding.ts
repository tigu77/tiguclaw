/**
 * 회귀: 채널→세션 바인딩이 실제로 인입 경로를 바꾸고, 셀렉터 채널은 건드리지 않는다
 * (2026-07-28 신규 기능 — `/sessions`).
 *
 * 지키는 계약:
 *  1. 바인딩이 없으면 기존 그대로 기본 세션(회귀 0 — 이게 깨지면 전 채널이 엉뚱한 데로 간다).
 *  2. 바인딩이 있으면 그 세션으로 간다(대화방 단위 — DM/그룹이 각각).
 *  3. **explicit 세션(대시보드 탭)이 언제나 이긴다** — 셀렉터 있는 채널은 바인딩 무관.
 *     이게 뒤집히면 대시보드에서 탭을 골라도 딴 세션에 쌓인다.
 *  4. 해제하면 기본 세션으로 돌아온다.
 */
import {
  resolveSessionId,
  setChannelSessionBindingLookup,
  DEFAULT_SESSION_ID,
} from "../../core/threadkey.js";
import {
  getChannelSessionBinding,
  setChannelSessionBinding,
  clearChannelSessionBinding,
} from "../../store/channel-session.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "telegram";
const DM = "chat-dm-1";
const GROUP = "chat-group-1";
const S1 = "dashboard:regression-session-1";
const S2 = "dashboard:regression-session-2";

export const check: RegressionCheck = {
  name: "channel-session-binding",
  guards: "셀렉터 없는 채널의 세션 고정 — 바인딩 무시/역전 시 대화가 엉뚱한 세션에 쌓임",
  run: async (): Promise<Assertion[]> => {
    // 부팅(index.ts)이 하는 등록을 여기서도 한다 — 미등록이면 바인딩이 **조용히 무시**되므로
    // 그 상태를 통과로 오판하지 않게 등록 후/전을 모두 확인한다.
    setChannelSessionBindingLookup(null);
    const beforeRegister = resolveSessionId(CH, DM);
    setChannelSessionBindingLookup((c, a) => getChannelSessionBinding(c, a));

    clearChannelSessionBinding(CH, DM);
    clearChannelSessionBinding(CH, GROUP);
    const out: Assertion[] = [
      assert("미등록이면 기본 세션(안전 degrade)", beforeRegister === DEFAULT_SESSION_ID, beforeRegister),
      assert("바인딩 없으면 기본 세션(회귀 0)", resolveSessionId(CH, DM) === DEFAULT_SESSION_ID, resolveSessionId(CH, DM)),
    ];

    setChannelSessionBinding(CH, DM, S1);
    out.push(assert("바인딩하면 그 세션으로", resolveSessionId(CH, DM) === S1, resolveSessionId(CH, DM)));
    out.push(
      assert(
        "다른 대화방은 영향 없음(방 단위)",
        resolveSessionId(CH, GROUP) === DEFAULT_SESSION_ID,
        resolveSessionId(CH, GROUP),
      ),
    );

    setChannelSessionBinding(CH, GROUP, S2);
    out.push(
      assert(
        "DM·그룹이 각각 다른 세션",
        resolveSessionId(CH, DM) === S1 && resolveSessionId(CH, GROUP) === S2,
        `${resolveSessionId(CH, DM)} / ${resolveSessionId(CH, GROUP)}`,
      ),
    );

    // ★가장 중요한 계약 — 셀렉터(대시보드 탭)가 언제나 이긴다.
    out.push(
      assert(
        "explicit 세션이 바인딩을 이긴다(대시보드 무영향)",
        resolveSessionId(CH, DM, "dashboard:explicit-tab") === "dashboard:explicit-tab",
        resolveSessionId(CH, DM, "dashboard:explicit-tab"),
      ),
    );

    clearChannelSessionBinding(CH, DM);
    out.push(assert("해제하면 기본 세션으로", resolveSessionId(CH, DM) === DEFAULT_SESSION_ID, resolveSessionId(CH, DM)));

    clearChannelSessionBinding(CH, GROUP);
    return out;
  },
};
