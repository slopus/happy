
We're going to work on a task.

But before we do let's make sure we start in a clean state, as
described in CLAUDE.md.

Now we're ready to select a task to make forward progress. Review the context:

 - Tracking issue(s): e.g. `bd show bd-1` with the appropriate prefix.
 - CLAUDE.md
 - PROJECT_VISION.md

Then select a task, make forward progress, and commit it after `make
validate` passes. Generally pick higher priority tasks first.

If you become completely stuck, write the problem to "error.txt" before you exit.

If you are successful, and `make validate` passes, then commit the
changes. Finally, push the changes (`git push origin main`). If there
are any upstream commits, pull those and merge them (fixing any merge
conflicts and revalidating) before pushing the merged results.
