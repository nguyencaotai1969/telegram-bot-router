# Code review: own turns, mid-turn replies, 📎 files (2026-11-07)

Scope: topic-busy-period, topic-turn, topic-run, topic-conversations, topic-claude-process, claude-stream-events,
telegram-outgoing-files, telegram-api, telegram-send-options, claude-telegram-instructions, bot-commands,
topic-model-choice, message-router + new tests. typecheck clean, 98/98 tests pass.
Repros (scratch, not in repo): subagent-claude.ts, repro-subagent.ts, repro-slot-bypass.ts, repro-owed.ts.

## High

### H1. Sub-agent tool calls count as Claude's own steps (startsTurn + release)
`parseStreamLine` drops sub-agent *text* but still emits sub-agent `tool` events, unmarked. Two consequences:
- `startsTurn(tool)` opens an "own turn" when a background sub-agent (Agent run_in_background) makes a tool call after
  the main `result`. REPRODUCED: 🔔 status posted with no task_notification; `busy()` true, `/new` refused; a user
  message sent meanwhile is replayed as a "mid-turn read" (ack edited to "📨 Claude đã đọc"), its answer is posted
  WITHOUT reply-to under the 🔔 status; after the answer the next sub-agent call opens a 2nd 🔔; if no main-thread
  result comes within RUN_TIMEOUT_MINUTES the turn timer kills the whole process (background agent lost).
- `TopicTurn.see(tool)` releases held text on a sub-agent call that lands between the main text and `result`.
  REPRODUCED: replay(ASK) → text "reply-to-ask" → sub-agent tool → result "reply-to-ask" ⇒ posted twice
  (reply to ASK, then as final answer). Same path uploads a 📎 file twice.
Fix: add `sub: boolean` to ToolEvent (from `parent_tool_use_id`); `startsTurn` and `release()` ignore sub-agent tools
(still show them in progress). Consider `init` as the adoption trigger. Verify with a real probe of a background Agent.

## Medium

### M1. Several messages read at one step: `owed` overwritten, an answer lost
`TopicTurn.read()` keeps only the last message. REPRODUCED (direct TopicTurn): read(2), read(3), text "Re msg 2",
tool, text "Re msg 3", tool ⇒ "Re msg 2" posted as reply to msg 3; "Re msg 3" dropped silently (no owed, no files).
Fix: FIFO of owed messages; each released text answers the oldest.

### M2. A Claude-opened ("alone") period runs user turns outside MAX_PARALLEL_RUNS
A message joining an alone period gets JOINED and is written at once; after the own turn closes it becomes a full
user turn with no slot, and the period lives on while messages keep coming. REPRODUCED with maxParallelRuns=1:
topic A holds the only slot (SLOW), topic B's user message runs and is answered before A ends, activeCount=1.
Inconsistent with a waiting scheduled period that adopts an own turn (its messages wait for the slot).
Also: a stopped alone period is not "busy" while its process is still dying (no scheduler job).
Fix: adoptOwnTurn enqueues the new period in the scheduler like `deliver` (adopt with alone=false); events are
handled before its slot comes, as for a waiting period; `run()` with an empty inbox then just finishes.

### M3. 📎 lines are acted on wherever they appear (security + noise)
FILE_LINE matches inside ``` fences and in quoted lists. REPRODUCED: "- 📎 ~/.ssh/id_ed25519" quoted from a README /
web page (prompt injection) ⇒ upload of the private key to the group; a fenced example "📎 <path>" ⇒ warning note
"Không gửi được tệp path"; a heading "📎 Tệp đính kèm:" ⇒ warning. Any readable file can go (router .env with the bot
token, ~/.ssh). Fix: skip fenced/quoted blocks; deny dot-dirs/.env*/key files and the router's own folder (or allow
only cwd, tmpdir, non-hidden home); only treat a spec that looks like a path.

### M4. Uploads can block the topic for ~10 min and duplicate
`upload` uses a fixed 120 s timeout; `deliver` retries code 0 (incl. timeout, local EBUSY/ENOENT) 5× with 2+4+8+16 s.
A 50 MB file on a < ~3.5 Mbit/s uplink: 5×120 s + 30 s ≈ 630 s with `conv.reporting` blocked (every later answer in
the topic waits), `reports>0` keeps the period busy and, for a scheduled period, its slot. A timeout after Telegram
got the body ⇒ duplicate file. Fix: timeout scaled by size; at most 1-2 upload attempts; no retry on local read errors.

## Low
- L1 Path handling: Git Bash `/tmp/x.png` ⇒ `D:\tmp\x.png` (should map to os.tmpdir()); `/mnt/d/..`, `**path**`,
  `[a](path)`, `📎\uFE0F path` all yield bogus paths; `> 📎`, `1. 📎`, `• 📎` lines are missed (stay in the text).
- L2 Own-turn status (`ownTurnStatus` → `sendAck`) bypasses `conv.reporting`: 🔔 can appear above the previous turn's
  final answer still posting (own turn opened by the not-yet-finished period).
- L3 The own turn's `init` reaches the finished owner and is dropped (no `saveTopicSession`); between that init and
  the first tool, `take()` sees `idle=true` and may send set_model to a Claude that is already working.
- L4 Summary elapsed time and session usage are now computed when the queue reaches the report: "✅ Xong · 12m"
  includes time spent behind a slow upload.
- L5 Own turn begun just as a user message E is written (owner = new period, E not replayed): the own-turn result is
  reported as E's answer, then E's turn reopens on the same status message (two ProgressStatus edit one message).
- L6 TELEGRAM_NOTE says the first text after reading a message is posted at once as its reply; when that text is the
  final answer it is dropped and the answer replies to the turn's first message instead.

## Verified OK
Ownership hand-off (proc.owner single, onEnd routed by owner, killed processes' events ignored); /stop of an own turn
in an alone, waiting, or still-posting period; process death mid own turn (cutShort, unread noted); claudeProcessFor
waits for a dying process before replacing it; queuePost never rejects; held text never posted after result/cutShort;
multipart form rebuilt per attempt with re-readable Bun.file; 400 photo ⇒ document fallback; TELEGRAM_NOTE `< | >`
safe (claude.exe only, arg quoted).

**Status:** DONE_WITH_CONCERNS
**Summary:** 1 High, 4 Medium, 6 Low; H1, M1, M2, M3 reproduced.
**Concerns:** H1 depends on Claude Code streaming background sub-agent messages after the main result (the fixture
assumes it does); confirm with a real probe.
