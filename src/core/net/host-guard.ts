/**
 * **DNS 리바인딩 방어** — Host 헤더 허용 판정 (2026-08-24).
 *
 * 왜 필요한가: 대시보드·브리지는 `127.0.0.1` 에 바인드된다. 로컬 프로세스 관점에선
 * 안전하지만, 사용자가 악성 페이지를 열면 **DNS 리바인딩**으로 그 페이지의 JS 가 이
 * 포트에 도달한다. 공격자 도메인의 DNS 를 짧은 TTL 로 두었다가 `127.0.0.1` 로 바꾸면,
 * 브라우저는 그 요청을 **same-origin 으로 취급**한다.
 *
 * ★그래서 기존 CSRF 가드(`Sec-Fetch-Site`/`Origin` same-origin 강제, 2026-08-02)로는
 *  **안 막힌다.** 브라우저가 same-origin 이라고 믿으니 그 검사는 통과한다. 이건 CSRF 와
 *  다른 축이다 — 같은 이름으로 묶으면 하나가 다른 하나를 막아준다고 착각하게 된다.
 *
 * ★`X-Forwarded-*` 로 판정하면 안 된다. 리바인딩된 요청은 same-origin 이라 프리플라이트가
 *  없고, JS 가 그 헤더를 **임의로 붙일 수 있다**. 경계가 될 수 있는 건 브라우저가 절대
 *  위조하지 못하는 `Host`(= 그 페이지의 출처 이름)뿐이다. 공격자 페이지의 Host 는
 *  `evil.example` 이지 `localhost` 가 아니다.
 *
 * ★**IP 리터럴은 통과시킨다** (2026-08-24 사용자 지적: "0.0.0.0 으로 열고 싶은 상황이면?").
 *  리바인딩은 **이름**이 있어야 성립하므로 IP 로 들어온 요청은 이 공격이 아니다. 그래서
 *  `DASHBOARD_HOST=0.0.0.0` 으로 LAN 을 연 사람은 **설정 없이** 자기 IP 로 들어온다.
 *  Tailscale 도 IP(100.x)로는 바로 되고, MagicDNS **이름**으로 쓸 때만 목록에 적는다.
 *
 * ★원격 접속을 깨지 않는다 — 실측(2026-08-24): Tailscale 경유 요청의 Host 는
 *  `<node>.<tailnet>.ts.net[:port]` 다. 그래서 루프백만 허용하면 원격이 죽는다.
 *  `*.ts.net` 을 코드에 박지 않는다(벤더 이름을 코어에 새기는 것 + 그 도메인의 DNS 를
 *  우리가 보증할 수 없다) — 대신 **명시 허용 목록**을 둔다. 거부는 **시끄럽게**, 그리고
 *  고치는 법을 그 자리에서 말한다(조용히 깨지면 사용자는 이유를 모른다).
 */

/** 포트를 떼고 소문자로 — `[::1]:3101` · `LocalHost:80` 같은 형태 전부. */
export const hostnameOf = (hostHeader: string | undefined | null): string => {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (raw === "") return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : ""; // `[::1]:3101` → `::1`
  }
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
};

/**
 * 루프백 — 이름과 IPv4/IPv6 전부.
 *
 * ★`127.0.0.0/8` **전체**를 받는다(`127.0.0.1` 만이 아니라). 리눅스·맥은 그 대역 전부가
 *  루프백이고, 실제로 `127.0.0.2` 로 바인드해 쓰는 배치가 있다. 여기서 좁히면 그 배치가
 *  깨지는데, 넓혀도 공격면은 안 커진다 — 어차피 공격자는 그 이름으로 도달할 수 없다.
 */
const LOOPBACK_NAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);
export const isLoopbackHostname = (h: string): boolean => {
  if (h === "") return false;
  if (LOOPBACK_NAMES.has(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m === null) return false;
  return m.slice(1).every((p) => Number(p) <= 255) && Number(m[1]) === 127;
};

/**
 * **IP 리터럴인가** — v4 점4개 또는 v6(콜론 포함).
 *
 * ★이게 이 방어의 경계선이다: **DNS 리바인딩은 이름이 있어야 성립한다.** 공격자는
 *  자기 도메인의 DNS 를 127.0.0.1 로 바꿔치기하는데, 브라우저가 `http://192.168.0.10:3101`
 *  로 갈 땐 **조회할 이름이 없다** — 바꿔칠 것이 없다. 그래서 Host 가 IP 리터럴이면
 *  리바인딩이 아니고, 막아도 얻는 게 없다(막으면 `DASHBOARD_HOST=0.0.0.0` 으로 LAN 을
 *  연 사람이 자기 IP 로 못 들어온다 — 고른 것을 우리가 되돌리는 셈).
 *
 * ★공인 IP 도 받는다. 0.0.0.0 으로 연 사람에게 "직접 접속" 은 이미 그가 고른 것이고,
 *  Host 가드는 애초에 인증 경계가 아니다(그 자리는 토큰·네트워크가 맡는다). 여기서
 *  범위를 나누면 사설/공인 표를 손으로 들고 다니게 되는데 얻는 안전이 0이다.
 */
export const isIpLiteral = (h: string): boolean => {
  if (h === "") return false;
  if (h.includes(":")) return true; // v6 — `hostnameOf` 가 대괄호를 이미 벗겼다.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
};

/** 콤마 목록 → 소문자 호스트명 집합. 포트를 적어도 받아준다(사람이 그렇게 적는다). */
export const parseAllowedHosts = (raw: string | undefined): Set<string> => {
  const out = new Set<string>();
  for (const part of String(raw ?? "").split(",")) {
    const h = hostnameOf(part);
    if (h !== "") out.add(h);
  }
  return out;
};

/**
 * 이 Host 로 들어온 요청을 받아도 되나.
 *
 * ★Host 가 **없으면 거부하지 않는다.** HTTP/1.0 클라이언트·일부 진단 도구는 안 보낸다.
 *  브라우저는 **항상** 보내므로, 부재는 "브라우저가 아니다" 는 뜻이고 공격면이 아니다.
 *  (여기서 막으면 로컬 셸 자동화만 깨지고 방어엔 보탬이 0이다 — CSRF 가드와 같은 판단.)
 */
export const isAllowedHost = (
  hostHeader: string | undefined | null,
  allowed: ReadonlySet<string>,
): boolean => {
  const h = hostnameOf(hostHeader);
  if (h === "") return true; // Host 미전송 = 브라우저 아님.
  // 순서가 곧 논리다: 리바인딩 불가(IP 리터럴) → 루프백 이름 → 사용자가 연 이름.
  return isIpLiteral(h) || isLoopbackHostname(h) || allowed.has(h);
};

/** 거부 응답 본문 — **고치는 법을 그 자리에서** 말한다(조용한 실패 금지). */
export const rebindRejectionMessage = (
  hostHeader: string | undefined | null,
  envVar: string,
): string =>
  `허용되지 않은 Host '${hostnameOf(hostHeader)}' — DNS 리바인딩 방어로 차단했습니다. ` +
  `원격(예: Tailscale)으로 쓰신다면 그 이름을 .env 의 ${envVar} 에 콤마로 추가하세요 ` +
  `(예: ${envVar}=my-box.tailnet.ts.net). 로컬은 설정 없이 그대로 됩니다.`;
