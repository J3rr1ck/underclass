# underclass danger zsh integration
# Provides tab completion for plain words, command-not-found hints, and failure tracking.

_danger_preexec() {
    export DANGER_LAST_CMD="$1"
    export DANGER_LAST_CWD="$PWD"
}

_danger_precmd() {
    export DANGER_LAST_STATUS="$?"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _danger_preexec
add-zsh-hook precmd _danger_precmd

danger_suggest() {
    local BUFFER_VAL="$BUFFER"
    if [[ -n "$BUFFER_VAL" && ! "$BUFFER_VAL" =~ "^[a-zA-Z0-9_-]+\ " ]]; then
        local SUGGESTION=$(danger assist "$BUFFER_VAL" 2>/dev/null)
        if [[ -n "$SUGGESTION" ]]; then
            BUFFER="$SUGGESTION"
            CURSOR=${#BUFFER}
        fi
    fi
}

zle -N danger_suggest
bindkey '^I' danger_suggest

command_not_found_handler() {
    local cmd="$1"
    echo "danger: command not found: $cmd" >&2
    danger assist --hint "$cmd" >&2
    return 127
}
