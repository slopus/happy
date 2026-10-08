# Native Codex history

`happy codex history` imports local Codex threads into Happy's session list,
including archived threads, other directories and subagent threads.
It uses the same Codex binary and `CODEX_HOME` as `happy codex`. Discovery and
history reads do not start agent threads. Imported messages and attachments use
Happy's normal session encryption.

- `happy codex history --watch` also enables discovery every five minutes in the daemon.
- `happy codex history --stop` disables automatic discovery without removing history.

Archive state follows Codex: unarchived threads stay in the normal list even
without a Happy process; only native archived threads enter the archive. The
phone's Archive action archives Codex too. Native archive/unarchive changes are
mirrored on the next sync. Connection status is independent of archive status.

Resume
uses the original native thread ID and working directory; an archived native
thread is unarchived only when resumed. Its stored model and provider are retained.
Subagent records that Codex does not allow direct input to resume their parent
conversation instead; the app navigates to that parent without altering the child history.
If the stored provider has been removed from Codex config, resume uses the current
configured defaults while preserving the native conversation.
The updated app pages the complete session catalog; older apps show at most 150 rows.

Repeated syncs reuse the same session and message IDs. Deleted imported rows
stay deleted. Locally saved history keys do not expire after fourteen days.
After a thread is attached to Happy, the running Happy session records subsequent
messages; the importer stops replaying that thread to avoid duplicate messages.
Existing Happy threads are skipped when their metadata can be decrypted with
local credentials. The sync summary reports any unreadable remote records.
