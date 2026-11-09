# Claude Telegram Router

**English** · [Tiếng Việt](README.vi.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-agent-d97757)](https://docs.claude.com/en/docs/claude-code)

**Control Claude Code from your phone.** One Telegram bot, one group with Topics: **each topic is one project**. Write in a topic and Claude Code works in that project's folder on your machine, then answers in the same topic. No `@bot` mentions, no terminal per project.

> The bot's own messages (status, commands, warnings) are in Vietnamese. Claude itself answers in whatever language you write in.

## Features

- 🗂️ **One topic = one project folder**, each with its own Claude session and memory of the conversation.
- ⚡ **Warm Claude process per topic**: the first message starts it, the next ones go straight in.
- 📨 **Message while Claude works**: extra messages are fed into the running task, no waiting.
- 🖼️ **Photos and files both ways**: send screenshots, albums or documents to Claude; ask Claude to send images or files back.
- 🔔 **Claude keeps going on its own** when a background job (tests, build, agent) finishes.
- ⏳ **Live progress**: one message is edited to show Claude's latest steps.
- 🧠 **Session-size warnings** (tokens and message count), with a one-tap `/new`.
- 🎛️ **Per-topic model** with `/model` buttons.
- 🚦 **Parallel limit** across topics, run timeout, stale-message skip, single-instance lock.
- 🔒 **Locked to your user ID and your group**; secret files (`.env`, SSH keys, `.pem`) are never uploaded.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in (`claude` runs in a terminal)
- A Telegram account and a **new** bot from [@BotFather](https://t.me/BotFather)
- Windows 10/11 (used daily and tested). macOS / Linux: the code handles them but they are untested; start with `bun run start`.

## Quick start

1. **Create a bot** with @BotFather (`/newbot`). Use a dedicated bot: only one program can receive a bot's updates (error 409).
2. **Disable privacy mode** so the bot reads every message in the group: @BotFather → `/setprivacy` → your bot → **Disable** (or make the bot a group admin).
3. **Create a group** → Edit → turn on **Topics** → create one topic per project. Add the bot *after* step 2 (if it was already in the group, remove and re-add it).
4. **Install and configure**:
   ```bash
   git clone https://github.com/nguyencaotai1969/telegram-bot-router.git
   cd telegram-bot-router
   bun install
   cp .env.example .env
   ```
   Fill in `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS` (your Telegram user ID). Leave `ALLOWED_CHAT_IDS` empty for now.
5. **Run** `start-router.cmd` (Windows) or `bun run start`. Send any message in the group: the bot replies with the group ID (`-100…`). Put it in `ALLOWED_CHAT_IDS` and restart.
6. **Bind each topic** to a folder, once: `/bind D:\projects\my-app`.

## Usage

After binding, write in the topic as you would to a developer sitting in that folder:

```
You:   Run the tests and fix the failing ones
Bot:   ⏳ working… (latest steps: Read, Bash, Edit…)
Bot:   Fixed 2 tests in tests/api.test.ts …
       ✅ Done · 🧠 64k
```

| You want to | Do this |
| --- | --- |
| Give a task | Just write it: "add a logout button to the header" |
| Add details mid-task | Write again, no need to wait. The bot says "📨 sent into the running task"; Claude reads it at its next step |
| Show a bug or a design | Send a photo (or album, or file) with a caption: "the layout breaks like this, fix it" |
| Get an image or file back | "take a screenshot of the home page and send it to me", "send me the report you made" |
| Change model | `/model` and tap a button, or `/model opus` |
| Start a new topic of conversation | `/new` (long sessions get slower and costlier; the bot reminds you) |
| Stop now | `/stop` |
| See what is going on | `/status` |
| Work on several projects | One topic per project; up to `MAX_PARALLEL_RUNS` run at once |

### How Claude sends files

Claude is told to write a line `📎 <path>` (optionally `📎 <path> | caption`). The router strips that line and uploads the file to the same topic: images (png, jpg, webp up to 10 MB) as photos, anything else as a document (up to 50 MB). A `📎` line inside a ``` code block is treated as an example and not sent.

Photos and files you send are saved in `data/inbox/` (deleted after 7 days) and their paths are given to Claude to read.

## Commands

| Command | What it does |
| --- | --- |
| `/bind <folder>` | Bind the topic to a project folder (forgets the topic's old session) |
| `/status` | Project, session, context size, whether Claude is working / warm / closed |
| `/new` | Next message starts a fresh conversation |
| `/model` | Pick the topic's model with buttons, or `/model <name>`. Applies to the running Claude without losing context |
| `/stop` | Stop the current task and close the topic's Claude process (and everything it started) |
| `/topics` | Topics bound in this group |
| `/unbind` | Unbind the topic |
| `/id` | Chat / topic / user IDs |
| `/help` | Help |

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | required | Comma-separated Telegram user IDs allowed to give orders |
| `ALLOWED_CHAT_IDS` | empty | Comma-separated group IDs the bot works in |
| `CLAUDE_BIN` | auto | Path to `claude.exe`; set only if auto-detection fails |
| `CLAUDE_MODEL` | Claude Code default | Default model for topics without `/model` |
| `MAX_PARALLEL_RUNS` | `3` | Topics working at the same time |
| `RUN_TIMEOUT_MINUTES` | `60` | A task running longer is stopped |
| `STALE_MESSAGE_MINUTES` | `10` | Messages older than this when the bot starts are skipped |
| `CONTEXT_WARN_TOKENS` | `200000` | Warn when the session context passes this (`0` = off) |
| `SESSION_WARN_MESSAGES` | `20` | Warn when the session passes this many messages (`0` = off) |
| `ROUTER_DATA_DIR` | `./data` | Where state, inbox and lock file live |

## Security

Claude runs with `--dangerously-skip-permissions`: it runs commands and edits files **without asking**. Anyone who can give it orders controls your machine. That is why:

- only user IDs in `ALLOWED_USER_IDS`, and only in groups in `ALLOWED_CHAT_IDS`, are obeyed;
- router keys (bot token, IDs) are removed from the environment Claude runs in;
- files that look like secrets are never uploaded, whoever asks;
- forwarded messages are marked as someone else's words, for reference only.

Keep the bot token private, and only bind folders you are fine with Claude changing.

## Good to know

- Your computer must be on and the router running. To start it at Windows login, put a shortcut to `start-router.cmd` in `shell:startup`.
- Each warm topic uses about 150–180 MB of RAM until `/stop`, `/new`, `/bind`, `/unbind` or the router closes. A closed session resumes with its context (`--resume`).
- One folder can be bound to only one topic, so two Claude sessions never edit the same place.
- Only one router can run at a time (`data/router.lock`).
- While the router runs Claude, the Claude Code Telegram plugin (if installed) is turned off for those runs so it does not steal the bot's messages.
- `claude.exe` is looked up again on every start, so Claude Code auto-updates need no router restart.

See [README.vi.md](README.vi.md) for more details (Vietnamese).

## Development

```bash
bun install
bun run typecheck
bun run test
```

Tests use `tests/fixtures/fake-claude.ts` instead of the real `claude.exe`, so they cost no Claude usage.

## License

[MIT](LICENSE)
