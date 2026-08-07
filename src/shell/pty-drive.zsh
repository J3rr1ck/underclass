# Drive an interactive zsh through a real pty and echo everything it printed.
#
# The whole point: `zsh -i < file` never reaches a prompt, so `precmd` never
# fires and the hook under test never runs. A pty is not a nicety here, it is
# the only way to observe the bug. `zpty` is a zsh module, so this needs no
# expect, no python, and no dependency.
#
# usage: zsh pty-drive.zsh <zshrc-to-source> <command>...
emulate -L zsh
zmodload zsh/zpty || { print -u2 "zpty unavailable"; exit 77 }

local zrc=$1; shift
zpty -d
zpty z "zsh -f -i"
# -f skips the real rc files; PROMPT is set small so output is easy to read.
zpty -w z "PROMPT='### '"
zpty -w z "source ${(q)zrc}"
for c in "$@"; do zpty -w z "$c"; done
zpty -w z "exit"

local line out=""
while zpty -r z line; do out+="$line"; done
zpty -d z
print -r -- "$out"
