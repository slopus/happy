# Debugging Web Client Authentication

I've added extensive logging to help diagnose the "Invalid secret key" error.

## Quick Test

1. **Stop the web client** (if running):
   ```bash
   pkill -f "expo start"
   ```

2. **Clear Expo cache and restart**:
   ```bash
   cd happy
   rm -rf .expo node_modules/.cache
   yarn start:local-server
   ```

3. **Wait for the web client to finish bundling** (watch for "Bundled" message)

4. **Open your browser** to http://localhost:8081

5. **Open DevTools Console** (F12 → Console tab)

6. **Try to authenticate** with the secret key:
   ```
   NNVP6-G4NHA-ITJMY-LCBBJ-6GDJU-WFPNK-FDQOZ-5F2CT-FAVUN-X52CJ-6A
   ```

## What to Look For in Console

The console should show detailed logs like:

```
[ServerConfig] URL Resolution:
  - Stored in localStorage: none
  - Environment variable: http://localhost:3005
  - Auto-detected default: http://localhost:3005
  - Final server URL: http://localhost:3005
```

Then when you submit the secret key:

```
[Restore] Starting authentication with secret key...
[Restore] Input key (first 20 chars): NNVP6-G4NHA-ITJMY-LC...
[Restore] Normalized to base64url (first 20 chars): a2r_G404ETSzCxBCnxhp...
[Restore] Decoded to bytes, length: 32
[Restore] Calling authGetToken...
[authGetToken] Using server URL: http://localhost:3005
[authGetToken] Sending POST request to: http://localhost:3005/v1/auth
```

## Diagnosis

### If you see `Final server URL: https://api.cluster-fluster.com`

**Problem:** The web client is using production server instead of localhost.

**Solutions:**
1. Clear browser localStorage (F12 → Application → Storage → Clear site data)
2. Check that environment variable is set: `EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005`
3. Verify you're accessing from localhost, not an IP address

### If you see `Response status: 401` or `403`

**Problem:** Server is receiving the request but rejecting it.

**Solutions:**
1. The secret key might be from a different account
2. Run `node scripts/setup-test-credentials.mjs` to generate a fresh account
3. Check server logs: `./happy-launcher.sh logs server`

### If you see network error or CORS error

**Problem:** Can't connect to the server.

**Solutions:**
1. Check server is running: `curl http://localhost:3005`
2. Restart server: `./happy-launcher.sh restart`

### If logs show different bytes length (not 32)

**Problem:** Secret key parsing failed.

**Solutions:**
1. Make sure you copied the entire key
2. Check for extra spaces or characters
3. The key should be exactly: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX` (11 groups)

## Send Me the Logs

Copy all the console output (starting from `[ServerConfig]` through the error) and share it.
This will show exactly where the authentication is failing.

## Manual Test (Bypass Web Client)

To verify the server is working, you can test authentication directly:

```bash
node scripts/test-web-client-exact-flow.mjs
```

This should succeed with the same secret key. If this works but the web client doesn't,
the issue is definitely in the web client configuration or cache.
