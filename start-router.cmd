@echo off
rem Claude Telegram Router: one bot, each topic of the group = one project.
rem Close this window (or Ctrl+C) to stop the bot.
chcp 65001 >nul
title Claude Telegram Router
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
cd /d "%~dp0"
bun run src/main.ts
pause
