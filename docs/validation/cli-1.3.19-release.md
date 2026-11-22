# CLI 1.3.19 release validation

Release the current main CLI, including the Fast empty-thread fix and the merged reasoning-effort / initial Fast configuration fixes.

The CLI previously required the workspace SDK 0.3.0 at runtime, but npm only provides 0.2.0. A normal install would fail with E404. SDK 0.3.0 remains an independent unpublished candidate. This release embeds the runtime used by the CLI without publishing the standalone SDK.

The SDK uses hashes v1 while the CLI uses v2. Build the SDK first, prebundle its ESM runtime and crypto dependencies, then let pkgroll include that module in the CLI. Keep the CLI's existing runtime dependencies.

Validation: CLI unit suite: 201 files, 1944 passed, 2 skipped. An earlier pre-main run timed out in a Goal Board filesystem event case; the full suite passed after rebasing onto current main. The final atomic build, owner native-session hooks and skill-discovery artifact suites passed 24 tests. The actual build passed. Independent review found no Critical/Important issues. Release packing uses a clean dist to exclude obsolete chunks retained by atomic builds.

Clean installation, CI, npm publication and machine activation results are recorded separately in the release receipt. This report does not claim they have already happened.

CLI-only release: verify automatic main Web deployment, but do not manually publish OTA or APK. Updates on both machines preserve existing workers, launcher settings and account data; verify each active version, daemon and new-session reply.
