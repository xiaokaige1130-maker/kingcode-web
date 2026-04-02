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
- `/status`
- `/profiles`
- `/profile <id>`
- `/workflow <id>`
- `/scope [path]`
- `/skills`
- `/skillinfo <id>`
- `/skill <id>`
- `/unskill <id>`
- `/tree [path]`
- `/ls [path]`
- `/open <path>`
- `/exclude <path>`
- `/files`
- `/include <path>`
- `/write <path>`
- `/run <command>`
- `/git status`
- `/git commit <message>`
- `/git push`
- `/clearcmd`

Plain text input sends a chat request using the active workflow plus any included files and recent command output.

For `openai-compatible` providers such as `DeepSeek`, the CLI prints tokens incrementally instead of waiting for the full response.

## Skills and Scope

KingCode can discover skills from:

- `./skills/<name>/SKILL.md`
- `<workspace>/skills/<name>/SKILL.md`
- `<workspace>/.claude/skills/<name>/SKILL.md`

Web mode lets you select skills from the sidebar. CLI mode supports `/skills`, `/skill <id>`, and `/unskill <id>`.

Both Web and CLI also support a scoped working area inside the configured workspace root:

- Web: set `Scope Path` in the workspace card
- CLI: use `/scope <path>`

File browsing, command execution, selected files, and skill discovery all follow the active scope.

## Git helpers

KingCode now includes minimal Git helpers on top of the existing command runner.

- CLI:
  - `/git status`
  - `/git commit <message>`
  - `/git push`
- Web:
  - a `Git Panel` in the right sidebar with status, commit, and push actions

These helpers still rely on local Git configuration and credentials. They do not create GitHub repositories or manage authentication for you.

## Deploy helpers

KingCode also includes a first-pass deployment panel for local or current-server maintenance.

- Web `Deploy Panel` supports:
  - cloning a Git repository into the active workspace scope
  - running an install command such as `npm install` or `pip install -r requirements.txt`
  - creating a PM2 service for common Node.js start modes
  - creating a systemd service on Linux
  - loading PM2, systemd, or Docker Compose logs
  - running common Docker Compose actions
  - running a health check against a target URL
  - reading recent deployment history stored by KingCode
  - reading recent Git commits for a deployed project
  - rolling a project back to a chosen Git commit
  - updating an existing project by running `git pull`, install, build, and PM2 restart
  - reading basic project and PM2 status

- Presets:
  - `Node Web`
  - `Python Bot`
  - `Docker Compose`

The deployment panel is designed for the machine KingCode is running on. It does not add SSH or remote host management.

Rollback currently uses `git reset --hard <commit>` inside the selected project path, then optionally reinstalls, rebuilds, and restarts the service. Use it only when that repository state is safe to discard locally.

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

- Web responses are still non-streaming
- no multi-agent orchestration
- no marketplace/plugin loader
- no autonomous tool-calling loop

Those can be added on top of the current adapter and workspace layers without replacing the architecture.
