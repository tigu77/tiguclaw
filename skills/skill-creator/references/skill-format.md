# skill-format — 티구클로 스킬 규격

skill-creator Phase 2 에서 SKILL.md 초안을 쓸 때의 형식. 티구클로·Claude Code·Codex 스킬 포맷은 동일(같은 SKILL.md frontmatter) — 그래서 wrapper-sync 로 상호 래핑된다.

## 파일 구조

```
<skills-root>/<name>/
  SKILL.md              # 필수 — frontmatter + 본문(절차)
  references/*.md       # 선택 — 상세 규격·긴 설명(본문 슬림 유지용)
  scripts/*             # 선택 — 결정적 헬퍼(node/bash 등). Bash 로 실행.
  agents/*.md           # 선택 — 참조용 역할 정의(주의: skills/ 안 agents 는 spawn_agent
                        #   자동 등록 안 됨. 등록형 서브에이전트는 <home>/agents 또는 레포 agents/).
```

## 발견 경로 (우선순위)

1. 프로젝트 전용: `<project>/.tiguclaw/skills/` (최우선)
2. 홈 공통: `<home>/skills/`
3. 빌트인 제품: 레포 `skills/` (`appRoot()/skills`)
4. 플러그인 번들: `plugins/<id>/skills/`

같은 이름은 위(프로젝트)가 이긴다. **매 턴 라이브 발견 → 스킬 추가·수정에 재시작 불요.**

## frontmatter

```yaml
---
name: <kebab-case, 파일 폴더명과 일치>
description: "<트리거 문구가 담긴 한두 문단>"
---
```

- **name**: 소문자·하이픈. 발동 키.
- **description**: 이게 발동을 결정한다. 규칙:
  - **적극적으로(pushy)**: 스킬은 undertrigger 경향 → "~할 때", "~요청 시", "'…' 같은 말" 을 **사용자 표현으로 여러 개** 나열. should-trigger 케이스를 문장에 녹여라.
  - **구현이 아니라 의도**: "무엇을 해주는가/언제 원하는가" 중심. 내부 방식 설명 금지.
  - **경계 명시**: 헷갈리는 인접 스킬과 구분하는 한 줄(예: "harness 와 구분 — 이건 …").
  - **길이 예산**: description 은 매 턴 capability 인덱스에 prepend 되므로 과길이 금지. 트리거에 필요한 만큼만.

## 본문

- 명령형 절차/체크리스트. 비서(또는 서브에이전트)가 그대로 수행.
- 긴 규격·표·예시는 `references/` 로 빼고 본문에선 "→ references/x.md" 로 가리켜 슬림 유지.
- 결정적 계산(집계·검증)은 `scripts/` 로. 프롬프트에 계산 맡기지 말 것.

## 트리거 검증 (초안 후)

description 이 제대로 발동하는지 점검:
- **should-trigger** 문장 4~6개: 이 스킬이 반드시 떠야 할 사용자 요청 예시.
- **should-NOT-trigger** 4~6개: 헷갈리지만 떠선 안 되는 near-miss(특히 인접 스킬 영역).
- 실측하려면 skill-creator 의 eval 루프(§eval-method)로 트리거를 측정할 수도 있으나, 초안 단계는 이 서술 체크리스트로 충분. 과소/과대 발동이 보이면 description 문구를 조정.
