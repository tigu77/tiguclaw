---
name: codex-wrapper-sync
description: "Codex 의 스킬(~/.codex/skills, 프로젝트 AGENTS.md·프롬프트)을 tiguclaw 로 가져와(래핑/동기화) 그대로 쓸 수 있게 한다. (1) '코덱스에서 쓰던 스킬 가져와', 'codex 래핑/동기화', 'codex-wrapper-sync' 요청 시, (2) Codex 로 쓰던 능력을 tiguclaw 비서가 재사용하고 싶을 때. Codex 스킬도 SKILL.md 포맷이라 검증+복사가 핵심(단 Codex 는 서브에이전트 없음)."
---

# codex-wrapper-sync — Codex 자산을 tiguclaw 로 래핑

Codex 의 스킬을 tiguclaw 의 `skills/` 로 가져온다. **Codex 스킬도 `<dir>/SKILL.md`
(frontmatter name/description) 포맷**이라 tiguclaw 와 동일 → 래핑은 *검증 + 복사*가 본질.
★Codex 는 Claude Code 식 **서브에이전트가 없다**(단일 에이전트) → agents 는 대상 아님(스킬만).
tiguclaw 는 매 턴 라이브 발견하므로 **재시작 불요**. 자매 스킬 = `claude-wrapper-sync`.

## 1) 소스·대상 정하기
- **소스**(존재하는 것만):
  - 유저 스킬: `~/.codex/skills/<name>/SKILL.md`. **`.system/` 은 제외**(skill-creator 등 Codex
    빌트인 — 유저 자산 아님).
  - (선택) 프로젝트 프롬프트: `~/.codex/prompts/*.md` → tiguclaw commands 로 래핑 가능(슬래시커맨드 동형).
  - (선택) `<project>/AGENTS.md`: Codex 프로젝트 지침(문맥). 스킬이 아니라 *컨텍스트* 라 자동
    래핑 대상 아님 — 사용자가 원하면 그 요지를 새 스킬 SKILL.md 나 프로젝트 PROJECT.md 로 손수 정리.
- **대상**(불명확하면 물어라): 전역 `<TIGUCLAW_HOME>/skills` (기본) 또는 특정 프로젝트
  **`<project>/.tiguclaw/skills`** (2026-07-10 메타 폴더 컨벤션 — 프로젝트 자기 폴더와 충돌 회피).
- `Glob` 로 `~/.codex/skills/*/SKILL.md`(단 `.system` 제외) 목록을 만든다.

## 2) 드라이런 미리보기 (먼저 보여주고 확인)
- 각 스킬: 이름·소스경로 → 대상경로.
- **이름 충돌**: 대상/빌트인(harness·code-review 등)에 같은 이름이면 ⚠️ + **덮어쓰기 명시 확인**(빌트인 클로버링 금지).
- frontmatter `name`/`description` 누락 → **드롭**(사유 표기).

## 3) ★래핑 방식 — 전체 복사 (기본이자 원칙)
- **원본 내용을 그대로 복사(self-contained)**한다 — 포인터·요약 아님. 자기완결이라 머신·이동·다른
  인스턴스 sync 에도 안 깨진다. Codex 원본은 대부분 홈(`~/.codex/skills`, 머신 종속)이라 **포인터 부적합
  → 반드시 복사**.
- ★**절대·머신종속 경로 절대 금지**(`/Users/…`, `C:\…`, `~/.codex/…` 를 본문에 하드코딩 X). 원본을
  참조하지 말고 내용을 복사하라.

## 3b) 복사 절차 (확인 후)
- **스킬**: `~/.codex/skills/<name>/` 디렉터리 전체 → `<대상>/skills/<name>/`. `SKILL.md`(내용 전체) +
  보조 파일(스크립트·레퍼런스) 함께(`Glob` 하위 열거 후 각각 Read/Write). `metadata.short-description`
  등 부가 frontmatter 는 tiguclaw 가 무시 → verbatim 안전.
- **(선택) 프롬프트→커맨드**: `~/.codex/prompts/<name>.md` → `<대상>/commands/<name>.md` (내용 복사).

## 4) 호환 주의
- Codex 스킬 본문이 Codex 전용 도구·표현을 참조하면, tiguclaw 에 없는 도구는 런타임이 무시.
  **어댑터별 특수분기 금지**(#2) — 본문은 의도로 두되, 순수 Codex 표현이면 중립화 권장.
- 서브에이전트 위임이 필요한 스킬이면 tiguclaw 의 `spawn_agent`(+ 필요한 agent 는 `claude-wrapper-sync`
  나 `harness` 로 별도 마련)로 매핑.

## 5) 보고
래핑한 스킬 목록·스킵/충돌/드롭 내역·"**재시작 불요 — 바로 사용 가능**"을 알린다. 래핑된 스킬은
tiguclaw 가 claude·codex 어느 어댑터로든 동일 발견·사용(핵심원칙 #2).

## 원칙
파괴적(덮어쓰기)은 **명시 확인**(SYSTEM.md 헌법). 빌트인 클로버링 금지. Claude Code 자산은
자매 스킬 `claude-wrapper-sync`.
