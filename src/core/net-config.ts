/**
 * IPv6 Happy-Eyeballs 회피 — 부팅 최상단에서 1회(import 부수효과).
 *
 * 문제(2026-07-23 라이브 사고): IPv6 가 끊긴 환경(예: Tailscale 활성 Mac 에서
 * api.telegram.org 의 IPv6 주소가 블랙홀)에서 node 의 fetch/node-fetch 가 IPv6 연결을
 * 시도하다 ETIMEDOUT → grammy 텔레그램 bot.init·getUpdates·sendMessage 가 전멸했다.
 * 증상: 데몬 프로세스는 살아있는데(/health ok) 텔레그램 커넥션 0 → 스케줄 알림 전부 유실.
 * curl IPv4 는 정상, node 만 못 붙음.
 *
 * 해결: 주소 해석을 IPv4 우선 + autoSelectFamily off → IPv4 직결. node-fetch 도 내부
 * net.connect 기본을 따르므로 함께 적용된다. 실측: 이 설정 후 grammy sendMessage 200 OK.
 *
 * 트레이드오프: IPv6-only 네트워크에서 IPv4 미지원 서비스엔 못 붙지만, 실사용 환경에선
 * IPv4 가 사실상 보편이라 안전. (근본 원인은 그 환경의 IPv6 이나, 데몬을 견고하게 만든다.)
 */
import net from "node:net";
import dns from "node:dns";

// autoSelectFamily(Happy-Eyeballs) off — IPv6 를 시도하다 매달리는 것 자체를 차단.
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}
// 해석 순서 IPv4 우선 — autoSelectFamily off 상태에서 첫 주소(=IPv4)로 붙게.
dns.setDefaultResultOrder("ipv4first");
