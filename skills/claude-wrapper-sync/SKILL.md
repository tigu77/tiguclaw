---
name: claude-wrapper-sync
description: "Claude Code 프로젝트의 서브에이전트·스킬·슬래시커맨드(.claude/)를 tiguclaw 로 가져와(래핑/동기화) 그대로 쓸 수 있게 한다. (1) '클로드 코드에서 쓰던 에이전트/스킬 가져와', '.claude 래핑/동기화', 'claude-wrapper-sync' 요청 시, (2) Claude Code 로 작업한 폴더의 능력을 tiguclaw 비서가 재사용하고 싶을 때. 포맷이 거의 동일해 검증+복사가 핵심."
reach: main
---

# claude-wrapper-sync — Claude Code 자산을 tiguclaw 로 래핑

Claude Code 의 `.claude/{agents,skills,commands}` 를 tiguclaw 의 `{agents,skills,commands}` 로
가져온다. **세 포맷이 사실상 동일**(agents=`<name>.md` frontmatter name/description/model/tools,
skills=`<dir>/SKILL.md` frontmatter name/description)이라 래핑은 *검증 + 복사*가 본질이다.
새 코어·라이브러리 없음. tiguclaw 는 이 자산을 **매 턴 라이브 발견**하므로 **재시작 불요** —
동기화 직후 `find_skills`/`find_agents` 또는 바로 `invoke_skill`/`spawn_agent` 로 쓸 수 있다.

## 0) ★메인 지침 먼저 이해·반영 (CLAUDE.md → PROJECT.md)
Claude Code 스킬/에이전트는 프로젝트 `CLAUDE.md`(+ 하위 `**/CLAUDE.md`, 전역 `~/.claude/CLAUDE.md`)가
세운 **컨벤션·아키텍처·규칙 컨텍스트를 전제**한다. 스킬만 복사하면 그 맥락이 없어 겉돈다. 순서:
1. 먼저 `<project>/CLAUDE.md`(및 하위·전역)를 **Read 해 이해**한다.
2. 그 **핵심 컨텍스트를 tiguclaw 의 `<project>/PROJECT.md` 에 반영**한다 — CLAUDE.md ↔ tiguclaw PROJECT.md
   (둘 다 프로젝트 메인 지침). PROJECT.md 가 없으면 요지를 정리해 작성(frontmatter `name`·`description`·
   `status: active`), 있으면 **덮어쓰지 말고** 스킬이 의존하는 규칙만 보강. ★verbatim 통째 복사보다
   *요지*(스킬이 전제하는 컨벤션·용어·제약)를 담아라(길면 요약).
3. ★LLM-agnostic(#2): CLAUDE.md 는 claude SDK 만 자동 로드하므로, **PROJECT.md 에 반영해야** codex/openai
   어댑터로도 같은 맥락이 선다. SDK 자동로드에 의존하지 말 것.
4. 컨텍스트에 의존하는 스킬은 홈 전역보다 **프로젝트 스코프(`<project>/.tiguclaw/skills`) 래핑 권장**
   (맥락 PROJECT.md 와 같은 프로젝트에서 함께 산다). 그 폴더는 `project_register` 로 등록.

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

## 3) ★래핑 방식 — 전체 복사(기본) vs 포인터
- **기본 = 전체 복사(self-contained)**: 원본 내용을 그대로 대상 파일에 **복사**한다(포인터·요약 아님).
  자기완결이라 머신·이동·다른 인스턴스(맥·집·회사) sync 에도 안 깨진다. 홈/전역 래핑은 **반드시 복사**
  (홈 스킬이 특정 프로젝트를 안정적으로 가리킬 수 없음).
- **포인터(원본 참조)는 예외적으로만**: *프로젝트 스코프* 래핑이고(대상=`<project>/.tiguclaw/skills/`)
  원본이 **같은 프로젝트** 안이며(`<project>/.claude/skills/...`) 사용자가 원본과 라이브 동기화를
  명시로 원할 때만. 이때 참조는 **반드시 프로젝트-상대경로**(예: `.claude/skills/editor-ux/SKILL.md`)
  — 스킬은 cwd=프로젝트로 실행되니 해석된다.
- ★★**절대·머신종속 경로 절대 금지**(`E:/…`, `/Users/…`, `C:\…`). sync 되면 다른 머신서 깨진다.
  확신 없으면 **복사**하라.

## 3b) 복사 절차 (확인 후)
- **에이전트**: `.claude/agents/<name>.md` → `<대상>/agents/<name>.md`. `Read`→`Write` 로 **내용 전체** 복사.
  포맷 동일. 미지정 frontmatter 키(color 등)는 tiguclaw 가 무시하므로 verbatim 안전.
- **스킬**: `.claude/skills/<name>/` 디렉터리 전체 → `<대상>/skills/<name>/`. `SKILL.md`(내용 전체) +
  보조 파일(스크립트·레퍼런스) 함께 복사(`Glob` 로 하위 파일 열거 후 각각 Read/Write).
- **커맨드**: `.claude/commands/<name>.md` → `<대상>/commands/<name>.md`. tiguclaw 도 commands 라이브 발견.

## 4) 호환 주의 (거의 그대로, 예외만)
- 에이전트 `model` (opus/sonnet/haiku): tiguclaw 는 티어로 해석 — 그대로 두면 됨(모르는 값은 디폴트).
- 에이전트/스킬 `tools`·`allowed-tools`: Claude Code 도구명(Read/Edit/Bash/Grep/Glob/WebFetch…)은
  tiguclaw file-ops 와 동일. tiguclaw 에 없는 도구(특정 MCP 등)는 tiguclaw 가 무시 → 그대로 두거나
  주석. **어댑터별 특수분기 금지**(#2) — 도구 목록은 의도만, 실제 가용은 런타임이 결정.
- 스킬 본문이 `Task`/`Agent`(claude SDK 빌트인) 언급 시: tiguclaw 는 그걸 **차단**하고 `spawn_agent` 으로 일원화 —
  본문은 그대로 둬도 되나, 순수 claude 표현이면 "Task/ spawn_agent" 병기 권장(LLM-agnostic).

## 5) 보고
래핑한 목록(종류·이름·대상경로), 스킵/충돌/드롭 내역, "**재시작 불요 — 바로 사용 가능**"을 알린다.
이 자산은 tiguclaw 가 claude·codex 어느 어댑터로든 동일하게 발견·사용한다(핵심원칙 #2).

## 원칙
파괴적(덮어쓰기)은 **명시 확인**(SYSTEM.md 헌법). 빌트인 스킬/에이전트는 클로버링 금지.
Codex 자산 래핑은 자매 스킬 `codex-wrapper-sync`.
