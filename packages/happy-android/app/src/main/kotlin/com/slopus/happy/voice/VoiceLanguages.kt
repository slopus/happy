package com.slopus.happy.voice

/** constants/Languages.ts `Language`: a voice assistant language; [code] null is auto-detect. */
data class VoiceLanguage(
    val code: String?,
    val name: String,
    val nativeName: String,
    val region: String? = null,
    /** The ElevenLabs language code, where ElevenLabs supports it. */
    val elevenLabsCode: String? = null,
) {
    /** getLanguageDisplayName: "Name (Native)" when they differ, then " - Region". */
    val displayName: String
        get() = listOfNotNull(if (name != nativeName) "$name ($nativeName)" else name, region).joinToString(" - ")

    /** The language screen's search: name, native name, code or region, ignoring case. */
    fun matches(query: String): Boolean {
        if (query.isEmpty()) return true
        val q = query.lowercase()
        return listOfNotNull(name, nativeName, code, region).any { it.lowercase().contains(q) }
    }
}

/** constants/Languages.ts. */
object VoiceLanguages {
    /** LANGUAGES, auto-detect first, in happy-app's order. */
    val all: List<VoiceLanguage> = listOf(
    VoiceLanguage(null, "Auto-detect", "Auto-detect", null, null),
    VoiceLanguage("en-US", "English", "English", "United States", "en"),
    VoiceLanguage("en-GB", "English", "English", "United Kingdom", "en"),
    VoiceLanguage("en-AU", "English", "English", "Australia", "en"),
    VoiceLanguage("en-CA", "English", "English", "Canada", "en"),
    VoiceLanguage("es-ES", "Spanish", "Español", "Spain", "es"),
    VoiceLanguage("es-MX", "Spanish", "Español", "Mexico", "es"),
    VoiceLanguage("es-AR", "Spanish", "Español", "Argentina", "es"),
    VoiceLanguage("fr-FR", "French", "Français", "France", "fr"),
    VoiceLanguage("fr-CA", "French", "Français", "Canada", "fr"),
    VoiceLanguage("de-DE", "German", "Deutsch", "Germany", "de"),
    VoiceLanguage("de-AT", "German", "Deutsch", "Austria", "de"),
    VoiceLanguage("it-IT", "Italian", "Italiano", null, "it"),
    VoiceLanguage("pt-BR", "Portuguese", "Português", "Brazil", "pt-br"),
    VoiceLanguage("pt-PT", "Portuguese", "Português", "Portugal", "pt"),
    VoiceLanguage("ru-RU", "Russian", "Русский", null, "ru"),
    VoiceLanguage("zh-CN", "Chinese", "中文", "Simplified", "zh"),
    VoiceLanguage("zh-TW", "Chinese", "中文", "Traditional", "zh"),
    VoiceLanguage("ja-JP", "Japanese", "日本語", null, "ja"),
    VoiceLanguage("ko-KR", "Korean", "한국어", null, "ko"),
    VoiceLanguage("ar-SA", "Arabic", "العربية", null, "ar"),
    VoiceLanguage("hi-IN", "Hindi", "हिन्दी", null, "hi"),
    VoiceLanguage("nl-NL", "Dutch", "Nederlands", null, "nl"),
    VoiceLanguage("sv-SE", "Swedish", "Svenska", null, "sv"),
    VoiceLanguage("no-NO", "Norwegian", "Norsk", null, "no"),
    VoiceLanguage("da-DK", "Danish", "Dansk", null, "da"),
    VoiceLanguage("fi-FI", "Finnish", "Suomi", null, "fi"),
    VoiceLanguage("pl-PL", "Polish", "Polski", null, "pl"),
    VoiceLanguage("tr-TR", "Turkish", "Türkçe", null, "tr"),
    VoiceLanguage("he-IL", "Hebrew", "עברית", null, null),
    VoiceLanguage("th-TH", "Thai", "ไทย", null, null),
    VoiceLanguage("vi-VN", "Vietnamese", "Tiếng Việt", null, "vi"),
    VoiceLanguage("id-ID", "Indonesian", "Bahasa Indonesia", null, "id"),
    VoiceLanguage("ms-MY", "Malay", "Bahasa Melayu", null, "ms"),
    VoiceLanguage("uk-UA", "Ukrainian", "Українська", null, "uk"),
    VoiceLanguage("cs-CZ", "Czech", "Čeština", null, "cs"),
    VoiceLanguage("hu-HU", "Hungarian", "Magyar", null, "hu"),
    VoiceLanguage("ro-RO", "Romanian", "Română", null, "ro"),
    VoiceLanguage("bg-BG", "Bulgarian", "Български", null, "bg"),
    VoiceLanguage("el-GR", "Greek", "Ελληνικά", null, "el"),
    VoiceLanguage("hr-HR", "Croatian", "Hrvatski", null, "hr"),
    VoiceLanguage("sk-SK", "Slovak", "Slovenčina", null, "sk"),
    VoiceLanguage("sl-SI", "Slovenian", "Slovenščina", null, null),
    VoiceLanguage("et-EE", "Estonian", "Eesti", null, null),
    VoiceLanguage("lv-LV", "Latvian", "Latviešu", null, null),
    VoiceLanguage("lt-LT", "Lithuanian", "Lietuvių", null, null),
    )

    /** findLanguageByCode. */
    fun find(code: String?): VoiceLanguage? = all.firstOrNull { it.code == code }

    /** getElevenLabsCodeFromPreference: null for auto-detect or an unsupported language. */
    fun elevenLabsCode(preference: String?): String? = preference?.let { find(it)?.elevenLabsCode }
}
