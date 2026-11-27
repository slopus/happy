package com.slopus.happy.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Settings' Happy Cloud switch: off on every build until turned on, and kept on the phone. */
@RunWith(AndroidJUnit4::class)
class HappyCloudSettingTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences(HappyCloudSetting.PREFS_NAME, Context.MODE_PRIVATE)
        .also { it.edit().clear().commit() }

    @Test
    fun offUntilTurnedOnAndKept() {
        val setting = HappyCloudSetting(prefs)
        assertFalse(setting.enabled.value)
        setting.set(true)
        assertTrue(setting.enabled.value)
        assertTrue(HappyCloudSetting(prefs).enabled.value)
        setting.set(false)
        assertFalse(HappyCloudSetting(prefs).enabled.value)
    }
}
