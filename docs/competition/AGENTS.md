# Competition Research

Use this folder for distilled competitor research that is worth keeping in the
Happy repo.

## What belongs here

- markdown notes about how another product works
- protocol writeups, message samples, and sequence diagrams
- screenshots and small sanitized artifacts that explain behavior
- links to upstream docs, repos, commits, issues, and blog posts
- comparisons back to Happy when the finding affects product or protocol design

## What does not belong here

- git checkouts of competitor repos
- git submodules
- copied source trees or vendored code dumps
- large raw logs, binaries, or secrets

If you need a checkout for research, keep it outside this repository. Prefer the
existing adjacent area under `../happy-adjacent/research/{vendor}` when it
exists; otherwise use another machine-local path that is not committed.

## Recommended layout

```text
docs/competition/
├── AGENTS.md
├── comparison-matrix.md            # cross-vendor summary by topic
├── claude/
│   ├── README.md                   # high-level overview and key takeaways
│   ├── sources.md                  # upstream URLs, commit hashes, dates reviewed
│   ├── message-protocol.md         # envelopes, streaming events, turn boundaries
│   ├── session-lifecycle.md        # startup, resume, interruption, teardown
│   └── artifacts/                  # screenshots, tiny trace snippets, diagrams
├── codex/
│   └── ...
└── opencode/
    └── ...
```

## Per-vendor file expectations

Each vendor folder should start small and stay focused:

- `README.md`: what this product is, what was inspected, and the main findings
- `sources.md`: repo URL, docs links, commit/tag reviewed, and review date
- topic files such as `message-protocol.md`, `tool-calling.md`,
  `subagents.md`, `task-tracking.md`, `modes-and-permissions.md`, or
  `sandbox.md` when those topics matter
- `artifacts/`: only small evidence files that help explain the writeup

Do not mirror the competitor's repo layout here. Write the conclusions we want
to keep.

## Research workflow

1. Inspect the competitor from a local checkout, docs site, product behavior, or
   captured traces.
2. Record the exact upstream references in `sources.md`.
3. Write the distilled result in the vendor folder.
4. Extract reusable comparisons into `comparison-matrix.md` when multiple
   vendors cover the same topic.

## Current priorities

Start with the protocol and control surfaces that matter most for Happy:

- message protocol and event envelopes
- tool call representation and streaming
- subagents / task delegation model
- task tracking / todo surfaces
- mode switching and model switching
- permission / approval flow
- sandbox / workspace isolation
- session resume, fork, and interrupt behavior
- remote sync / server architecture

Current product note: OpenCode is a particularly strong reference right now.
Its desktop UI, feature set, and especially the clickable context/debug surface
look worth studying closely. Treat its messaging protocol as a leading design
input, and dig further into how it syncs state with its server.

The rule of thumb is simple: checkouts stay outside the repo; insights and small
supporting artifacts go here.
