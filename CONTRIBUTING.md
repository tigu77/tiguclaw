# Contributing / 기여

*[English](#english) · [한국어](#한국어)*

## English

Thanks for looking. A few things worth knowing before you spend time.

**This repo is a mirror.** Development happens in a private repository and is
mirrored here, scrubbed. That means: PRs are welcome but may be applied upstream
by hand rather than merged; issues are the faster path for most things.

**So where does your thing go?**

- **A bug, or an install / platform problem** → open an issue. The environment is
  usually the bug, and that is the one thing we cannot reproduce for you.
- **A small, self-contained fix** → open a PR. Green typecheck + regression is the
  whole bar.
- **A feature, or anything that moves structure** → open a discussion or an issue
  first. Not for permission — so it doesn't collide with work already in flight
  upstream, which you cannot see from here.

**When a PR is applied by hand, you keep the credit.** The upstream commit names
you and the PR number, and so does the release note. Mirroring is a plumbing
constraint; it is not a way to take authorship.

**Before opening a PR**

```bash
npm ci
npm run typecheck
npm run test:regression   # the whole suite; it's fast and offline
```

Both must be green. The regression suite is the contract — if you fix a bug,
add a check that fails without your fix. Verify that by **breaking your own fix
on purpose** and watching the check go red. A check that passes either way
guards nothing.

**Principles the code holds to** (README has the full list): no feature may be
Claude-only — every capability must work across adapters; the core stays small
and capabilities live as data (skills, agents, prompts); anything an SDK already
does, we don't rebuild.

**Reporting instead** is often more useful than a patch — especially for install
and platform problems, where the environment *is* the bug. Use the issue
templates; they ask for exactly what's needed.

Security problems: **not** a public issue — see [SECURITY.md](.github/SECURITY.md).

## 한국어

**이 저장소는 미러입니다.** 개발은 비공개 저장소에서 이뤄지고 스크럽되어 여기로
반영됩니다. 그래서 PR 은 환영하지만 머지 대신 상류에 손으로 반영될 수 있고,
대부분의 경우 **이슈가 더 빠른 길**입니다.

**그럼 무엇을 어디로 보내면 되나요?**

- **버그, 또는 설치·플랫폼 문제** → 이슈. 대개 환경 자체가 버그이고, 그건 저희가
  대신 재현해 드릴 수 없는 유일한 것입니다.
- **작고 자기완결적인 수정** → PR. 타입체크와 회귀가 초록이면 그게 기준의 전부입니다.
- **기능, 또는 구조를 움직이는 것** → 먼저 디스커션이나 이슈로. 허락을 받으라는 게
  아니라, 여기서는 보이지 않는 상류의 진행 중 작업과 부딪히지 않게 하기 위해서입니다.

**손으로 반영되더라도 공은 기여자의 것입니다.** 상류 커밋에 기여자와 PR 번호를 적고,
릴리스 노트에도 남깁니다. 미러는 배관상의 제약이지 저작을 가져가는 방식이 아닙니다.

**PR 전에**

```bash
npm ci
npm run typecheck
npm run test:regression   # 전체 스위트 — 빠르고 네트워크 안 씁니다
```

둘 다 초록이어야 합니다. 회귀 스위트가 곧 계약입니다 — 버그를 고쳤으면 **그 고침이
없을 때 빨간불이 되는 검사**를 같이 넣어주세요. 확인 방법은 **자기 수정을 일부러
망가뜨려** 검사가 빨개지는지 보는 것입니다. 어느 쪽이든 통과하는 검사는 아무것도
지키지 않습니다.

**코드가 지키는 원칙**(전체는 README): 어떤 기능도 Claude 전용이면 안 됩니다 —
모든 능력은 어댑터를 가로질러 동작해야 합니다. 코어는 작게 두고 능력은 데이터로
삽니다(스킬·에이전트·프롬프트). SDK 가 이미 하는 일은 다시 만들지 않습니다.

**패치보다 신고가 더 도움 될 때가 많습니다** — 특히 설치·플랫폼 문제는 환경 자체가
버그라서요. 이슈 템플릿이 필요한 것만 정확히 묻습니다.

보안 문제는 **공개 이슈로 열지 마세요** — [SECURITY.md](.github/SECURITY.md).
