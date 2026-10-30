package com.slopus.happy.ui

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.TERMINAL_URL_PREFIX
import com.slopus.happy.crypto.AccountLink
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.Sodium
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.crypto.decryptBox
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.components.PromptTags
import com.slopus.happy.ui.connect.DeepLink
import com.slopus.happy.ui.connect.DeepLinks
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.onboarding.RestoreTags
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Restore by QR, the first screen's terminal link and connecting a terminal by link, the whole app against the in-memory server. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OnboardingFlowTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var server: FakeHappyServer
    private lateinit var graph: AppGraph

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
        rule.setContent { HappyApp(graph) }
    }

    @After
    fun tearDown() {
        DeepLinks.pending.value?.let(DeepLinks::consume)
        server.close()
    }

    @Test
    fun restoreByScanningTheCodeFromTheOtherPhone() {
        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("Restore Legacy Account").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(RestoreTags.QR_CODE), 5_000)

        // The code carries the key the request was registered with.
        val publicKey = synchronized(server) { server.accountRequests.keys.single() }
        rule.onNode(hasTestTag(RestoreTags.QR_CODE), useUnmergedTree = true)
            .assertContentDescriptionEquals(AccountLink.linkUrl(decodeBase64(publicKey)))

        // The other phone approves.
        server.approveAccountRequest(decodeBase64(publicKey), AccountLink.sealSecret(server.secret, decodeBase64(publicKey)))

        // The account has no computer, so home shows its link state (the filter only shows while loading).
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.LINK), 10_000)
        val signedIn = graph.auth.state.value as AuthState.SignedIn
        assertArrayEquals(server.secret, signedIn.credentials.secretBytes())
        assertEquals(server.token, signedIn.credentials.token)
        // No challenge sign-in: the token came with the approval.
        assertEquals(0, server.authenticatedKeys.size)
    }

    /**
     * restore/index.tsx stays mounted under restore/manual: an approval made
     * while "Use secret key" is open still signs in, with the request the
     * code was showing, and no second request is registered.
     */
    @Test
    fun anApprovalWhileTheSecretKeyScreenIsOpenStillSignsIn() {
        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("Restore Legacy Account").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(RestoreTags.QR_CODE), 5_000)
        val publicKey = synchronized(server) { server.accountRequests.keys.single() }

        rule.onNode(hasTestTag(RestoreTags.USE_KEY), useUnmergedTree = true).performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(RestoreTags.KEY_INPUT), 5_000)
        server.approveAccountRequest(decodeBase64(publicKey), AccountLink.sealSecret(server.secret, decodeBase64(publicKey)))

        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.LINK), 10_000)
        val signedIn = graph.auth.state.value as AuthState.SignedIn
        assertArrayEquals(server.secret, signedIn.credentials.secretBytes())
        assertEquals(setOf(publicKey), synchronized(server) { server.accountRequests.keys.toSet() })
    }

    /** The first screen: a terminal link creates an account and approves the terminal with it, in one step. */
    @Test
    fun aTerminalLinkOnTheFirstScreenCreatesAnAccountThatApprovesIt() {
        val terminal = Sodium.boxKeypair()
        server.addTerminalRequest(terminal.publicKey, supportsV2 = false)
        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("Enter link manually").performClick()
        rule.onNodeWithTag(PromptTags.INPUT).performTextInput(TERMINAL_URL_PREFIX + encodeBase64(terminal.publicKey, Base64Variant.Url))
        rule.onNodeWithTag(PromptTags.CONFIRM).performClick()

        val key = encodeBase64(terminal.publicKey)
        rule.waitUntil(5_000) { synchronized(server) { server.terminalRequests.getValue(key).response != null } }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.LINK), 5_000)
        val account = graph.auth.state.value as AuthState.SignedIn
        val response = synchronized(server) { server.terminalRequests.getValue(key).response!! }
        assertArrayEquals(account.credentials.secretBytes(), decryptBox(decodeBase64(response), terminal.secretKey))
    }

    /** A terminal link that can't be approved keeps no account: the first screen stays, with the error. */
    @Test
    fun aFailedTerminalApprovalOnTheFirstScreenKeepsNoAccount() {
        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("Enter link manually").performClick()
        rule.onNodeWithTag(PromptTags.INPUT).performTextInput("happy://terminal?abc")
        rule.onNodeWithTag(PromptTags.CONFIRM).performClick()
        rule.waitUntilAtLeastOneExists(hasText("Failed to connect terminal"), 5_000)
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        assertTrue(graph.accountStore.registry.value.entries.isEmpty())
        rule.onNodeWithText("Start").assertExists()
    }

    @Test
    fun aTerminalLinkOpensTheConfirmScreenAndAcceptConnectsIt() {
        // The first screen makes no empty account; make one directly, as a terminal code would.
        runBlocking { graph.auth.createAccount() }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.LINK), 5_000)
        val account = graph.auth.state.value as AuthState.SignedIn

        val terminal = Sodium.boxKeypair()
        server.addTerminalRequest(terminal.publicKey, supportsV2 = false)
        DeepLinks.offer(DeepLink.Terminal(encodeBase64(terminal.publicKey, Base64Variant.Url)))

        rule.waitUntilAtLeastOneExists(hasText("Accept Connection"), 5_000)
        rule.onNodeWithText("Accept Connection").performClick()
        // The button reads "Connecting" at once, so wait for the answer itself.
        val key = encodeBase64(terminal.publicKey)
        rule.waitUntil(5_000) { synchronized(server) { server.terminalRequests.getValue(key).response != null } }
        val response = synchronized(server) { server.terminalRequests.getValue(key).response!! }
        assertArrayEquals(account.credentials.secretBytes(), decryptBox(decodeBase64(response), terminal.secretKey))
        assertNull(DeepLinks.pending.value)
    }

    @Test
    fun aTerminalLinkWhileSignedOutIsDropped() {
        DeepLinks.offer(DeepLink.Terminal("abc"))
        rule.waitForIdle()
        assertNull(DeepLinks.pending.value)
        rule.onNodeWithText("Start").assertExists()
        rule.onNodeWithText("Accept Connection").assertDoesNotExist()
    }
}
