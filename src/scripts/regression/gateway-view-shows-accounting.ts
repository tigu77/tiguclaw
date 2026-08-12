/**
 * 회귀: **게이트웨이 호출을 펼치면 회계·건강이 보인다.**
 *
 * 사고 (2026-08-12, 사용자: "게이트웨이에 내용물이 싹 비어있네"):
 *  외부 호출 뷰에서 게이트웨이 항목을 펼치면 `요청 (없음) / 응답 (없음)` 두 칸뿐이었다.
 *  본문을 안 남기는 건 **의도**다(외부 앱 데이터 — PII 방지, `http-bridge` 주석).
 *  그런데 대신 남기기로 한 **회계·건강**(요청 모델·실제 처리 모델·토큰·도구 호출·
 *  메시지 수·소요)은 프런트가 `endpointLog` 에 담아 놓고 **그리지 않았다.**
 *  즉 자료는 있었고 읽는 쪽이 없었다 — 이 뷰가 2026-08-01 에 겪은 것과 같은 부류
 *  ("엔드포인트 기록들이 다 사라졌어": 서버엔 있는데 화면이 안 물었다).
 *  `stream`·`messages` 는 아예 담지도 않아 두 번 잃고 있었다.
 *
 * ★등급: **배선 린트**. 진짜 판정은 헤드리스 CDP(`_workspace/_gateway_view_cdp.mjs`)가
 *  한다 — 실제 게이트웨이 호출을 한 건 만들고, 뷰를 열어 항목을 펼쳐 innerText 를 읽는다.
 *  그 스크립트로 수정 전/후를 실측했다:
 *    수정 전(변이) → `요청 (없음) / 응답 (없음)`
 *    수정 후       → `요청 모델: tiguclaw · 실제 처리: gpt-5.5 · 토큰 입력 17 · 출력 32 …`
 *  회귀 스위트는 브라우저를 안 띄우므로(_framework 승격 기준) 여기선 배선만 지킨다.
 */
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const src = await readFile(
    new URL("../../../packages/dashboard/js/channel-hints.js", import.meta.url),
    "utf8",
  );
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  const captures = /stream: \(p && p\.stream\) === true/.test(code) &&
    /messages: Number\(p && p\.messages\)/.test(code);
  out.push({
    name: "★게이트웨이 고유 필드를 담는다(안 담으면 그릴 것도 없다)",
    ok: captures,
    got: captures ? "stream·messages 캡처" : "★버려진다 — 화면에 낼 수 없다",
  });

  const renders = /if \(e\.kind === "gateway"\) \{/.test(code) &&
    /buildEpSection\("회계·건강"/.test(code);
  out.push({
    name: "★게이트웨이는 회계·건강을 그린다(본문 두 칸만 그리면 빈 화면이 된다)",
    ok: renders,
    got: renders ? "gateway 분기 + 회계·건강 섹션" : "★분기 없음 — 요청/응답 (없음) 두 칸",
  });

  const shows =
    /실제 처리/.test(code) && /입력 \$\{/.test(code) && /요청 모델/.test(code);
  out.push({
    name: "실제 처리 모델·토큰이 그 안에 있다(게이트웨이의 회계 축)",
    ok: shows,
    got: `실제처리=${/실제 처리/.test(code)} 토큰=${/입력 \$\{/.test(code)}`,
  });

  // ★2026-08-12 사용자 결정으로 **본문도 남긴다** — 회계만 있고 본문이 없으면 반쪽이다.
  //  ("요청·결과 다 남는 게 맞지 않나? 그걸 알고 싶어서 저기에 기록이 남는 건데")
  const showsBody =
    /detail\.appendChild\(buildEpSection\("요청", e\.request\)\);/.test(code) &&
    /buildEpSection\("응답", e\.response\)/.test(code);
  out.push({
    name: "★게이트웨이도 요청·응답 본문을 보여준다(회계만으론 무슨 일이었는지 모른다)",
    ok: showsBody,
    got: showsBody ? "요청·응답 섹션 있음" : "★본문 미표시 — 회계만 보인다",
  });
  const bridge = await readFile(
    new URL("../../../plugins/http-bridge/index.ts", import.meta.url),
    "utf8",
  );
  const records =
    /request: endpointPreview\(runInput\.text\)/.test(bridge) &&
    /response: endpointPreview\(/.test(bridge);
  out.push({
    name: "★게이트웨이 이벤트가 본문을 싣는다(화면이 그릴 자료 자체가 있어야 한다)",
    ok: records,
    got: records ? "request·response 기록" : "★안 실린다 — 화면만 고쳐도 빈 칸이다",
  });

  return out;
};

export const check: RegressionCheck = {
  name: "gateway-view-shows-accounting",
  guards:
    "게이트웨이 호출을 펼치면 '요청 (없음) / 응답 (없음)' 뿐이던 것 — 회계·건강은 프런트가 담고도 안 그렸고, 본문은 아예 안 남겼다(그 '안 남긴다' 는 사용자가 정한 게 아니라 내가 정한 것이었고 2026-08-12 에 뒤집혔다)",
  run,
};
