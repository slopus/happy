# Agent Exercise Flow

38 user interactions against lab-rat-todo-project. One continuous session.
Execute sequentially. Each section labels what's being tested. The flow is
linear and realistic — each step builds on the last.

The step numbering intentionally skips `24` for historical continuity. The
flow contains 38 total interactions (`0-23`, `25-38`).

Not all agents support every primitive (e.g. TaskCreate/TaskOutput may be
Claude-only). Record what happens, document what's unsupported with evidence.

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

## MULTI-PERMISSION

Multiple tools needing approval in a single turn.

### Step 25 — Multiple permissions in one turn

> Refactor the app: extract the filter logic into a new file called
> `filters.js`, move the dark mode toggle into a new file called
> `theme.js`, and update app.js to import from both.

This should trigger multiple edit/write tools in one agent turn. When
the permission prompts appear (there should be multiple), **APPROVE ONE
AT A TIME**. Do not use "allow always" — approve each individually with
"allow once."

Observe: do all permission prompts appear together? Can you approve
them independently? Does the agent wait for ALL permissions to resolve
before continuing?

### Step 26 — Supersede pending permissions

> Actually, undo all that. Put everything back in app.js. Also add a
> comment at the top: "// single-file architecture".

Send this **immediately** — while the agent is potentially still waiting
for permission or executing from step 25. If there are pending
permissions, they should be **auto-rejected** because the user sent a
new message. The new request takes priority.

Observe: are pending permissions auto-declined? Does the agent start
fresh with the new request?

---

## SUBAGENT PERMISSIONS

Child session permission handling.

### Step 27 — Subagent hits a permission wall

> Use a subagent to add a "clear completed" button. The subagent should
> edit index.html and app.js. Don't auto-approve anything for it.

The subagent (child session) should need permission to edit files. When
the permission appears (it should be for the child session, not the
parent), **APPROVE ONCE**.

Observe: does the permission appear in the context of the child session?
Does the parent session show a badge or indication that a child needs
attention? After approval, does the child complete and report back?

---

## STOP WITH PENDING STATE

### Step 28 — Stop session while permission is pending

> Add a new "priority" field to todos — high, medium, low. Use a
> colored dot next to each item.

When the permission prompt appears, **DO NOT APPROVE**. Instead, **STOP
THE SESSION** entirely (kill the agent process).

Observe: are pending permissions auto-rejected on stop? Is the session
state clean — no stuck "blocked" tools?

### Step 29 — Resume after forced stop

Come back. Resume the session.

> What happened with the priority feature?

Agent should see that the previous tools were rejected because the
session was stopped. It should explain what happened and wait for
instruction. The session history should be intact.

### Step 30 — Retry after stop

> Try again — add the priority field. Approve everything this time.

Approve the permissions. Verify the agent completes the task cleanly
after the previous forced stop.

---

## BACKGROUND TASKS

Long-running tools that execute while the agent continues or waits.

### Step 31 — Launch a background task

> Run a background task that sleeps for 30 seconds and then echoes
> "lol i am donezen". While it's running, tell me what time it is.

The agent should launch the bash command in the background (e.g.
`run_in_background` parameter, `&`, or however the agent supports it)
and respond to the "what time is it" question without waiting for the
background task to finish.

Observe: does the tool part appear immediately in a "running" state?
Does the agent continue responding while it runs? Is the tool output
captured when it eventually completes?

### Step 32 — Background task completes

Wait ~30 seconds for the background task to finish.

> Did that background task finish? What was the output?

Agent should see the completed background tool and report the output
("lol i am donezen"). Verify: the tool part transitioned from `running`
to `completed` with the output captured. The timestamp gap between
start and end should be ~30 seconds.

### Step 33 — Interact during background task

> Run another background task: sleep 20 && echo "background two".
> While that's running, add a comment to the top of app.js saying
> "// background task test".

The agent should handle both — launch the background task AND perform
the edit in the foreground. Two tool parts: one running (background),
one completed (edit). Verify the edit happens immediately, background
completes later.

---

## WRAP UP (part 1)

### Step 34 — Full summary

> Give me a git-style summary of everything we changed so far. List files
> modified, lines added/removed if you can tell.

Agent should produce a coherent summary spanning all interactions so far.
If it can do this accurately, the transcript held together.

---

## BACKGROUND SUBAGENTS (Tasks)

Background agent tasks that run concurrently with the main conversation.
Claude uses TaskCreate/TaskOutput. Availability varies by agent — document
what works and what doesn't per agent.

### Step 35 — Background subagent (TaskCreate)

> Launch a background agent task: have it research what CSS frameworks
> would work well for this project. Don't wait for it — tell me about
> the current project structure while it works.

The agent should use TaskCreate (or equivalent) to launch a background
agent task, then continue responding in the foreground without blocking.

Observe: does a background task tool part appear? Does the agent continue
the conversation? Is the task visible as a separate running entity?

### Step 36 — Check background agent result (TaskOutput)

> Did that background research finish? What did it find?

The agent should use TaskOutput (with block:true) to retrieve the
background task's result, then present the findings.

Observe: does the agent retrieve the completed task output? Does the
tool part transition from running to completed? Is the result coherent?

### Step 37 — Multiple background tasks

> Launch two background tasks in parallel: one to check if our HTML is
> valid, another to analyze our CSS for unused rules. While they run,
> add a comment to app.js saying "// multi-task test".

Multiple concurrent background tasks plus foreground work. Three tool
parts should appear: two background (running), one foreground (edit).

Observe: do both background tasks launch? Does the foreground edit
happen immediately? Do background tasks complete independently?

---

## WRAP UP (final)

### Step 38 — Final summary

> Update your earlier summary with everything we did since then,
> including the background tasks. Give me the final git-style summary.

This is the capstone. Agent should produce a coherent summary spanning
all 38 interactions.

---

## Primitives coverage

After running all steps, check which primitives were exercised:

### Transcript
- text response (no tools) — 1, 2, 19, 22, 29, 38
- reasoning/thinking — 2, 3
- streaming text — 1, 2, 38
- multi-step turn — 1, 6, 13, 25, 30, 33, 37

### Tools
- tool completed — 1, 4, 6, 9, 13, 25, 30, 32, 33, 36
- tool errored — 3, 10, 26, 28
- tool with output — 1, 16, 32, 36
- multi-file edit — 6, 13, 25
- file changed on disk — 4, 5, 6, 13, 17, 30, 33, 37
- background task (long-running) — 31, 32, 33, 35, 37
- foreground + background concurrent — 33, 35, 37
- background subagent (TaskCreate) — 35, 37
- background subagent result (TaskOutput) — 36

### Permissions
- reject → error — 3
- allow once → completed — 4
- allow always → rule stored — 5
- auto-approve (always rule) — 6, 9
- deny / sandbox — 15
- multiple permissions in one turn — 25
- auto-reject on new message — 26
- auto-reject on session stop — 28
- subagent permission — 27

### Web search
- external fetch — 7

### Subagents
- child tasks — 8
- constrained permissions — 8, 27
- parallel execution — 8
- child permission resolution — 27

### Interruption
- cancel mid-stream — 10
- cleanup after cancel — 10
- resume — 11
- supersede with new message — 26

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
- continuity after resume — 22, 29, 38
- forced stop with pending state — 28
- resume after forced stop — 29

### Background tasks
- launch background tool — 31
- background completes with output — 32
- foreground work during background — 33, 35, 37
- concurrent tool parts (running + completed) — 33, 37

### Background subagents
- TaskCreate — 35, 37
- TaskOutput (retrieve result) — 36
- multiple concurrent background tasks — 37
