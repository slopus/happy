package com.slopus.happy.model.settings

import java.util.Locale

/** One of happy-app's UI languages (text/_all.ts `SUPPORTED_LANGUAGES`). */
data class Language(val code: String, val nativeName: String, val englishName: String) {
    /** The locale whose resources hold this language's strings. */
    val locale: Locale get() = Locale.forLanguageTag(code)
}

object Languages {
    /** _all.ts's order. */
    val supported = listOf(
        Language("en", "English", "English"),
        Language("ru", "Русский", "Russian"),
        Language("pl", "Polski", "Polish"),
        Language("es", "Español", "Spanish"),
        Language("it", "Italiano", "Italian"),
        Language("pt", "Português", "Portuguese"),
        Language("ca", "Català", "Catalan"),
        Language("zh-Hans", "中文(简体)", "Chinese (Simplified)"),
        Language("zh-Hant", "中文(繁體)", "Chinese (Traditional)"),
        Language("ja", "日本語", "Japanese"),
    )

    const val DEFAULT = "en"

    fun byCode(code: String?): Language? = supported.firstOrNull { it.code == code }

    /**
     * The language index.ts picks: [preferred] if supported, else the first
     * device locale it has (Chinese by script, simplified when the script is
     * unknown), else English.
     */
    fun resolve(preferred: String?, deviceLocales: List<Locale>): Language {
        byCode(preferred)?.let { return it }
        for (locale in deviceLocales) {
            val language = locale.language.ifEmpty { continue }
            if (language == "zh") {
                return when (locale.script) {
                    "Hant" -> byCode("zh-Hant")!!
                    else -> byCode("zh-Hans")!!
                }
            }
            byCode(language)?.let { return it }
        }
        return byCode(DEFAULT)!!
    }

    /**
     * The name language.tsx and appearance.tsx show for "Automatic": the
     * first device locale's language if it is a supported code as is, else
     * English's. (So a Chinese device shows English here, as in happy-app.)
     */
    fun detectedName(deviceLocales: List<Locale>): String {
        val language = deviceLocales.firstOrNull()?.language?.lowercase() ?: "en"
        return (byCode(language) ?: byCode(DEFAULT)!!).nativeName
    }
}
