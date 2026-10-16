package com.slopus.happy.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConfigTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private fun prefs(name: String) = context.getSharedPreferences(name, Context.MODE_PRIVATE).also { it.edit().clear().commit() }

    @Test
    fun serverUrlDefaultsAndCustom() {
        val prefs = prefs(ServerConfig.PREFS_NAME)
        val config = ServerConfig(prefs, "https://api.cluster-fluster.com")
        assertEquals("https://api.cluster-fluster.com", config.url.value)
        assertFalse(config.isCustom)
        assertNull(config.customHostLabel)

        config.set(" https://happy.example.com:3005/ ")
        assertEquals("https://happy.example.com:3005", config.url.value)
        assertEquals("happy.example.com:3005", config.customHostLabel)
        assertEquals("survives a restart", "https://happy.example.com:3005", ServerConfig(prefs, "https://api.cluster-fluster.com").url.value)

        config.set("https://selfhost.example")
        assertEquals("selfhost.example", config.customHostLabel)

        config.set(null)
        assertFalse(config.isCustom)
        assertEquals("https://api.cluster-fluster.com", config.url.value)
    }

    @Test
    fun serverUrlValidation() {
        assertEquals(ServerConfig.Validation.Valid, ServerConfig.validate("https://happy.example.com"))
        assertEquals(ServerConfig.Validation.Valid, ServerConfig.validate("http://192.168.1.10:3005"))
        assertEquals(ServerConfig.Validation.Empty, ServerConfig.validate("   "))
        assertEquals(ServerConfig.Validation.NotHttp, ServerConfig.validate("ftp://happy.example.com"))
        assertEquals(ServerConfig.Validation.Malformed, ServerConfig.validate("happy.example.com"))
        assertEquals(ServerConfig.Validation.Malformed, ServerConfig.validate("https://"))
    }

    @Test
    fun themePreferencePersistsAndClears() {
        val prefs = prefs(LocalSettings.PREFS_NAME)
        val settings = LocalSettings(prefs)
        assertEquals(ThemePreference.Adaptive, settings.themePreference.value)
        settings.setThemePreference(ThemePreference.Dark)
        assertTrue("stored the way happy-app stores it", prefs.getString("local-settings", null)!!.contains("\"themePreference\":\"dark\""))
        assertEquals(ThemePreference.Dark, LocalSettings(prefs).themePreference.value)
        settings.clear()
        assertEquals(ThemePreference.Adaptive, settings.themePreference.value)
        assertTrue(prefs.all.isEmpty())
    }
}
