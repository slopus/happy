# Original ElevenLabs 0.12.2 consumer rules (MIT, see LICENSE).
-keep public class io.elevenlabs.** { public *; }
-keep class io.livekit.** { *; }
-keep class org.webrtc.** { *; }
-keep class io.elevenlabs.models.** { *; }
-keepattributes Signature
-keepattributes *Annotation*
# Happy: Gson fills TokenResponse by its field's name. R8 renames the field
# (dropping its @SerializedName with it), so a minified build fetched the
# public agent's token but read none, and every call ended at connect.
-keepclassmembers class io.elevenlabs.network.TokenResponse { <fields>; }
