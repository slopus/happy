# Prompt Table Feature

The `--prompt-table` argument allows you to specify a text file containing weighted prompts for random selection.

## Format

Each line in the prompt table file should follow this format:
```
<WEIGHT> <PROMPTFILE>
```

Where:
- `WEIGHT` is a positive integer representing the relative probability
- `PROMPTFILE` is the path to a prompt file (relative to the table file or absolute)

## Key Features

1. **Relative Weights**: Weights are relative, not absolute percentages
   - `10 10` gives 50%/50% (same as `1 1` or `100 100`)
   - `50 30 20` gives 50%, 30%, 20% respectively

2. **Comments and Empty Lines**: Lines starting with `#` or empty lines are ignored

3. **Path Resolution**: Prompt file paths are resolved relative to the table file's directory

4. **Error Handling**: Invalid lines are skipped with warnings, the script continues with valid entries

## Examples

### Example 1: Balanced Selection (example_equal_weights.txt)
```
# Equal probability for both prompts
10 prompts/optimization_task.md
10 prompts/task_gardening.md
```
Result: 50% chance for each prompt

### Example 2: Weighted Selection (example_prompt_table.txt)
```
# Different probabilities
50 prompts/generic_forward_progress_task.md
30 prompts/optimization_task.md
20 prompts/task_gardening.md
```
Result: 50%, 30%, and 20% respectively

### Example 3: Using Smaller Numbers
```
# Same distribution as Example 2, but with smaller numbers
5 prompts/generic_forward_progress_task.md
3 prompts/optimization_task.md
2 prompts/task_gardening.md
```
Result: Same 50%, 30%, 20% distribution (5+3+2=10 total)

## Usage

```bash
# Use prompt table for all iterations
./gogo_claude.py --prompt-table my_prompts.txt 10

# Cannot combine with positional prompts
./gogo_claude.py --prompt-table table.txt 10 custom.md  # ERROR

# Cannot combine with other prompt selection modes
./gogo_claude.py --prompt-table table.txt --optimize 10  # ERROR
```

## How It Works

When `--prompt-table` is specified:

1. The table file is loaded and parsed at startup
2. Invalid entries are skipped with warnings
3. For each iteration, a prompt is randomly selected based on the weights
4. The selection uses cumulative distribution for accurate probability

The script displays the loaded prompts with their probabilities at startup:
```
Loaded 3 prompts from example_prompt_table.txt
   50 ( 50.0%) generic_forward_progress_task.md
   30 ( 30.0%) optimization_task.md
   20 ( 20.0%) task_gardening.md
```

## Testing

You can test the probability distribution:
```bash
python3 -c "
from pathlib import Path
from gogo_claude import load_prompt_table, select_weighted_prompt
from collections import Counter

prompts = load_prompt_table(Path('example_prompt_table.txt'), Path('.'))
selections = [select_weighted_prompt(prompts).name for _ in range(1000)]
for name, count in Counter(selections).items():
    print(f'{name}: {count/10:.1f}%')
"
```
