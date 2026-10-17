ElevenLabs Android SDK 0.12.2, MIT licensed, copyright ElevenLabs 2025.

Source: https://repo.maven.apache.org/maven2/io/elevenlabs/elevenlabs-android/0.12.2/elevenlabs-android-0.12.2-sources.jar

Archive SHA-256: `6ecaaa0f20ad7b0e4a115def58ab5ad81e16bb7400d958f5f674fd56923d053b`.

The Kotlin tree is extracted from the published source archive. The import
commit contains the unmodified sources so subsequent fixes can be reviewed
separately. This is a local source module; no patched binary is checked in.

The local fixes remove redundant ElevenLabs audio focus owners and make
teardown complete before cancellation returns. LiveKit's AudioSwitchHandler
owns focus and device routing for the room. See the following patch commit
and its lifecycle tests. Re-evaluate the patch before upgrading the SDK.