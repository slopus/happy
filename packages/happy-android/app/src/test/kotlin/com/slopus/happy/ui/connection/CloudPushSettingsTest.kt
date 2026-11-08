package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.compose.ui.unit.height
import com.slopus.happy.push.CloudPushPreferences
import com.slopus.happy.push.CloudPushSettings
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudPushSettingsTest {
    @get:Rule val rule = createComposeRule()

    @Test fun serverSwitchNeverPromptsForDevicePermissionByDefault() {
        var enabled: Boolean? = null
        var prompts = 0
        rule.setContent {
            HappyTheme {
                CloudPushSettingsScreen(CloudPushPreferences.State.Loaded(CloudPushSettings(true)), false, false, false,
                    { enabled = it }, {}, { prompts++ }, {})
            }
        }
        rule.onNodeWithTag(CloudPushTags.SWITCH).assertIsOn().performClick()
        assertEquals(false, enabled)
        assertEquals(0, prompts)
        rule.onNodeWithText("Device permission").assertIsDisplayed()
        rule.onNodeWithTag(CloudPushTags.DEVICE).performClick()
        assertEquals(1, prompts)
        rule.onNodeWithText("Hide message content").assertDoesNotExist()
    }

    @Test fun permissionGrantedHidesPromptAndSavingDisablesOnlyServerToggle() {
        rule.setContent {
            HappyTheme {
                CloudPushSettingsScreen(CloudPushPreferences.State.Loaded(CloudPushSettings(false), saving = true), true, false, false, {}, {}, {}, {})
            }
        }
        rule.onNodeWithTag(CloudPushTags.SWITCH).assertIsOff().assertIsNotEnabled()
        rule.onNodeWithTag(CloudPushTags.DEVICE).assertDoesNotExist()
        rule.onNodeWithText("Allowed").assertIsDisplayed()
    }

    @Test fun failedReadOffersRetryWithoutInventingEnabledState() {
        var retries = 0
        rule.setContent { HappyTheme { CloudPushSettingsScreen(CloudPushPreferences.State.Failed, true, false, false, {}, { retries++ }, {}, {}) } }
        rule.onNodeWithTag(CloudPushTags.SWITCH).assertDoesNotExist()
        rule.onNodeWithText("Failed to load push notification settings.").performClick()
        assertEquals(1, retries)
    }

    @Test fun notificationsAreSearchableOnlyWhereCloudOffersThem() {
        var local = emptyList<AgentSettingsRow>()
        var cloud = emptyList<AgentSettingsRow>()
        rule.setContent {
            HappyTheme {
                local = agentSettingsIndex()
                cloud = agentSettingsIndex(projectsAvailable = false, notificationsAvailable = true)
            }
        }
        rule.runOnIdle {
            assertFalse(local.any { it.id == CloudPushTags.ROW })
            assertEquals("Notifications", cloud.single { it.id == CloudPushTags.ROW }.title)
        }
    }

    @Test fun devicePermissionActionUsesResponsiveSettingsColumnAndTouchTarget() {
        rule.setHappyContent { CloudPushSettingsScreen(CloudPushPreferences.State.Loaded(CloudPushSettings(true)), false, false, false, {}, {}, {}, {}) }
        val row = rule.node(CloudPushTags.DEVICE)
        assertDp("permission settings width", (379 - 2f / rule.density.density).dp, row.bounds.width)
        assertTrue(row.bounds.height.value >= 48)
        rule.onNodeWithTag(CloudPushTags.SWITCH).assertIsDisplayed()
    }

    @Test fun permissionNotYetRequestedIsNotLabelledDenied() {
        rule.setHappyContent { CloudPushSettingsScreen(CloudPushPreferences.State.Loaded(CloudPushSettings(true)), false, false, false, {}, {}, {}, {}, com.slopus.happy.model.settings.PushPermissionStatus.Undetermined) }
        rule.onNodeWithText("Not requested").assertIsDisplayed()
        rule.onNodeWithText("Denied").assertDoesNotExist()
    }
}