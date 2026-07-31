/**
 * 회귀: **자격증명이 경계를 넘지 않는다** (2026-07-31 전체검토 P0 2건).
 *
 * ①**외부 MCP 자식이 토큰 전부를 상속받았다.** `buildEnv` 가 `process.env` 를 통째로
 *  넘겼는데, MCP SDK 는 그 필드를 주면 **자기 안전 기본값을 통째로 대체**한다
 *  (`stdio.js`: `{...getDefaultEnvironment(), ...serverParams.env}`, 기본값은
 *  HOME·LOGNAME·PATH·SHELL·TERM·USER 6개뿐 — 주석에 "deemed safe to inherit").
 *  즉 SDK 가 일부러 막아둔 걸 되돌렸다. 실측: 자식 env 에 시크릿 **8종**.
 *  `add_mcp_server` 는 비서가 스스로 쓰는 도구라, 검토 안 된 npm 패키지가 오는 게 정상 경로다.
 *
 * ②**`?token=` 이 `$QUERY` 로 프롬프트에 들어갔다.** EventSource 가 헤더를 못 실어서
 *  이 배포는 `?token=` 을 1급 인증 수단으로 쓴다. 그 값이 ①외부 LLM 제공자로 송신
 *  ②`endpoint.call` 이벤트로 **read 토큰 청취자**에게 ③`transcripts` 에 평문 영구 적재
 *  (FTS 색인까지) 됐다. 실증: read 토큰만으로 write 토큰을 획득해 `POST /messages` 200.
 *  `redactSecrets` 로는 못 막는다 — 그건 **env 값 매칭**인데 이 토큰은 `bridge_tokens`
 *  DB 발급본이라 env 에 없다. 07-28 에 "저권한이 admin 토큰을 관측" 을 막았는데
 *  **env 토큰만 닫고 role 계층이 스스로 찍어낸 자격증명은 열어둔 채**였다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

const SECRETY = /KEY|TOKEN|SECRET|REFRESH|PASSWORD|OAUTH|CREDENTIAL/i;

export const check: RegressionCheck = {
  name: "credential-boundary",
  guards:
    "외부 MCP 자식이 토큰 8종을 상속받고, ?token= 인증값이 $QUERY 로 프롬프트·이벤트·transcripts 에 새던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① $QUERY 소독 — 순수 함수라 동작으로 본다.
    const { stripAuthParams } = await import("../../core/entry/endpoint-registry.js");
    const cases: Array<[string, string]> = [
      ["?token=2fac9343c96c7b5deadbeef&foo=bar", "2fac9343"],
      ["?foo=bar&access_token=xyzSECRET&baz=1", "xyzSECRET"],
      ["?TOKEN=upperSECRET", "upperSECRET"], // 대소문자 무관
      ["?api_key=k1&apikey=k2&key=k3", "k1"],
    ];
    const leaked = cases.filter(([q, secret]) => stripAuthParams(q).includes(secret));
    out.push(
      assert(
        "★인증 파라미터가 $QUERY 치환값에서 제거된다",
        leaked.length === 0,
        leaked.length === 0
          ? `${cases.length}종 전부 제거`
          : `유출 ${leaked.map(([q]) => q).join(" ")}`,
      ),
    );
    // 나머지 파라미터는 보존한다 — 과잉 삭제면 엔드포인트가 망가진다.
    const kept = stripAuthParams("?foo=bar&access_token=x&baz=1");
    out.push(
      assert(
        "인증 아닌 파라미터는 보존한다(과잉 삭제 0)",
        kept.includes("foo=bar") && kept.includes("baz=1"),
        kept,
      ),
    );
    // 잘렸다는 사실을 남긴다 — 조용히 지우면 "왜 파라미터가 없지" 로 오진한다.
    out.push(
      assert(
        "잘라낸 개수를 표시한다(조용히 지우지 않는다)",
        stripAuthParams("?token=a&b=1").includes("__auth_removed=1") &&
          !stripAuthParams("?b=1").includes("__auth_removed"),
        stripAuthParams("?token=a&b=1"),
      ),
    );

    // ★그 소독이 실제로 치환 지점에 배선돼 있다(규칙만 있고 안 부르면 무의미).
    const wired = await sourceHas("../../core/entry/endpoint-registry.ts", [
      /\.replaceAll\("\$QUERY", stripAuthParams\(params\.query\)\)/,
    ]);
    out.push(
      assert(
        "★expandEndpoint 가 소독된 query 를 쓴다",
        wired.ok,
        wired.ok ? "배선 확인" : `누락 ${wired.missing.join(" ")}`,
      ),
    );

    // ★② 외부 MCP 자식 env — 판정 자체를 동작으로 본다(실제 spawn 은 느려서 판정만).
    const prev = process.env.REGRESSION_FAKE_OAUTH_TOKEN;
    process.env.REGRESSION_FAKE_OAUTH_TOKEN = "probe-only-not-a-real-secret-0123456789";
    try {
      const inherited = Object.keys(process.env).filter(
        (k) => !SECRETY.test(k), // buildEnv 와 동일 판정
      );
      out.push(
        assert(
          "★시크릿류 env 키가 자식 상속 목록에서 빠진다",
          !inherited.includes("REGRESSION_FAKE_OAUTH_TOKEN"),
          `상속 대상 ${inherited.length}개 / 시크릿 후보 ${Object.keys(process.env).length - inherited.length}개 제외`,
        ),
      );
    } finally {
      if (prev === undefined) delete process.env.REGRESSION_FAKE_OAUTH_TOKEN;
      else process.env.REGRESSION_FAKE_OAUTH_TOKEN = prev;
    }

    // 배선 — buildEnv 가 그 판정을 쓰고, 명시 지정분(config.env)은 통과시킨다.
    const envWired = await sourceHas("../../core/external-mcp.ts", [
      /const SECRET_ENV_KEY_RE = \/KEY\|TOKEN\|SECRET\|REFRESH\|PASSWORD\|OAUTH\|CREDENTIAL\/i;/,
      /if \(SECRET_ENV_KEY_RE\.test\(k\)\) continue;/,
      // 사용자가 mcp.json 에 직접 적은 env 는 의도된 위임이라 그대로 넘긴다.
      /return \{ \.\.\.base, \.\.\.\(extra \?\? \{\}\) \};/,
    ]);
    out.push(
      assert(
        "★buildEnv 가 시크릿을 거르고 명시 지정분만 통과시킨다",
        envWired.ok,
        envWired.ok ? "3개 확인" : `누락 ${envWired.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
