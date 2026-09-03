# Security Policy / 보안 정책

*[English](#reporting-a-vulnerability) · [한국어](#취약점-신고)*

tiguclaw runs on **your own machine** with access to your shell, files, and
credentials — the same self-elected model as Claude Code. Read
[`docs/security.ko.md`](../docs/security.ko.md) ([English](../docs/security.en.md)) for the
threat model and the boundaries the runtime does and does not enforce.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. That opens a private advisory only maintainers can see.

Please include:

- what an attacker can do (impact), and what access they need to start
- version (`tiguclaw --version` or `package.json`), OS, and how you installed
- steps to reproduce — a minimal path is worth more than a long log
- relevant lines from `<home>/logs/daemon-*.log`, **with secrets removed**

We aim to acknowledge within a few days. Please give us a chance to ship a fix
before disclosing publicly.

### Out of scope

- Anything requiring an attacker to already have your shell or your `.env` —
  at that point they have the assistant too, by design.
- Binding the dashboard to a public interface yourself (`DASHBOARD_HOST=0.0.0.0`)
  without a tunnel. That's documented as a choice with a stated cost.
- Third-party LLM providers' own behaviour.

---

## 취약점 신고

**보안 문제는 공개 이슈로 열지 말아주세요.**

GitHub 비공개 신고를 써주세요: 이 저장소의 **Security → Report a vulnerability**.
관리자만 볼 수 있는 비공개 어드바이저리가 열립니다.

같이 적어주시면 좋은 것:

- 공격자가 **무엇을 할 수 있는지**(영향), 그리고 시작하려면 무엇이 필요한지
- 버전(`tiguclaw --version` 또는 `package.json`)·OS·설치 방법
- 재현 절차 — 긴 로그보다 **최소 경로**가 훨씬 도움이 됩니다
- `<home>/logs/daemon-*.log` 의 관련 줄 (**비밀값은 지우고**)

며칠 안에 회신하려 합니다. 수정본이 나갈 시간을 조금만 주세요.

### 범위 밖

- 공격자가 **이미** 당신의 쉘이나 `.env` 를 가진 상황을 전제하는 것 — 그 시점엔
  비서도 이미 가진 것이고, 그건 설계상 그렇습니다.
- 터널 없이 대시보드를 직접 외부에 여는 것(`DASHBOARD_HOST=0.0.0.0`).
  대가를 명시한 선택지로 문서화돼 있습니다.
- 외부 LLM 제공자 자체의 동작.
