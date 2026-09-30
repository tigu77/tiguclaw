#!/usr/bin/env node
// 가짜 `claude setup-token` — 진짜처럼 **TTY 가 아니면 아무것도 안 찍는다**(실측: 비TTY 면 출력 0). 가짜 터미널 중계를 거쳐야만 돈다.
if (!process.stdout.isTTY) process.exit(3);
process.stdout.write("\x1b[1mWelcome\x1b[0m\r\nBrowser didn't open? Use the url below\r\n");
process.stdout.write(`https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s${"q".repeat(300)}\r\n`);
// 진짜 발급기처럼 **프롬프트를 그리기 전에** raw 모드다(안 그러면 먼저 온 입력이 cooked 로 들어가 \r 이 \n 이 된다).
process.stdin.setRawMode?.(true);
process.stdout.write("\x1b[2KPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\x1b[1C");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (!buf.includes("\r")) return;
  const code = buf.split("\r")[0];
  if (code === "good-code#st") {
    process.stdout.write(`\r\nYour OAuth token (valid for 1 year):\r\n\r\nsk-ant-oat01-${"A".repeat(90)}\r\n\r\nStore this token securely.\r\n`);
    setTimeout(() => process.exit(0), 100);
  } else {
    process.stdout.write("\r\nOAuth error: Request failed with status code 400\r\nPress Enter to retry.\r\n");
  }
});
