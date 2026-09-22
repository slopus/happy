# Fresh session continuation

Approved in conversation: when Resume fails, create a fresh provider session on the same machine and directory, while retaining all persisted prior questions and answers in the same scrolling conversation. Do not execute until the user sends a message. Preserve the original sessions and files. Test via Ego using existing authenticated state.

Use encrypted `continuationOfSessionId` metadata, separate from native fork lineage. Spawn through existing account-aware RPC without resume/fork identifiers. Persist the created ID before hydration/metadata work so retries reuse it; share an in-flight lock across UI entry points. Persist the source-to-successor link for reopening. Failures never delete/archive/kill the source or silently resend requests of unknown outcome.

A composed transcript keeps messages under their original session identity, groups within each session, and inserts a visible fresh-session boundary. Old messages are read-only; source identity remains available for attachments and details. Load ancestry lazily, detect cycles and missing history, and use existing message pagination. The active composer always addresses the route's current session. History visibility does not promise that the new model has inherited context.

Cases: C1 fresh creation without resumable ID; C2 no automatic message and settings retained; C3 old Q&A visible and paginates; C4 second continuation and reload preserve ancestry; C5 old interactive content cannot execute; C6 offline/create/hydration errors and duplicate requests handled; C7 mobile-width and desktop Ego verification with real login/new session.

Scope: App JS only; server/CLI auth paths stay intact. Original model context recovery is out of scope. Existing saved history remains accessible rather than being summarized away.
