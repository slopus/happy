package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.CloudSecretMetadata
import com.slopus.happy.agent.CloudZone
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudMetadataScreenTest {
    @get:Rule val rule = createComposeRule()

    @Test fun zonesUseTheSettingsCardMeasureAndShowAccess() {
        val zones = CloudMetadataState.Zones(
            listOf(
                CloudZone("default", "Everyday", "General work", "blue", false, true, null),
                CloudZone("locked", "Production", "Production access", "red", true, false, listOf("ana")),
            ),
            mapOf("ana" to "Ana"),
        )
        rule.setHappyContent { CloudMetadataScreen(CloudMetadataPage.Zones, zones, {}, {}) }
        rule.onNodeWithText("Default zone\nGeneral work\nMay join: All members").assertIsDisplayed()
        rule.onNodeWithText("Critical zone\nProduction access\nMay join: Ana").assertIsDisplayed()
        rule.onNodeWithText("Manage on desktop").assertIsDisplayed()
        rule.onNodeWithTag("zone.locked").assertHasNoClickAction()
        assertDp("zone card row width", (379 - 2f / rule.density.density).dp, rule.node("zone.locked").bounds.width)
    }

    @Test fun secretMetadataUsesTheSameReadOnlyCardMeasure() {
        val secrets = CloudMetadataState.Secrets(listOf(CloudSecretMetadata("deploy", "Deploy token", "Used for releases", "team")))
        rule.setHappyContent { CloudMetadataScreen(CloudMetadataPage.Secrets, secrets, {}, {}) }
        rule.onNodeWithText("TEAM").assertIsDisplayed()
        rule.onNodeWithText("Used for releases").assertIsDisplayed()
        rule.onNodeWithTag("secret.deploy").assertHasNoClickAction()
        assertDp("secret card row width", (379 - 2f / rule.density.density).dp, rule.node("secret.deploy").bounds.width)
    }
}
