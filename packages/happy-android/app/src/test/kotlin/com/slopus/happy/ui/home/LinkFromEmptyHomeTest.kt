package com.slopus.happy.ui.home

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.TERMINAL_URL_PREFIX
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.Sodium
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.crypto.decryptBox
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.PromptTags
import com.slopus.happy.ui.connect.LocalQrScanner
import com.slopus.happy.ui.connect.QrScanner
import com.slopus.happy.ui.connect.ScanResult
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The empty home's link state against the in-memory server: its Scan QR code
 * approves the terminal with the account already signed in (no second
 * account, unlike the signed-out Add), and with no scanner it asks for the
 * link; cancelling that leaves home as it was.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LinkFromEmptyHomeTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var server: FakeHappyServer
    private lateinit var graph: AppGraph
    private var scan: ScanResult = ScanResult.Cancelled

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = server.url,
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        val scanner = QrScanner { scan }
        rule.setContent { CompositionLocalProvider(LocalQrScanner provides scanner) { HappyApp(graph) } }
        runBlocking { graph.auth.createAccount() }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.LINK), 5_000)
    }

    @After
    fun tearDown() = server.close()

    @Test
    fun scanApprovesTheTerminalWithThisAccount() {
        val account = graph.auth.state.value as AuthState.SignedIn
        val terminal = Sodium.boxKeypair()
        server.addTerminalRequest(terminal.publicKey, supportsV2 = false)
        scan = ScanResult.Scanned(TERMINAL_URL_PREFIX + encodeBase64(terminal.publicKey, Base64Variant.Url))

        rule.onNodeWithText("Scan QR code").performClick()

        val key = encodeBase64(terminal.publicKey)
        rule.waitUntil(5_000) { synchronized(server) { server.terminalRequests.getValue(key).response != null } }
        val response = synchronized(server) { server.terminalRequests.getValue(key).response!! }
        assertArrayEquals(account.credentials.secretBytes(), decryptBox(decodeBase64(response), terminal.secretKey))
        assertEquals(1, graph.accountStore.registry.value.entries.size)
        rule.onNodeWithTag(HomeTags.SETTINGS).assertExists()
    }

    @Test
    fun withoutAScannerItAsksForTheLinkAndCancelKeepsHome() {
        scan = ScanResult.Failed("no camera")
        rule.onNodeWithText("Scan QR code").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(PromptTags.INPUT), 5_000)
        rule.onNodeWithTag(PromptTags.CANCEL).performClick()
        rule.waitForIdle()
        rule.onNodeWithTag(PromptTags.INPUT).assertDoesNotExist()
        rule.onNodeWithTag(HomeTags.LINK).assertExists()
        rule.onNodeWithTag(HomeTags.SETTINGS).assertExists()
        rule.onNodeWithTag(AccountMenuTags.BUTTON).assertExists()
    }
}
