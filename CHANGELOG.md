# Changelog

## 2.1.0 — `/trace`
- **`/trace` slash command** (and `ttt trace [n|words]`): a waterfall of any task.
  - **What it shows:** every model call, tool call, wait on you, failure and subagent handoff, nested on one time axis. Each subagent sits under the `Agent` call that spawned it.
  - **In the terminal:** a compact waterfall, with Claude replying in three lines: the biggest time sink, what failed or waited on you, and one way to make it faster.
  - **In the browser:** summary chips, a collapsible span tree, `⌘F` search, zoom from 0.5× to 4×, a Slowest jump list, an inspect panel, and light/dark themes. It's one local file with no network requests.
- `install.sh` links the command into `~/.claude/commands/trace.md`, and `--uninstall` removes it.
- **Fix:** `$'` / `$&` in transcript data could corrupt generated HTML (the dashboard too). Templating now uses function replacements.
- **Fix:** the SVG renderer collapsed runs of spaces.

## 2.0.0 — forecasts, runway, loop alerts
- 🔮 **Pre-flight estimate** the moment you send a prompt, from TF-IDF similarity over finished tasks across all projects. On 182 real tasks it typically misses by ×2.6, against ×4.6 for guessing the median.
- 📋 **Plan burn-down** from Claude's todo list or its subagents finishing.
- 🔋 **5-hour runway** (`≈N tasks`) and an ⚠ **cap warning**, measured from per-session burn while working.
- 🏁 **Roadmap forecast** (`ttt plan`) from `TODO.md` / `ROADMAP.md` or GitHub issues.
- **Where the time goes** (`ttt why`): model, each tool, and waiting on you.
- **Waiting on you** (`ttt blocked [--apply]`), exact from permission decisions, with allow-rules.
- 🌀 **Loop alerts**, notifications and optional voice (Sam).
- **Forecast backtest** with calibrated ranges (`ttt report`, `ttt eta`), and model economics with API-equivalent cost.
- **`ttt dashboard`**: a local visual dashboard.

## 1.0.0 — Token to Time
- A status-bar segment for ccstatusline with the running task, project real time, tokens and an exchange rate.
- An incremental byte-offset transcript indexer, and `ttt report`, `ttt all`, `ttt convert`.
