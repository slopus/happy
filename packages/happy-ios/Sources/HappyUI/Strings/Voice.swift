import Foundation

extension Strings {
    enum Voice {
        static var title: String { localized("settings.voiceAssistant", "Voice Assistant") }
        static var subtitle: String { "Talk to your coding agents" }
        static var done: String { "Close" }
        static var connecting: String { "Connecting…" }
        static var listening: String { "Listening" }
        static var userSpeaking: String { "You’re speaking" }
        static var agentSpeaking: String { "Happy is speaking" }
        static var muted: String { "Microphone muted" }
        static var mute: String { "Mute microphone" }
        static var unmute: String { "Unmute microphone" }
        static var stop: String { "Stop voice" }
        static var ended: String { "Voice session ended" }
        static var callFooter: String { "Voice uses your microphone and shares session context with ElevenLabs. Voice stops when Happy enters the background." }
        static var permissionDenied: String { "Allow microphone access in Settings to use voice." }
        static var openSettings: String { "Open Settings" }
        static var authentication: String { "Sign in again to use voice." }
        static var unavailable: String { localized("errors.voiceServiceUnavailable", "Voice service is temporarily unavailable") }
        static var subscriptionRequired: String { "Your free voice time has been used. More voice time requires an active subscription." }
        static var hardLimit: String { "You’ve reached the maximum voice time for the last 30 days." }
        static var conversationLimit: String { "You’ve reached the maximum number of voice conversations for the last 30 days." }
        static var upgrade: String { localized("settingsVoice.supportTitle", "Upgrade Voice") }
        static var upgradeSubtitle: String { localized("settingsVoice.supportSubtitle", "Get more voice time and support development") }
        static var languageTitle: String { localized("settingsVoice.languageTitle", "Language") }
        static var languageDescription: String { localized("settingsVoice.languageDescription", "Choose your preferred language for voice assistant interactions. This setting syncs across all your devices.") }
        static var preferredLanguage: String { localized("settingsVoice.preferredLanguage", "Preferred Language") }
        static var preferredLanguageSubtitle: String { localized("settingsVoice.preferredLanguageSubtitle", "Language used for voice assistant responses") }
        static var search: String { localized("settingsVoice.language.searchPlaceholder", "Search languages...") }
        static var usageTitle: String { localized("settingsVoice.usageTitle", "Usage (Last 30 Days)") }
        static var usageFooter: String { localized("settingsVoice.usageFooter", "Voice time used in the last 30 days. Free tier: 20 min. Subscribed: 5 hours. Max 100 conversations per month.") }
        static var usage: String { localized("settingsVoice.usageLabel", "Voice Time") }
        static var conversations: String { localized("settingsVoice.conversationsLabel", "Conversations") }
        static var retry: String { "Retry" }
        static var byo: String { localized("settingsVoice.byoTitle", "Bring Your Own Agent") }
        static var byoDescription: String { localized("settingsVoice.byoDescription", "Connect directly to your own public ElevenLabs agent. Define sendMessageToSession and processPermissionRequest client tools and the initialConversationContext dynamic variable.") }
        static var agentID: String { localized("settingsVoice.customAgentId", "ElevenLabs Agent ID") }
        static var agentDescription: String { localized("settingsVoice.customAgentIdDescription", "Enter your ElevenLabs agent ID. Leave empty to use the Happy default.") }
        static var notConfigured: String { localized("settingsVoice.customAgentIdNotSet", "Not configured") }
        static var direct: String { localized("settingsVoice.bypassToken", "Direct Connection") }
        static var directSubtitle: String { localized("settingsVoice.bypassTokenSubtitle", "Skip Happy server, connect straight to ElevenLabs") }
    }
}
