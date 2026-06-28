# Claude Goal Status Fixtures

These fixtures are raw Claude Code JSONL transcript lines used to validate Happy's Claude goal adapter.

- `active.jsonl`: active goal sentinel emitted after `/goal <condition>`.
- `completed.jsonl`: completed goal evaluation emitted after Claude satisfies a goal.
- `edit-active.jsonl`: active goal sentinel emitted after replacing an existing goal with `/goal <new condition>`.
- `cleared.jsonl`: clear confirmation emitted after `/goal clear`. Claude Code 2.1.153 emitted this as `met: true` with `sentinel: true` and the cleared condition still present.

Do not hand-edit fixture payloads. If Claude changes this transcript shape, add a new fixture with provenance instead of rewriting old evidence.
