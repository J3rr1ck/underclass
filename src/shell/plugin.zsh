# danger.plugin.zsh — zsh, with help when you need it.
#
# This is not a shell. It is your shell, plus four things:
#
#   1. Tab on prose        writes the command you described
#   2. command not found   says how to install it, not just that it is missing
#   3. a failed command    gets a one-line hint when we have one to give
#   4. `danger why`        explains the last failure; `danger edit` makes small edits
#
# WHY A PLUGIN AND NOT A SHELL. Every alt shell that made safety a language
# feature (murex, nushell, xonsh) traded POSIX for it, and the trade cost them
# adoption, so their safety reached nobody. Wrapping zsh keeps your completion,
# your globbing, your job control, your history, your prompt, your framework and
# your muscle memory — all of it, because it *is* zsh. Uninstalling is deleting
# one line. See docs/danger-terminal/DESIGN.md §1.3 for the full comparison.
#
# WHAT IT DOES NOT DO. It does not gate, veto, or checkpoint your commands, and
# it never edits a file without showing you a diff first. The design for the
# gate exists and is deliberately not implemented here: a tool that intercepts
# every command needs an undo substrate underneath it, and that substrate is a
# separate, much larger piece of work. Until it exists, this plugin only ever
# *suggests* — the Enter key stays yours.
#
# Cost when idle: two hook functions of pure zsh, no subprocess, no PATH scan,
# no network. A subprocess is spawned only when you press the suggest key or run
# `danger why`.

# Re-sourcing must be harmless: frameworks and shell integrations re-source rc
# files, and a plugin that double-wraps its own widget wedges the Tab key.
(( ${+DANGER_PLUGIN_LOADED} )) && return 0
typeset -g DANGER_PLUGIN_LOADED=1
typeset -g DANGER_PLUGIN_VERSION=0.1.0-alpha.1

# --- configuration ------------------------------------------------------------
# All overridable from .zshrc *before* sourcing this file.
: ${DANGER_SUGGEST_KEY:='^X^A'}     # explicit "write me a command" key
: ${DANGER_SMART_TAB:=1}            # 1 = Tab on prose asks; 0 = Tab is only ever zsh's
: ${DANGER_HINTS:=1}                # 1 = one-line hints after a failure
: ${DANGER_CNF:=1}                  # 1 = install advice on command-not-found
: ${DANGER_SUGGEST_TIMEOUT:=8}     # seconds Tab may block (it is NOT interruptible)
typeset -g DANGER_HOME="${DANGER_HOME:-${HOME}/.underclass}"

# The generated rule tables. Absent (or a failed `danger init`) degrades to
# silence rather than to an error on every prompt.
[[ -r "$DANGER_HOME/shell/danger-rules.zsh" ]] && source "$DANGER_HOME/shell/danger-rules.zsh"

# `danger` must be a real command, because every model-backed feature shells out
# to it: Tab on prose, `danger why`, `danger edit`. Running from a checkout
# (`node …/dist/danger.js shell`) leaves it off PATH, and the failure is silent —
# Tab does nothing, `why` reports "command not found", and what remains looks
# like a shell that never explains anything. `danger init` stages a shim; use it
# if the real binary is not already reachable.
if ! whence -p danger >/dev/null 2>&1; then
  if [[ -x "$DANGER_HOME/shell/bin/danger" ]]; then
    path=( "$DANGER_HOME/shell/bin" $path )
  else
    # Loud, once, at startup — not silently degraded on every keypress.
    print -u2 -r -- $'\e[33mdanger: the `danger` command is not on PATH, so Tab-on-prose and `danger why`\e[0m'
    print -u2 -r -- $'\e[33m  will not work. Fix with:  npm link -w underclass    (or re-run `danger init`)\e[0m'
    typeset -g DANGER_NO_BIN=1
  fi
fi

typeset -g DANGER_LAST_CMD=''
typeset -g DANGER_LAST_STATUS=0
typeset -g DANGER_LAST_CWD=''
# The last *failure*, latched, as distinct from the last command. `danger why`
# reads these and nothing else. Keeping them separate is the whole fix for the
# bug where `why` explained itself: `preexec` fires for `danger why` too, so by
# the time the wrapper runs, DANGER_LAST_CMD is already "danger why".
typeset -g DANGER_FAILED_CMD=''
typeset -g DANGER_FAILED_STATUS=0
typeset -g DANGER_FAILED_CWD=''
typeset -g DANGER_LAST_START=0
typeset -g DANGER_HINTED_ONCE=0

autoload -Uz add-zsh-hook

# --- 3. a failed command gets a hint ------------------------------------------

# preexec sees the command *after* alias expansion, which is the string the user
# effectively ran and therefore the one worth diagnosing.
danger_preexec() {
  DANGER_LAST_CMD="$3"
  DANGER_LAST_CWD="$PWD"
  # $EPOCHSECONDS is a zsh/datetime parameter — no fork. Absent module → 0.
  DANGER_LAST_START=${EPOCHSECONDS:-0}
}

danger_precmd() {
  # $? MUST be read on the first line: anything before it, including a
  # conditional, replaces the status we are here to capture. Restoring it on the
  # way out matters just as much — other precmd hooks (prompt themes, Cursor's
  # and VS Code's shell integration) read $? too, and a plugin that clobbers it
  # silently breaks their error indicators.
  local st=$?
  DANGER_LAST_STATUS=$st

  (( st == 0 )) && return $st
  [[ -n $DANGER_LAST_CMD ]] || return $st
  # 130 is Ctrl-C. The user knows — and latching it would bury the real failure
  # they are about to ask about.
  (( st == 130 )) && return $st

  local -a words
  words=( ${(z)DANGER_LAST_CMD} ) 2>/dev/null || words=( ${=DANGER_LAST_CMD} )
  local head=${words[1]:t}

  # Never latch danger's own invocations. Without this the bug comes back in a
  # slower form: `danger why` fails (an unreachable endpoint is the common
  # offline case), precmd latches "danger why" as the failure, and the next
  # `danger why` is back to explaining itself.
  [[ $head == danger ]] && return $st

  # Latch the failure. Deliberately ahead of every remaining early return: an
  # explicit `danger why` must work even with DANGER_HINTS=0, and even for a
  # command whose non-zero exit we decline to volunteer a hint about.
  DANGER_FAILED_CMD=$DANGER_LAST_CMD
  DANGER_FAILED_STATUS=$st
  DANGER_FAILED_CWD=$DANGER_LAST_CWD

  (( DANGER_HINTS )) || return $st

  # A non-zero exit from grep is an answer, not a failure.
  if (( ${+DANGER_BENIGN_NONZERO} )); then
    (( ${DANGER_BENIGN_NONZERO[(Ie)$head]} )) && return $st
  fi

  local hint=''
  (( ${+functions[danger_status_hint]} )) && hint=$(danger_status_hint $st $head)

  if [[ -n $hint ]]; then
    print -u2 -r -- "$(danger_dim 'danger:') $hint"
  elif (( ! DANGER_HINTED_ONCE )); then
    # Said once per session, then never again. A tool that reminds you of itself
    # after every failure gets muted, and then its real hints go unread too.
    DANGER_HINTED_ONCE=1
    if (( ${+DANGER_NO_BIN} )); then
      print -u2 -r -- "$(danger_dim "danger: \`danger why\` would explain that, but the danger command is not on PATH.")"
    else
      print -u2 -r -- "$(danger_dim "danger: run \`danger why\` to have that explained. (said once per session)")"
    fi
  fi
  return $st
}

danger_dim() { print -n -- $'\e[2m'"$1"$'\e[0m' }

add-zsh-hook preexec danger_preexec
add-zsh-hook precmd  danger_precmd

# --- 2. command not found -----------------------------------------------------

if (( DANGER_CNF )); then
  # Chain rather than replace: some setups (Debian, nix, brew's own) already
  # define this, and theirs may know about packages we do not.
  if (( ${+functions[command_not_found_handler]} )); then
    functions[danger_orig_cnf]=$functions[command_not_found_handler]
  fi

  command_not_found_handler() {
    local cmd=$1
    local advice=''
    (( ${+DANGER_INSTALL_HINT} )) && advice=${DANGER_INSTALL_HINT[$cmd]}

    if [[ -n $advice ]]; then
      print -u2 -r -- "danger: \`$cmd\` is not installed. $advice"
      return 127
    fi

    # No table entry. zsh can do approximate matching against its own command
    # hash with (#a1), which is a one-error fuzzy glob — so "gti" finds "git"
    # without forking, without a spell-check dependency, and without a network
    # call. Restricted to a *populated* hash so a fresh shell does not answer
    # "no idea" purely because it has not scanned PATH yet.
    setopt localoptions extendedglob null_glob
    if (( ${#commands} > 20 )); then
      local -a near
      near=( ${(k)commands[(I)(#a1)$cmd]} )
      if (( ${#near} )); then
        print -u2 -r -- "danger: \`$cmd\` not found. Did you mean: ${(j:, :)near[1,4]}?"
        return 127
      fi
    fi

    if (( ${+functions[danger_orig_cnf]} )); then
      danger_orig_cnf "$@"
      return $?
    fi
    print -u2 -r -- "zsh: command not found: $cmd"
    return 127
  }
fi

# --- 1. Tab on prose ----------------------------------------------------------

# Prose detection, fork-free. The question is only "would zsh's own completion
# have anything to say here?" — if the first word names something runnable, zsh
# is better at this than any model, and we must not get in the way.
danger_is_prose() {
  emulate -L zsh
  setopt localoptions no_extendedglob
  local buf=${1## #}
  [[ -n ${buf//[[:space:]]/} ]] || return 1

  local -a words
  words=( ${=buf} )
  # Under three words it is a command being typed, not a sentence. Always zsh's.
  (( ${#words} >= 3 )) || return 1

  # "Is the first word a command?" is the obvious test and it is WRONG: `find`,
  # `make`, `test`, `sort`, `kill`, `open`, `head`, `which`, `time` and `install`
  # are all binaries AND all natural sentence openers. "find all files larger
  # than 100mb" is prose that begins with a real command, and treating it as
  # shell is the failure that makes this feature feel broken.
  #
  # Grammar separates them instead. Shell is terse and omits function words;
  # English cannot. So: any flag means shell, any operator means shell, and
  # otherwise two function words mean prose.
  local w
  for w in $words; do
    [[ $w == -[A-Za-z?]* || $w == --[A-Za-z]* ]] && return 1
  done
  # Operators, expansions, globs, quoting. Paths are deliberately NOT here —
  # "add a null check to src/foo.ts" is prose that mentions a path.
  [[ $buf == *[\|\&\;\<\>\$\`\*\?\{\}\[\]\(\)\"\']* ]] && return 1
  [[ ${words[1]} == [A-Za-z_]##*=* ]] && return 1

  (( ${+DANGER_PROSE_WORD} )) || return 1
  local -i score=0
  # A first word that names nothing runnable is worth a point on its own — that
  # is what catches "refactor the parser module", which has only one function
  # word but cannot possibly be a command. `whence -w` is a builtin covering
  # commands, builtins, functions, aliases and reserved words without forking.
  whence -w -- ${words[1]} >/dev/null 2>&1 || (( score++ ))
  for w in $words; do
    # Strip trailing punctuation so "files?" still counts, and lowercase.
    w=${${(L)w}%%[.,!?:\;]##}
    if (( ${+DANGER_PROSE_WORD[$w]} )); then
      (( ++score >= 2 )) && return 0
    fi
  done
  (( score >= 2 ))
}

# Destructive-looking suggestions get flagged before the user's finger is on
# Enter. This is advisory: there is no undo substrate yet, and pretending
# otherwise would be the one unforgivable lie for a tool called danger.
danger_looks_destructive() {
  setopt localoptions extendedglob
  [[ $1 == (*rm[[:space:]]#-#[[:alpha:]]#[[:space:]]*|*(#i)rm\ -(r|f)*|*mkfs*|*dd\ *of=*|*:\>*|*chmod\ -R*|*chown\ -R*|*git\ (reset\ --hard|clean\ -[a-z]#d|push\ --force)*|*truncate*|*shred*) ]]
}

danger_ask() {
  local buf=$BUFFER
  [[ -n ${buf//[[:space:]]/} ]] || { zle -M "danger: describe what you want, then press the suggest key."; return }

  # ZLE has no async primitive, so this blocks — and it blocks UNINTERRUPTIBLY.
  # Ctrl-C during the command substitution below does not return the line:
  # measured, Ctrl-C at 2.0s and no Ctrl-C at all both released at 10.6s. The
  # earlier message here promised "Ctrl-C to cancel", which was simply false, so
  # it now states the real bound instead. A server that accepts and never
  # replies costs the full timeout — measured at 25.1s before this was lowered.
  zle -M "danger: asking… (blocks until the model answers; up to ${DANGER_SUGGEST_TIMEOUT}s)"
  zle -R

  local out ec
  out=$(DANGER_FROM_SHELL=1 command danger _suggest --cwd "$PWD" --timeout $DANGER_SUGGEST_TIMEOUT -- "$buf" 2>/dev/null)
  ec=$?

  if (( ec != 0 )) || [[ -z ${out//[[:space:]]/} ]]; then
    zle -M "danger: no suggestion. \`under doctor\` checks whether a model is reachable."
    return
  fi

  # Take the first line — via an ARRAY, not a nested subscript.
  #
  # `${${(f)out}[1]}` looks like "first line" and is not. When the inner
  # expansion yields exactly one element, zsh subscripts the SCALAR, so `[1]`
  # is its first CHARACTER: a reply of "find . -size +100M" put a bare `f` in
  # the buffer. And SUGGEST_SYSTEM (assist.ts) demands a one-line reply, so the
  # better the model behaved the more reliably this broke — while the widget
  # still printed "Enter to run". Verified in zsh both ways.
  local -a __danger_lines
  __danger_lines=( ${(f)out} )
  local cmdline=${__danger_lines[1]}
  [[ -n $cmdline ]] || { zle -M "danger: empty suggestion."; return }

  # The original prose goes into history so the *intent* is searchable later,
  # and so Up-arrow returns you to what you asked rather than to what it
  # answered. This is also the undo: the buffer is replaced, not executed.
  print -s -- "$buf"

  BUFFER=$cmdline
  CURSOR=${#BUFFER}
  if danger_looks_destructive "$cmdline"; then
    zle -M "danger: this suggestion deletes or rewrites things. Read it. There is no undo."
  else
    zle -M "danger: Enter to run, Ctrl-U to discard, Up for what you typed."
  fi
}
zle -N danger_ask
bindkey "$DANGER_SUGGEST_KEY" danger_ask

if (( DANGER_SMART_TAB )); then
  # Wrap whatever Tab currently does rather than assuming `expand-or-complete`:
  # oh-my-zsh, prezto, fzf-tab and zsh-autocomplete all rebind it, and stealing
  # the key from them is how a plugin earns an uninstall.
  typeset -g DANGER_TAB_FALLBACK
  () {
    local -a b
    b=( ${(z)"$(bindkey '^I')"} )
    local w=${b[2]//\"/}
    # Guard against binding to ourselves, and against an unbound Tab.
    if [[ -n $w && $w != danger_smart_tab && ${+widgets[$w]} == 1 ]]; then
      DANGER_TAB_FALLBACK=$w
    else
      DANGER_TAB_FALLBACK=expand-or-complete
    fi
  }

  danger_smart_tab() {
    if danger_is_prose "$LBUFFER"; then
      danger_ask
    else
      zle "$DANGER_TAB_FALLBACK"
    fi
  }
  zle -N danger_smart_tab
  bindkey '^I' danger_smart_tab
fi

# --- 4. `danger why` needs to know what just failed ---------------------------

# A wrapper function, because the last failure lives in shell variables and a
# child process cannot read them. This is also the only way `danger why` with no
# arguments can work at all: nothing is written to disk, so there is no per-
# command fork and no state file to go stale.
#
# `command danger` everywhere below bypasses this function, so the plugin's own
# calls do not recurse.
danger() {
  if [[ $1 == why && $# -eq 1 ]]; then
    # The latch, NOT DANGER_LAST_CMD — which by now says "danger why", because
    # preexec fired for this very invocation before this function ran. The latch
    # also survives an intervening successful command, so `npm test` / `ls` /
    # `danger why` still explains npm test.
    if [[ -z $DANGER_FAILED_CMD ]]; then
      print -u2 -r -- "danger: nothing has failed in this shell yet."
      return 1
    fi
    DANGER_LAST_CMD="$DANGER_FAILED_CMD" \
    DANGER_LAST_STATUS="$DANGER_FAILED_STATUS" \
    DANGER_LAST_CWD="${DANGER_FAILED_CWD:-$PWD}" \
      command danger why
    return $?
  fi
  command danger "$@"
}

# --- 5. completion for danger itself ------------------------------------------
# Only registered if compinit has already run; calling compdef before it exists
# is a startup error, and being the plugin that breaks startup is unrecoverable.
if (( ${+functions[compdef]} )); then
  _danger() {
    local -a subs
    subs=(
      'why:explain the last failed command'
      'edit:make a small edit to one file, with a diff to approve'
      'shell:start a subshell with this plugin loaded'
      'init:install into ~/.zshrc'
      '--yolo:let the agent fix a failure and re-run'
      '--explain:diagnose a failure without editing anything'
    )
    if (( CURRENT == 2 )); then
      _describe -t commands 'danger' subs && return
    fi
    # Past the subcommand, complete a command line — `danger npm test` is the
    # common shape, so defer to zsh's own command completion.
    shift words; (( CURRENT-- )); _normal
  }
  compdef _danger danger
fi

# --- what the user sees on first install --------------------------------------
if [[ -n ${DANGER_GREET:-} ]]; then
  print -r -- "danger $DANGER_PLUGIN_VERSION — this is zsh, plus:"
  if (( ${+DANGER_NO_BIN} )); then
    print -r -- "$(danger_dim '  · install advice on an unknown command, and a hint after a failure')"
    print -r -- "$(danger_dim '  · Tab-on-prose and `danger why` are UNAVAILABLE — see the warning above')"
  else
    print -r -- "$(danger_dim '  · type what you want and press Tab — it writes the command')"
    print -r -- "$(danger_dim '  · `danger why` explains the last failure; `danger edit F "change"` edits one file')"
    print -r -- "$(danger_dim '  · unknown commands get install advice; failures get a one-line hint')"
  fi
  print -r -- "$(danger_dim '  Everything else is your zsh, unchanged. `exit` leaves.')"
  unset DANGER_GREET
fi
