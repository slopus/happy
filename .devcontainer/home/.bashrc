
PS1="\[\033[0;34m\][\[\033[0;31m\]\u\[\033[0;31m\]@\[\033[0;31m\]\h \[\033[0;33m\]\w\[\033[0;34m\]] \[\033[1;36m\] $ \[\033[0m\]"

export LS_OPTIONS='--color=auto'
eval "$(dircolors)"
alias ls='ls $LS_OPTIONS'
alias ll='ls $LS_OPTIONS -l'
alias l='ls $LS_OPTIONS -lA'

alias m=make

alias g=git
alias gs="git status"
alias gd="git diff"
alias gl='git log --color --color-words'
alias gs='git status -s -uno'
alias gd='GIT_PAGER= git diff --color --color-words -w'

alias git_current_branch='git rev-parse --abbrev-ref HEAD'
alias gpom='git push origin `git_current_branch` || (git pull origin `git_current_branch` && git push origin `git_current_branch`)'
alias gpull='git pull origin `git_current_branch`'
alias gpull_rec='git pull origin `git_current_branch` && git submodule update --init --recursive'

# Silently fail if we're not in a git repo:
function print_git_branch() {
    git rev-parse --quiet --abbrev-ref HEAD 2> /dev/null || :
}

function set_git_prompt() {
    PS1="\[\033[0;34m\][\[\033[0;31m\]\u\[\033[0;31m\]@\[\033[0;31m\]\h \[\033[0;33m\]\w\[\033[0;34m\]] (\$(print_git_branch)) \[\033[1;36m\] \n\$ \[\033[0m\]"
}

export GITHUB_PERSONAL_ACCESS_TOKEN="$(cat ~/.github/PAT.txt)"

# source "$HOME/.local/bin/env"

export PATH=$PATH:/opt/local/bin/
export PATH=$PATH:/opt/cargo/bin

# Prioritize this to override other commands.
export PATH=$HOME/bin:$PATH

if [ -f /opt/venv/bin/activate ]; then
   source /opt/venv/bin/activate
fi

# export PATH=$PATH:$HOME/.local/bin

alias copilot-yolo='copilot -allow-pall-paths --allow-all-tools'

alias glo="git log --oneline --graph --decorate --all -30"
