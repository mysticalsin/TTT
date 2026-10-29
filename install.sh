#!/bin/bash
# Install TTT: the Claude Code bar (ccstatusline layout + cc-health.sh), Sam's voice-out,
# the `ttt` CLI and /trace. Idempotent and reversible:
#   ./install.sh              install / update everything
#   ./install.sh --ttt-only   keep your own ccstatusline bar, only add the TTT line to it
#   ./install.sh --uninstall  remove every link this installer made, restore backups
set -e
R="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.claude/bin"
CFG="${CCSTATUSLINE_CONFIG:-$HOME/.config/ccstatusline/settings.json}"
DOTFILES=".claude/bin/cc-health.sh .claude/bin/cc-tokens .claude/bin/sam .config/ccstatusline/settings.json"

command -v node >/dev/null 2>&1 || { echo "ERR: node is required"; exit 1; }
chmod +x "$R/bin/ttt.mjs" "$R/.claude/bin/cc-health.sh" "$R/.claude/bin/cc-tokens" "$R/.claude/bin/sam"

link() { # $1 = path relative to $HOME and to this repo; backs up a real file before linking
  local src="$R/$1" dst="$HOME/$1"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then echo "ok   $dst"; return; fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then mv "$dst" "$dst.pre-dotfiles.bak"; echo "bak  $dst -> $dst.pre-dotfiles.bak"; fi
  ln -sfn "$src" "$dst"
  echo "link $dst -> $src"
}

unlink_ours() { # $1 = path relative to $HOME; only removes links into this repo
  local dst="$HOME/$1"
  [ -L "$dst" ] && [ "$(readlink "$dst")" = "$R/$1" ] || return 0
  rm "$dst" && echo "rm   $dst"
  if [ -e "$dst.pre-dotfiles.bak" ]; then mv "$dst.pre-dotfiles.bak" "$dst"; echo "back $dst"; fi
}

if [ "$1" = "--uninstall" ]; then
  [ -L "$BIN/ttt" ] && rm "$BIN/ttt" && echo "rm   $BIN/ttt"
  [ -L "$HOME/.claude/commands/trace.md" ] && rm "$HOME/.claude/commands/trace.md" && echo "rm   ~/.claude/commands/trace.md"
  # Our own layout carries the TTT line, so unlinking it is enough; someone else's gets the line removed.
  if [ -e "$CFG" ] && [ "$(readlink "$CFG")" != "$R/.config/ccstatusline/settings.json" ]; then
    node "$R/scripts/statusline.mjs" remove "$CFG"
  fi
  for f in $DOTFILES; do unlink_ours "$f"; done
  echo "done."; exit 0
fi

# The bar: cc-health.sh, cc-tokens, sam and the ccstatusline layout (which already has the TTT line).
if [ "$1" != "--ttt-only" ]; then
  for f in $DOTFILES; do link "$f"; done
  command -v jq >/dev/null 2>&1 || echo "WARN: jq not installed (cc-health.sh needs it) -> brew install jq"
  command -v ccstatusline >/dev/null 2>&1 \
    && echo "ccstatusline: $(ccstatusline --version 2>/dev/null || echo installed)" \
    || echo "WARN: ccstatusline not installed -> npm install -g ccstatusline@2.2.19"
fi

mkdir -p "$BIN"
if [ -e "$BIN/ttt" ] && [ ! -L "$BIN/ttt" ]; then mv "$BIN/ttt" "$BIN/ttt.pre-ttt.bak"; echo "bak  $BIN/ttt"; fi
ln -sf "$R/bin/ttt.mjs" "$BIN/ttt"
echo "link $BIN/ttt -> $R/bin/ttt.mjs"

# /trace slash command for Claude Code (user-level, every project).
CMD="$HOME/.claude/commands"
mkdir -p "$CMD"
if [ -e "$CMD/trace.md" ] && [ ! -L "$CMD/trace.md" ]; then
  echo "skip $CMD/trace.md exists and isn't ours — leaving it alone"
else
  ln -sf "$R/commands/trace.md" "$CMD/trace.md"
  echo "link $CMD/trace.md -> $R/commands/trace.md   (/trace in Claude Code)"
fi

if [ -e "$CFG" ]; then
  node "$R/scripts/statusline.mjs" add "$CFG"
else
  echo "note: no ccstatusline config at $CFG"
  echo "      standalone: set statusLine.command to \"$BIN/ttt bar\" in ~/.claude/settings.json"
fi

# Warm the cache in the background so the first bar render is instant.
( "$BIN/ttt" index --all --quiet >/dev/null 2>&1 & )
echo "indexing your history in the background…"
echo "done.  Try:  ttt report   ·   ttt all   ·   ttt convert 250k   ·   sam \"hello\""
