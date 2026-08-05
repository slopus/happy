# Chat activity status visual evidence

Visible UI cases: 1

| Case ID | Problem | Before | After |
|---|---|---|---|
| CHAT-ACTIVITY-01 | Skill use was only mentioned in prose and its `SKILL.md` read appeared as a generic terminal command; delegated agents had no durable, human-readable lifecycle state in the conversation. The fix treats Skill identity and sub-agent lifecycle as one conversation-activity case because both are rendered by the same status strip and validated in one actual App flow. | [before.png](before.png) | [after.png](after.png) |

## Verification

```bash
pnpm test:e2e:web -- --grep '对话明确展示 Skill 名称与子 Agent 生命周期状态'
```

The isolated Web E2E sends SessionEnvelope fixtures through normalization, the reducer, and production message grouping before rendering the conversation. It asserts the localized Skill name, text status, and nested running/completed sub-agent ownership, captures `after.png`, then removes the temporary server, Web app, daemon, and database environment. CLI mapper unit tests separately cover Codex/Claude provider events and failure semantics.
