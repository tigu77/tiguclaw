/**
 * 회귀: **들어온 메시지가 로그에 남는다 — 어디로 갔는지까지** (2026-09-28).
 *
 * 사고: 회사돌쇠 로그엔 나가는 전달(`route`)만 있고 들어온 메시지 기록이 없어, «답하는 중에 보낸
 *  두 번째 메시지의 답이 버려진다» 를 로그만으로 확정하지 못했다(언제 왔는지 · steer 됐는지 · 새 턴이
 *  됐는지가 안 보였다). 원격이 안 되는 기계는 로그가 유일한 진단면이다.
 * ★본문은 절대 싣지 않는다 — 사용자가 로그 파일을 통째로 건넨다.
 */
import { formatInboundLog } from "../../core/inbound-log.js";
import { readEntrySource, stripComments } from "./_wiring.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const secret = "비밀스러운 본문 SECRET-BODY";
  const line = formatInboundLog({ channel: "telegram", threadKey: "dashboard:x", textLength: secret.length, attachments: 2, route: "steer" });
  const queued = formatInboundLog({ channel: "http-bridge", threadKey: "dashboard:y", textLength: 3, attachments: 0, route: "queued" });
  const fresh = formatInboundLog({ channel: "cli", threadKey: "dashboard:z", textLength: 3, attachments: 0, route: "new", synthetic: true });
  const src = stripComments(readEntrySource());
  return [
    {
      name: "★한 줄에 채널·세션·길이·첨부·행선지(steer/대기/새 턴)가 있고 본문은 없다",
      ok:
        /channel=telegram session=dashboard:x len=\d+ att=2 → .*steer/.test(line) &&
        !line.includes("SECRET") &&
        queued.includes("대기") &&
        fresh.includes("새 턴") &&
        fresh.includes(" synthetic ") &&
        !line.includes("synthetic"),
      got: `${line} | ${queued} | ${fresh}`,
    },
    {
      name: "★진입점이 steer 수락과 큐 적재 **둘 다**에서 남긴다(한쪽만이면 두 번째 메시지가 또 안 보인다)",
      ok:
        /if \(accepted\) \{\s*console\.log\(inboundLine\(msg, "steer"\)\)/.test(src) &&
        /console\.log\(inboundLine\(msg, threadHasQueuedTurn\(msg\.threadKey\) \? "queued" : "new"\)\);\s*return enqueueThreadTurn\(/.test(src) &&
        /synthetic: msg\.synthetic === true,/.test(src),
      got: "index.ts serializedHandler",
    },
  ];
};

export const check: RegressionCheck = {
  name: "inbound-is-logged",
  guards: "들어온 메시지 기록이 로그에 없어 «두 번째 메시지가 steer 됐나·새 턴이 됐나» 를 로그만으로 못 가르던 것(회사돌쇠 2026-09-28)",
  run,
};
