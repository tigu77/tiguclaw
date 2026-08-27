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
 */
import type http from "node:http";
export declare const writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
