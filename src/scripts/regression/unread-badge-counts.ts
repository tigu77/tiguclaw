/**
 * 회귀: **안 본 메시지 배지는 비활성 탭에서 실제로 센다.**
 *
 * 사용자 제안 (2026-08-12): "세션탭에 안 본 메시지가 있으면 지금처럼 진행중 배지 말고
 *  다른 배지를 보여주면 어떨까?" — 두 배지는 **다른 질문**에 답한다:
 *   · 진행 점(`st-dot`) = "지금 도는가"(곧 저절로 사라진다)
 *   · 안 본 배지(`st-unread`) = "내가 못 본 게 있나"(사람이 볼 일이 남았다)
 *  한 배지로 합치면 턴이 끝나 점이 사라지는 순간 = 읽을 게 생긴 순간의 신호가 같이 사라진다.
 *
 * ★이 검사가 지키는 진짜 함정(내가 실제로 빠졌던 것):
 *  적재를 `if (!isActiveThread(tk)) return;` **아래**에 두면, 정작 세려던 경우
 *  (다른 탭에 온 답)에 **한 번도 안 불린다.** 코드는 있는데 영원히 0인 상태 —
 *  헤드리스 검증(_workspace/_unread_badge_cdp.mjs)에서 배지가 안 떠서 잡았다.
 *  그래서 여기서는 존재가 아니라 **순서**를 본다.
 *
 * ★등급: 배선 린트. 진짜 판정은 위 CDP 스크립트(실제 턴 → 배지 "2" → 탭 열기 → 사라짐).
 */
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const base = new URL("../../../packages/dashboard/", import.meta.url);
  const sse = await readFile(new URL("js/sse.js", base), "utf8");
  const tabs = await readFile(new URL("js/tabs.js", base), "utf8");
  const constants = await readFile(new URL("js/constants.js", base), "utf8");
  const css = await readFile(new URL("app.css", base), "utf8");

  // ★순서 — 적재가 활성 세션 가드보다 **위**여야 한다.
  // ★앵커는 **그 블록의** 가드다 — 파일 전체 첫 등장으로 비교하면 첨부 분기의 가드(더 위)와
  //  견주게 돼 항상 실패한다(첫 판이 그랬다). 메시지 렌더 가드는 이 주석이 표식이다.
  const iBump = sse.indexOf("bumpUnread(tk)");
  const iGate = sse.indexOf("★멀티세션(B계층) — 채팅 스트림 DOM 은 active 세션만");
  out.push({
    name: "★적재가 활성 세션 가드보다 먼저다(아래면 다른 탭 것을 영영 못 센다)",
    ok: iBump >= 0 && iGate >= 0 && iBump < iGate,
    got: iBump < 0 ? "★bumpUnread 호출 없음" : `bump@${iBump} vs gate@${iGate}`,
  });

  const onlyOut = /if \(ev\.type === "channel\.message\.out"\) bumpUnread\(tk\);/.test(sse);
  out.push({
    name: "비서 답변(out)만 센다(내가 다른 채널에서 친 말은 '안 본' 이 아니다)",
    ok: onlyOut,
    got: onlyOut ? "out 한정" : "★in 까지 세면 텔레그램에서 말할 때마다 내 탭이 빨개진다",
  });

  const guardsActive = /if \(!tk \|\| isActiveThread\(tk\)\) return;/.test(constants);
  out.push({
    name: "보고 있는 탭은 안 센다",
    ok: guardsActive,
    got: guardsActive ? "활성 탭 제외" : "★현재 탭도 쌓인다",
  });

  const clears = /clearUnread\(tk\)/.test(tabs);
  out.push({
    name: "★탭을 열면 배지가 사라진다",
    ok: clears,
    got: clears ? "switchToThread 에서 해제" : "★안 지워진다 — 영원히 남는 배지",
  });

  const separate =
    /className = "st-unread"/.test(tabs) &&
    /className = "st-dot"/.test(tabs) &&
    /\.session-tab \.st-unread/.test(css);
  out.push({
    name: "★진행 점과 별개 배지다(둘 다 참이면 둘 다 보인다)",
    ok: separate,
    got: separate ? "st-dot · st-unread 공존 + CSS 있음" : "★한 배지에 겹쳐 썼다",
  });

  // ★코너 알림 배지 (2026-08-13 사용자 제안) — 탭 우상단에 얹힌다. 얹으면 ⋯ 케밥 위를
  //  스치는데, **탭 닫기가 케밥 하나뿐**이라 클릭을 삼키면 탭을 못 닫는다.
  //  `pointer-events:none` 이 그 유일한 보증이므로 여기서 못 박는다.
  //  (기하 — 안 잘리는가·케밥이 여전히 눌리는가 — 는 실측: `_workspace/_unread_badge_style_cdp.mjs`.)
  const overlay = /\.session-tab \.st-unread \{[^}]*position:absolute[^}]*pointer-events:none/s.test(
    css,
  );
  out.push({
    name: "★코너 배지는 클릭을 삼키지 않는다(케밥=탭 닫기 유일 경로)",
    ok: overlay,
    got: overlay ? "absolute + pointer-events:none" : "★흐름 안으로 돌아갔거나 클릭을 먹는다",
  });

  return out;
};

export const check: RegressionCheck = {
  name: "unread-badge-counts",
  guards:
    "안 본 메시지 배지의 적재가 활성 세션 가드 아래에 있어 다른 탭에 온 답을 한 번도 못 세던 것(코드는 있는데 영원히 0) + 진행 점과 한 배지로 겹쳐 신호가 서로를 덮던 것",
  run,
};
