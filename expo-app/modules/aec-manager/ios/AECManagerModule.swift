import ExpoModulesCore
import AVFoundation

public class AECManagerModule: Module {
    public func definition() -> ModuleDefinition {
        Name("AECManager")

        Function("enableAEC") { (audioSessionId: Int) in
            // iOS uses system-level AEC through AVAudioSession voiceChat mode
            // The audio session is already configured in AppDelegate
            // This function re-applies the configuration if needed
            self.configureVoiceChatSession()
        }

        Function("disableAEC") {
            // Reset to default audio session configuration
            self.resetAudioSession()
        }

        Function("setVoiceCommunicationMode") {
            self.configureVoiceChatSession()
        }

        Function("resetAudioMode") {
            self.resetAudioSession()
        }

        Function("isAECAvailable") { () -> Bool in
            // iOS always has AEC available through voiceChat mode
            return true
        }

        Function("isNSAvailable") { () -> Bool in
            // iOS has noise suppression built into voiceChat mode
            return true
        }

        Function("isAGCAvailable") { () -> Bool in
            // iOS has AGC built into voiceChat mode
            return true
        }
    }

    /// Configure audio session for voice chat with AEC
    private func configureVoiceChatSession() {
        do {
            let audioSession = AVAudioSession.sharedInstance()

            // Set category to PlayAndRecord for full-duplex audio
            // voiceChat mode enables AEC, AGC, and noise suppression
            try audioSession.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
            )

            // Set preferred sample rate and buffer duration for low latency
            try audioSession.setPreferredSampleRate(24000)
            try audioSession.setPreferredIOBufferDuration(0.02)  // 20ms buffer

            // Activate the audio session
            try audioSession.setActive(true)

            print("[AECManagerModule] Audio session configured for VoiceChat with AEC")
        } catch {
            print("[AECManagerModule] Failed to configure audio session: \(error)")
        }
    }

    /// Reset audio session to default configuration
    private func resetAudioSession() {
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .default)
            try audioSession.setActive(true)
            print("[AECManagerModule] Audio session reset to default")
        } catch {
            print("[AECManagerModule] Failed to reset audio session: \(error)")
        }
    }
}
