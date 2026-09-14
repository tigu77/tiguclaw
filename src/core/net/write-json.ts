// src/core/net/write-json.ts
/**
 * 브리지의 **모든 JSON 응답**이 지나는 한 자리 (179개 호출부).
 *
 * ★**직렬화를 헤더보다 먼저 한다.** 반대 순서(종전)면 `JSON.stringify` 가 던질 때 헤더는
 *  이미 나갔는데 응답은 안 끝난 상태가 된다. 그 예외를 받은 상위가 500을 쓰려다
 *  `ERR_HTTP_HEADERS_SENT` 로 **다시** 던져 `unhandledRejection` → **데몬 crash-fast** 다.
 *  요청 하나가 프로세스를 죽인다(v0.39.0 적대 검토 G축 ③, 격리 재현됨).
 *
 * 순서만 바꾸면 던져도 **헤더 미전송**이라 상위가 정상적으로 500을 쓸 수 있다. 던지는 것을
 * 막지는 않는다 — 막으면 직렬화 불가를 200으로 덮게 되고, 그건 조용한 오답이다.
 *
 * ★index.ts 안에 있던 것을 **부를 수 있게** 떼어냈다. 종전엔 파일 한복판의 지역 const 라
 *  검사할 방법이 소스 grep 뿐이었고, grep 은 두 줄의 **순서**를 지키기에 약하다
 *  ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못 놓인 것").
 *
 * ★**자리가 `plugins/` 가 아니라 `src/core/net/` 인 이유**: 회귀가 이걸 부르는데, `plugins/`
 *  는 `tsc` 의 `rootDir`(=`src`) 밖이라 `npm run build` 가 TS6059 로 죽는다. 첫 판이 정확히
 *  그랬고 **릴리스 업데이트-경로 게이트가 push 전에 잡았다**. 게다가 이건 플러그인 것이
 *  아니라 **일반 HTTP 응답 헬퍼**다 — 옆의 `host-guard.ts` 와 같은 층이 맞다.
 */
import type http from "node:http";

export const writeJson = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // ★**413 은 연결을 닫는다** (2026-09-14, 회귀가 잡았다). 본문이 크면 우리는 읽기를
    //  멈추고 거절하는데, 그러면 소켓엔 **아직 안 받은 본문**이 남는다. keep-alive 로 그
    //  소켓을 재사용한 **다음 요청**이 그 잔여물을 헤더로 읽어 깨진다(실측: 6초 지연 뒤
    //  connection reset). 거절의 대가를 다음 요청이 치르면 안 된다.
    ...(status === 413 ? { Connection: "close" } : {}),
  });
  res.end(payload);
};
