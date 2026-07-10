---
name: claude-wrapper-sync
description: "Claude Code 프로젝트의 서브에이전트·스킬·슬래시커맨드(.claude/)를 tiguclaw 로 가져와(래핑/동기화) 그대로 쓸 수 있게 한다. (1) '클로드 코드에서 쓰던 에이전트/스킬 가져와', '.claude 래핑/동기화', 'claude-wrapper-sync' 요청 시, (2) Claude Code 로 작업한 폴더의 능력을 tiguclaw 비서가 재사용하고 싶을 때. 포맷이 거의 동일해 검증+복사가 핵심."
---

# claude-wrapper-sync — Claude Code 자산을 tiguclaw 로 래핑

Claude Code 의 `.claude/{agents,skills,commands}` 를 tiguclaw 의 `{agents,skills,commands}` 로
가져온다. **세 포맷이 사실상 동일**(agents=`<name>.md` frontmatter name/description/model/tools,
skills=`<dir>/SKILL.md` frontmatter name/description)이라 래핑은 *검증 + 복사*가 본질이다.
새 코어·라이브러리 없음. tiguclaw 는 이 자산을 **매 턴 라이브 발견**하므로 **재시작 불요** —
동기화 직후 `find_skills`/`find_agents` 또는 바로 `invoke_skill`/`spawn_agent` 로 쓸 수 있다.

## 1) 소스·대상 정하기
- **소스**: 사용자가 준 Claude Code 프로젝트 경로의 `<project>/.claude/` (없으면 `~/.claude/`).
  하위: `.claude/agents/*.md`, `.claude/skills/<name>/SKILL.md`, `.claude/commands/*.md`.
- **대상** (둘 중, 불명확하면 사용자에게 물어라):
  - **전역 재사용** → `<TIGUCLAW_HOME>/{agents,skills,commands}` (기본. 모든 대화서 사용).
  - **특정 프로젝트 전용** → 그 프로젝트 폴더의 **`.tiguclaw/{agents,skills,commands}`** (cwd 스코프,
    2026-07-10 메타 폴더 컨벤션 — 프로젝트 자기 폴더와 충돌 회피). 레거시 flat `<project>/skills` 도
    발견되나 신규는 `.tiguclaw/` 아래에 쓴다.
- `Glob` 로 소스 목록을 먼저 만든다.

## 2) 드라이런 미리보기 (먼저 보여주고 확인)
쓰기 전에 **무엇이 래핑될지 목록**을 만들어 사용자에게 보인다:
- 각 항목: 종류(agent/skill/command)·이름·소스경로 → 대상경로.
- **이름 충돌**: 대상(또는 tiguclaw 빌트인 harness·code-review 등)에 같은 이름이 이미 있으면
  ⚠️ 표시하고 **덮어쓰기 여부를 명시 확인**받는다(빌트인 클로버링 금지 — 스킵/개명 권장).
- frontmatter `name`·`description` 누락 항목은 **드롭**(tiguclaw 파서가 버림) — 목록에 "드롭(사유)"로.

## 3) 복사 (확인 후)
- **에이전트**: `.claude/agents/<name>.md` → `<대상>/agents/<name>.md`. `Read`→`Write` 그대로.
  포맷 동일. 미지정 frontmatter 키(color 등)는 tiguclaw 가 무시하므로 verbatim 안전.
- **스킬**: `.claude/skills/<name>/` 디렉터리 전체 → `<대상>/skills/<name>/`. `SKILL.md` +
  보조 파일(스크립트·레퍼런스) 함께 복사(`Glob` 로 하위 파일 열거 후 각각 Read/Write).
- **커맨드**: `.claude/commands/<name>.md` → `<대상>/commands/<name>.md`. tiguclaw 도 commands 라이브 발견.

## 4) 호환 주의 (거의 그대로, 예외만)
- 에이전트 `model` (opus/sonnet/haiku): tiguclaw 는 티어로 해석 — 그대로 두면 됨(모르는 값은 디폴트).
- 에이전트/스킬 `tools`·`allowed-tools`: Claude Code 도구명(Read/Edit/Bash/Grep/Glob/WebFetch…)은
  tiguclaw file-ops 와 동일. tiguclaw 에 없는 도구(특정 MCP 등)는 tiguclaw 가 무시 → 그대로 두거나
  주석. **어댑터별 특수분기 금지**(#2) — 도구 목록은 의도만, 실제 가용은 런타임이 결정.
- 스킬 본문이 `Task`(claude 전용) 언급 시: tiguclaw 는 `spawn_agent`(codex/openai)도 동형 —
  본문은 그대로 둬도 되나, 순수 claude 표현이면 "Task/ spawn_agent" 병기 권장(LLM-agnostic).

## 5) 보고
래핑한 목록(종류·이름·대상경로), 스킵/충돌/드롭 내역, "**재시작 불요 — 바로 사용 가능**"을 알린다.
이 자산은 tiguclaw 가 claude·codex 어느 어댑터로든 동일하게 발견·사용한다(핵심원칙 #2).

## 원칙
파괴적(덮어쓰기)은 **명시 확인**(SYSTEM.md 헌법). 빌트인 스킬/에이전트는 클로버링 금지.
Codex 자산 래핑은 자매 스킬 `codex-wrapper-sync`.
