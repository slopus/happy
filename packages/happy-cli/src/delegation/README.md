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
unsupported effort and unconfirmed switches fail without replacing an explicit
choice. Omissions use the child's observed native defaults, never the parent's
Codex Ultra. If Codex's configured startup model is unavailable, an omitted model
uses the current native catalog's unique visible `isDefault` model instead;
there is no first-item, parent-model or hardcoded fallback. If no unique default
exists, the caller must specify a model. Actual returned codes are stored on the task. A revision uses the
same resolved role/model snapshot, including after a saved role is edited/deleted.

After a confirmed completed/failed/cancelled revision is durably stored, the
coordinator requests automatic archive and executor shutdown through a bound
`delegation-retire` RPC. Waiting for input and uncertain/interrupted delivery do
not authorize retirement. The worker checks its exact task binding, process,
local input/root receipt and idle state before locking further input and using
the ordinary full cleanup path. A missing old-worker handler never falls back to
an unbound kill. Reconnect, startup and explicit task reads can retry an
unconfirmed cleanup; no periodic polling is introduced. Cleanup failure does
not erase or change a completed result.

The retirement ACK confirms only that input is fenced and cleanup started.
Completion is retained separately after OS-confirmed worker disappearance and
fresh archived metadata. On worker exit, reconnect, startup or an explicit read,
the daemon can repair a failed archive write for that exact stopped, owned child
with a single encrypted metadata CAS. A version conflict remains unconfirmed
until a later event; it never retries stale metadata or signals a process.

The parent retains task history and results. An explicit revision starts a fresh
child with the frozen execution snapshot and up to 200,000 characters of saved
task instructions, context and results, keeping the original and newest
revisions. Shortened fields and omitted older revisions are labeled. This is
context reconstruction, not restoration of native tool history. Each version
retains its own child identity so delayed exit, report and ACK events cannot
replace or terminate the new child. The original child remains archived.

Model/effort are optional overrides, not optional runtime settings. Codex startup
waits for the native thread's actual configuration to be acknowledged in session
metadata before advertising readiness or accepting default-model preparation.
A delayed acknowledgement keeps preparation waiting; failure must not advertise
a ready worker. Selecting a catalog default still goes through the ordinary
configuration acknowledgement before task delivery and does not change global
Codex settings or saved role configuration.

The coordinator durably freezes the prepared native model/effort before posting
the task input to the relay. A lost HTTP acknowledgement can leave delivery
uncertain, but it must not erase the configuration used by the worker or change
the resolved model on a later revision of the same task. A failed durable write
prevents delivery.

Task history files have a dedicated 256 MiB read bound covering the current
100-revision schema, including worst-case JSON string escaping. The ordinary
journal reader keeps its 32 MiB default. Individual unreadable task records are
retained with a diagnostic and isolated from healthy records; they cannot be
overwritten until repaired and successfully loaded again.

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
