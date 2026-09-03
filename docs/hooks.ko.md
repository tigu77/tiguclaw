# 훅 (Hooks)

정해진 순간에 비서가 실행하는 셸 명령입니다. **Claude Code `settings.json` 의 `hooks` 포맷을 그대로** 쓰므로, 이미 Claude Code 훅을 써보셨다면 그대로 넘어옵니다.

훅은 정해진 순간에 비서가 실행하는 셸 명령입니다 — 하는 일을 관찰하거나, 어떤 동작을 실행 전에 차단합니다. **Claude Code `settings.json` 의 `hooks` 포맷을 그대로** 쓰기 때문에, 이미 Claude Code 훅을 써보셨다면 그대로 넘어옵니다.

배선된 이벤트는 다섯 가지입니다:

| 이벤트 | 발화 시점 | 대표 용도 |
|---|---|---|
| `UserPromptSubmit` | 턴 시작 전 | 들어오는 프롬프트 로깅·게이팅 |
| `PreToolUse` | 도구 실행 전 | 도구 호출 **차단**(예: 특정 경로 쓰기 거부) |
| `PostToolUse` | 도구 반환 후 | 도구 결과 관찰·감사 |
| `SubagentStop` | 위임한 서브에이전트 종료 후 | 위임 결과 검수·기록 |
| `Stop` | 턴 종료 후 | 턴 후 알림·로깅 |

각 훅은 stdin 으로 작은 JSON payload(`tool_name`·`tool_input`·`cwd` 등)를 받습니다. `PreToolUse` 는 exit code `2` 로 도구를 차단합니다 — 비서는 도구 결과 자리에 (stderr 로 넘긴) 사유를 보고 넘어갑니다. 그 외 non-zero exit 은 격리·로깅되어, 훅이 깨져도 데몬은 절대 죽지 않습니다.

`<home>/settings.json` 에 블록을 추가하세요. `matcher` 는 선택이고, 도구 이름을 정규식으로 받습니다(비우면 모든 도구):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "~/.tiguclaw/hooks/guard-writes.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.tiguclaw/hooks/audit.sh" }
        ]
      }
    ]
  }
}
```

가드 스크립트는 허용한 디렉터리 밖 쓰기를 exit `2` 로 거부할 수 있습니다:

```bash
#!/usr/bin/env bash
read -r payload
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')
case "$path" in
  "$HOME"/projects/*) exit 0 ;;              # 허용
  *) echo "쓰기는 ~/projects 아래에서만 허용됩니다" >&2; exit 2 ;;  # 차단
esac
```

알아두실 것 몇 가지:

- **같은 설정이 모든 LLM 에서 돕니다.** 하나의 `settings.json` `hooks` 블록이 `anthropic`·`codex`·`openai` 어디서 턴이 돌든 똑같이 동작합니다 — 단일 훅 엔진이 셋 다 굴리므로, 프로바이더별로 따로 배울 것도 관리할 것도 없어요.
- **프로젝트별 훅.** `<프로젝트>/.tiguclaw/settings.json` 에 같은 형식으로 쓰면, 비서가 그 폴더에서 일할 때만 발화합니다. Claude Code 를 쓰던 프로젝트라면 `<프로젝트>/.claude/settings.json` 의 훅도 그대로 읽으니 옮겨 적을 필요가 없습니다. 두 층은 **덮어쓰지 않고 함께 돕니다** — 전역에 걸어둔 안전 훅을 프로젝트 설정이 조용히 끄는 일은 없어요.
- **눈으로 볼 수 있습니다.** 훅 실행은 대시보드 활동 모니터에 뜨고(차단은 붉은 틴트), 등록된 훅은 대시보드 인벤토리 **🪝 훅** 카테고리에 나옵니다.

훅은 도구 호출을 **관찰하고 차단**합니다. 그리고 `UserPromptSubmit`·`PreToolUse` 훅이 stdout 으로 뭔가를 쓰면 그게 **맥락으로 들어갑니다** — 비서가 그 내용을 보고 판단해요. 아직 안 되는 건 하나입니다: **도구 입력 자체를 고쳐 넣는 것**. 그건 다음 단계예요.

---

[← README](../README.ko.md) · [English](hooks.en.md)
