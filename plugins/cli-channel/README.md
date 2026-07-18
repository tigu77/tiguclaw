# cli-channel

CLI(stdin readline) 채널 플러그인 — `name: "cli"`. 코어 `src/channels/cli.ts` 에서
이전(2026-07-18, telegram-channel 동형). tiguclaw 를 터미널에서 인터랙티브로 돌릴 때
콘솔 입출력 채널. 데몬(비대화)에선 stdin 미입력이라 사실상 inert.

"채널=전부 균일 착탈식 능력" 비전의 일부 — 코어에 하드코딩 채널 0.
