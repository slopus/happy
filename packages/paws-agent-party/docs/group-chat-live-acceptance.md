# Generic group chat: live acceptance, 2026-09-17

The current group-chat entry was exercised in Ego against the normal built POC
service and real Paws SDK. The owner-authorized Linux test executor ran two
independent Codex sessions. No fixture SDK was injected. This is a local POC
acceptance result, not a deployment or acceptance of every planned feature.

## Observed cases

| Case | Result |
| --- | --- |
| Configure roles and invite them into a group | Created Product Adviser and Technical Adviser in the browser. A third member remained idle. |
| Inline mention selection | Selected both advisers through the `@` suggestions and submitted a single message. |
| Two real participants | Both advisers produced role-specific answers. Their durable execution intervals overlapped by about 12.5 seconds. The unmentioned member had no remote session. |
| Auto replies off | A plain message saved the new project code, page count and reporting time without adding a remote turn. |
| Targeted follow-up | Only Technical Adviser answered, reusing its session and correctly recalling the newly recorded `青柠47`, three static pages and 09:00 reporting time. |
| Auto replies on | A message without mentions selected Technical Adviser and produced one additional real response. Selection currently uses deterministic text/role relevance, not an AI moderator. |
| Unknown mention | `@研究员` was rejected; the draft remained available, no public message or remote turn was added, and auto routing did not replace the invalid recipient. |
| Refresh | All eight public messages (four user messages and four responses) remained unchanged after a browser reload. Internal directed task instructions were absent from the public timeline. |
| Durable provenance | All four replies matched their actual remote session, local submission, root turn, durable turn-end record and Party public message. No pending permission requests remained. |

The two new test workers were stopped through the daemon's normal stop-session
endpoint after checking that their submissions and completed turns belonged to
this acceptance. All five pre-existing workers were preserved. The local
acceptance service and Ego task space were closed; histories remain stored.
No executor limits changed. No new tunnel or deployment was created.

## Fixes found during acceptance

- Selecting an inline mention previously left the trigger `@` behind. Completion
  now replaces the active token; regression tests cover single and multiple mentions.
- Agent creation cleared the form after waiting for a full connection refresh,
  which could erase a newly typed profile. The accepted fields now clear before
  that refresh, before the new profile appears in the list.

Focused composer and group-service tests, typecheck and the production build
passed. Four verified key browser frames were reported to Happy.

## Limits of this acceptance

Both executed roles used Codex; mixed-engine execution was not tested. The
current group UI still lacks expandable execution details, agent-requested
member expansion and image attachment controls. Remote tools, recurring tasks,
running-task cancellation, account switching during work, service restart and
cross-room races are not covered by this live acceptance. Those gaps must not
be described as completed on the basis of these four text replies.
