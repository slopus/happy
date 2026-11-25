# Delegation contracts

`delegation-roles` is an authenticated, encrypted machine RPC. Its capability is
`machine.metadata.delegationRoles === 1`; the older `delegation: 1` alone does not
promise this handler. Settings can list/create/update/delete without an active
parent session. These calls use the same serialized service and `roles.json` as
the authenticated parent `agent_roles` tools and never launch work.

Create generates a stable ID unless the caller supplied one; duplicate IDs fail.
Update requires an existing `roleId` and a patch without `id`. Names are labels,
not identity. New roles default to `autoDelegate: false`. Null model/effort in a
patch clears the field; omitted execution fields use native target defaults.
Legacy parent `roles-save` / `agent_roles(save)` retain their old upsert behavior;
new callers use create/update. Delete does not change existing task snapshots.

New MCP `delegate_task` requires `intent` and exactly one of `roleId`, `taskId`, or
`route: { agent, model?, effort? }`. Automatic intent requires a currently saved
role whose `autoDelegate` is enabled. Temporary routes and revisions require
explicit intent. The backend enforces these checks and records intent per
version. `explicit` remains the model/caller's classification of the user's
request, not independently verified human approval. Legacy API requests without
intent remain compatible only for roleId/taskId; the new MCP schema does not
allow that omission. No client keyword dispatcher or additional approval system
is involved.

Every new task freezes a role/temporary route snapshot. Native preparation
resolves only the target executor's advertised model/effort catalog, acknowledges
the actual configuration, then submits the task. Unknown or ambiguous labels,
unsupported effort and unconfirmed switches fail without a different-model
fallback. Omissions use the child's observed native defaults, never the parent's
Codex Ultra. Actual returned codes are stored on the task. A revision uses the
same child and resolved snapshot, including after a saved role is edited/deleted.

New workers advertise `capabilities.delegationRoutes: 1` only after preparation
RPCs are installed. Temporary/native-default tasks require that parent-worker
capability. Response negotiation is independent: parent RPC callers send
`protocolVersion: 2` for complete responses; omission always returns V1, even
from a new worker. V1-only execution requests fail before saving/dispatching a
temporary/default task that the client could not read. A V2 client can inspect
retained V2 tasks without a live native worker. New App callers send the field
only when machine capability `delegationRoles: 1` confirms the daemon accepts it;
old daemons keep receiving the original request shape. HTTP MCP translates both
direct HTTP and stdio bridge tool calls into V2 daemon requests. Older workers
keep receiving V1 publication records. In metadata, `delegationProtocol: 1`, `delegationRoles` and
`delegatedTasks` remain truthful V1 projections with required model/roleId; V2-only
entries are omitted, never filled with fabricated values. `delegationV2` holds
the complete `{ version: 2, roles, tasks }` snapshot for upgraded clients.
New clients must read V2 preferentially, including an authoritative empty list.
An old client remains able to decode the legacy envelope but cannot display or
configure the new temporary/default features. Live processes are not hot-upgraded.
