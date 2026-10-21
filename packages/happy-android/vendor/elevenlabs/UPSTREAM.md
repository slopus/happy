ElevenLabs Android SDK 0.12.2, MIT licensed, copyright ElevenLabs 2025.

Source: https://repo.maven.apache.org/maven2/io/elevenlabs/elevenlabs-android/0.12.2/elevenlabs-android-0.12.2-sources.jar

Archive SHA-256: `6ecaaa0f20ad7b0e4a115def58ab5ad81e16bb7400d958f5f674fd56923d053b`.

The Kotlin tree is extracted from the published source archive. The import
commit contains the unmodified sources so subsequent fixes can be reviewed
separately. This is a local source module; no patched binary is checked in.
The archive's `BuildConfig.java` lives under `src/main/java` for AGP's Java compiler.

The local fixes remove redundant ElevenLabs audio focus owners and make
teardown complete before cancellation returns. LiveKit's AudioSwitchHandler
owns focus and device routing for the room. See the following patch commit
and its lifecycle tests. Re-evaluate the patch before upgrading the SDK.

Local changes:

- `ConversationClientImpl` and `LiveKitAudioManager` no longer create extra
  focus owners or reset global audio mode. LiveKit's supported defaults keep
  Bluetooth > wired headset > speakerphone > earpiece. Its audio thread
  drains focus release asynchronously after logical room disposal.
- `ConversationSessionImpl` serializes terminal cleanup in `NonCancellable`:
  stop audio, close the connection, clean event/audio state, cancel scopes.
  Failed and cancelled starts follow the same path; cancellation stays cancellation.
- `BaseConnection.close`, `WebRTCConnection.close` and `WebSocketConnection.close`
  dispose the connection and its owned room/scopes. Remote room disconnects
  notify the controller as well as explicit stops.
- `setMicMuted` toggles the room's microphone track rather than the system-wide
  microphone setting.

The published AAR has no resources (`R.txt` is empty). The original manifest
permissions and consumer ProGuard rules are preserved by this module. LiveKit
2.26.0 and Gson 2.10.1 follow its published POM; AndroidX, OkHttp and coroutines
use the monorepo's versions, as Gradle already resolved them for the AAR.

To reproduce the original import, download the source URL above, verify the
SHA-256, and extract `io/*` under `src/main/kotlin`. The upstream import commit
is separate from the patch. Run `:elevenlabs:testDebugUnitTest` and the app's
`com.slopus.happy.voice.*` tests after changes. Device validation should compare
`dumpsys audio` before a call, during a call, and after stop/failure/logout:
focus stack empties, recording ends, communication mode/routing settle to the
previous state, and muting a call does not leave the global microphone muted.