package com.slopus.happy.fixture

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.push.CloudPushPreferences
import com.slopus.happy.push.CloudPushSettings
import com.slopus.happy.ui.connection.CloudPushSettingsScreen
import com.slopus.happy.ui.connection.CloudPushTags
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** UI only: no AppGraph, FCM token, relay exchange, OS prompt or server mutation. */
@RunWith(AndroidJUnit4::class)
class CloudPushSettingsDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun masterSwitchAndExplicitDevicePermissionAreIndependent() {
        var changes = 0
        var prompts = 0
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { HappyTheme {
            CloudPushSettingsScreen(CloudPushPreferences.State.Loaded(CloudPushSettings(true)), false, false, false, { changes++ }, {}, { prompts++ }, {})
        } }
        rule.onNodeWithTag(CloudPushTags.SWITCH).assertIsDisplayed()
        rule.onNodeWithTag(CloudPushTags.DEVICE).assertIsDisplayed()
        rule.waitForIdle()
        assertEquals(0, changes + prompts)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "cloud-push").apply { mkdirs() }
        UiDevice.getInstance(instrumentation).takeScreenshot(File(directory, "settings-fixture.png"))
        rule.onNodeWithTag(CloudPushTags.SWITCH).performClick()
        assertEquals(1, changes)
        assertEquals(0, prompts)
        rule.onNodeWithTag(CloudPushTags.DEVICE).performClick()
        assertEquals(1, prompts)
    }
}