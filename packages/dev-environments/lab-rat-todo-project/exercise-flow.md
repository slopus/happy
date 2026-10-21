# Agent Exercise Flow

24 steps against lab-rat-todo-project. One continuous session. Execute
sequentially. Each section labels what's being tested. The flow is linear
and realistic — each step builds on the last.

Not all agents support every primitive. Record what happens, skip what
doesn't apply, note what's missing.

---

## SETUP

### Step 0 — Open the agent

Open your agent. Point it at this project directory.

Observe what it shows you at startup — available modes, models, slash
commands, permission level, project detection, anything it surfaces before
you type a word.

---

## TRANSCRIPT

Basic message flow: reading, reasoning, text responses.

### Step 1 — Orient

> Read all files, tell me what this does.

Agent should read the source files and give a text summary. Multiple read
tool calls, no edits.

### Step 2 — Find the bug

> There's a bug in the Done filter — it shows all items instead of only
> completed ones. Find it and show me the exact line.

Agent should find the `!item.done || item.done` condition in `app.js`
around line 88 and explain why it's always true. Should NOT edit yet.

---

## PERMISSIONS

Reject, allow once, allow always, auto-approve.

### Step 3 — Edit rejected

> Fix it.

When the permission prompt appears, **REJECT** it. Say something like
"no — show me the diff first."

Agent should recover: tool errors, agent explains the diff in text instead.

### Step 4 — Edit approved once

> Ok that diff looks right. Go ahead and apply it.

When the permission prompt appears, **ALLOW ONCE**.

File should change on disk. The bug fix should be applied.

### Step 5 — Edit approved always

> Add dark mode support. Use a `prefers-color-scheme: dark` media query
> in styles.css. Keep it simple — just invert the main colors.

When the permission prompt appears, **ALLOW ALWAYS**.

The always rule is now stored for this session.

### Step 6 — Auto-approved edit

> Also add a `.dark-toggle` button to the HTML so users can manually
> switch themes. Put it after the h1 in the hero panel. Wire it up in
> app.js — toggle a `dark` class on the body.

This touches multiple files. Edits matching the always rule from step 5
should go through with NO permission prompt. Note which files prompt and
which don't.

---

## WEB SEARCH

Agent fetches information from the internet.

### Step 7 — Search the web

> Search the web for best practices on accessible keyboard shortcuts
> in todo apps.

Agent should use a web search or web fetch tool. Observe whether it
searches, what it finds, and how it presents results.

---

## SUBAGENTS

Parallel child tasks with their own context.

### Step 8 — Parallel explore

> I want to add keyboard shortcuts. Before you do anything, use a
> subagent to explore what keyboard events the app currently handles,
> and separately check if there are any accessibility issues in the
> HTML. Do both in parallel.

Agent should spawn two child tasks. Observe: do they run in parallel?
Do they have restricted permissions? Does the parent summarize findings?

---

## TOOLS

Straightforward edit based on prior research.

### Step 9 — Simple edit

> Add Cmd+Enter to submit the form from anywhere on the page. That's
> it, nothing else.

Agent edits `app.js`. Should auto-approve if the always rule covers it,
otherwise note the prompt.

---

## INTERRUPTION

Cancel mid-stream and recover.

### Step 10 — Cancel

> Add keyboard shortcut support — Cmd+Enter to submit from anywhere,
> Escape to clear the input, arrow keys to navigate todos.

**CANCEL/INTERRUPT** while the agent is mid-response — while it's
streaming text or executing a tool.

Observe: does it stop cleanly? Are partial tool calls cleaned up?
Is there half-written code on disk?

### Step 11 — Resume after cancel

> Ok just the Cmd+Enter. Do that.

Agent should pick up and complete the simpler request cleanly.

---

## QUESTION

Agent asks the user for input before acting.

### Step 12 — Agent asks a question

> I want to add a test framework. Ask me which one I want before you
> set anything up.

Agent should present options (Jest, Vitest, Mocha, etc.) and wait.

**Answer: "Vitest"**

Agent should acknowledge without immediately setting it up.

### Step 13 — Act on the answer

> Set up Vitest. Add a vitest config, a package.json with the dev
> dependency, and one test that verifies the Done filter bug is fixed
> (the filter should only return items where done===true).

Multiple files created. Observe permission behavior.

---

## SANDBOX

What happens at the edge of the project directory.

### Step 14 — Read outside project

> What files are in the parent directory?

Observe what happens. Might work, might be denied, might prompt.
This is vendor-specific — capture the exact behavior.

### Step 15 — Write outside project

> Create a file at `../outside-test.txt` with the content
> "boundary test".

Almost certainly blocked or denied. Capture the exact error or behavior.

---

## TODO

Agent-managed task tracking.

### Step 16 — Create todos

> Create a todo list for this project. Track: 1) add due dates to
> todos, 2) add drag-to-reorder, 3) add export to JSON. Use your
> todo tracking.

Agent should create tracked tasks. Observe whether it uses a dedicated
tool, writes to a file, or just puts them in the response.

---

## MODEL SWITCH

Different model mid-session.

### Step 17 — Switch and edit

Switch to a different model (however the agent supports this — config,
slash command, UI toggle).

> Add a "due date" field to the todo items. Add a date picker input
> next to the text input in the form. Store the date in localStorage
> with the item.

Observe: does the agent acknowledge the model change? Does the response
feel different?

---

## COMPACTION

Context window management.

### Step 18 — Compact

> Compact the context.

(Or however the agent supports this — slash command, automatic, etc.)

Observe: does it acknowledge compaction? Can you tell context shrank?

### Step 19 — Post-compaction sanity

> What files have we changed so far?

Agent should still reason about session history and list modified files
accurately even after compaction.

---

## PERSISTENCE

Close and reopen. Does everything survive?

### Step 20 — Close

Close the agent. Close the terminal. Walk away.

### Step 21 — Reopen

Come back. Open the same session (however the agent supports this —
session ID, session list, recent sessions).

Observe: is the history there? Can you scroll back? Are tool results
intact? Permission decisions? Question answers?

### Step 22 — Verify continuity

> What was the last thing we were working on?

Agent should reference prior work from the session. This proves the
transcript survived and the agent can reason about it.

---

## TODO (continued)

Updating tracked tasks after a session break.

### Step 23 — Mark todo done

> Mark the "add due dates" todo as completed — we just did that.

Agent should update the task tracking from step 16.

---

## WRAP UP

Final proof of transcript coherence.

### Step 24 — Full summary

> Give me a git-style summary of everything we changed. List files
> modified, lines added/removed if you can tell.

This is the capstone. Agent should produce a coherent summary spanning
all 24 interactions. If it can do this accurately, the transcript held
together.

---

## Primitives coverage

After running all steps, check which primitives were exercised:

### Transcript
- text response (no tools) — 1, 2, 19, 24
- reasoning/thinking — 2, 3
- streaming text — 1, 2, 24
- multi-step turn — 1, 6, 13

### Tools
- tool completed — 1, 4, 6, 9, 13
- tool errored — 3, 10
- tool with output — 1, 16
- multi-file edit — 6, 13
- file changed on disk — 4, 5, 6, 13, 17

### Permissions
- reject → error — 3
- allow once → completed — 4
- allow always → rule stored — 5
- auto-approve (always rule) — 6, 9
- deny / sandbox — 15

### Web search
- external fetch — 7

### Subagents
- child tasks — 8
- constrained permissions — 8
- parallel execution — 8

### Interruption
- cancel mid-stream — 10
- cleanup after cancel — 10
- resume — 11

### Question
- agent asks, user answers — 12

### Sandbox
- read outside project — 14
- write outside project — 15

### Todo
- create tasks — 16
- update tasks — 23

### Model switch
- different model mid-session — 17

### Compaction
- compact — 18
- works after compaction — 19

### Persistence
- close + reopen — 20, 21
- history intact — 21, 22
- continuity after resume — 22, 24
