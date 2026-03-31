<!-- retro:managed:start -->
## Retro-Discovered Patterns

- Always increase the version number after every change to happy packages (happy-cli or happy-app). User stated this explicitly: '# After every change make sure you increase the version number'.

**Why:** Christian wants version history to track exactly what's deployed and when — stale version strings have caused confusion when debugging issues.

**How to apply:** Before committing any change to `/Users/cr/Scripts/AI-Dev/happy`, bump the version in `packages/happy-cli/package.json` and/or `packages/happy-app/app.config.js` as appropriate. No exception.
- Never bake API keys (OpenAI, ElevenLabs, etc.) into TestFlight builds of the happy mobile app. Keys must be user-configurable via in-app settings (e.g., under the voice assistant settings tab).

**Why:** Colleague Björn couldn't use voice mode because the OpenAI API key wasn't included in the TestFlight build — key was only in dev environment. Shipping keys in the build also creates a security/cost exposure risk.

**How to apply:** When adding any API integration to happy-app, implement a settings UI where users enter their own key. Check `EXPO_PUBLIC_*` variables — these are baked in at Metro bundle time and must NOT contain production secrets for distributed builds.

<!-- retro:managed:end -->
