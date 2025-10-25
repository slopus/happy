#!/bin/bash

# A simple wrapper to drive claude repeatedly with a generic prompt.

set -e  # Exit on error

# Check arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 ITERS [PROMPT1] [PROMPT2] ..."
    echo "  ITERS: Number of iterations to run"
    echo "  PROMPT1, PROMPT2, ...: Optional prompt files for first N iterations"
    echo ""
    echo "Examples:"
    echo "  $0 5                    # All 5 iterations use generic prompt"
    echo "  $0 5 task1.txt          # Iteration 1 uses task1.txt, iterations 2-5 use generic"
    echo "  $0 5 t1.txt t2.txt t3.txt  # Iterations 1-3 use custom prompts, 4-5 use generic"
    exit 1
fi

# Hmm, this can have different relationships to the top of repo...
cd "$(dirname $0)"/
PROMPT_DIR="./prompts"

ITERS=$1
shift  # Remove first argument, leaving prompt files in $@

# Store prompt files in an array
PROMPT_FILES=("$@")

# Ensure logs directory exists
mkdir -p ./logs

# Run iterations
for ((i=1; i<=ITERS; i++)); do
    echo "=== Iteration $i of $ITERS ==="

    # Find unused log filename for this iteration
    XY=1
    while [ -f "./logs/claude_workstream$(printf '%02d' $XY).jsonl" ]; do
        XY=$((XY + 1))
    done

    LOG="./logs/claude_workstream$(printf '%02d' $XY).jsonl"
    LATEST="./logs/claude_workstream_latest.jsonl"
    echo "Using log file: $LOG"
    ln -sf "$LOG" "$LATEST"

    # Determine which prompt file to use
    # Array is 0-indexed, so iteration i uses index i-1
    PROMPT_INDEX=$((i - 1))
    if [ $PROMPT_INDEX -lt ${#PROMPT_FILES[@]} ] && [ -n "${PROMPT_FILES[$PROMPT_INDEX]}" ]; then
        PROMPT_FILE="${PROMPT_FILES[$PROMPT_INDEX]}"
        echo "Using custom prompt for iteration $i: $PROMPT_FILE"
    else
        PROMPT_FILE="generic_forward_progress_task.txt"
        echo "Using generic prompt for iteration $i"
    fi

    # Run claude command, tee to log, and extract results
    # Remove control characters (except newline) before passing to jq to avoid parse errors
    time claude --dangerously-skip-permissions --verbose --output-format stream-json -c -p "$(cat "$PROMPT_DIR/$PROMPT_FILE")" | \
        tee -a "$LOG" | \
        perl -pe 's/[\x00-\x09\x0b-\x1f]//g' | \
	jq  -r 'select (.type == "assistant" or .type == "result") | [.message.content.[0].text, .result]'

    # Check for error.txt
    if [ -f error.txt ]; then
        echo "Error detected in error.txt:"
        cat error.txt
        exit 1
    fi

    echo "Completed iteration $i"
done

echo "Successfully completed all $ITERS iterations"
exit 0
