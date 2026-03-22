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

### 설치 & 초기화

```bash
curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.sh | bash
tiguclaw init   # 대화형 설정 — 완료 후 gateway install 여부 자동 질문
```

### 제거

```bash
curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/uninstall.sh | bash
```

## 아키텍처

```
tiguclaw (단일 바이너리)
├── L0 슈퍼마스터 (delegation_only — 항상 응답 가능)
│   ├── L1 마스터 에이전트 (상주, 봇 토큰 선택)
│   │   ├── L2 미니 에이전트 (IPC, 실패 시 escalate_to_parent)
│   │   └── L3 워커 에이전트 (임시 작업)
├── REST API + WebSocket (axum, 포트 3002)
│   └── /hooks/agent · /hooks/steer · /hooks/escalate
└── 대시보드 (타임라인 뷰 + 실시간 WS, DB 영속화)
```

### 클리어런스 레벨

각 에이전트는 툴 접근 범위를 결정하는 **clearance** 설정을 가집니다:

| 프리셋 | 설명 |
|--------|------|
| `full` | 모든 툴 허용 — 신뢰할 수 있는 L0/L1용 |
| `standard` | 기본값 — 대부분의 에이전트에 적합 |
| `minimal` | 제한적 — 임시 또는 신뢰도 낮은 워커용 |

`agent.toml`에서 에이전트별로 설정:
```toml
[agent]
clearance = "standard"   # full | standard | minimal
```

### 에스컬레이션 프로토콜

L2 에이전트가 실패하거나 막히면 자동으로 에스컬레이션됩니다:
1. L2가 `escalate_to_parent` 툴로 L1에 실패 보고
2. L1이 재시도하거나 L0로 에스컬레이션
3. L0가 재배정, 새 에이전트 spawn, 또는 사람에게 알림 결정

## 에이전트 폴더 구조

```
agents/
├── supermaster/
│   ├── agent.toml    ← 역할/레벨/클리어런스/허용 툴/한도
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

installed/            ← 마켓에서 설치된 에이전트 팩
```

## 핵심 기능

- **다계층 에이전트 구조** — L0~L3 역할과 spawn/kill/steer
- **클리어런스 시스템** — full/standard/minimal 프리셋, `agent.toml`에서 에이전트별 설정
- **에스컬레이션 프로토콜** — L2 실패 → L1 보고 → L0 에스컬레이션 (`escalate_to_parent`)
- **L0 가용성 보장** — `delegation_only = true`로 L0는 항상 응답 가능
- **steer** — 작업 중인 에이전트 방향 전환 (`/steer`, CLI, 대시보드)
- **텔레그램 네이티브** — 폰에서 에이전트 군단 제어
- **타임라인 대시보드** — 에이전트별/전체 이벤트 흐름, DB 영속화, 실시간 WS
- **하이브리드 메모리 검색** — 로컬 임베딩(fastembed) + 벡터 검색(sqlite-vec) + BM25 + 시간 감쇠
- **DB 자동 백업** — 보존 기간 설정, `tiguclaw backup` CLI
- **에이전트 마켓** — `tiguclaw market` CLI, `[package]` 스펙, `installed/` 구조
- **채널 컨텍스트 주입** — 에이전트가 어떤 채널로 소통하는지 시스템 프롬프트에 자동 주입
- **에이전트 폴더 구조** — `agents/{name}/` + `AGENT.md` + `agent.toml`
- **공유 컨텍스트** — `shared/` 폴더: 모든 에이전트가 공통 정보 공유
- **성격 팩** — `personalities/`로 말투/스타일 교체 가능
- **컨텍스트 관리** — `/new`, `/contexts`, `/save`, `/load` + 보존 기간
- **자동 spawn** — 워크로드 분석 후 서브에이전트 자율 생성
- **모델 에스컬레이션** — Sonnet 기본 처리 → 복잡도 높으면 Opus 자동 에스컬레이션
- **승인 정책** — 중요 작업에 사람 승인 요구
- **프롬프트 캐싱** — Anthropic 캐시로 비용 절감
- **Hooks HTTP API** — `POST /hooks/agent` · `/hooks/steer` 외부 서비스 연동

## 설정

```toml
[agent]
name = "MyAgent"
spec = "agents/supermaster"
delegation_only = true   # L0: 항상 응답 가능, 작업은 위임
clearance = "full"       # full | standard | minimal

[[channels]]
type = "telegram"
bot_token = "${TELEGRAM_BOT_TOKEN}"
admin_chat_id = 123456789
primary = true

[dashboard]
enabled = true
port = 3002

[backup]
enabled = true
retention_days = 7       # DB 스냅샷 보존 일수

[package]
name = "my-agent-pack"
version = "1.0.0"
description = "tiguclaw market용 커스텀 에이전트 팩"
```

전체 설정 항목은 `config.toml.example` 참조.

## 대시보드

대시보드는 tiguclaw에 내장되어 `http://localhost:3002`에서 서빙됩니다. Node.js 불필요.

**타임라인 뷰** — 에이전트별/전체 이벤트 스트림을 DB에 영속화하고 실시간 WebSocket으로 업데이트합니다.

커스텀 대시보드 개발 시:

```bash
cd dashboard && npm install && npm run dev
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

CLI: `tiguclaw steer <이름> "<메시지>"`

## CLI 레퍼런스

| 명령어 | 설명 |
|--------|------|
| `tiguclaw init` | 대화형 초기 설정 (완료 후 gateway install 질문) |
| `tiguclaw gateway install` | 백그라운드 서비스로 등록 |
| `tiguclaw backup` | 수동 DB 백업 |
| `tiguclaw market` | 에이전트 팩 탐색 및 설치 |
| `tiguclaw steer <이름> "<메시지>"` | 작업 중 에이전트 방향 전환 |

## 로드맵

- [x] L0~L3 다계층 에이전트 구조
- [x] 실시간 웹 대시보드 (내장, Node.js 불필요)
- [x] 타임라인 대시보드 (에이전트별/전체, DB 영속화, WS)
- [x] 하이브리드 메모리 검색 (fastembed + sqlite-vec + BM25)
- [x] 에이전트 폴더 구조 + 성격 팩
- [x] 공유 컨텍스트 (shared/)
- [x] 자동 spawn + 승인 정책
- [x] 컨텍스트 관리 + 보존
- [x] 클리어런스 시스템 (full / standard / minimal)
- [x] 에스컬레이션 프로토콜 (L2 → L1 → L0)
- [x] L0 가용성 보장 (delegation_only)
- [x] steer (작업 중 방향 전환 — CLI / hook / 대시보드)
- [x] DB 자동 백업 + 보존 기간
- [x] 에이전트 마켓 CLI (`tiguclaw market`)
- [x] 채널 컨텍스트 주입
- [ ] tiguclaw-hub — 커뮤니티 마켓 레포 (Phase 10, 별도 레포 예정)
- [ ] 분산 에이전트 (멀티 서버)
- [ ] Discord / Slack 채널

## 라이센스

MIT — [LICENSE](LICENSE) 참조
