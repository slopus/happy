# Contributing to Happy

## Development Workflow: Build Variants

The Happy app supports three build variants across **iOS, Android, and macOS desktop**, each with separate bundle IDs so all three can be installed simultaneously:

| Variant | Bundle ID | App Name | Use Case |
|---------|-----------|----------|----------|
| **Development** | `com.slopus.happy.dev` | Happy (dev) | Local development with hot reload |
| **Preview** | `com.slopus.happy.preview` | Happy (preview) | Beta testing & OTA updates before production |
| **Production** | `com.ex3ndr.happy` | Happy | Public App Store release |

**Why Preview?**
- **Development**: Fast iteration, dev server, instant reload
- **Preview**: Beta testers get OTA updates (`eas update --branch preview`) without app store submission
- **Production**: Stable App Store builds

This allows you to test production-like builds with real users before releasing to the App Store.

## Quick Start

### iOS Development

```bash
# Development variant (default)
yarn ios:dev

# Preview variant
yarn ios:preview

# Production variant
yarn ios:production
```

### Android Development

```bash
# Development variant
yarn android:dev

# Preview variant
yarn android:preview

# Production variant
yarn android:production
```

### macOS Desktop (Tauri)

```bash
# Development variant - run with hot reload
yarn tauri:dev

# Build development variant
yarn tauri:build:dev

# Build preview variant
yarn tauri:build:preview

# Build production variant
yarn tauri:build:production
```

**How Tauri Variants Work:**
- Base config: `src-tauri/tauri.conf.json` (production defaults)
- Partial configs: `tauri.dev.conf.json`, `tauri.preview.conf.json`
- Tauri merges partial configs using [JSON Merge Patch (RFC 7396)](https://datatracker.ietf.org/doc/html/rfc7396)
- Only differences need to be specified in partial configs (DRY principle)

### Development Server

```bash
# Start dev server for development variant
yarn start:dev

# Start dev server for preview variant
yarn start:preview

# Start dev server for production variant
yarn start:production
```

## Visual Differences

Each variant displays a different app name on your device:
- **Development**: "Happy (dev)" - Yellow/orange theme
- **Preview**: "Happy (preview)" - Preview theme
- **Production**: "Happy" - Standard theme

This makes it easy to distinguish which version you're testing!

## Common Workflows

### Testing Development Changes

1. **Build development variant:**
   ```bash
   yarn ios:dev
   ```

2. **Make your changes** to the code

3. **Hot reload** automatically updates the app

4. **Rebuild if needed** for native changes:
   ```bash
   yarn ios:dev
   ```

### Testing Preview (Pre-Release)

1. **Build preview variant:**
   ```bash
   yarn ios:preview
   ```

2. **Test OTA updates:**
   ```bash
   yarn ota  # Publishes to preview branch
   ```

3. **Verify** the preview build works as expected

### Production Release

1. **Build production variant:**
   ```bash
   yarn ios:production
   ```

2. **Submit to App Store:**
   ```bash
   yarn submit
   ```

3. **Deploy OTA updates:**
   ```bash
   yarn ota:production
   ```

## All Variants Simultaneously

You can install all three variants on the same device:

```bash
# Build all three variants
yarn ios:dev
yarn ios:preview
yarn ios:production
```

All three apps appear on your device with different icons and names!

## EAS Build Profiles

The project includes EAS build profiles for automated builds:

```bash
# Development build
eas build --profile development

# Production build
eas build --profile production
```

## Environment Variables

Each variant can use different environment variables via `APP_ENV`:

```javascript
// In app.config.js
const variant = process.env.APP_ENV || 'development';
```

This controls:
- Bundle identifier
- App name
- Associated domains (deep linking)
- Intent filters (Android)
- Other variant-specific configuration

## Deep Linking

Only **production** variant has deep linking configured:

- **Production**: `https://app.happy.engineering/*`
- **Development**: No deep linking
- **Preview**: No deep linking

This prevents dev/preview builds from interfering with production deep links.

## Testing Connected to Different Servers

You can connect different variants to different Happy CLI instances:

```bash
# Development app → Dev CLI daemon
yarn android:dev
# Connect to CLI running: yarn dev:daemon:start

# Production app → Stable CLI daemon
yarn android:production
# Connect to CLI running: yarn stable:daemon:start
```

Each app maintains separate authentication and sessions!

## Local Server Development

To test with a local Happy server:

```bash
yarn start:local-server
```

This sets:
- `EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005`
- `EXPO_PUBLIC_DEBUG=1`
- Debug logging enabled

## Troubleshooting

### Build fails with "Bundle identifier already in use"

This shouldn't happen - each variant has a unique bundle ID. If it does:

1. Check `app.config.js` - verify `bundleId` is set correctly for the variant
2. Clean build:
   ```bash
   yarn prebuild
   yarn ios:dev  # or whichever variant
   ```

### App not updating after changes

1. **For JS changes**: Hot reload should work automatically
2. **For native changes**: Rebuild the variant:
   ```bash
   yarn ios:dev  # Force rebuild
   ```
3. **For config changes**: Clean and prebuild:
   ```bash
   yarn prebuild
   yarn ios:dev
   ```

### All three apps look the same

Check the app name on the home screen:
- "Happy (dev)"
- "Happy (preview)"
- "Happy"

If they're all the same name, the variant might not be set correctly. Verify:

```bash
# Check what APP_ENV is set to
echo $APP_ENV

# Or look at the build output
yarn ios:dev  # Should show "Happy (dev)" as the name
```

### Connected device not found

For iOS connected device testing:

```bash
# List available devices
xcrun devicectl list devices

# Run on specific connected device
yarn ios:connected-device
```

## Tips

1. **Use development variant for active work** - Fast iteration, debug features enabled
2. **Use preview for pre-release testing** - Test OTA updates before production
3. **Use production for final validation** - Exact configuration that ships to users
4. **Install all three simultaneously** - Compare behaviors side-by-side
5. **Different CLI instances** - Connect dev app to dev CLI, prod app to stable CLI
6. **Check app name** - Always visible which variant you're testing

## How It Works

The `app.config.js` file reads the `APP_ENV` environment variable:

```javascript
const variant = process.env.APP_ENV || 'development';
const bundleId = {
  development: "com.slopus.happy.dev",
  preview: "com.slopus.happy.preview",
  production: "com.ex3ndr.happy"
}[variant];
```

The `cross-env` package ensures this works cross-platform:

```json
{
  "scripts": {
    "ios:dev": "cross-env APP_ENV=development expo run:ios"
  }
}
```

Cross-platform via `cross-env` - works identically on Windows, macOS, and Linux!
