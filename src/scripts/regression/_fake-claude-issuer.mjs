#!/usr/bin/env node
// 가짜 `claude setup-token` — 진짜처럼 **TTY 가 아니면 아무것도 안 찍는다**(실측: 비TTY 면 출력 0). 가짜 터미널 중계를 거쳐야만 돈다.
if (!process.stdout.isTTY) process.exit(3);
// 회귀가 «부모가 죽으면 같이 끝나나» 를 보려고 자기 pid 를 남긴다.
if (process.env.FAKE_ISSUER_PIDFILE) (await import("node:fs")).writeFileSync(process.env.FAKE_ISSUER_PIDFILE, String(process.pid));
// pty 가 닫혀도(SIGHUP) 안 죽는 발급기 — 중계가 **직접 죽이는지** 를 본다(SIGHUP 에 기대면 그 줄을 지워도 초록이었다, 적대 검토).
if (process.env.FAKE_ISSUER_IGNORE_HUP) process.on("SIGHUP", () => {});
process.stdout.write("\x1b[1mWelcome\x1b[0m\r\nBrowser didn't open? Use the url below\r\n");
process.stdout.write(`https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s${"q".repeat(300)}\r\n`);
// 진짜 발급기처럼 **프롬프트를 그리기 전에** raw 모드다(안 그러면 먼저 온 입력이 cooked 로 들어가 \r 이 \n 이 된다).
process.stdin.setRawMode?.(true);
process.stdout.write("\x1b[2KPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\x1b[1C");
let buf = "";
process.stdin.on("data", (d) => {
  // 진짜 발급기처럼 — **한 덩어리로 온 긴 입력은 붙여넣기**로 보고 그 안의 엔터를 제출로 치지 않는다(2026-10-14 실측:
  //  94자 코드+엔터를 한 번에 쓰면 무반응, 따로 쓰면 제출). 짧은 입력은 종전대로.
  const chunk = d.toString();
  buf += chunk.length > 40 ? chunk.replace(/\r/g, "") : chunk;
  if (!buf.includes("\r")) return;
  const code = buf.split("\r")[0];
  if (code === "silent-code#st") return; // 답하지 않는 발급기 — 마무리가 기다리는 사이 버튼을 다시 누르는 경우를 만든다
  if (code === "good-ink#st") {
    // 진짜 발급기(Ink) 화면처럼 — 낱말 사이를 공백 대신 «오른쪽 1칸»(ESC[1C)으로 그리고, 토큰 바로 뒤에 낱말이 온다(2026-10-14).
    const C = "\x1b[1C";
    process.stdout.write(`\r\nYour${C}OAuth${C}token${C}(valid${C}for${C}1${C}year):\r\n\r\nsk-ant-oat01-${"C".repeat(90)}${C}Store${C}this${C}token${C}securely.\r\n`);
    setTimeout(() => process.exit(0), 100);
    return;
  }
  if (code === "good-code#st" || code.startsWith("good-long-")) {
    process.stdout.write(`\r\nYour OAuth token (valid for 1 year):\r\n\r\nsk-ant-oat01-${"A".repeat(90)}\r\n\r\nStore this token securely.\r\n`);
    setTimeout(() => process.exit(0), 100);
  } else {
    process.stdout.write("\r\nOAuth error: Request failed with status code 400\r\nPress Enter to retry.\r\n");
  }
});
