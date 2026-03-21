# Contributing to tiguclaw

## 개발 환경
- Rust 1.75+
- Telegram Bot Token (BotFather에서 생성)
- Anthropic API Key

## 빠른 시작
```bash
git clone https://github.com/tigu77/tiguclaw
cd tiguclaw
cp .env.example .env
# .env 파일 편집
cargo run
```

## 구조
```
crates/
├── core/         # Config, 타입, 트레이트
├── agent/        # AgentLoop, 툴, 스케줄러
├── memory/       # SQLite 메모리, AgentStore
├── hooks/        # HTTP Hooks API (axum)
├── provider-anthropic/  # Claude API
└── channel-telegram/    # Telegram 채널
src/
└── main.rs       # 진입점
```

## 기여 방법
1. Fork → 브랜치 → PR
2. `cargo clippy` 경고 0개 유지
3. `cargo test` 통과
4. 커밋 메시지: `feat/fix/chore(scope): 설명`
