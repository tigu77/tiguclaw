/**
 * `log-secret-leak` 의 **동작** 검사용 자식 프로세스 (2026-07-31 3차 검토).
 *
 * ★왜 자식인가: `initFileLogging()` 은 `console.*` 을 전역으로 갈아끼운다. 스위트 안에서
 *  하면 뒤에 오는 검사들이 그 로거를 물려받는다. 그리고 우리가 보려는 것은 **이 프로세스의
 *  stdout/stderr 에 무엇이 실제로 나갔는가** 다 — 부모가 파이프로 받아야 볼 수 있다.
 *
 * ★왜 grep 이 아닌가: 원래 이 자리는 "logging.ts 에 redactSecrets 호출이 있다" 는 정규식
 *  이었다. 호출은 멀쩡히 있었지만 **파일 미러에만** 걸려 있었고, 터미널 경로(`original`)는
 *  원문을 흘려 launchd 가 그걸 평문 파일로 쌓았다(A4d). 정규식은 그 절반을 못 봤다.
 *
 * 부모가 stdout/stderr 를 통째로 읽어 시크릿 문자열이 있는지 본다.
 */
import { initFileLogging } from "../../core/logging.js";

const BOT_TOKEN = process.argv[2] ?? "";
process.env.REGRESSION_CHILD_BOT_TOKEN = BOT_TOKEN;

initFileLogging();

// 실사고 형상 — grammy HttpError 의 내부 FetchError message 에 토큰이 박혀 있고,
// `console.error("...", e)` 의 util.inspect 가 그걸 통째로 펼쳤다.
const inner = new Error(
  `request to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed`,
);
const httpErr = Object.assign(new Error("HTTP error"), {
  name: "HttpError",
  error: inner,
});

console.error("telegram: 발송 실패", httpErr);
console.log(`평문 문자열 안에 섞인 경우도 본다: bot${BOT_TOKEN}/getMe`);
console.warn("객체 필드로 들어간 경우", { url: `https://x/bot${BOT_TOKEN}/y` });

process.exit(0);
