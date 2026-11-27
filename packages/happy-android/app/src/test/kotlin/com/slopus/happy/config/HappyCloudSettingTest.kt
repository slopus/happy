package com.slopus.happy.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings' Happy Cloud switch: the build's default, nothing kept, until
 * it is turned; then the person's choice, whatever the build's default.
 */
@RunWith(AndroidJUnit4::class)
class HappyCloudSettingTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences(HappyCloudSetting.PREFS_NAME, Context.MODE_PRIVATE)
        .also { it.edit().clear().commit() }

    @Test
    fun theBuildsDefaultUntilTurned() {
        assertTrue(HappyCloudSetting(prefs, default = true).enabled.value)
        assertFalse(HappyCloudSetting(prefs, default = false).enabled.value)
        assertTrue("nothing kept until the switch is turned", prefs.all.isEmpty())
    }

    @Test
    fun aTurnIsKeptOverEveryDefault() {
        HappyCloudSetting(prefs, default = true).set(false)
        assertFalse(HappyCloudSetting(prefs, default = true).enabled.value)
        HappyCloudSetting(prefs, default = false).set(true)
        assertTrue(HappyCloudSetting(prefs, default = false).enabled.value)
    }
}
