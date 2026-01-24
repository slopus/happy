# PRD-003: Complete Runline Branding

**Type:** Ralph-friendly (batch text replacement)
**Complexity:** Low
**Estimated iterations:** 2-3

## Goal

Complete the rebranding from "Happy" to "Runline" across all UI strings and translations.

## Current State

Partial changes exist (uncommitted) in:
- `sources/components/HeaderLogo.tsx`
- `sources/components/SettingsView.tsx`
- `sources/components/SidebarView.tsx`
- `sources/components/TabBar.tsx`
- `sources/-zen/components/ZenHeader.tsx`
- All translation files in `sources/text/translations/`

## Success Criteria (Programmatic)

1. No occurrences of "Happy" in user-visible strings (except credits/attribution)
2. `yarn tsc --noEmit` passes
3. `grep -r "Happy" sources/ --include="*.tsx" --include="*.ts"` returns only:
   - Attribution/credits (e.g., "Based on Happy")
   - Variable names (ok to keep)
   - Comments explaining Happy origin

## Implementation Steps

### Step 1: Review uncommitted changes

```bash
git diff --stat
git diff sources/components/
```

### Step 2: Complete translation updates

For each file in `sources/text/translations/*.ts`:
- Replace "Happy" → "Runline" in user-visible strings
- Keep "Happy" in any attribution strings

### Step 3: Update remaining UI components

Search for remaining occurrences:
```bash
grep -rn "Happy" sources/ --include="*.tsx" --include="*.ts" | grep -v node_modules
```

Update each to "Runline" where appropriate.

### Step 4: Verify no regressions

```bash
yarn tsc --noEmit
```

### Step 5: Commit changes

```bash
git add sources/
git commit -m "Complete Runline branding across UI and translations"
```

## Files to Modify

- `sources/components/*.tsx` - UI components with brand name
- `sources/text/translations/*.ts` - all language files
- Any other files containing "Happy" in user-visible strings

## Files to NOT Modify

- `README.md` - attribution to Happy is intentional
- `LICENSE` - legal requirements
- Comments explaining the Happy fork origin

## Verification Commands

```bash
cd ~/src/runline/arc/expo-app
yarn tsc --noEmit

# Check for remaining Happy references
grep -rn '"Happy"' sources/ --include="*.tsx" --include="*.ts" | grep -v "Based on" | grep -v "fork of"
# Should return empty or only acceptable references
```

## Rollback

```bash
git checkout sources/
```
