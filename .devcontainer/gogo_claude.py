#!/usr/bin/env python3
"""
A simple wrapper to drive claude repeatedly with prompts.
"""

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple


# Built-in prompts with weights (probabilities out of 100)
BUILTIN_PROMPTS = [
    (50, "generic_forward_progress_task.md"),  # 50% - generic forward progress
    (30, "optimization_task.md"),              # 30% - optimization
    (20, "task_gardening.md"),                 # 20% - documentation/gardening
]


def select_weighted_prompt(prompts: List[Tuple[int, Path]]) -> Path:
    """Select a random prompt based on weights."""
    total_weight = sum(weight for weight, _ in prompts)
    rand = random.randint(1, total_weight)

    cumulative = 0
    for weight, path in prompts:
        cumulative += weight
        if rand <= cumulative:
            return path

    # Fallback (shouldn't reach here)
    return prompts[0][1]


def find_next_log_number(logs_dir: Path) -> int:
    """Find the next available log number."""
    num = 1
    while (logs_dir / f"claude_workstream{num:02d}.jsonl").exists():
        num += 1
    return num


def run_iteration(iteration: int, total: int, prompt_file: Path, logs_dir: Path) -> bool:
    """Run a single iteration with claude."""
    print(f"\n=== Iteration {iteration} of {total} ===")

    # Find unused log filename
    log_num = find_next_log_number(logs_dir)
    log_file = logs_dir / f"claude_workstream{log_num:02d}.jsonl"
    latest_link = logs_dir / "claude_workstream_latest.jsonl"

    print(f"Using log file: {log_file}")

    # Update latest symlink
    if latest_link.exists() or latest_link.is_symlink():
        latest_link.unlink()
    latest_link.symlink_to(log_file.name)

    # Determine which prompt to use and log it
    print(f"Using prompt: {prompt_file.name}")

    # Read prompt content
    with open(prompt_file, 'r') as f:
        prompt_content = f.read()

    # Build claude command
    cmd = [
        'claude',
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format', 'stream-json',
        '-c',
        '-p', prompt_content
    ]

    # Run claude command with tee-like behavior
    try:
        with open(log_file, 'a') as log:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )

            # Process output line by line
            for line in process.stdout:
                # Write to log file
                log.write(line)
                log.flush()

                # Try to parse and display
                try:
                    data = json.loads(line)
                    if data.get('type') in ['assistant', 'result']:
                        # Extract text content
                        if 'message' in data and 'content' in data['message']:
                            for content in data['message']['content']:
                                if 'text' in content:
                                    print(content['text'], end='')
                        elif 'result' in data:
                            print(f"\nResult: {data['result']}")
                except json.JSONDecodeError:
                    pass  # Skip malformed JSON

            process.wait()

            if process.returncode != 0:
                stderr = process.stderr.read()
                print(f"Error running claude: {stderr}", file=sys.stderr)
                return False

    except Exception as e:
        print(f"Error during iteration: {e}", file=sys.stderr)
        return False

    # Check for error.txt
    error_file = Path('error.txt')
    if error_file.exists():
        print("\nError detected in error.txt:")
        print(error_file.read_text())
        return False

    print(f"\nCompleted iteration {iteration}")
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Drive claude repeatedly with prompts',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Custom prompts are used first, then randomly selects from built-in prompts:
  - generic_forward_progress_task.md (50%% probability)
  - optimization_task.md             (30%% probability)
  - task_gardening.md                (20%% probability)

Examples:
  %(prog)s 5                    # All 5 iterations randomly select from built-ins
  %(prog)s 5 task1.md           # Iteration 1 uses task1.md, 2-5 random built-ins
  %(prog)s 5 t1.md t2.md        # Iterations 1-2 use custom, 3-5 random built-ins
        """
    )

    parser.add_argument('iterations', type=int, help='Number of iterations to run')
    parser.add_argument('prompts', nargs='*', help='Optional prompt files for first N iterations')

    args = parser.parse_args()

    # Setup paths
    script_dir = Path(__file__).parent
    prompt_dir = script_dir / 'prompts'
    logs_dir = script_dir / 'logs'

    # Ensure logs directory exists
    logs_dir.mkdir(exist_ok=True)

    # Build list of built-in prompts with absolute paths
    builtin_prompts = [
        (weight, prompt_dir / filename)
        for weight, filename in BUILTIN_PROMPTS
    ]

    # Convert custom prompts to Paths
    custom_prompts = [Path(p) for p in args.prompts]
    num_custom = len(custom_prompts)

    # Run iterations
    for i in range(1, args.iterations + 1):
        if i <= num_custom:
            # Use custom prompt
            prompt_file = custom_prompts[i - 1]
            print(f"Using custom prompt for iteration {i}: {prompt_file}")
        else:
            # Randomly select from built-in prompts based on weights
            prompt_file = select_weighted_prompt(builtin_prompts)
            print(f"Using built-in prompt for iteration {i}: {prompt_file.name}")

        # Run the iteration
        success = run_iteration(i, args.iterations, prompt_file, logs_dir)
        if not success:
            sys.exit(1)

    print(f"\nSuccessfully completed all {args.iterations} iterations")
    sys.exit(0)


if __name__ == '__main__':
    main()
