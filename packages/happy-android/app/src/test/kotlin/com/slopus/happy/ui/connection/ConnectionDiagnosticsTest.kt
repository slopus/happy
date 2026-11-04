package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.TransportDiagnostics
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectionDiagnosticsTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val sample = ConnectionPageState("Connected", "Tailcat", true, computer = "Studio", daemonVersion = "2.0.0", transports = listOf(
        TransportDiagnostics(TransportDiagnostics.Kind.Tailcat, 1, listOf(
            TransportDiagnostics.Tunnel(RequestCategory.Realtime, TransportDiagnostics.Path.Direct, "relay.example.com", 1),
            TransportDiagnostics.Tunnel(RequestCategory.Query, TransportDiagnostics.Path.Relayed, "relay.example.com", 0),
        )),
    ))

    private fun shot(name: String) {
        val file = File("build/outputs/connection-diagnostics/$name.png")
        file.parentFile?.mkdirs()
        file.outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun connectionIsTheFirstStorageCardAndOpensItsOwnPage() {
        var opened = 0
        rule.setHappyContent { DataStorageScreen(0, MediaAutoDownload(), {}, null, {}, onConnection = { opened++ }) }
        assertTrue(rule.node(ConnectionPageTags.ROW).bounds.top < rule.node(DataStorageTags.USAGE).bounds.top)
        rule.node(ConnectionPageTags.ROW).performClick()
        assertEquals(1, opened)
    }

    @Test fun currentFlowsAndPublicPathsCopyAsShown() {
        var copied = ""
        rule.setHappyContent { ConnectionDiagnosticsScreen(sample, "2.0.0 (debug)", { copied = it; true }, {}) }
        rule.onNodeWithText("Direct").performScrollTo().assertExists()
        rule.onNodeWithText("Relayed").performScrollTo().assertExists()
        rule.node(ConnectionPageTags.COPY).performScrollTo().performClick()
        rule.onNodeWithText("Copied").assertExists()
        assertTrue(copied.contains("Open app flows: 1\n"))
        assertTrue(copied.contains("Tailcat tunnels: 2\n"))
        assertTrue(copied.contains("Tunnel 1 path: Direct\n"))
        assertTrue(copied.contains("Tunnel 2 configured relay: relay.example.com\n"))
        assertFalse(copied.contains("closing", ignoreCase = true))
    }

    @Test fun relayAccountsShowRealStatusAndServerWithoutInventedFlowCounts() {
        val state = ConnectionPageState("Offline", "Socket.IO", false, server = "relay.example.com")
        rule.setHappyContent { ConnectionDiagnosticsScreen(state, "2.0.0", { true }, {}) }
        rule.onNodeWithText("Offline").assertExists()
        rule.onNodeWithText("No").assertExists()
        rule.onNodeWithText("relay.example.com").assertExists()
        rule.node(ConnectionPageTags.FLOWS).assertDoesNotExist()
        assertFalse(connectionDiagnosticsText(state, "2.0.0").contains("Open app flows"))
        shot("cli-light")
    }

    @Test fun clipboardRefusalSaysItFailed() {
        rule.setHappyContent { ConnectionDiagnosticsScreen(ConnectionPageState("Offline", "HTTPS", false), "2.0.0", { false }, {}) }
        rule.node(ConnectionPageTags.COPY).performScrollTo().performClick()
        rule.onNodeWithText("Couldn’t copy diagnostics").assertExists()
        rule.onNodeWithText("Copied").assertDoesNotExist()
    }

    @Test fun serverDiagnosticsKeepOnlyHostAndPort() {
        assertEquals("example.com:8443", diagnosticServer("https://person:secret@example.com:8443/private?token=hidden#secret"))
        assertEquals("[::1]", diagnosticServer("https://[::1]/private?token=hidden"))
        assertEquals(null, diagnosticServer("not a URL"))
        val text = connectionDiagnosticsText(ConnectionPageState("Connected", "HTTPS", true, server = diagnosticServer("https://person:secret@example.com/private?token=hidden")), "2.0.0")
        assertTrue(text.contains("Server: example.com\n"))
        for (secret in listOf("person", "secret", "hidden", "private", "token")) assertFalse(text.contains(secret))
    }

    @Test fun darkConnectionUsesNormalSettingsCards() {
        rule.setHappyContent(dark = true) { ConnectionDiagnosticsScreen(sample, "2.0.0", { true }, {}) }
        rule.waitForIdle()
        shot("agent-dark")
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun connectionCardsStayInTheTabletColumn() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { ConnectionDiagnosticsScreen(sample, "2.0.0", { true }, {}) }
        }
        val card = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[0].bounds
        assertTrue(card.width < 800.dp)
        assertEquals(640f, (card.left.value + card.right.value) / 2, 1f)
        shot("agent-tablet-light")
    }
}