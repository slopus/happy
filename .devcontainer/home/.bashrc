
PS1="\[\033[0;34m\][\[\033[0;31m\]\u\[\033[0;31m\]@\[\033[0;31m\]\h \[\033[0;33m\]\w\[\033[0;34m\]] \[\033[1;36m\] $ \[\033[0m\]"

export LS_OPTIONS='--color=auto'
eval "$(dircolors)"
alias ls='ls $LS_OPTIONS'
alias ll='ls $LS_OPTIONS -l'
alias l='ls $LS_OPTIONS -lA'
