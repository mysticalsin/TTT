#!/bin/bash
# cc-health.sh — reads Claude Code status JSON on stdin, prints a color-coded
# health segment. Colors: green <70% used, amber 70-89%, red >=90%.
# Usage (as a ccstatusline custom-command, preserveColors:true):
#   cc-health.sh ctx      -> "🧠 NN% ctx"
#   cc-health.sh limits   -> "🔋 5h … → resets HH:MM · on track   📅 7d … → resets …"
mode="${1:-limits}"
json="$(cat)"

RST=$'\033[0m'
DIM=$'\033[38;5;245m'

# ---- truecolor rainbow (24-bit). _rb prints `filled` rainbow cells then
# `total-filled` dim cells, hue flowing from `off` degrees. ccstatusline passes
# it through untouched because the widget is preserveColors:true. ----
_rb() { # $1 filled  $2 total  $3 off_deg  $4 fillchar  $5 emptychar
  awk -v f="$1" -v t="$2" -v off="$3" -v fc="$4" -v ec="$5" '
  function hsv(h,  i,fr,r,g,b){
    h=((h%360)+360)%360; h=h/60.0; i=int(h); fr=h-i;
    if(i==0){r=1;g=fr;b=0} else if(i==1){r=1-fr;g=1;b=0}
    else if(i==2){r=0;g=1;b=fr} else if(i==3){r=0;g=1-fr;b=1}
    else if(i==4){r=fr;g=0;b=1} else {r=1;g=0;b=1-fr}
    return sprintf("38;2;%d;%d;%d", r*255, g*255, b*255) }
  BEGIN{ s=""; n=(t>0?t:1);
    for(j=0;j<f;j++){ s=s sprintf("\033[%sm%s", hsv(off + j*(360.0/n)), fc) }
    for(j=f;j<t;j++){ s=s sprintf("\033[38;5;238m%s", ec) }
    printf "%s\033[0m", s }'
}

# ---- rainbow mode: a full-width flowing rainbow rule (the color-rich headline
# row). Placed before the jq check so it renders even without jq. ----
if [ "$mode" = "rainbow" ]; then
  w="${COLUMNS:-60}"; [[ "$w" =~ ^[0-9]+$ ]] || w=60
  (( w>100 )) && w=100; (( w<12 )) && w=44
  off=${RB_OFF:-$(( ($(date +%s) * 37) % 360 ))}
  _rb "$w" "$w" "$off" "─" "─"
  exit 0
fi

# color by danger pct
col() {
  local p="${1%%.*}"; [[ "$p" =~ ^[0-9]+$ ]] || p=0
  if   [ "$p" -ge 90 ]; then printf '\033[38;5;203m'   # red
  elif [ "$p" -ge 70 ]; then printf '\033[38;5;215m'   # amber
  else                       printf '\033[38;5;115m'   # green
  fi
}
bar() { # $1 pct  $2 width (default 5)
  local p="${1%%.*}" w="${2:-5}"; [[ "$p" =~ ^[0-9]+$ ]] || p=0
  (( p<0 )) && p=0; (( p>100 )) && p=100
  local f=$(( p*w/100 )) e i s=""
  e=$(( w-f ))
  for ((i=0;i<f;i++)); do s+="▓"; done
  for ((i=0;i<e;i++)); do s+="░"; done
  printf '%s' "$s"
}
clock() { # epoch -> HH:MM (local)
  [[ "$1" =~ ^[0-9]+$ ]] || { printf '?'; return; }
  if date -r 0 +%s >/dev/null 2>&1; then date -r "$1" +"%H:%M"; else date -d "@$1" +"%H:%M"; fi
}
dayclock() { # epoch -> "Thu HH:MM"
  [[ "$1" =~ ^[0-9]+$ ]] || { printf '?'; return; }
  if date -r 0 +%s >/dev/null 2>&1; then date -r "$1" +"%a %H:%M"; else date -d "@$1" +"%a %H:%M"; fi
}

ecol() { # effort level -> ANSI color
  case "$1" in
    low)    printf '\033[38;5;245m';;  # gray
    medium) printf '\033[38;5;80m';;   # cyan
    high)   printf '\033[38;5;227m';;  # yellow
    xhigh)  printf '\033[38;5;214m';;  # orange
    max)    printf '\033[38;5;203m';;  # red
    *)      printf '\033[38;5;245m';;
  esac
}
project() { # $1 used%  $2 resets_at  $3 window_sec  [$4 max_horizon_sec] -> "ok" or red "⚠cap~Xm/h"
  local u="${1%%.*}" r="$2" win="$3" maxh="${4:-0}"
  if ! [[ "$r" =~ ^[0-9]+$ ]] || ! [ "$u" -gt 0 ] 2>/dev/null; then printf '%sok%s' "$DIM" "$RST"; return; fi
  local remain=$(( r - now )) elapsed=$(( win - (r - now) ))
  if [ "$elapsed" -le 60 ]; then printf '%sok%s' "$DIM" "$RST"; return; fi
  local cap cm; cap=$(awk -v e="$elapsed" -v u="$u" 'BEGIN{printf "%d", e*(100/u-1)}')
  # warn only if projected to cap before reset, and (when a horizon is set) within that horizon
  if [ "$cap" -lt "$remain" ] && { [ "$maxh" -le 0 ] || [ "$cap" -lt "$maxh" ]; }; then
    cm=$(( cap/60 ))
    if [ "$cm" -lt 60 ]; then printf '\033[38;5;203m⚠cap~%dm%s' "$cm" "$RST"
    else printf '\033[38;5;203m⚠cap~%dh%s' "$(( cm/60 ))" "$RST"; fi
  else printf '%sok%s' "$DIM" "$RST"; fi
}

command -v jq >/dev/null 2>&1 || { printf ''; exit 0; }
now=$(date +%s)

if [ "$mode" = "effort" ]; then
  lvl=$(jq -r '.effort.level // empty' <<<"$json" 2>/dev/null)
  { [ -z "$lvl" ] || [ "$lvl" = "null" ]; } && exit 0
  printf '💭 \033[1m%s%s%s' "$(ecol "$lvl")" "$lvl" "$RST"
  exit 0
fi

if [ "$mode" = "ctx" ]; then
  size=$(jq -r '.context_window.context_window_size // 200000' <<<"$json" 2>/dev/null)
  pct=$(jq -r '.context_window.used_percentage // empty' <<<"$json" 2>/dev/null)
  if [ -z "$pct" ] || [ "$pct" = "null" ]; then
    used=$(jq -r '((.context_window.current_usage.input_tokens // 0) + (.context_window.current_usage.cache_creation_input_tokens // 0) + (.context_window.current_usage.cache_read_input_tokens // 0))' <<<"$json" 2>/dev/null)
    [[ "$used" =~ ^[0-9]+$ ]] && [ "$size" -gt 0 ] 2>/dev/null && pct=$(( used*100/size )) || pct=""
  fi
  [ -z "$pct" ] && exit 0
  pi="${pct%%.*}"
  warn=""
  [ "$pi" -ge 85 ] 2>/dev/null && warn=$' \033[38;5;203m⚠compact soon\033[0m'
  printf '🧠 %s%s%% ctx%s%s' "$(col "$pi")" "$pi" "$RST" "$warn"
  exit 0
fi

# ---- limits mode: 5h block + 7-day ----
h5=$(jq -r '.rate_limits.five_hour.used_percentage // empty' <<<"$json" 2>/dev/null)
h5r=$(jq -r '.rate_limits.five_hour.resets_at // empty' <<<"$json" 2>/dev/null)
d7=$(jq -r '.rate_limits.seven_day.used_percentage // empty'  <<<"$json" 2>/dev/null)
d7r=$(jq -r '.rate_limits.seven_day.resets_at // empty'   <<<"$json" 2>/dev/null)

out=""
if [ -n "$h5" ] && [ "$h5" != "null" ]; then
  h5i="${h5%%.*}"
  status="$(project "$h5i" "$h5r" 18000)"   # 5h block = 18000s
  out="🔋5h $(col "$h5i")$(bar "$h5i") ${h5i}%${RST} ${DIM}↻$(clock "$h5r")${RST} ${status}"
fi
if [ -n "$d7" ] && [ "$d7" != "null" ]; then
  d7i="${d7%%.*}"
  d7status="$(project "$d7i" "$d7r" 604800 86400)"   # 7d window; only warn if cap <24h out
  case "$d7status" in *cap*) extra=" ${d7status}";; *) extra="";; esac
  [ -n "$out" ] && out="${out}   "
  out="${out}📅7d $(col "$d7i")$(bar "$d7i") ${d7i}%${RST} ${DIM}↻$(dayclock "$d7r")${RST}${extra}"
fi
printf '%s' "$out"
