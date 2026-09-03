# telegram-channel

텔레그램 채널 플러그인 — `Channel` 구현(grammy 폴링 + inline 선택지 + 첨부 + outbound).
런타임 채널명은 `telegram`(manifest `name`). `TELEGRAM_BOT_TOKEN` 있으면 `status:"up"`·폴링, 없으면 `status:"disabled"`·self-disable(목록엔 균일 표시, 409 hazard 0).

채널 플러그인이 무엇을 구현하는지는 [`docs/plugins.ko.md`](../../docs/plugins.ko.md) §2 의 `kind: channel` 을 보세요.
