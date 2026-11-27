package com.slopus.happy.ui.connect

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.PromptTags
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.PairingError
import com.slopus.happy.analytics.PairingMethod
import com.slopus.happy.analytics.PairingStart
import com.slopus.happy.auth.InvalidPairingKeyException
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The connect flows (useConnectTerminal.ts, useConnectAccount.ts) with a
 * fake scanner: what is approved, what is ignored, and what the person sees.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ConnectFlowTest {
    @get:Rule
    val rule = createComposeRule()

    private val terminalUrl = "happy://terminal?abc"
    private val accountUrl = "happy:///account?CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
    private val recovery = "This code restores a Happy CLI account on the device showing it. On a device already signed in to that account, open Settings → Backup & Restore → Link New Device and scan this code."

    private class FakeScanner : QrScanner {
        val results = ArrayDeque<ScanResult>()
        var scans = 0
        var lastRequest: ScanRequest? = null
        override suspend fun scan(request: ScanRequest): ScanResult {
            scans++
            lastRequest = request
            return results.removeFirst()
        }
    }

    private val scanner = FakeScanner()
    private val notPairing = "This isn’t a pairing code or link. Use the pairing code or link shown on the device you want to connect."
    private val approved = CopyOnWriteArrayList<String>()
    private var failWith: Exception? = null
    private var successes = 0
    private var errors = 0
    private lateinit var flow: ConnectFlow

    private fun setTerminal(withOnError: Boolean = false) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner) {
                flow = rememberTerminalConnect(
                    approve = { url -> failWith?.let { throw it }; approved += url },
                    onSuccess = { successes++ },
                    onError = if (withOnError) ({ errors++ }) else null,
                )
            }
        }
    }

    private fun setAccount() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner) {
                flow = rememberAccountLink(
                    approve = { url -> failWith?.let { throw it }; approved += url },
                    onSuccess = { successes++ },
                    onError = { errors++ },
                )
            }
        }
    }

    @Test
    fun aScannedTerminalCodeIsApprovedQuietly() {
        setTerminal()
        scanner.results += ScanResult.Scanned(terminalUrl)
        rule.runOnIdle { flow.scan() }
        rule.waitUntil { successes == 1 }
        assertEquals(listOf(terminalUrl), approved)
        // Success is felt, not announced.
        rule.onNodeWithText("Success").assertDoesNotExist()
        assertFalse(flow.isLoading)
    }

    @Test
    fun aCancelledScanDoesNothing() {
        setTerminal()
        scanner.results += ScanResult.Cancelled
        rule.runOnIdle { flow.scan() }
        rule.waitForIdle()
        assertEquals(1, scanner.scans)
        assertTrue(approved.isEmpty())
        rule.onNodeWithText("Error").assertDoesNotExist()
    }

    /** Each scan that can't be approved here is an alert, never silence. */
    private fun assertScanSays(scanned: ScanResult, message: String) {
        scanner.results += scanned
        rule.runOnIdle { flow.scan() }
        rule.onNodeWithText(message).assertExists()
        rule.onNodeWithText("OK").performClick()
        rule.onNodeWithText(message).assertDoesNotExist()
        assertTrue(approved.isEmpty())
    }

    @Test
    fun theTerminalScannerSaysWhatEveryOtherCodeIs() {
        setTerminal()
        assertScanSays(ScanResult.Scanned(accountUrl), "This code links a new device. Scan it from Settings › Backup & Restore › Link New Device.")
        assertScanSays(ScanResult.Scanned("https://example.com"), notPairing)
        assertScanSays(ScanResult.Scanned("happy://something?else"), notPairing)
        assertScanSays(ScanResult.Scanned("happy://direct?abc"), "This code connects Happy Agent. Use Add in the account menu on Home.")
        assertScanSays(ScanResult.Failed(ScanFailure.Unavailable), "The QR scanner isn't available on this device. Paste the link instead.")
        assertScanSays(ScanResult.Failed(ScanFailure.NoCamera), "This device has no camera. Paste the link instead.")
        assertScanSays(ScanResult.Failed(ScanFailure.CameraFailed), "The camera couldn't start. Try again, or paste the link instead.")
        assertEquals(0, successes)
    }

    @Test
    fun aPairingCodeGoesToAgentPairingFromAnyScanner() {
        val paired = CopyOnWriteArrayList<String>()
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner, LocalAgentPairing provides { code, _ -> paired += code }) {
                flow = rememberAccountLink(approve = { url -> approved += url })
            }
        }
        scanner.results += ScanResult.Scanned("  happy://direct?eyJ2IjoxfQ \n")
        rule.runOnIdle { flow.scan() }
        rule.waitUntil { paired.isNotEmpty() }
        assertEquals(listOf("happy://direct?eyJ2IjoxfQ"), paired)
        // Pasted, too, even where the prompt asks for a terminal link.
        rule.runOnIdle { flow.connectWithUrl("HAPPY://DIRECT?x") }
        rule.waitUntil { paired.size == 2 }
        assertTrue(approved.isEmpty())
        rule.onNodeWithText("Error").assertDoesNotExist()
    }

    @Test
    fun aPastedLinkWithoutThePrefixGivesPairingGuidance() {
        setTerminal()
        // A Happy code of another kind names the screen it belongs to, as the
        // camera does; a link of no known kind tells the user what to use.
        val elsewhere = "This code links a new device. Scan it from Settings › Backup & Restore › Link New Device."
        rule.runOnIdle { flow.connectWithUrl(accountUrl) }
        rule.onNodeWithText(elsewhere).assertExists()
        rule.onNodeWithText("OK").performClick()
        rule.onNodeWithText(elsewhere).assertDoesNotExist()

        rule.runOnIdle { flow.connectWithUrl("https://example.com/not-happy") }
        rule.onNodeWithText(notPairing).assertExists()
        assertTrue(approved.isEmpty())
        rule.onNodeWithText("OK").performClick()
        rule.onNodeWithText(notPairing).assertDoesNotExist()
    }

    @Test
    fun aFailedApprovalIsAnAlertUnlessTheCallerReportsIt() {
        failWith = IOException("offline")
        setTerminal()
        rule.runOnIdle { flow.connectWithUrl(terminalUrl) }
        rule.onNodeWithText("Failed to connect terminal").assertExists()
        assertEquals(0, successes)
    }

    @Test
    fun aLocalPairingParseFailureRecordsOnceButANetworkErrorDoesNot() {
        setTerminal()
        val events = CopyOnWriteArrayList<AnalyticsEvent>()
        rule.runOnIdle {
            flow.record = { events += it }
            failWith = InvalidPairingKeyException(IllegalArgumentException())
            flow.connectWithUrl("happy://terminal?bad")
        }
        rule.onNodeWithText("Failed to connect terminal").assertExists()
        assertEquals(listOf(AnalyticsEvent.MobilePairingFailed(PairingMethod.Relay, PairingStart.PasteLink, PairingError.InvalidCode)), events.toList())
        rule.onNodeWithText("OK").performClick()
        rule.runOnIdle {
            failWith = IOException("offline")
            scanner.results += ScanResult.Scanned(terminalUrl)
            flow.scan()
        }
        rule.onNodeWithText("Failed to connect terminal").assertExists()
        assertEquals(1, events.size)
    }

    @Test
    fun aCallerWithOnErrorGetsTheFailureInstead() {
        failWith = IOException("offline")
        setTerminal(withOnError = true)
        rule.runOnIdle { flow.connectWithUrl(terminalUrl) }
        rule.waitUntil { errors == 1 }
        rule.onNodeWithText("Failed to connect terminal").assertDoesNotExist()
    }

    @Test
    fun theFlowIsBusyWhileApproving() {
        val gate = CompletableDeferred<Unit>()
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner) {
                flow = rememberTerminalConnect(approve = { gate.await() })
            }
        }
        rule.runOnIdle { flow.connectWithUrl(terminalUrl) }
        rule.waitUntil { flow.isLoading }
        gate.complete(Unit)
        rule.waitUntil { !flow.isLoading }
    }

    @Test
    fun aLinkedDeviceIsAnnouncedAndOnSuccessWaitsForOk() {
        setAccount()
        scanner.results += ScanResult.Scanned(accountUrl)
        rule.runOnIdle { flow.scan() }
        rule.onNodeWithText("Device linked successfully").assertExists()
        assertEquals(listOf(accountUrl), approved)
        assertEquals(0, successes)
        rule.onNodeWithText("OK").performClick()
        rule.runOnIdle { assertEquals(1, successes) }
    }

    @Test
    fun theAccountScannerSaysWhereTerminalCodesGo() {
        setAccount()
        assertScanSays(ScanResult.Scanned(terminalUrl), "This code connects a terminal. Scan it from Settings › Scan QR code to authenticate.")
        assertEquals(0, errors)
    }

    @Test
    fun aFailedLinkIsAnAlertAndOnError() {
        failWith = IOException("offline")
        setAccount()
        rule.runOnIdle { flow.connectWithUrl(accountUrl) }
        rule.onNodeWithText("Failed to link device").assertExists()
        rule.runOnIdle { assertEquals(1, errors) }
    }

    @Test
    fun enterUrlManuallyConnectsWhatWasPasted() {
        var showing by mutableStateOf(true)
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner) {
                flow = rememberTerminalConnect(approve = { url -> approved += url })
                if (showing) EnterTerminalUrlPrompt(flow, onDismiss = { showing = false })
            }
        }
        rule.onNodeWithText("Paste the authentication URL from your terminal").assertExists()
        rule.onNodeWithTag(PromptTags.INPUT).performTextInput("  $terminalUrl ")
        rule.onNodeWithText("Authenticate").performClick()
        rule.waitUntil { approved.isNotEmpty() }
        assertEquals(listOf(terminalUrl), approved)
        assertFalse(showing)
    }

    private val paired = CopyOnWriteArrayList<String>()
    private val ways = CopyOnWriteArrayList<String>()

    private fun setStart() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner, LocalAgentPairing provides { code, _ -> paired += code }) {
                flow = rememberAddConnect(
                    approve = { url -> failWith?.let { throw it }; approved += url },
                    onRestore = { ways += "restore" },
                    onServer = { ways += "server" },
                    serverLabel = "happy.example.com",
                )
            }
        }
    }

    /** Add's scanner offers the other ways in under its ⋮ (iOS's AccountAdding.otherWays), and each goes where it says. */
    @Test
    fun addsScannerOffersTheOtherWaysIn() {
        setStart()
        scanner.results += ScanResult.Chose(ScannerWay.Restore)
        rule.runOnIdle { flow.scan() }
        rule.waitUntil { ways.isNotEmpty() }
        assertEquals(
            ScanRequest(listOf(ScannerWay.EnterLink, ScannerWay.Restore, ScannerWay.Server, ScannerWay.Help), "happy.example.com"),
            scanner.lastRequest,
        )
        scanner.results += ScanResult.Chose(ScannerWay.Server)
        rule.runOnIdle { flow.scan() }
        rule.waitUntil { ways.size == 2 }
        assertEquals(listOf("restore", "server"), ways)

        scanner.results += ScanResult.Chose(ScannerWay.EnterLink)
        rule.runOnIdle { flow.scan() }
        rule.onNodeWithText("Paste the link from Happy CLI on your computer or from Happy Agent.").assertExists()
    }

    /** Other flows' scanners have no ⋮. */
    @Test
    fun aTerminalScanOffersNoOtherWays() {
        setTerminal()
        scanner.results += ScanResult.Cancelled
        rule.runOnIdle { flow.scan() }
        rule.waitUntil { scanner.scans == 1 }
        assertEquals(ScanRequest(), scanner.lastRequest)
    }

    /** The first screen: a terminal code is approved (by a new account), a pairing code pairs, the rest say what they are. */
    @Test
    fun theFirstScreenRoutesEveryCode() {
        setStart()
        scanner.results += ScanResult.Scanned(terminalUrl)
        rule.runOnIdle { flow.scan() }
        rule.waitUntil { approved.isNotEmpty() }
        assertEquals(listOf(terminalUrl), approved)
        rule.onNodeWithText("Error").assertDoesNotExist()

        scanner.results += ScanResult.Scanned("happy://direct?abc")
        rule.runOnIdle { flow.scan() }
        rule.waitUntil { paired.isNotEmpty() }
        assertEquals(listOf("happy://direct?abc"), paired)

        approved.clear()
        assertScanSays(ScanResult.Scanned(accountUrl), recovery)
        assertScanSays(ScanResult.Scanned("happy://something?else"), notPairing)
        assertScanSays(ScanResult.Scanned("https://example.com"), notPairing)
    }

    /** "Enter link manually" routes a pasted link as Connect routes a scanned code. */
    @Test
    fun theFirstScreenRoutesPastedLinks() {
        setStart()
        rule.runOnIdle { flow.connectWithUrl(" $terminalUrl ") }
        rule.waitUntil { approved.isNotEmpty() }
        assertEquals(listOf(terminalUrl), approved)
        rule.runOnIdle { flow.connectWithUrl("happy://direct?xyz") }
        rule.waitUntil { paired.isNotEmpty() }
        rule.runOnIdle { flow.connectWithUrl(accountUrl) }
        rule.onNodeWithText(recovery).assertExists()
        // iOS's title, not "Error" (Strings.Scan.deviceNeedsAccountTitle).
        rule.onNodeWithText("No account to share").assertExists()
        rule.onNodeWithText("OK").performClick()
        rule.runOnIdle { flow.connectWithUrl("hello") }
        rule.onNodeWithText(notPairing).assertExists()
        rule.onNodeWithText("OK").performClick()
        assertEquals(listOf(terminalUrl), approved)
    }

    @Test
    fun aFailedApprovalOnTheFirstScreenIsAnAlert() {
        failWith = IOException("offline")
        setStart()
        rule.runOnIdle { flow.connectWithUrl(terminalUrl) }
        rule.onNodeWithText("Failed to connect terminal").assertExists()
        assertFalse(flow.isLoading)
    }

    @Test
    fun codesAreClassifiedByKind() {
        assertEquals(HappyCode.Terminal(terminalUrl), HappyCode.classify(" $terminalUrl "))
        assertEquals(HappyCode.Account(accountUrl), HappyCode.classify(accountUrl))
        assertEquals(HappyCode.AgentPairing("happy://direct?abc"), HappyCode.classify("happy://direct?abc"))
        // Malformed pairing codes stay pairing codes; they never fall back to relay approval.
        assertEquals(HappyCode.AgentPairing("happy://direct"), HappyCode.classify("happy://direct"))
        assertEquals(HappyCode.AgentPairing("Happy://Direct?%%"), HappyCode.classify("Happy://Direct?%%"))
        assertEquals(HappyCode.UnknownHappy("happy://directory?x"), HappyCode.classify("happy://directory?x"))
        assertEquals(HappyCode.UnknownHappy("happy://session/1"), HappyCode.classify("happy://session/1"))
        assertEquals(HappyCode.NotHappy("hello"), HappyCode.classify("hello"))
    }
}
