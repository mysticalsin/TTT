#!/bin/bash
# Install TTT: link the `ttt` CLI and add a Token-to-Time line to your ccstatusline bar.
# Idempotent and reversible:  ./install.sh            install / update
#                             ./install.sh --uninstall remove the bar line + link
set -e
R="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.claude/bin"
CFG="${CCSTATUSLINE_CONFIG:-$HOME/.config/ccstatusline/settings.json}"

command -v node >/dev/null 2>&1 || { echo "ERR: node is required"; exit 1; }
chmod +x "$R/bin/ttt.mjs"

if [ "$1" = "--uninstall" ]; then
  [ -L "$BIN/ttt" ] && rm "$BIN/ttt" && echo "rm   $BIN/ttt"
  [ -e "$CFG" ] && node "$R/scripts/statusline.mjs" remove "$CFG"
  echo "done."; exit 0
fi

mkdir -p "$BIN"
if [ -e "$BIN/ttt" ] && [ ! -L "$BIN/ttt" ]; then mv "$BIN/ttt" "$BIN/ttt.pre-ttt.bak"; echo "bak  $BIN/ttt"; fi
ln -sf "$R/bin/ttt.mjs" "$BIN/ttt"
echo "link $BIN/ttt -> $R/bin/ttt.mjs"

if [ -e "$CFG" ]; then
  node "$R/scripts/statusline.mjs" add "$CFG"
else
  echo "note: no ccstatusline config at $CFG"
  echo "      standalone: set statusLine.command to \"$BIN/ttt bar\" in ~/.claude/settings.json"
fi

# Warm the cache in the background so the first bar render is instant.
( "$BIN/ttt" index --all --quiet >/dev/null 2>&1 & )
echo "indexing your history in the background…"
echo "done.  Try:  ttt report   ·   ttt all   ·   ttt convert 250k"
