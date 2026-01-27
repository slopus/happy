# Attribution Control Design

**Date:** 2026-01-23
**Issue:** https://github.com/slopus/happy/issues/165
**Status:** Ready for implementation

## Problem

Happy injects a system prompt into Claude Code sessions that instructs Claude to add "Co-Authored-By: Happy" to all git commits. This happens without user knowledge or consent because:

1. The setting defaults to ON (opt-out instead of opt-in)
2. It reads from Claude's `~/.claude/settings.json` instead of Happy's own config
3. No CLI command or mobile UI exists to control it
4. The feature is completely undocumented

Users have reported this as potential "MCP prompt injection" in issue #165.

## Solution

Change attribution to opt-in with proper user controls:

1. **Default OFF** - No attribution unless explicitly enabled
2. **Happy's own settings** - Store in `~/.happy/settings.json`
3. **CLI control** - `happy config set attribution true/false`
4. **Documentation** - Document the setting in README

## Implementation

### 1. Settings Schema (`cli/src/persistence.ts`)

Add field to Settings interface:

```typescript
interface Settings {
  // ... existing fields ...

  // Attribution settings (defaults to false - opt-in)
  includeAttribution?: boolean
}
```

No schema version bump needed - additive change with sensible default.

### 2. System Prompt Logic (`cli/src/claude/utils/claudeSettings.ts`)

Replace current logic:

```typescript
// NEW: Read from Happy's settings, default to false
export function shouldIncludeAttribution(): boolean {
  const settings = readSettingsSync();
  return settings?.includeAttribution === true;
}
```

Add synchronous settings reader (needed because system prompt is constructed at module load):

```typescript
export function readSettingsSync(): Settings | null {
  try {
    if (!existsSync(configuration.settingsFile)) return null;
    const content = readFileSync(configuration.settingsFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
```

### 3. Update System Prompt (`cli/src/claude/utils/systemPrompt.ts`)

```typescript
import { shouldIncludeAttribution } from "./claudeSettings";

export const systemPrompt = (() => {
  if (shouldIncludeAttribution()) {
    return BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS;
  }
  return BASE_SYSTEM_PROMPT;
})();
```

### 4. CLI Command (`cli/src/commands/config.ts`)

New command structure:

```bash
happy config set attribution true   # Enable
happy config set attribution false  # Disable
happy config get attribution        # Check value
happy config list                   # List all settings
```

### 5. Documentation (`cli/README.md`)

Add section:

```markdown
### Attribution Settings

By default, Happy does not add attribution to git commits. To enable:

\`\`\`bash
happy config set attribution true
\`\`\`

When enabled, commits include:
\`\`\`
Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
\`\`\`
```

### 6. Tests (`cli/src/claude/utils/claudeSettings.test.ts`)

Update to test:
- Default is `false`
- Explicit `true` enables attribution
- Reading from Happy's settings (not Claude's)

## File Changes Summary

| File | Action |
|------|--------|
| `cli/src/persistence.ts` | Add `includeAttribution` to Settings |
| `cli/src/claude/utils/claudeSettings.ts` | New `shouldIncludeAttribution()` + sync reader |
| `cli/src/claude/utils/systemPrompt.ts` | Use new function |
| `cli/src/claude/utils/claudeSettings.test.ts` | Update tests |
| `cli/src/commands/config.ts` | **NEW** - config command |
| `cli/src/index.ts` | Add config command |
| `cli/README.md` | Document setting |

## Future Work (Out of Scope)

- Mobile app settings toggle (separate PR)
- Server-side settings sync (if needed)
