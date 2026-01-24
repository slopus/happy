# PRD-002: Pin libsodium-wrappers Version

**Type:** Ralph-friendly (dependency fix)
**Complexity:** Low
**Estimated iterations:** 1-2

## Goal

Pin `libsodium-wrappers` to version 0.7.14 to avoid ESM/Metro bundler issues on web builds.

## Background

The current `yarn.lock` resolved to `libsodium-wrappers@0.7.16` which introduced an ESM build with top-level await. Metro doesn't support this, causing web builds to fail.

We have a workaround in `metro.config.js` that forces CommonJS, but the cleaner fix is to pin the version.

## Success Criteria (Programmatic)

1. `yarn.lock` shows `libsodium-wrappers@0.7.14`
2. `yarn web` starts without libsodium-related errors
3. `yarn tauri dev` builds successfully

## Implementation Steps

### Step 1: Add resolution to package.json

In `expo-app/package.json`, add a resolutions field:

```json
{
  "resolutions": {
    "libsodium-wrappers": "0.7.14",
    "libsodium": "0.7.14"
  }
}
```

### Step 2: Reinstall dependencies

```bash
cd ~/src/runline/arc
rm -rf node_modules expo-app/node_modules
yarn install
```

### Step 3: Verify version

```bash
cat node_modules/libsodium-wrappers/package.json | grep version
# Should show "0.7.14"
```

### Step 4: Remove metro workaround (optional)

If working, the libsodium resolver in `metro.config.js` can be removed:

```javascript
// Remove or comment out the libsodium resolution block
```

### Step 5: Test web build

```bash
cd expo-app
yarn web
# Should start without errors
```

## Verification Commands

```bash
cd ~/src/runline/arc/expo-app
yarn web
# Wait for "Web Bundling complete"
```

## Files to Modify

- `expo-app/package.json` - add resolutions
- `expo-app/metro.config.js` - optionally remove workaround

## Rollback

Remove the resolutions field and run `yarn install` again.
