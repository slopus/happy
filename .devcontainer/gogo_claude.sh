#!/bin/bash

# A simple wrapper to drive claude repeatedly with a generic prompt.

set -e  # Exit on error

# Check arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 ITERS [PROMPT1] [PROMPT2] ..."
    echo "  ITERS: Number of iterations to run"
    echo "  PROMPT1, PROMPT2, ...: Optional prompt files for first N iterations"
    echo ""
    echo "Custom prompts are used first, then randomly selects from built-in prompts:"
    echo "  - generic_forward_progress_task.md (50% probability)"
    echo "  - optimization_task.md             (30% probability)"
    echo "  - task_gardening.md                (20% probability)"
    echo ""
    echo "Examples:"
    echo "  $0 5                    # All 5 iterations randomly select from built-ins"
    echo "  $0 5 task1.md           # Iteration 1 uses task1.md, 2-5 random built-ins"
    echo "  $0 5 t1.md t2.md        # Iterations 1-2 use custom, 3-5 random built-ins"
    exit 1
fi

# Hmm, this can have different relationships to the top of repo...
cd "$(dirname $0)"/
PROMPT_DIR="$(pwd)/prompts"

ITERS=$1
shift  # Remove first argument, leaving prompt files in $@

# Built-in prompts with weights (probabilities out of 100)
# Format: "weight:path"
BUILTIN_PROMPTS=(
    "50:$PROMPT_DIR/generic_forward_progress_task.md"     # 50% - generic forward progress
    "30:$PROMPT_DIR/optimization_task.md"                 # 30% - optimization
    "20:$PROMPT_DIR/task_gardening.md"                    # 20% - documentation/gardening
)

# Function to select a random prompt based on weights
select_weighted_prompt() {
    local total_weight=0
    local weights=()
    local paths=()

    # Parse weights and paths
    for entry in "${BUILTIN_PROMPTS[@]}"; do
        local weight="${entry%%:*}"
        local path="${entry#*:}"
        weights+=("$weight")
        paths+=("$path")
        total_weight=$((total_weight + weight))
    done

    # Generate random number between 1 and total_weight
    local rand=$((RANDOM % total_weight + 1))

    # Select prompt based on cumulative weights
    local cumulative=0
    for i in "${!weights[@]}"; do
        cumulative=$((cumulative + weights[i]))
        if [ $rand -le $cumulative ]; then
            echo "${paths[$i]}"
            return
        fi
    done
}

# Custom prompts are used first, then we randomly select from built-ins
CUSTOM_PROMPTS=("$@")
NUM_CUSTOM=${#CUSTOM_PROMPTS[@]}

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

    # Determine which prompt to use
    if [ $i -le $NUM_CUSTOM ]; then
        # Use custom prompt
        PROMPT_FILE="${CUSTOM_PROMPTS[$((i - 1))]}"
        echo "Using custom prompt for iteration $i: $PROMPT_FILE"
    else
        # Randomly select from built-in prompts based on weights
        PROMPT_FILE=$(select_weighted_prompt)
        echo "Using built-in prompt for iteration $i: $(basename "$PROMPT_FILE")"
    fi

    # Run claude command, tee to log, and extract results
    # Remove control characters (except newline) before passing to jq to avoid parse errors
    time claude --dangerously-skip-permissions --verbose --output-format stream-json -c -p "$(cat "$PROMPT_FILE")" | \
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
