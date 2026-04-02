# KingCode

中文使用说明请看：

[`docs/使用说明.md`](C:/Users/云电脑/Desktop/omnicode-web/docs/使用说明.md)

KingCode is a local coding assistant with a browser UI. It was designed as a practical alternative to Claude Code's public extension model, while staying provider-agnostic so you can connect different AI APIs instead of being locked to one backend.

## What the public Claude Code repo actually exposes

The repository at `anthropics/claude-code` does not currently expose the whole Claude Code runtime. What it does expose clearly is the extension architecture around the product:

- `commands`: markdown-driven workflows
- `agents`: prompt-specialized roles
- `skills`: reusable behavior packs
- `hooks`: event-based guardrails
- `plugins`: packaging for teams and marketplaces

That means the best reproducible path is not "clone the hidden core", but "rebuild the mechanism":

- a configurable model provider layer
- workspace-aware prompt injection
- file and command tools
- workflow presets that act like slash commands
- a visual shell instead of a terminal-only UX

## What this project includes

- A zero-dependency Node.js server
- A local Web UI at `http://localhost:4780`
- Provider profiles for:
  - OpenAI-compatible APIs
  - Anthropic
  - Gemini
  - Generic JSON APIs
- Workspace browser and file editor
- Command runner scoped to the chosen workspace root
- Workflow presets: `Analyze`, `Plan`, `Review`, `Implement`

## Quick start

```bash
cd omnicode-web
npm start
```

Then open `http://localhost:4780`.

## Terminal mode

```bash
cd omnicode-web
npm run cli
```

CLI commands:

- `/help`
- `/profiles`
- `/profile <id>`
- `/workflow <id>`
- `/tree [path]`
- `/open <path>`
- `/include <path>`
- `/write <path>`
- `/run <command>`

Plain text input sends a chat request using the active workflow plus any included files and recent command output.

## Provider model

Profiles are stored in `data/providers.json`. The `generic-json` adapter is the escape hatch for providers that do not match OpenAI, Anthropic, or Gemini directly.

Supported body template tokens:

- `{{api_key}}`
- `{{model}}`
- `{{model_json}}`
- `{{system_prompt}}`
- `{{system_prompt_json}}`
- `{{last_user_message}}`
- `{{last_user_message_json}}`
- `{{messages_json}}`

Example generic body:

```json
{
  "model": {{model_json}},
  "messages": {{messages_json}}
}
```

Example generic response path:

```text
choices.0.message.content
```

## Technical mapping from Claude Code to this tool

- `commands` -> workflow chips and prompt presets
- `agents` -> model behavior defined by workflow plus system prompt
- `skills` -> reusable prompt/system instructions in config
- `hooks` -> easy next step would be request/response interceptors in `server.js`
- `tools` -> file browser, editor, and command runner

## Limits

This is intentionally an MVP:

- no streaming responses yet
- no multi-agent orchestration
- no marketplace/plugin loader
- no autonomous tool-calling loop

Those can be added on top of the current adapter and workspace layers without replacing the architecture.
