/**
 * 회귀: 채팅 입력창 안내문(placeholder)을 정하는 곳은 **하나뿐**이다.
 *
 * 사고 (2026-08-10): 고스트 제안이 안내문과 겹쳐서 고쳤는데, 그 수정이 폰 안내문을 PC
 *  것으로 덮어썼다. 한 번 더 보정하려는 순간 사용자가 막았다 — "땜빵식으로 수정하지 말자".
 *
 *  전수로 보니 같은 값을 **네 곳**이 쓰고 있었고 판정 기준까지 갈려 있었다:
 *    index.html(기본) · perf.js(`pointer: coarse` → 버튼 전송 문구) ·
 *    mobile-nav.js(`max-width: 900px` → 짧은 문구) · ghost-suggest.js(고스트 중 비움)
 *  승자는 **로드 순서**가 정했다. 실제 결과:
 *    - 폰: mobile-nav 가 나중이라 perf.js 문구는 **한 번도 안 보였다**(죽은 문자열).
 *    - 좁은 데스크톱 창: "메시지 입력…" 만 떠 Enter 전송인지 알 수 없었다.
 *    - 고스트가 떴다 사라지면 초기 스냅샷으로 되돌아가 폰 문구가 PC 것으로 바뀌었다.
 *
 * 고침: 판정을 `util.js` 의 `computeChatPlaceholder` 하나로 모았다. 두 축이 실제로 다른
 *  것을 결정한다 — *무엇을 안내하나*(전송 방식)는 입력 장치, *얼마나 길게*는 화면 폭.
 *  다른 파일들은 사실만 알린다(`setChatGhostShowing`) 또는 갱신만 요청한다.
 *
 * ★등급: **배선 린트**(소스 문자열 대조). 브라우저 없이는 실제 렌더를 못 보므로
 *  "쓰는 곳이 하나인가" 만 본다. 동의어 우회(예: `el.placeholder = …`)까지 잡도록
 *  두 형태를 모두 센다.
 */
import { readFile, readdir } from "node:fs/promises";
import type { Assertion, RegressionCheck } from "./_framework.js";

const JS_DIR = new URL("../../../packages/dashboard/js/", import.meta.url);

/** 채팅 입력창의 안내문을 **쓰는** 코드가 있는 파일들. */
const findWriters = async (): Promise<string[]> => {
  const files = (await readdir(JS_DIR)).filter((f) => f.endsWith(".js"));
  const hits: string[] = [];
  for (const f of files) {
    const src = await readFile(new URL(f, JS_DIR), "utf8");
    // setAttribute("placeholder", …) 또는 .placeholder = … 를 chat-input 맥락에서 쓰는가.
    const setsAttr = /setAttribute\(\s*["']placeholder["']/.test(src);
    const setsProp = /\.placeholder\s*=/.test(src);
    if (!setsAttr && !setsProp) continue;
    // prompt-options.js 는 **다른 입력창**(선택지 '기타' 입력)이다 — 대상 밖.
    if (f === "prompt-options.js") continue;
    hits.push(f);
  }
  return hits.sort();
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const writers = await findWriters();

  out.push({
    name: "★채팅 안내문을 쓰는 파일은 util.js 하나뿐이다(판정 단일화)",
    ok: writers.length === 1 && writers[0] === "util.js",
    got: `쓰는 파일=[${writers.join(", ")}] (기대 [util.js])`,
  });

  const util = await readFile(new URL("util.js", JS_DIR), "utf8");
  out.push({
    name: "두 축이 한 함수에서 조합된다(입력 장치 · 화면 폭)",
    ok:
      util.includes("computeChatPlaceholder") &&
      util.includes("(pointer: coarse)") &&
      util.includes("(max-width: 900px)"),
    got: `computeChatPlaceholder=${util.includes("computeChatPlaceholder")} coarse=${util.includes("(pointer: coarse)")} width=${util.includes("(max-width: 900px)")}`,
  });

  // 고스트는 **사실만** 알린다 — 문구를 직접 만들지 않는다.
  const ghost = await readFile(new URL("ghost-suggest.js", JS_DIR), "utf8");
  out.push({
    name: "고스트는 표시 사실만 알리고 문구를 정하지 않는다",
    ok: ghost.includes("setChatGhostShowing") && !/setAttribute\(\s*["']placeholder["']/.test(ghost),
    got: `알림=${ghost.includes("setChatGhostShowing")} 직접설정=${/setAttribute\(\s*["']placeholder["']/.test(ghost)}`,
  });

  // 전송 동작과 안내문이 **같은 기준**을 쓴다 — 갈리면 화면이 거짓말을 한다.
  const perf = await readFile(new URL("perf.js", JS_DIR), "utf8");
  out.push({
    name: "★전송 판정과 안내문이 같은 기준(isTouchPrimary)을 쓴다",
    ok: perf.includes("isTouchPrimary()") && !perf.includes("const isTouchPrimary"),
    got: `사용=${perf.includes("isTouchPrimary()")} 자체정의=${perf.includes("const isTouchPrimary")} (기대 사용만)`,
  });

  return out;
};

export const check: RegressionCheck = {
  name: "chat-placeholder-single-source",
  guards:
    "채팅 안내문을 네 곳이 각자 다른 기준으로 써서 로드 순서가 승자를 정하던 것(폰에서 한 문구는 아예 안 보였고, 고스트가 뜬 뒤엔 폰 문구가 PC 것으로 바뀌었다)",
  run,
};
