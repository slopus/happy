import Foundation

public struct VoiceLanguage: Equatable, Sendable {
    public let code: String?
    public let name: String
    public let providerCode: String?

    /// Locale values match happy-app's synced voiceAssistantLanguage setting.
    public static let all: [VoiceLanguage] = [
        .init(code: nil, name: "Auto-detect", providerCode: nil),
        .init(code: "en-US", name: "English — United States", providerCode: "en"),
        .init(code: "en-GB", name: "English — United Kingdom", providerCode: "en"),
        .init(code: "en-AU", name: "English — Australia", providerCode: "en"),
        .init(code: "en-CA", name: "English — Canada", providerCode: "en"),
        .init(code: "es-ES", name: "Español — España", providerCode: "es"),
        .init(code: "es-MX", name: "Español — México", providerCode: "es"),
        .init(code: "es-AR", name: "Español — Argentina", providerCode: "es"),
        .init(code: "fr-FR", name: "Français — France", providerCode: "fr"),
        .init(code: "fr-CA", name: "Français — Canada", providerCode: "fr"),
        .init(code: "de-DE", name: "Deutsch", providerCode: "de"),
        .init(code: "it-IT", name: "Italiano", providerCode: "it"),
        .init(code: "pt-BR", name: "Português — Brasil", providerCode: "pt"),
        .init(code: "pt-PT", name: "Português — Portugal", providerCode: "pt"),
        .init(code: "ru-RU", name: "Русский", providerCode: "ru"),
        .init(code: "zh-CN", name: "中文 — 简体", providerCode: "zh"),
        .init(code: "zh-TW", name: "中文 — 繁體", providerCode: "zh"),
        .init(code: "ja-JP", name: "日本語", providerCode: "ja"),
        .init(code: "ko-KR", name: "한국어", providerCode: "ko"),
        .init(code: "ar-SA", name: "العربية", providerCode: "ar"),
        .init(code: "hi-IN", name: "हिन्दी", providerCode: "hi"),
        .init(code: "nl-NL", name: "Nederlands", providerCode: "nl"),
        .init(code: "sv-SE", name: "Svenska", providerCode: "sv"),
        .init(code: "no-NO", name: "Norsk", providerCode: "no"),
        .init(code: "da-DK", name: "Dansk", providerCode: "da"),
        .init(code: "fi-FI", name: "Suomi", providerCode: "fi"),
        .init(code: "vi-VN", name: "Tiếng Việt", providerCode: "vi"),
        .init(code: "id-ID", name: "Bahasa Indonesia", providerCode: "id"),
        .init(code: "ms-MY", name: "Bahasa Melayu", providerCode: "ms"),
        .init(code: "uk-UA", name: "Українська", providerCode: "uk"),
        .init(code: "cs-CZ", name: "Čeština", providerCode: "cs"),
        .init(code: "hu-HU", name: "Magyar", providerCode: "hu"),
        .init(code: "ro-RO", name: "Română", providerCode: "ro"),
        .init(code: "bg-BG", name: "Български", providerCode: "bg"),
        .init(code: "el-GR", name: "Ελληνικά", providerCode: "el"),
        .init(code: "hr-HR", name: "Hrvatski", providerCode: "hr"),
        .init(code: "sk-SK", name: "Slovenčina", providerCode: "sk"),
        .init(code: "tr-TR", name: "Türkçe", providerCode: "tr"),
        .init(code: "pl-PL", name: "Polski", providerCode: "pl"),
    ]

    public static func selection(_ code: String?) -> VoiceLanguage {
        all.first { $0.code == code } ?? all[0]
    }
}
