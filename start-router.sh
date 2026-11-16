#!/usr/bin/env bash
# Claude Telegram Router: one bot, each topic of the group = one project.
# Linux/macOS version of start-router.cmd. Ctrl+C to stop.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$(readlink -f "$0")")" || exit 1

if ! command -v bun >/dev/null 2>&1; then
  echo "Chưa có bun. Cài bằng: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

[ -d node_modules ] || bun install

bun run src/main.ts
