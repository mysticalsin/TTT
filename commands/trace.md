---
description: Trace waterfall of your last task — every model call, tool, wait and subagent (TTT)
argument-hint: "[n | words from the prompt]"
allowed-tools: Bash(~/.claude/bin/ttt trace:*)
---
!`~/.claude/bin/ttt trace $ARGUMENTS --plain`

The trace above was produced by TTT and its interactive waterfall has been opened in the browser. Reply in at most three short lines: the single biggest time sink in this trace, anything that failed or waited on the user, and one concrete way to make a task like this faster next time. Do not repeat the waterfall and do not run any other tools.
