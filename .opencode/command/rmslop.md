---
description: Remove AI code slop
---

Check the diff against main, and remove all AI generated slop introduced in this branch.

This includes:

- Extra comments that a human wouldn't add or is inconsistent with the rest of the file
- Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase
- Casts to `any` to get around type issues
- Any other style that is inconsistent with the file
- Unnecessary emoji usage
- Mid-file imports (all imports should be at top)
- Excessive use of `if` statements where better design exists

Report at the end with only a 1-3 sentence summary of what you changed.
