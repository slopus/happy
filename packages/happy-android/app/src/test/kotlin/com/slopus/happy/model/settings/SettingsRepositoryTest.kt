package com.slopus.happy.model.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.config.LocalSettings
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.HappyJson
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class SettingsRepositoryTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore

    @Before
    fun setUp() {
        database = HappyDatabase(context, name = null)
        store = HappyStore(database)
    }

    @After
    fun tearDown() = database.close()

    private fun json(text: String): JsonObject = HappyJson.parseToJsonElement(text).jsonObject

    @Test
    fun followsTheStoreAndRecordsChangesAsPending() = runTest {
        store.saveSettings(json("""{"viewInline":true,"future":"keep"}"""), version = 4)
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        var syncs = 0
        val repository = SettingsRepository(store, scope, onChanged = { syncs++ }, io = dispatcher)
        scope.advanceUntilIdle()
        assertTrue(repository.settings.value.viewInline)
        assertEquals(JsonPrimitive("keep"), repository.settings.value.unknown["future"])

        repository.change { it.copy(analyticsOptOut = true, preferredLanguage = "ja") }
        assertTrue("shown before the write lands", repository.settings.value.analyticsOptOut)
        scope.advanceUntilIdle()
        assertEquals(json("""{"analyticsOptOut":true,"preferredLanguage":"ja"}"""), store.pendingSettings())
        assertEquals(1, syncs)
        assertEquals("ja", repository.settings.value.preferredLanguage)

        // The server copy changes under it (a sync): pending changes stay on top.
        store.saveSettings(json("""{"viewInline":false,"analyticsOptOut":false}"""), version = 5)
        scope.advanceUntilIdle()
        assertFalse(repository.settings.value.viewInline)
        assertTrue(repository.settings.value.analyticsOptOut)

        store.clearAll()
        scope.advanceUntilIdle()
        assertEquals(com.slopus.happy.model.Settings.Defaults, repository.settings.value)
        scope.cancel()
    }

    @Test
    fun anUnchangedTransformWritesNothing() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        var syncs = 0
        val repository = SettingsRepository(store, scope, onChanged = { syncs++ }, io = dispatcher)
        scope.advanceUntilIdle()
        repository.change { it.copy(viewInline = false) }
        scope.advanceUntilIdle()
        assertEquals(0, syncs)
        assertTrue(store.pendingSettings().isEmpty())
        scope.cancel()
    }

    @Test
    fun localSettingsKeepTheWholeDocument() {
        val prefs = context.getSharedPreferences(LocalSettings.PREFS_NAME, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        prefs.edit().putString("local-settings", """{"zenMode":true,"expandedProjects":{"p":true},"future":1}""").commit()
        val settings = LocalSettings(prefs)
        assertTrue(settings.values.value.zenMode)
        assertEquals(mapOf("p" to true), settings.values.value.expandedProjects)
        settings.setThemePreference(ThemePreference.Light)
        val reread = LocalSettings(prefs).values.value
        assertEquals(ThemePreference.Light, reread.themePreference)
        assertTrue(reread.zenMode)
        assertEquals(JsonPrimitive(1), reread.unknown["future"])
    }

    @Test
    fun localSettingsWithABadFieldAreTheDefaults() {
        assertEquals(LocalSettingsValues.Defaults, LocalSettingsValues.parse(json("""{"zenMode":"yes","debugMode":true}""")))
        assertEquals(LocalSettingsValues.Defaults, LocalSettingsValues.parse(json("""{"themePreference":"sepia"}""")))
        assertEquals(LocalSettingsValues.Defaults.copy(sidebarPanelsOpen = listOf("changes")), LocalSettingsValues.parse(json("""{"sidebarPanelsOpen":["changes"]}""")))
    }
}
