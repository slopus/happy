---
name: codex-upgrade
description: Upgrade the local Codex CLI to the latest stable release when the user asks to update Codex or invokes $codex-upgrade. Covers this Mac's isolated npm release layout; does not update the Codex Desktop app or Happy source code.
---

# Upgrade Codex CLI

Use this Skill for a requested **local Codex CLI upgrade**. An explicit upgrade request or `$codex-upgrade` invocation authorizes the local installation and link switch. Use the `latest` npm dist-tag at execution time; do not reuse a version from notes or a prior conversation.

## This machine's installer

The PATH entry is `~/.local/bin/codex`, a symlink to a native binary under `~/.local/share/codex/releases/<version>/`. `codex update` could not identify this layout. Run the updater bundled with this project Skill. It checks the current link and npm's stable version, installs side by side, validates the new binary, then atomically switches the symlink. From the repository root:

```bash
python3 .agents/skills/codex-upgrade/scripts/upgrade_codex.py --upgrade
```

From another working directory, resolve `scripts/upgrade_codex.py` relative to this `SKILL.md` and run it by absolute path.

The script refuses an unexpected installation layout, a version downgrade, or a concurrent upgrade. It leaves previous releases intact for rollback. Do not delete old versions as part of an ordinary upgrade. If this machine's installation method changes, inspect it and use its actual package manager; do not force this script or replace another `codex` on PATH.

For a read-only version check, use `--check`. A direct invocation of this Skill for an upgrade should run `--upgrade`, not stop after `--check` to ask again.

## Verify and report

After the script completes, check `codex --version`, `readlink ~/.local/bin/codex`, and `codex doctor --summary --no-color`. The script reports doctor failures separately after activation; a diagnostic failure alone does not roll back a validated binary. Distinguish doctor warnings from a failed installation. If the request names a newly released model, inspect the new CLI's `model/list` and run a small actual request when account access matters; a listed model alone does not prove entitlement.

Report the previous and installed versions, whether the PATH link changed, and any failed verification. Existing Codex sessions retain their running binary and model; the new CLI applies to new processes. Do not restart Happy's daemon or change authentication, provider settings, or Desktop app for a routine CLI upgrade. Never print tokens or auth file contents.
