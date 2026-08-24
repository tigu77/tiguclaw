# Hooks

Shell commands the assistant runs at defined moments. It uses **Claude Code's `settings.json` `hooks` format as-is**, so hooks you already wrote carry over unchanged.

Hooks are shell commands the assistant runs at defined moments — to observe what it's doing, or to block an action before it happens. They use the **same `hooks` format as Claude Code's `settings.json`**, so if you already write Claude Code hooks, they carry straight over.

Five events are wired up:

| Event | When it fires | Typical use |
|---|---|---|
| `UserPromptSubmit` | before a turn starts | log or gate incoming prompts |
| `PreToolUse` | before a tool runs | **block** a tool call (e.g. deny writes to a path) |
| `PostToolUse` | after a tool returns | observe / audit tool results |
| `SubagentStop` | after a delegated sub-agent finishes | review or record delegated work |
| `Stop` | after a turn finishes | post-turn notifications or logging |

Each hook receives a small JSON payload on stdin (`tool_name`, `tool_input`, `cwd`, and so on). For `PreToolUse`, exit code `2` blocks the tool — the assistant sees your reason (on stderr) in place of the tool result and moves on. Any other non-zero exit is isolated and logged, so a broken hook never takes the daemon down.

Add a block to `<home>/settings.json`. The optional `matcher` is a regexp against the tool name (empty = every tool):

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

A guard script might exit `2` to refuse any write outside a directory you allow:

```bash
#!/usr/bin/env bash
read -r payload
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')
case "$path" in
  "$HOME"/projects/*) exit 0 ;;              # allow
  *) echo "writes are only allowed under ~/projects" >&2; exit 2 ;;  # block
esac
```

A few things worth knowing:

- **The same config runs on every LLM.** One `settings.json` `hooks` block behaves identically whether the turn runs on `anthropic`, `codex`, or `openai` — a single hook engine drives all three, so there's nothing provider-specific to learn or maintain.
- **Per-project hooks.** Put the same block in `<project>/.tiguclaw/settings.json` and it fires only while the assistant works in that folder. If the project already has Claude Code hooks in `<project>/.claude/settings.json`, those are read as-is — nothing to copy over. The two layers **stack; they don't override** — a safety hook set globally can't be silently switched off by a project's settings.
- **You can watch them.** Hook runs show up in the dashboard's activity monitor (a blocked call is tinted red), and every registered hook is listed under the **🪝 Hooks** category in the dashboard inventory.

Hooks **observe and block** tool calls. On top of that, whatever a `UserPromptSubmit` or `PreToolUse` hook writes to stdout becomes **context the assistant reads** before deciding. One thing is still missing: **rewriting a tool's input**. That comes later.

---

[← README](../README.md) · [한국어](hooks.md)
