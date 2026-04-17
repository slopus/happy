<!-- retro:managed:start -->
## Retro-Discovered Patterns

- CLI auto-resume (resuming last session automatically on startup) was a bug introduced when implementing the mobile session resume feature. It should ONLY apply to the mobile app — the CLI must NOT auto-resume sessions on startup.

**Why:** Christian explicitly corrected in session 91d576fa: 'the auto resume was meant for the mobile app. That you can resume an inactive session. Not for the command line.'

**How to apply:** Any feature that resumes a previous Claude session must be scoped to the mobile app's inactive session list. CLI startup should always start fresh (or require explicit --resume flag).
- Happy app voice mode UX behavior spec (described by Christian in session 5523e42a):

- **Focused session**: full spoken updates delivered as they happen
- **Background sessions**: one short notification only, e.g. 'gobot-migration has an update'
- **On switch to a session**: recap all buffered updates from that session since the user was last focused on it
- **No full context re-injection** needed on every switch — the issue is prompt clarity so the model knows which session it's focused on

**Why:** Christian stated: 'while I'm focused on a session I get full spoken updates from that session. For any other session in the background, I just want a short notification... when I switch, I should get a recap of all the updates that happened there while I was away.'

**How to apply:** When modifying voice mode behavior, prompt engineering, or session-switching logic, maintain these three tiers of verbosity.

<!-- retro:managed:end -->
