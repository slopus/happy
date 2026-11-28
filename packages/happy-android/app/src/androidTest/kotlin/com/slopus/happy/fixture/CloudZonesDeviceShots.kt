package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.CloudZone
import com.slopus.happy.agent.ZoneCompute
import com.slopus.happy.agent.ZoneInternet
import com.slopus.happy.agent.ZonePrincipal
import com.slopus.happy.ui.connection.CloudMetadataPage
import com.slopus.happy.ui.connection.CloudMetadataScreen
import com.slopus.happy.ui.connection.CloudMetadataState
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Emulator-only fixture: Settings › Zones on Happy Cloud (Zones v2) from
 * synthetic data (no network, account or server): an open zone, a
 * restricted one listing a person and teams with internet off, and one
 * with no computers. Captured to the test app's external files under
 * `cloud-zones/`.
 */
@RunWith(AndroidJUnit4::class)
class CloudZonesDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "cloud-zones").apply { mkdirs() }

    @Test fun zones() {
        val state = CloudMetadataState.Zones(
            listOf(
                CloudZone("everyday", "Everyday", "General work for everyone.", "blue", internet = ZoneInternet.On, compute = ZoneCompute.Any),
                CloudZone(
                    "finance", "Finance", "Books and payroll. Nothing here leaves the zone.", "red", restricted = true,
                    members = listOf(
                        ZonePrincipal(ZonePrincipal.Kind.User, "u-ada"),
                        ZonePrincipal(ZonePrincipal.Kind.Team, "finance"),
                        ZonePrincipal(ZonePrincipal.Kind.Team, "owners"),
                    ),
                    internet = ZoneInternet.Off, compute = ZoneCompute.Listed,
                ),
                CloudZone("research", "Research", "Reading and writing only.", "purple", internet = ZoneInternet.On, compute = ZoneCompute.None),
                CloudZone("vault", "Vault", "", "amber", restricted = true, internet = ZoneInternet.Off, compute = ZoneCompute.None),
            ),
            names = mapOf("u-ada" to "Ada Lovelace"),
            teams = mapOf("finance" to "Finance team", "owners" to "Owners"),
        )
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { HappyTheme { CloudMetadataScreen(CloudMetadataPage.Zones, state, {}, {}) } }
        rule.onNodeWithText("Finance").assertExists()
        rule.waitForIdle()
        SystemClock.sleep(800)
        device.takeScreenshot(File(directory, "zones.png"))
    }
}
