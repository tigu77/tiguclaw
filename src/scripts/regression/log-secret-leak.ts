/**
 * 회귀: **로그 파일에 시크릿·PII 가 평문으로 남지 않는다** (2026-07-31 전체검토 P0).
 *
 * 사고: grammy `HttpError` 의 own property `error`(내부 FetchError)의 message 가
 * `request to https://api.telegram.org/bot<TOKEN>/sendMessage failed` 라서,
 * `console.error("...", e)` 의 `util.inspect` 가 **현재 유효한 봇 토큰**을 평문으로 찍었다.
 * 실측 **468회**(daemon 234 + launchd.err 234). 같은 자리에서 `payload.chat_id`(실 텔레그램
 * id)와 `payload.text`(발신 본문 전문)도 통째로 펼쳐져 **1,780줄**이 쌓였다.
 *
 * ★뼈아픈 대칭: 커밋 4d4a18c 가 `/logs` **출구**에서 막은 바로 그 부류가 **입구에서**
 *  그대로 들어오고 있었다. 출구만 보고 입구를 안 봤다.
 *
 * 두 계층으로 닫는다 — 하나로는 부족하다는 걸 실측으로 확인했다:
 *  ①**로거 관문**(`logging.ts`)에서 `redactSecrets` — 모든 `console.*` 이 디스크로 가는
 *   단일 지점이라 호출부를 열거하지 않아도 현재·미래 모듈이 전부 덮인다. 토큰을 잡는다.
 *   (실측: 885자 → 868자, 토큰 ✅ / chatId·본문 🔴)
 *  ②**발생원 요약**(`describeTelegramError`) — redact 는 env 값 매칭이라 chat_id·본문 같은
 *   **비밀 아닌 PII** 는 원리적으로 못 잡는다. payload 를 애초에 안 만든다.
 *   (실측: 885자 → 45자 / 646자 → 94자, 세 축 전부 ✅)
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

/**
 * 시크릿 **형상** 픽스처 — 조각으로 조립한다.
 *
 * ★소독을 검사하는 코드는 본질적으로 시크릿처럼 생긴 입력이 필요하다. 그런데 리터럴로
 *  적으면 public 싱크의 시크릿 게이트(`[0-9]{8,10}:[A-Za-z0-9_-]{30,}`)에 걸린다.
 *  게이트에 예외(allowlist)를 파는 건 금지다 — 그러면 나중에 **진짜** 유출이 그 구멍으로
 *  나간다. 대신 조립해서 리터럴이 파일에 안 남게 한다(값은 완전 합성).
 *
 *  첫 판에서는 실제 봇의 숫자 ID 를 검토 출력에서 그대로 옮겨 적었다가 게이트에 걸렸다 —
 *  **픽스처도 배포되는 파일**이고, 봇 ID 는 그 자체로 식별 정보다. 게이트가 두 번 잡아줬다.
 */
const SYNTHETIC_TOKEN = `${"0".repeat(10)}:${"SYNTHETIC_FIXTURE_no_real_secret_here"}`;
const FOREIGN_TOKEN = `${"1234567890"}:${"Z".repeat(8)}${"synthetic".repeat(3)}`;

export const check: RegressionCheck = {
  name: "log-secret-leak",
  guards:
    "grammy 에러 객체를 통째로 찍어 봇 토큰 468회·chat_id·발신 본문 전문이 로그 파일에 평문으로 쌓이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 로거 관문이 실제로 소독한다 — 부를 수 있는 순수 함수라 동작으로 본다.
    const { redactSecrets } = await import("../../core/outbound-sanitize.js");
    const prev = process.env.REGRESSION_FAKE_TOKEN;
    // ★값은 **완전 합성**이다. 첫 판에서 실제 봇의 숫자 ID(토큰 앞부분)를 검토 출력에서
    //  그대로 옮겨 적었다가 public 싱크의 시크릿 게이트에 걸렸다 — 픽스처도 배포되는 파일이고,
    //  봇 ID 는 그 자체로 식별 정보다. 게이트가 잡아준 게 두 번째다.
    process.env.REGRESSION_FAKE_TOKEN = SYNTHETIC_TOKEN;
    try {
      const fake = process.env.REGRESSION_FAKE_TOKEN;
      const line = redactSecrets(
        `telegram send failed: request to https://api.telegram.org/bot${fake}/sendMessage failed`,
      );
      out.push(
        assert(
          "★env 시크릿이 로그 문자열에서 가려진다(값 매칭 1층)",
          !line.includes(fake) && line.includes("[REDACTED:REGRESSION_FAKE_TOKEN]"),
          line.slice(0, 110),
        ),
      );
    } finally {
      if (prev === undefined) delete process.env.REGRESSION_FAKE_TOKEN;
      else process.env.REGRESSION_FAKE_TOKEN = prev;
    }

    // env 에 없는 봇 토큰(다른 인스턴스·회전본)도 형상으로 잡는다.
    const foreign = redactSecrets(`bot${FOREIGN_TOKEN} 로 요청`);
    out.push(
      assert(
        "env 밖 봇 토큰도 형상 패턴으로 가려진다(2층)",
        !foreign.includes(FOREIGN_TOKEN),
        foreign.slice(0, 90),
      ),
    );

    // ★② 로거가 그 소독을 **실제로 호출한다**(규칙만 있고 안 부르면 무의미).
    const wired = await sourceHas("../../core/logging.ts", [
      /import \{ redactSecrets \} from "\.\/outbound-sanitize\.js";/,
      /\$\{redactSecrets\(format\(\.\.\.args\)\)\}/,
    ]);
    out.push(
      assert(
        "★로거가 파일에 쓰기 직전 redactSecrets 를 통과시킨다",
        wired.ok,
        wired.ok ? "관문 배선 확인" : `누락 ${wired.missing.join(" ")}`,
      ),
    );

    // ★③ 발생원이 에러 객체를 통째로 넘기지 않는다 — redact 로는 못 잡는 PII 축.
    const summarized = await sourceHas("../../../plugins/telegram-channel/index.ts", [
      /const describeTelegramError = \(e: unknown\): string =>/,
      // 진단 수치는 남긴다(에러코드·설명·메서드·본문 길이).
      /GrammyError \$\{e\.error_code\} \$\{e\.description\} \(method=/,
      // HttpError 는 message 를 쓰지 않는다 — 그 안에 토큰이 있다.
      /HttpError\(transport\)/,
    ]);
    const rawDump = await sourceHas("../../../plugins/telegram-channel/index.ts", [
      // `console.error("...", e)` 형태 = 객체 통째로 넘기기. 하나도 남으면 안 된다.
      /console\.(?:error|warn|log)\([^)]*",\s*(?:e|e2|err)\s*\)/,
    ]);
    out.push(
      assert(
        "★텔레그램 채널이 에러 객체를 통째로 로그에 넘기지 않는다(payload 미생성)",
        summarized.ok && !rawDump.ok,
        summarized.ok && !rawDump.ok
          ? "요약 경로 확인"
          : rawDump.ok
            ? "console.*(…, e) 형태가 되살아났다 — payload 가 통째로 펼쳐진다"
            : `누락 ${summarized.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
