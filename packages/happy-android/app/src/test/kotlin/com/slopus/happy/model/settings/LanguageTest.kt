package com.slopus.happy.model.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.Settings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/** text/index.ts's language resolution and language.tsx's detected name. */
@RunWith(AndroidJUnit4::class)
class LanguageTest {
    private fun locales(vararg tags: String) = tags.map(Locale::forLanguageTag)

    @Test
    fun resolvesLikeIndexTs() {
        assertEquals("ja", Languages.resolve("ja", locales("ru-RU")).code)
        assertEquals("ru", Languages.resolve(null, locales("ru-RU")).code)
        assertEquals("ru", Languages.resolve("xx", locales("fr-FR", "ru-RU")).code)
        assertEquals("zh-Hant", Languages.resolve(null, locales("zh-Hant-TW")).code)
        assertEquals("zh-Hans", Languages.resolve(null, locales("zh-Hans-CN")).code)
        assertEquals("zh-Hans", Languages.resolve(null, locales("zh-TW")).code)
        assertEquals("en", Languages.resolve(null, locales("fr-FR", "de-DE")).code)
        assertEquals("en", Languages.resolve(null, emptyList()).code)
    }

    @Test
    fun detectedNameIsTheFirstLocalesLanguage() {
        assertEquals("Русский", Languages.detectedName(locales("ru-RU", "ja")))
        assertEquals("English", Languages.detectedName(locales("fr-FR", "ru")))
        assertEquals("English", Languages.detectedName(locales("zh-Hans-CN")))
        assertEquals(10, Languages.supported.size)
    }

    @Test
    fun aSyncedChangeWaitsForTheNextStart() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences(LanguageController.PREFS_NAME, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val controller = LanguageController(context, prefs) { locales("en-US") }
        assertEquals("en", controller.language.value.code)

        val settings = MutableStateFlow(Settings.Defaults)
        val scope = TestScope(UnconfinedTestDispatcher())
        controller.follow(settings, scope)
        settings.value = Settings.Defaults.copy(preferredLanguage = "pl")
        assertEquals("not applied while running", "en", controller.language.value.code)
        assertEquals("but at the next start", "pl", LanguageController(context, prefs) { locales("en-US") }.language.value.code)

        controller.apply("ja")
        assertEquals("ja", controller.language.value.code)
        controller.apply(null)
        assertEquals("en", controller.language.value.code)
        assertEquals("en", LanguageController(context, prefs) { locales("en-US") }.language.value.code)
        scope.cancel()
    }
}
