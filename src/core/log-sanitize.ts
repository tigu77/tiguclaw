// src/core/log-sanitize.ts
/**
 * `/logs` 로 나가는 데몬 로그에서 **대화 캐리어를 지운다** (2026-07-31).
 *
 * ★왜 별도 모듈인가: 이 규칙이 깨지면 결과가 **다른 세션의 대화·chatId 유출**이라 그물이
 *  문자열 grep 이 아니라 **실제 동작**이어야 한다. index.ts 안에 두면 import 만으로 데몬이
 *  뜨므로 회귀 검사가 부를 수 없었다(실제로 처음엔 grep 만 걸었다가, 픽스처에 진짜 chatId 를
 *  넣는 바람에 public 싱크의 PII 게이트에 걸려 발각됐다 — 게이트가 제 역할을 했다).
 *
 * `redactSecrets` 는 env 값·토큰 패턴만 지운다. 로그엔 그 밖에 이런 게 들어간다:
 *  - `tail: …`      stream-trace·codex-turn-end 가 싣는 **모델 응답 서술**
 *  - `userText=…`   빈 응답 진단이 싣는 **사용자 원문**
 *  - `raw=…`        백엔드 원문 payload
 *  - `addr=`·`tg:`  텔레그램 chatId(PII)
 * 텔레그램은 영구 보존이고 `channel.message.out` 은 chat_log·events 에 적재된다.
 *
 * 지우면 안 되는 것 = **진단 수치**(`model=`·`req=`·`iter=`·`closing=`). /logs 를 만든
 * 이유가 그것이므로, 회귀가 양쪽(지워짐·남음)을 함께 본다.
 */
export const stripLogPayloads = (line: string): string =>
  line
    // `tail: …` 이후는 모델·사용자 발화 서술이다(stream-trace·codex-turn-end).
    .replace(/\btail:\s.*$/u, "tail: <생략>")
    // 빈 응답 진단이 싣는 사용자 원문.
    .replace(/\buserText=.*$/u, "userText=<생략>")
    // 백엔드 원문 payload.
    .replace(/\braw=.*$/u, "raw=<생략>")
    // 텔레그램 chatId 등 채널 좌표(PII).
    .replace(/\b(addr|target)=\d{6,}/gu, "$1=<가림>")
    .replace(/\btg:\d{6,}/gu, "tg:<가림>");
