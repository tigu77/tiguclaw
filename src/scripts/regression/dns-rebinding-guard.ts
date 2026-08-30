/**
 * 회귀: **DNS 리바인딩 방어** — Host 허용 판정 (2026-08-24).
 *
 * 대시보드·브리지는 `127.0.0.1` 에 바인드된다. 로컬 프로세스 관점에선 안전하지만,
 * 사용자가 악성 페이지를 열면 **DNS 리바인딩**으로 그 페이지의 JS 가 이 포트에 닿는다:
 * 공격자 도메인을 짧은 TTL 로 두었다가 `127.0.0.1` 로 바꾸면, 브라우저는 그 요청을
 * **same-origin 으로 취급**한다. 셸 접근을 가진 에이전트라 영향이 크다.
 *
 * ★기존 CSRF 가드(2026-08-02)는 이걸 **못 막는다.** 그건 `Sec-Fetch-Site`/`Origin` 으로
 *  same-origin 을 요구하는데, 리바인딩이면 브라우저가 same-origin 이라고 **믿는다**.
 *  두 축이 다르다 — 같은 이름으로 묶으면 하나가 다른 하나를 덮어준다고 착각하게 된다.
 *  그래서 이 검사는 "CSRF 가드가 있으니 됐다" 를 명시적으로 부정한다.
 *
 * ★그리고 **원격을 깨지 않는지**를 같이 지킨다. 실측(2026-08-24): Tailscale 경유 요청의
 *  Host 는 `<node>.<tailnet>.ts.net[:port]` 다. 루프백만 허용하면 원격 대시보드가 죽는데,
 *  그건 조용히 일어난다(사용자는 "왜 안 되지" 만 본다). 그래서 ①명시 허용 목록이 동작하고
 *  ②거부 메시지가 **고치는 법을 그 자리에서** 말하는지까지 본다.
 *
 * ★등급: **행동 게이트**. 판정이 순수 함수라 실행해서 본다. 배선(두 서버가 실제로 이걸
 *  첫 검사로 부르는가)은 소스 대조 — 그 한계는 아래 단언 이름에 적었다.
 */
import { readFile } from "node:fs/promises";
import { readSource } from "./_wiring.js";
import {
  hostnameOf,
  isIpLiteral,
  isLoopbackHostname,
  isAllowedHost,
  parseAllowedHosts,
  rebindRejectionMessage,
} from "../../core/net/host-guard.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const none = new Set<string>();

  // ── ① 공격자 Host 는 막는다 ───────────────────────────────────────────────
  const attacker = [
    "evil.example",
    "evil.example:3101",
    "rebind.attacker.test:7011",
    "127.0.0.1.nip.io", // ★루프백처럼 **보이는** 이름 — 접두 매칭이면 뚫린다
    "localhost.evil.example",
    "notlocalhost",
  ];
  const blocked = attacker.filter((h) => !isAllowedHost(h, none));
  out.push(
    assert(
      "★공격자 Host 를 막는다(루프백처럼 보이는 이름 포함)",
      blocked.length === attacker.length,
      blocked.length === attacker.length
        ? `${attacker.length}종 차단`
        : `★통과됨: ${attacker.filter((h) => isAllowedHost(h, none)).join(", ")}`,
    ),
  );

  // ── ② 로컬은 설정 없이 그대로 ─────────────────────────────────────────────
  const local = [
    "localhost",
    "localhost:3101",
    "127.0.0.1",
    "127.0.0.1:7011",
    "127.0.0.2:3101", // 127/8 전체가 루프백이다
    "[::1]:3101",
    "::1",
  ];
  const okLocal = local.filter((h) => isAllowedHost(h, none));
  out.push(
    assert(
      "로컬(루프백)은 설정 없이 전부 통과 — 기본 사용이 안 깨진다",
      okLocal.length === local.length,
      okLocal.length === local.length
        ? `${local.length}종 통과`
        : `★막힘: ${local.filter((h) => !isAllowedHost(h, none)).join(", ")}`,
    ),
    assert(
      "Host 미전송은 막지 않는다(브라우저는 항상 보낸다 = 공격면 아님)",
      isAllowedHost(undefined, none) && isAllowedHost("", none),
      "undefined·빈 문자열 통과",
    ),
  );

  // ── ②b ★IP 리터럴은 통과 — 리바인딩은 **이름**이 있어야 성립한다 ──────────
  //  사용자 지적("0.0.0.0 으로 열고 싶은 상황이면?"): LAN 을 연 사람이 자기 IP 로 못
  //  들어오면 그가 고른 것을 우리가 되돌리는 셈이다. 그리고 막아도 얻는 안전이 0이다 —
  //  `http://192.168.0.10:3101` 엔 바꿔칠 DNS 이름이 자체가 없다.
  const ipHosts = [
    "192.168.0.10:3101", // LAN (0.0.0.0 바인딩)
    "10.0.0.5",
    "100.88.236.82:3101", // Tailscale IP
    "203.0.113.5:3101", // 공인 IP — 0.0.0.0 으로 연 사람의 선택
    "[fe80::1]:3101",
  ];
  const ipOk = ipHosts.filter((h) => isAllowedHost(h, none));
  out.push(
    assert(
      "★IP 리터럴 Host 는 설정 없이 통과한다(0.0.0.0 으로 연 사람이 자기 IP 로 들어온다)",
      ipOk.length === ipHosts.length,
      ipOk.length === ipHosts.length
        ? `${ipHosts.length}종 통과`
        : `★막힘: ${ipHosts.filter((h) => !isAllowedHost(h, none)).join(", ")}`,
    ),
    assert(
      "그래도 **이름**은 여전히 막는다(IP 를 열었다고 이름까지 열리지 않는다)",
      !isAllowedHost("evil.example", none) && !isAllowedHost("192-168-0-10.evil.example", none),
      "이름 2종 차단",
    ),
  );

  // ── ③ 원격(Tailscale)이 안 깨진다 ─────────────────────────────────────────
  //  실측값 그대로 — 지어낸 이름이 아니다.
  const TS = "tigu77-mac-macbookpro.taild26be9.ts.net";
  const allowed = parseAllowedHosts(` ${TS}:3101 , other.example `);
  out.push(
    assert(
      "★허용 목록에 적으면 원격 Host 가 통과한다(포트를 적어도 받아준다)",
      isAllowedHost(TS, allowed) && isAllowedHost(`${TS}:3101`, allowed),
      `${TS} → ${String(isAllowedHost(TS, allowed))}`,
    ),
    assert(
      "허용 목록은 적은 것만 연다(그 옆 이름은 여전히 막힌다)",
      !isAllowedHost("evil.ts.net", allowed) && isAllowedHost("other.example", allowed),
      `evil.ts.net=${String(isAllowedHost("evil.ts.net", allowed))}`,
    ),
    assert(
      "★거부 메시지가 **고치는 법**을 그 자리에서 말한다(조용히 깨지지 않게)",
      rebindRejectionMessage("x.ts.net", "DASHBOARD_ALLOWED_HOSTS").includes(
        "DASHBOARD_ALLOWED_HOSTS",
      ) && rebindRejectionMessage("x.ts.net", "DASHBOARD_ALLOWED_HOSTS").includes("x.ts.net"),
      rebindRejectionMessage("x.ts.net", "DASHBOARD_ALLOWED_HOSTS").slice(0, 60) + "…",
    ),
  );

  // ── ④ 파싱 경계 ───────────────────────────────────────────────────────────
  out.push(
    assert(
      "Host 파싱 — 포트·대문자·IPv6 대괄호를 정규화한다",
      hostnameOf("LocalHost:3101") === "localhost" &&
        hostnameOf("[::1]:3101") === "::1" &&
        hostnameOf("  Evil.Example  ") === "evil.example",
      "3종 확인",
    ),
    assert(
      "루프백 판정이 8비트 범위를 지킨다(999.0.0.1 같은 건 아니다)",
      isLoopbackHostname("127.0.0.1") &&
        !isLoopbackHostname("127.0.0.999") &&
        !isLoopbackHostname("128.0.0.1"),
      "범위 확인",
    ),
    assert(
      "IP 리터럴 판정도 8비트 범위를 지킨다(`999.1.1.1` 은 이름이지 IP 가 아니다)",
      isIpLiteral("192.168.0.10") && isIpLiteral("fe80::1") && !isIpLiteral("999.1.1.1") &&
        !isIpLiteral("evil.example"),
      "범위 확인",
    ),
  );

  // ── ⑤ 배선 — 두 서버가 **첫 검사**로 부르는가 ─────────────────────────────
  //  ★한계를 적어둔다: 이건 소스 대조다(이름을 바꾸면 뚫린다). 판정 자체는 위에서
  //   실행으로 지키고, 여기선 "그 판정이 실제 요청 경로에 꽂혀 있나" 만 본다.
  const dash = await readFile(
    new URL("../../../packages/dashboard/index.ts", import.meta.url),
    "utf8",
  );
  const bridge = await readSource("../../../plugins/http-bridge");
  const csrfAt = dash.indexOf("sec-fetch-site");
  const guardAt = dash.indexOf("isAllowedHost(req.headers.host");
  out.push(
    assert(
      "대시보드가 Host 가드를 부른다 — 그리고 **CSRF 가드보다 먼저**(GET 도 덮이게)",
      guardAt > 0 && csrfAt > 0 && guardAt < csrfAt,
      guardAt > 0 && csrfAt > 0 && guardAt < csrfAt
        ? "순서 확인"
        : `★guard=${guardAt} csrf=${csrfAt}`,
    ),
    assert(
      "브리지도 같은 함수를 부른다 — 그리고 **/health 보다 먼저**(무인증 응답도 덮이게)",
      bridge.indexOf("isAllowedHost(req.headers.host") > 0 &&
        bridge.indexOf("isAllowedHost(req.headers.host") <
          bridge.indexOf('pathname === "/health"'),
      `guard=${bridge.indexOf("isAllowedHost(req.headers.host")} health=${bridge.indexOf('pathname === "/health"')}`,
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "dns-rebinding-guard",
  guards:
    "악성 페이지가 DNS 리바인딩으로 로컬 대시보드·브리지에 도달하던 것(기존 CSRF 가드는 same-origin 으로 보여 못 막는다) + 그 방어가 원격 Tailscale 접속을 조용히 깨는 것",
  run,
};
export default check;
