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
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    private val accountUrl = "happy:///account?abc"

    private class FakeScanner : QrScanner {
        val results = ArrayDeque<ScanResult>()
        var scans = 0
        override suspend fun scan(): ScanResult {
            scans++
            return results.removeFirst()
        }
    }

    private val scanner = FakeScanner()
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
    fun otherCodesCancelsAndFailedScansDoNothing() {
        setTerminal()
        scanner.results += listOf(
            ScanResult.Scanned(accountUrl),
            ScanResult.Scanned("https://example.com"),
            ScanResult.Cancelled,
            ScanResult.Failed("Google Play services are not available"),
        )
        repeat(4) {
            rule.runOnIdle { flow.scan() }
            rule.waitForIdle()
        }
        assertEquals(4, scanner.scans)
        assertTrue(approved.isEmpty())
        assertEquals(0, successes)
        rule.onNodeWithText("Error").assertDoesNotExist()
    }

    @Test
    fun aPastedLinkWithoutThePrefixIsInvalid() {
        setTerminal()
        rule.runOnIdle { flow.connectWithUrl(accountUrl) }
        rule.onNodeWithText("Invalid authentication URL").assertExists()
        assertTrue(approved.isEmpty())
        rule.onNodeWithText("OK").performClick()
        rule.onNodeWithText("Invalid authentication URL").assertDoesNotExist()
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
    fun theAccountScannerIgnoresTerminalCodes() {
        setAccount()
        scanner.results += ScanResult.Scanned(terminalUrl)
        rule.runOnIdle { flow.scan() }
        rule.waitForIdle()
        assertTrue(approved.isEmpty())
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

    @Test
    fun acceptScanKeepsOnlyCodesWithThePrefix() {
        assertEquals(terminalUrl, acceptScan(ScanResult.Scanned(terminalUrl), "happy://terminal?"))
        assertNull(acceptScan(ScanResult.Scanned(accountUrl), "happy://terminal?"))
        assertNull(acceptScan(ScanResult.Cancelled, "happy://terminal?"))
        assertNull(acceptScan(ScanResult.Failed("x"), "happy://terminal?"))
    }
}
