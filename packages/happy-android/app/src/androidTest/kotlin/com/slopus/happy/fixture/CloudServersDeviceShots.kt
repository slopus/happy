package com.slopus.happy.fixture

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.ui.connection.CloudCreateScreen
import com.slopus.happy.ui.connection.CloudScreen
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Happy Cloud's Join a server and the first Bootstrap a server on a device,
 * with no way to join with an invite code: an invite is a link, accepted on
 * the web. Captured to the app's files under `device-evidence/cloud-servers/`.
 */
@RunWith(AndroidJUnit4::class)
class CloudServersDeviceShots {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val evidence = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "device-evidence/cloud-servers").apply { mkdirs() }

    private fun shot(name: String) {
        rule.waitForIdle()
        Thread.sleep(1500)
        device.takeScreenshot(File(evidence, "$name.png"))
    }

    @Test
    fun joinAServer() {
        val servers = listOf(
            CloudServer(id = "s1", name = "acme", url = "https://acme.happy-clusters.com", displayName = "Acme"),
            CloudServer(id = "s2", name = "beta", url = "https://beta.happy-clusters.com"),
        )
        rule.setContent {
            HappyTheme {
                CloudScreen(
                    state = CloudAccountState.SignedIn, servers = servers, failure = null, here = emptySet(), joins = emptyMap(), image = { null },
                    onOpenBrowser = {}, onSignInWithGoogle = {}, onEmail = {}, signInWithPassword = { _, _ -> error("unused") },
                    onReload = {}, onJoinServer = {}, onContinue = {}, onCreate = {}, onSignOut = {}, onBack = {},
                )
            }
        }
        rule.onNodeWithText("Bootstrap a new one").assertExists()
        rule.onNodeWithText("Join with an invite").assertDoesNotExist()
        shot("join-a-server")
    }

    @Test
    fun theFirstBootstrap() {
        rule.setContent {
            HappyTheme {
                CloudCreateScreen(name = "", availability = null, busy = false, failure = null, onName = {}, onCreate = {}, onBack = {}, first = true)
            }
        }
        rule.onNodeWithText("Have an invite? Join a server").assertDoesNotExist()
        shot("first-bootstrap")
    }
}
