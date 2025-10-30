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


def load_prompt_table(table_file: Path, script_dir: Path) -> List[Tuple[int, Path]]:
    """Load prompt table from a text file.
    
    Format:
        <NUMBER> <PROMPTFILE>
        <NUMBER> <PROMPTFILE>
        ...
    
    Where NUMBER is the weight and PROMPTFILE is the path to the prompt file.
    Paths are resolved relative to the table file's directory.
    """
    prompts = []
    table_dir = table_file.parent
    
    with open(table_file, 'r') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            # Skip empty lines and comments
            if not line or line.startswith('#'):
                continue
            
            parts = line.split(None, 1)  # Split on first whitespace
            if len(parts) != 2:
                print(f"Warning: Skipping malformed line {line_num} in {table_file}: {line}", file=sys.stderr)
                continue
            
            try:
                weight = int(parts[0])
                if weight <= 0:
                    print(f"Warning: Skipping line {line_num} in {table_file}: weight must be positive", file=sys.stderr)
                    continue
            except ValueError:
                print(f"Warning: Skipping line {line_num} in {table_file}: invalid weight '{parts[0]}'", file=sys.stderr)
                continue
            
            # Resolve prompt file path (relative to table file or absolute)
            prompt_path = Path(parts[1])
            if not prompt_path.is_absolute():
                prompt_path = table_dir / prompt_path
            
            if not prompt_path.exists():
                print(f"Warning: Skipping line {line_num} in {table_file}: file not found '{prompt_path}'", file=sys.stderr)
                continue
            
            prompts.append((weight, prompt_path))
    
    if not prompts:
        raise ValueError(f"No valid prompts found in {table_file}")
    
    return prompts


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


def get_session_title(script_dir: Path) -> str:
    """Read session title from .session_title.txt"""
    title_file = script_dir / '.session_title.txt'
    if title_file.exists():
        return title_file.read_text().strip()
    return ""


def check_happy_version() -> bool:
    """Check if happy supports --name flag."""
    try:
        result = subprocess.run(
            ['happy', '-h'],
            capture_output=True,
            text=True,
            timeout=5
        )
        return '--name' in result.stdout or '--uname' in result.stdout
    except Exception:
        return False


def run_iteration(iteration: int, total: int, prompt_file: Path, logs_dir: Path, use_happy: bool, script_dir: Path) -> bool:
    """Run a single iteration with claude."""
    print(f"\n=== Iteration {iteration} of {total} ===")

    os.chdir("/workspace")

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
    if use_happy:
        # Use happy wrapper
        session_title = get_session_title(script_dir)

        # Check if happy supports --name flag
        if check_happy_version():
            # Newer version with --name support
            cmd = [
                'happy',
                '--name', session_title,
                'claude',
                '--dangerously-skip-permissions',
                '--verbose',
                '--output-format', 'stream-json',
                '-c',
                '-p', prompt_content
            ]
        else:
            # Older version - use initial message to set title
            cmd = [
                'happy',
                'claude',
                '--dangerously-skip-permissions',
                '--verbose',
                '--output-format', 'stream-json',
                '-c',
                '-p', f'Tell happy to change the title to {session_title}\n\n{prompt_content}'
            ]
    else:
        # Direct claude command
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
  %(prog)s 5                           # All 5 iterations randomly select from built-ins
  %(prog)s 5 task1.md                  # Iteration 1 uses task1.md, 2-5 random built-ins
  %(prog)s 5 t1.md t2.md               # Iterations 1-2 use custom, 3-5 random built-ins
  %(prog)s --happy 5                   # Use happy wrapper with session title
  %(prog)s --optimize 5                # All 5 iterations use optimization_task.md
  %(prog)s --general 5                 # All 5 iterations use generic_forward_progress_task.md
  %(prog)s --tasks 5                   # All 5 iterations use task_gardening.md
  %(prog)s --only custom.md 5          # All 5 iterations use custom.md
  %(prog)s --prompt-table table.txt 5  # Use weighted prompts from table.txt

Prompt table format (for --prompt-table):
  Each line: <WEIGHT> <PROMPTFILE>
  Example table.txt:
    10 prompts/generic_forward_progress_task.md
    10 prompts/optimization_task.md
  Weights are relative (10 10 = 50%% each, same as 1 1 or 100 100)
        """
    )

    parser.add_argument('iterations', type=int, help='Number of iterations to run')
    parser.add_argument('prompts', nargs='*', help='Optional prompt files for first N iterations')
    parser.add_argument('--happy', action='store_true',
                        help='Use happy wrapper (reads session title from .session_title.txt)')

    # Mutually exclusive group for prompt type selection
    prompt_type_group = parser.add_mutually_exclusive_group()
    prompt_type_group.add_argument('--optimize', action='store_true',
                                   help='Use only optimization_task.md for all built-in prompts')
    prompt_type_group.add_argument('--general', action='store_true',
                                   help='Use only generic_forward_progress_task.md for all built-in prompts')
    prompt_type_group.add_argument('--tasks', action='store_true',
                                   help='Use only task_gardening.md for all built-in prompts')
    prompt_type_group.add_argument('--only', type=str, metavar='PROMPT_FILE',
                                   help='Use specified prompt file for ALL iterations')
    prompt_type_group.add_argument('--prompt-table', type=str, metavar='TABLE_FILE',
                                   help='Load weighted prompt table from file (format: "<WEIGHT> <PROMPTFILE>" per line)')

    args = parser.parse_args()

    # Validate --only and --prompt-table are not used with positional prompts
    if args.only and args.prompts:
        parser.error("--only cannot be used with positional prompt arguments")
    if args.prompt_table and args.prompts:
        parser.error("--prompt-table cannot be used with positional prompt arguments")

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

    # Determine which prompt to use for built-in selections
    if args.prompt_table:
        # Load prompts from table file
        table_path = Path(args.prompt_table)
        if not table_path.exists():
            parser.error(f"Prompt table file not found: {args.prompt_table}")
        try:
            builtin_prompts = load_prompt_table(table_path, script_dir)
            prompt_mode = f"weighted table ({table_path.name})"
            print(f"Loaded {len(builtin_prompts)} prompts from {table_path}")
            total_weight = sum(w for w, _ in builtin_prompts)
            for weight, path in builtin_prompts:
                probability = (weight / total_weight) * 100
                print(f"  {weight:3d} ({probability:5.1f}%) {path.name}")
            print()
        except Exception as e:
            parser.error(f"Failed to load prompt table: {e}")
        fixed_prompt = None
        use_only_mode = False
    elif args.only:
        only_prompt_path = Path(args.only)
        if not only_prompt_path.exists():
            parser.error(f"Prompt file not found: {args.only}")
        fixed_prompt = only_prompt_path
        prompt_mode = f"custom ({only_prompt_path.name})"
        use_only_mode = True
    elif args.optimize:
        fixed_prompt = prompt_dir / "optimization_task.md"
        prompt_mode = "optimization"
        use_only_mode = False
    elif args.general:
        fixed_prompt = prompt_dir / "generic_forward_progress_task.md"
        prompt_mode = "general forward progress"
        use_only_mode = False
    elif args.tasks:
        fixed_prompt = prompt_dir / "task_gardening.md"
        prompt_mode = "task gardening"
        use_only_mode = False
    else:
        fixed_prompt = None
        prompt_mode = "random weighted selection"
        use_only_mode = False

    # Convert custom prompts to Paths
    custom_prompts = [Path(p) for p in args.prompts]
    num_custom = len(custom_prompts)

    # Print mode message
    if use_only_mode:
        print(f"Using --only mode: {prompt_mode} for all {args.iterations} iterations\n")
    elif num_custom < args.iterations:
        print(f"Built-in prompt mode: {prompt_mode}\n")

    # Run iterations
    for i in range(1, args.iterations + 1):
        if use_only_mode:
            # --only mode: use the specified prompt for ALL iterations
            prompt_file = fixed_prompt
            print(f"Using {prompt_mode} for iteration {i}")
        elif i <= num_custom:
            # Use custom prompt
            prompt_file = custom_prompts[i - 1]
            print(f"Using custom prompt for iteration {i}: {prompt_file}")
        else:
            # Use fixed prompt if specified, otherwise randomly select
            if fixed_prompt:
                prompt_file = fixed_prompt
                print(f"Using {prompt_mode} prompt for iteration {i}: {prompt_file.name}")
            else:
                # Randomly select from built-in prompts based on weights
                prompt_file = select_weighted_prompt(builtin_prompts)
                print(f"Using built-in prompt for iteration {i}: {prompt_file.name}")

        # Run the iteration
        success = run_iteration(i, args.iterations, prompt_file, logs_dir, args.happy, script_dir)
        if not success:
            sys.exit(1)

    print(f"\nSuccessfully completed all {args.iterations} iterations")
    sys.exit(0)


if __name__ == '__main__':
    main()
