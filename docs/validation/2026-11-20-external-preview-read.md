# External source link reads

The original Page Review session lives under HOME while its source link points to an external-volume worktree. `readFile` previously rejected that file before HTML preview could load.

Read-only file/list/tree requests now discover actual mounted volumes using the existing machine directory browser and check canonical targets against canonical HOME, cwd and mounted roots. They do not accept caller-provided roots. Write and command handlers retain their original workspace validation. Symlink escapes and prefix siblings are denied.

External session HTML previews resolve relative assets within the selected HTML's directory and use the read-only session RPC. Archive-bound readers keep their own root. Local video/audio MIME types and video posters are bundled without expanding iframe script/network privileges.

Validation: 30 CLI path/mount/workspace/chunk tests; 29 app preview/resource/controller/chunk tests; app typecheck; CLI build/typecheck. Independent code review approved. Runtime activation, original-session reload and production browser verification remain pending at initial commit.

No layout/design changes. This task verifies the original link and read-only behavior; it does not publish a replacement Page Review site.

The original 5.8MB video produced a 10.8MB encrypted RPC reply and disconnected the worker socket. A dedicated read-only range RPC now bounds media responses to 256KiB, verifies file identity/revision across ranges, and applies canonical preview scope. The app preserves archive-bound readers and rejects oversized, changed or incomplete media. Cancellation stops further byte-range dispatch; this is data transfer, not state polling.

The original session was refreshed on the same session ID/thread/account/directory; source bytes match the actual external file, system paths remain denied, and the production page shows the source read-only. Full HTML/media verification follows final Web release.
