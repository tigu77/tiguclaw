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
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";
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

    // ★② 외부 MCP 자식 env — 프로덕션 함수를 **직접 불러** 판정을 본다.
    //  (2026-07-31: 여기 있던 단언은 `process.env` 를 SECRETY 로 거른 뒤 그 결과에
    //   SECRETY 키가 없다고 주장하는 **항등식**이었다 — 프로덕션 코드를 통째로 되돌려도
    //   참이라 P0 을 그대로 통과시켰다. 그래서 `buildChildEnv` 를 export + parentEnv
    //   주입형으로 바꾸고, 아래는 그 함수의 실제 산출물을 본다.)
    const { buildChildEnv } = await import("../../core/external-mcp.js");
    const parentEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "ko_KR.UTF-8",
      MY_API_KEY: "probe-not-a-real-secret-key",
      GITHUB_TOKEN: "probe-not-a-real-secret-token",
      DB_PASSWORD: "probe-not-a-real-secret-pw",
      ANTHROPIC_OAUTH_REFRESH: "probe-not-a-real-secret-refresh",
    };
    const built = buildChildEnv(undefined, parentEnv);
    const crossed = Object.keys(parentEnv).filter(
      (k) => SECRETY.test(k) && k in built,
    );
    out.push(
      assert(
        "★시크릿류 env 키가 자식에게 안 넘어간다",
        crossed.length === 0,
        crossed.length === 0
          ? `시크릿 4종 전부 차단 · 비시크릿 ${Object.keys(built).join(",")} 는 보존`
          : `유출 ${crossed.join(" ")}`,
      ),
    );
    out.push(
      assert(
        "비시크릿 env 는 보존한다(과잉 삭제 0)",
        built.PATH === parentEnv.PATH && built.LANG === parentEnv.LANG,
        `PATH=${String(built.PATH)} LANG=${String(built.LANG)}`,
      ),
    );
    // mcp.json 에 사용자가 직접 적은 env 는 **의도된 위임**이라 시크릿이어도 통과해야 한다.
    const delegated = buildChildEnv({ MY_API_KEY: "intended-by-user" }, parentEnv);
    out.push(
      assert(
        "명시 지정분(config.env)은 시크릿이어도 통과한다",
        delegated.MY_API_KEY === "intended-by-user",
        String(delegated.MY_API_KEY),
      ),
    );

    // ★③ 시크릿 판정이 **세상에 하나**다 (2026-08-01 감사).
    //  종전엔 같은 판정이 `outbound-sanitize`(로그 소독)와 `external-mcp`(자식 env)에
    //  사본으로 있었고, **사본 쪽에만 `CREDENTIAL` 이 있어 이미 어긋나 있었다** —
    //  `*_CREDENTIAL` 값이 외부 자식에게는 안 넘어가는데 로그에는 평문으로 남았다.
    //  사본 쪽 주석은 "의미를 맞춰 둔다" 고 동기화를 주장하고 있었다(말≠실제).
    //  이름을 비교하지 않는다 — **두 소비처가 같은 답을 내는지**를 본다.
    const probeKeys = [
      "MY_CREDENTIAL",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "SOME_API_KEY",
      "A_TOKEN",
      "DB_PASSWORD",
      "HTTP_PORT", // 대조군 — 비밀 아님(둘 다 통과시켜야 한다)
      "LANG",
    ];
    const childEnv = buildChildEnv(
      undefined,
      Object.fromEntries(probeKeys.map((k) => [k, "probe-not-a-real-secret-value"])),
    );
    const { redactSecrets } = await import("../../core/outbound-sanitize.js");
    const disagree: string[] = [];
    for (const k of probeKeys) {
      const blockedFromChild = !(k in childEnv);
      const savedEnv = process.env[k];
      process.env[k] = "probe-not-a-real-secret-value";
      const redactedInLog = !redactSecrets(`값은 probe-not-a-real-secret-value 입니다`).includes(
        "probe-not-a-real-secret-value",
      );
      if (savedEnv === undefined) delete process.env[k];
      else process.env[k] = savedEnv;
      if (blockedFromChild !== redactedInLog) {
        disagree.push(`${k}(자식차단=${blockedFromChild} 로그가림=${redactedInLog})`);
      }
    }
    out.push(
      assert(
        "★시크릿 판정이 두 소비처(로그 소독·자식 env)에서 같은 답을 낸다(사본 드리프트 0)",
        disagree.length === 0,
        disagree.length === 0
          ? `${probeKeys.length}종 전부 일치 (CREDENTIAL 계열 포함)`
          : `★어긋남: ${disagree.join(" ")}`,
      ),
    );
    out.push(
      assert(
        "대조군 — 비밀 아닌 키는 양쪽 다 통과시킨다(과잉 차단 0)",
        "HTTP_PORT" in childEnv && "LANG" in childEnv,
        `HTTP_PORT=${String("HTTP_PORT" in childEnv)} LANG=${String("LANG" in childEnv)}`,
      ),
    );

    // ★그 판정이 **실제 spawn 에 배선**돼 있다 — 진짜 자식을 띄워 자식이 받은 env 를 읽는다.
    //  grep 이 아니라 자식 프로세스가 남긴 파일이 증거다. 호출부가 buildChildEnv 를
    //  건너뛰면(= A1 이 claude 경로에서 하는 일) 이 단언이 빨간불이 된다.
    const { getConnectedExternalMcpBridges, closeAllExternalMcp } = await import(
      "../../core/external-mcp.js"
    );
    const { getPaths } = await import("../../core/paths.js");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const home = getPaths().home;
    const probe = path.join(home, "envprobe.cjs");
    const dump = path.join(home, "envprobe.json");
    // 자식은 받은 env 를 파일로 남기고 즉시 끝난다(유효한 MCP 서버가 아니라 연결은
    //  실패하지만, 우리가 보려는 것은 **spawn 이 물려준 env** 라 그 전에 이미 남는다).
    await fs.writeFile(
      probe,
      `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: { envprobe: { command: process.execPath, args: [probe] } },
      }),
      "utf8",
    );
    const prevSecret = process.env.REGRESSION_PROBE_OAUTH_TOKEN;
    process.env.REGRESSION_PROBE_OAUTH_TOKEN = "probe-only-not-a-real-secret";
    try {
      await closeAllExternalMcp(); // connectPromise 초기화 — 우리 config 로 새로 붙는다.
      const r = await within(15000, "외부 MCP 자식 spawn", getConnectedExternalMcpBridges());
      let got: Record<string, string> | null = null;
      try {
        got = JSON.parse(await fs.readFile(dump, "utf8")) as Record<string, string>;
      } catch {
        got = null;
      }
      const childSecrets =
        got === null ? [] : Object.keys(got).filter((k) => SECRETY.test(k));
      out.push(
        assert(
          "★실제 spawn 된 외부 MCP 자식 env 에 시크릿이 0개다",
          got !== null && childSecrets.length === 0,
          got === null
            ? `자식이 env 를 안 남김(${"timedOut" in r ? r.timedOut : "spawn 실패"}) — 배선 확인 불가`
            : `자식 env ${Object.keys(got).length}키 중 시크릿 ${childSecrets.length}개${childSecrets.length > 0 ? ` (${childSecrets.slice(0, 5).join(",")})` : ""}`,
        ),
      );
      out.push(
        assert(
          "그 자식은 부모의 실제 시크릿도 못 받는다",
          got !== null && !("REGRESSION_PROBE_OAUTH_TOKEN" in got),
          got === null ? "자식 env 없음" : "부모 토큰 미도달",
        ),
      );
    } finally {
      if (prevSecret === undefined) delete process.env.REGRESSION_PROBE_OAUTH_TOKEN;
      else process.env.REGRESSION_PROBE_OAUTH_TOKEN = prevSecret;
      await closeAllExternalMcp();
    }
    return out;
  },
};
