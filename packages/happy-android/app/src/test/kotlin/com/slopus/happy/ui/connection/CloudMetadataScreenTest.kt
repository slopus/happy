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
import com.slopus.happy.agent.ZoneCompute
import com.slopus.happy.agent.ZoneInternet
import com.slopus.happy.agent.ZonePrincipal
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

    @Test fun zonesUseTheSettingsCardMeasureAndShowAccessAndSettings() {
        val zones = CloudMetadataState.Zones(
            listOf(
                CloudZone("open", "Everyday", "General work", "blue", internet = ZoneInternet.On, compute = ZoneCompute.Any),
                CloudZone(
                    "locked", "Production", "Production access", "red", restricted = true,
                    members = listOf(ZonePrincipal(ZonePrincipal.Kind.User, "ana"), ZonePrincipal(ZonePrincipal.Kind.Team, "ops")),
                    internet = ZoneInternet.Off, compute = ZoneCompute.Listed,
                ),
                CloudZone("empty", "Vault", restricted = true, compute = ZoneCompute.None),
            ),
            mapOf("ana" to "Ana"),
            mapOf("ops" to "Ops"),
        )
        rule.setHappyContent { CloudMetadataScreen(CloudMetadataPage.Zones, zones, {}, {}) }
        rule.onNodeWithText("General work\nMay join: All members\nInternet on · Any computer").assertIsDisplayed()
        rule.onNodeWithText("Restricted zone\nProduction access\nMay join: Ana and Ops\nNo internet · Listed computers only").assertIsDisplayed()
        // A restricted zone listing nobody yet; a setting the server didn't say is left out.
        rule.onNodeWithText("Restricted zone\nMay join: No members\nNo computers").assertIsDisplayed()
        rule.onNodeWithText("Manage on desktop").assertIsDisplayed()
        rule.onNodeWithTag("zone.locked").assertHasNoClickAction()
        assertDp("zone card row width", (379 - 2f / rule.density.density).dp, rule.node("zone.locked").bounds.width)
    }

    @Test fun secretMetadataUsesTheSameReadOnlyCardMeasure() {
        // The server's secrets, whether the cluster says `team` (as it still does) or `server`, under one heading.
        val secrets = CloudMetadataState.Secrets(listOf(CloudSecretMetadata("deploy", "Deploy token", "Used for releases", "team"), CloudSecretMetadata("relay", "Relay key", null, "server")))
        rule.setHappyContent { CloudMetadataScreen(CloudMetadataPage.Secrets, secrets, {}, {}) }
        rule.onNodeWithText("SERVER").assertIsDisplayed()
        rule.onNodeWithTag("secret.relay").assertIsDisplayed()
        rule.onNodeWithText("Used for releases").assertIsDisplayed()
        rule.onNodeWithTag("secret.deploy").assertHasNoClickAction()
        assertDp("secret card row width", (379 - 2f / rule.density.density).dp, rule.node("secret.deploy").bounds.width)
    }
}
