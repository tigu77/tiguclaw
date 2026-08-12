/**
 * 회귀: **작업 중에 보낸 메시지 위로 나중 답변이 올라오지 않는다.**
 *
 * 사고 (2026-08-12, 사용자 실측 회사돌쇠): 16:57 에 보낸 메시지 **위에** 17:02 답변이 떴다.
 *  뿌리는 **자리와 시각을 서로 다른 시계가 정한 것**이다 —
 *   · 답변 말풍선의 *자리*: 턴이 시작될 때 만들어진 그룹(≈16:52)이 정한다
 *     (`channel-hints.js` out 경로가 `completeTurnGroup(thread)` 그룹에 append).
 *   · 그 말풍선의 *표시 시각*: 답변이 나온 때(17:02)로 찍힌다(`ensureReplyBubble`).
 *  그 사이에 온 사용자 메시지는 스트림 맨 아래로 가므로, **끼어든 메시지는 구조적으로
 *  답변보다 위에 올 수 없었다.** 새로고침하면 정상인 게 증거다(이력은 ts 로 정렬).
 *
 * ★이 검사의 등급을 정직하게 적는다: **배선 린트**다. 진짜 판정은 헤드리스 CDP
 *  (`_workspace/_midturn_order_cdp.mjs`)가 한다 — 실제로 턴을 돌리고 중간에 메시지를 넣어
 *  **DOM 순서대로 읽은 시각이 단조 증가하는지**를 본다. 그 스크립트로 수정 전/후를 실측했다:
 *    수정 전(변이) → 역전 1건(`17:22:33 돌쇠` 다음에 `17:22:22 나`)
 *    수정 후       → 역전 0건
 *  회귀 스위트는 브라우저·라이브 데몬을 안 쓰므로(_framework 승격 기준) 여기서는
 *  **그 배선이 남아 있는지**만 지킨다. 동의어 우회는 못 잡는다.
 */
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const base = new URL("../../../packages/dashboard/js/", import.meta.url);
  const hints = await readFile(new URL("channel-hints.js", base), "utf8");
  const delta = await readFile(new URL("token-delta.js", base), "utf8");

  // 주석은 판정 대상이 아니다 — 코드만 본다(이 레포에서 세 번 데인 부류).
  const codeOnly = (src: string): string =>
    src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  const hintsCode = codeOnly(hints);
  const deltaCode = codeOnly(delta);

  const defined = /const interruptOpenTurn = \(thread\) =>/.test(deltaCode);
  out.push({
    name: "★끼어들기 처리기가 있다(진행 중 턴 그룹을 닫는다)",
    ok: defined && /card\.closed = true/.test(deltaCode) && /card\.interrupted = true/.test(deltaCode),
    got: defined ? "interruptOpenTurn 정의됨" : "★없음 — 끼어든 메시지가 답변 아래로 밀린다",
  });

  const called = /if \(!isOut\) interruptOpenTurn\(thread\);/.test(hintsCode);
  out.push({
    name: "★사용자 메시지 렌더가 그걸 부른다(안 부르면 죽은 코드)",
    ok: called,
    got: called ? "in 경로에서 호출" : "★미호출 — 순서 역전이 그대로 재발한다",
  });

  // 끼어들어 닫힌 옛 카드로 최종 답변이 되돌아가면 원래 증상 그대로다.
  const guarded =
    /if \(card && !card\.interrupted && card\.sawTextSegment/.test(hintsCode) &&
    /if \(card && !card\.interrupted && card\.replyBubble/.test(hintsCode);
  out.push({
    name: "★최종 답변이 닫힌 옛 그룹으로 돌아가지 않는다",
    ok: guarded,
    got: guarded ? "두 분기 모두 interrupted 가드" : "★가드 없음 — 답변이 다시 위로 올라간다",
  });

  // 진행 중 평문 버블은 버려야 한다 — 남기면 끼어든 메시지 위에 조각이 남아 중복으로 보인다.
  const dropsPartial = /card\.replyBubble\.parentNode\.removeChild\(card\.replyBubble\)/.test(
    deltaCode,
  );
  out.push({
    name: "진행 중 평문 조각을 버린다(최종 전체본이 아래에 다시 온다)",
    ok: dropsPartial,
    got: dropsPartial ? "부분 버블 제거" : "★남긴다 — 같은 말이 두 번 보인다",
  });

  return out;
};

export const check: RegressionCheck = {
  name: "chat-midturn-order",
  guards:
    "작업 중에 보낸 메시지 위로 나중 답변이 올라오던 것 — 답변의 자리는 턴 시작 시각이, 표시 시각은 완료 시각이 정해서 라이브 화면만 순서가 뒤집혔다(새로고침하면 정상이라 더 안 보였다)",
  run,
};
