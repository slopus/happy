# Head-of-Line Blocking Repro (GitHub #639)

## The Bug

OutgoingMessageQueue stops processing when it hits an unreleased (delayed) tool-call message, blocking all messages behind it — including immediately-ready ones like background task notifications. This causes messages to appear out of order, delayed, or "replayed."

Fixed in commit b37b43c4 (PR #699): changed `break` to `continue`/skip in `processQueueInternal`.

## Repro Prompt

Paste this into any Claude Code session:

---

I need you to do several things at once. First, run `sleep 12 && echo "BACKGROUND DONE"` in the background. Then immediately, WITHOUT waiting for that, do all of these in parallel: write a file `/tmp/hol-test-1.txt` with the text "file 1 written", write `/tmp/hol-test-2.txt` with "file 2 written", write `/tmp/hol-test-3.txt` with "file 3 written", and run `echo "immediate check at $(date +%H:%M:%S)"`. After those complete, write two more files `/tmp/hol-test-4.txt` and `/tmp/hol-test-5.txt`, then run `echo "second check at $(date +%H:%M:%S)"`. Keep going — read back all 5 files to verify their contents. By the time you're done reading them back, the background task should complete. Tell me exactly when you see the background task notification relative to your other work.

---

## What to Watch For

- **Fixed build**: Background task notification arrives promptly when sleep finishes, flows naturally between tool calls
- **Broken build**: Notification gets stuck behind unreleased write tool-call messages in the queue — arrives late, after several more tool calls have completed, or interleaves with earlier messages in a confusing way

## Why It Works

Each file write creates a delayed entry in the OutgoingMessageQueue. On the broken code, `processQueueInternal` hits the first unreleased item and `break`s out of the loop, so the background task completion notification (which is immediately ready) can't get past. The more parallel writes you stack up, the more obvious the delay.
