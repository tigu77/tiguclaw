# 🐯 tiguclaw

<p align="center">
  <strong>Rust로 만든 에이전트 OS — 텔레그램으로 AI 에이전트 군단을 spawn, 지휘, 모니터링.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/built_with-Rust-orange?style=for-the-badge&logo=rust" alt="Built with Rust"></a>
  <img src="https://img.shields.io/badge/AI-LLM_Agnostic-blueviolet?style=for-the-badge" alt="LLM Agnostic">
</p>

> 슈퍼마스터 하나. 무제한 서브에이전트. 실시간 대시보드.

[English](README.md) | 한국어

---

## tiguclaw란?

tiguclaw는 Rust로 작성된 경량 에이전트 운영체제입니다. L0~L3 계층 구조의 AI 에이전트들이 서로 spawn하고, IPC로 소통하며, 내장 웹 대시보드에서 실시간으로 모니터링됩니다. 모든 제어는 텔레그램에서.

## 빠른 시작

### 필요 조건

- [Rust](https://rustup.rs)
- 텔레그램 봇 토큰 ([@BotFather](https://t.me/BotFather))
- Anthropic API 키 ([console.anthropic.com](https://console.anthropic.com))

### 설치

```bash
git clone https://github.com/tigu77/tiguclaw
cd tiguclaw
bash install.sh   # 빌드 후 ~/.local/bin 에 설치
```

> **한 줄 설치** (저장소 공개 후):
> ```bash
> curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.sh | bash
> ```

### 초기 설정 (최초 1회)

```bash
mkdir ~/.tiguclaw && cd ~/.tiguclaw
tiguclaw init     # 대화형: 봇 토큰, API 키, 에이전트 이름 입력
```

### 실행

```bash
tiguclaw gateway install   # 백그라운드 서비스로 등록
```

## 아키텍처

```
tiguclaw (단일 바이너리)
├── 에이전트 루프 (L0 슈퍼마스터)
│   ├── L1 마스터 에이전트 (상주, 봇 토큰 선택)
│   │   ├── L2 미니 에이전트 (내부 IPC)
│   │   └── L3 워커 에이전트 (임시 작업)
├── REST API + WebSocket (axum, 포트 3002)
└── 대시보드 (정적 파일 — ~/.tiguclaw/dashboard/)
```

## 에이전트 폴더 구조

```
agents/
├── supermaster/
│   ├── agent.toml    ← 역할/레벨/허용 툴/한도
│   └── AGENT.md      ← 에이전트 정체성/능력 정의
├── researcher/
├── coder/
└── analyst/

shared/               ← 모든 에이전트 공유
├── CORE.md           ← 공통 원칙
├── USER.md           ← 사용자 프로파일
└── MEMORY.md         ← 장기 기억 요약

personalities/        ← 성격 팩
├── gentle.md
└── concise.md
```

## 핵심 기능

- **다계층 에이전트 구조** — L0~L3 역할과 spawn/kill/steer
- **텔레그램 네이티브** — 폰에서 에이전트 군단 제어
- **실시간 대시보드** — WebSocket 기반 웹 UI, 바이너리 내장 (Node.js 불필요)
- **하이브리드 메모리 검색** — 로컬 임베딩(fastembed) + 벡터 검색(sqlite-vec) + BM25 + 시간 감쇠
- **내장 대시보드** — axum이 직접 서빙 (`localhost:3002`), 별도 프로세스 없음
- **플러그인형 대시보드** — `~/.tiguclaw/dashboard/`로 교체/커스터마이징 가능
- **에이전트 폴더 구조** — `agents/{name}/` + `AGENT.md` + `agent.toml`
- **공유 컨텍스트** — `shared/` 폴더: 모든 에이전트가 공통 정보 공유
- **성격 팩** — `personalities/`로 말투/스타일 교체 가능
- **숨겨진 시스템 프롬프트** — spawn 시 설정(역할/한도/관계) 자동 주입
- **컨텍스트 관리** — `/new`, `/contexts`, `/save`, `/load` + 보존 기간
- **자동 spawn** — 워크로드 분석 후 서브에이전트 자율 생성
- **모델 에스컬레이션** — Sonnet 기본 처리 → 복잡도 높으면 Opus 자동 에스컬레이션
- **승인 정책** — 중요 작업에 사람 승인 요구
- **프롬프트 캐싱** — Anthropic 캐시로 비용 절감
- **Hooks HTTP API** — `POST /hooks/agent` 외부 서비스 연동

## 설정

```toml
[agent]
name = "MyAgent"
spec = "agents/supermaster"

[[channels]]
type = "telegram"
bot_token = "${TELEGRAM_BOT_TOKEN}"
admin_chat_id = 123456789
primary = true

[dashboard]
enabled = true
port = 3002
```

전체 설정 항목은 `config.toml.example` 참조.

## 대시보드

대시보드는 tiguclaw에 내장되어 `http://localhost:3002`에서 서빙됩니다. Node.js 불필요.

커스텀 대시보드 개발 시:

```bash
cd dashboard && npm install && npm run dev
# 개발 서버를 프록시로 사용:
export TIGUCLAW_DEV_DASHBOARD=http://localhost:3001
```

`~/.tiguclaw/dashboard/`에 정적 파일을 넣어 대시보드를 완전히 교체할 수도 있습니다.

## 슬래시 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/spawn <이름> <작업>` | 서브에이전트 생성 |
| `/agents` | 활성 에이전트 목록 |
| `/kill <이름>` | 에이전트 종료 |
| `/steer <이름> <메시지>` | 에이전트 방향 전환 |
| `/send <이름> <메시지>` | 에이전트에 메시지 전송 |
| `/specs` | 에이전트 스펙 목록 |
| `/new [이름]` | 컨텍스트 저장 후 새 대화 |
| `/contexts` | 저장된 컨텍스트 목록 |
| `/save <이름>` | 현재 컨텍스트 저장 |
| `/load <이름>` | 컨텍스트 불러오기 |
| `/status` | 통계 및 비용 |

## 로드맵

- [x] L0~L3 다계층 에이전트 구조
- [x] 실시간 웹 대시보드 (내장, Node.js 불필요)
- [x] 하이브리드 메모리 검색 (fastembed + sqlite-vec + BM25)
- [x] 에이전트 폴더 구조 + 성격 팩
- [x] 공유 컨텍스트 (shared/)
- [x] 자동 spawn + 승인 정책
- [x] 컨텍스트 관리 + 보존
- [ ] 에이전트 마켓플레이스 (`tiguclaw market`)
- [ ] 분산 에이전트 (멀티 서버)
- [ ] Discord / Slack 채널

## 라이센스

MIT — [LICENSE](LICENSE) 참조
