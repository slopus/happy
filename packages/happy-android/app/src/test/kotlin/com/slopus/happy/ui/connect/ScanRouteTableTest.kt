package com.slopus.happy.ui.connect

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.PairingError
import com.slopus.happy.analytics.PairingMethod
import com.slopus.happy.analytics.PairingStart
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.connection.LocalServerSignIn
import com.slopus.happy.ui.setHappyContent
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Every kind of code against every way in, as one table. A code either is
 * approved here, pairs an agent, signs in to a team server, or says exactly
 * where it belongs; nothing is ever ignored. The ways in differ only by [ConnectKind]:
 *
 * - [ConnectKind.Add] is the first screen's Start and the account menu's
 *   Add: the same flow (`LocalAddFlow`), signed out or in.
 * - [ConnectKind.Terminal] is Settings > Scan QR code, signed in.
 * - [ConnectKind.Account] is Settings > Account > Link New Device, signed in.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ScanRouteTableTest {
    @get:Rule
    val rule = createComposeRule()

    /** Where a code ends up. */
    private sealed interface Lands {
        /** This flow approved it itself, with the URL it passed on. */
        data class Approved(val url: String) : Lands

        /** It went to agent pairing, with the code it passed on. */
        data class Pairs(val code: String) : Lands

        /** It went to team server sign-in, for this base URL. */
        data class SignsIn(val url: String) : Lands

        /** It was refused, with exactly this message. */
        data class Says(val message: String) : Lands
    }

    // Fixture public keys only; this table never generates a QR or uses a secret.
    private val terminal = "happy://terminal?CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
    private val account = "happy:///account?CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
    private val pairing = "happy://direct?eyJ2IjoxfQ"
    private val unknownHappy = "happy://something?else"
    private val notHappy = "https://example.com"
    private val webPairing = "https://app.happy.engineering/terminal/connect#key=abc"
    private val server = "happy://k3x9q2m7p0a4b8c1d5e6f7g2/server?url=https%3A%2F%2Fhappy.acme.example%2F"
    private val serverAtPath = "happy://k3x9q2m7p0a4b8c1d5e6f7g2/server?url=https%3A%2F%2Facme.example%2Fhappy%2F"
    private val serverMalformed = "happy://k3x9q2m7p0a4b8c1d5e6f7g2/server?url=http%3A%2F%2Fhappy.acme.example%2F"
    private val servers = setOf(server, serverAtPath, serverMalformed)

    private val notPairing = "This isn’t a pairing code or link. Use the pairing code or link shown on the device you want to connect."
    private val downloadLink = "This is a download link, not a pairing code. If you’re setting up Happy Desktop, click ‘Downloaded and opened’ on your computer, then scan the pairing code it shows."
    private val terminalElsewhere = "This code connects a terminal. Scan it from Settings › Scan QR code to authenticate."
    private val accountElsewhere = "This code links a new device. Scan it from Settings › Backup & Restore › Link New Device."
    private val accountNeedsPhone = "This code restores a Happy CLI account on the device showing it. On a device already signed in to that account, open Settings → Backup & Restore → Link New Device and scan this code."
    private val invalidUrl = "Invalid authentication URL"
    private val serverInvalid = "This server code can't be used. Scan the code from Happy on your computer again."
    private val serverPathUnsupported = "This server is set up under a web address path, which Happy on Android can't connect to yet."
    private val serverScanOnly = "A server code works only when you scan it. Scan the code from Happy on your computer."

    /**
     * The table, read as: taken at this way in, this code lands here. Each
     * row is something a person can feel, so they are written out rather
     * than derived from the code under test.
     */
    private val table: List<Triple<ConnectKind, String, Lands>> = listOf(
        // Add: the only way in that makes an account. A terminal code creates
        // it and approves that terminal in one step; a pairing code pairs.
        Triple(ConnectKind.Add, terminal, Lands.Approved(terminal)),
        Triple(ConnectKind.Add, pairing, Lands.Pairs(pairing)),
        Triple(ConnectKind.Add, account, Lands.Says(accountNeedsPhone)),
        Triple(ConnectKind.Add, unknownHappy, Lands.Says(notPairing)),
        Triple(ConnectKind.Add, notHappy, Lands.Says(notPairing)),
        Triple(ConnectKind.Add, webPairing, Lands.Says(notPairing)),
        Triple(ConnectKind.Add, "happy:///account?bad", Lands.Says(invalidUrl)),
        Triple(ConnectKind.Add, server, Lands.SignsIn("https://happy.acme.example/")),
        Triple(ConnectKind.Add, serverAtPath, Lands.Says(serverPathUnsupported)),
        Triple(ConnectKind.Add, serverMalformed, Lands.Says(serverInvalid)),

        // Settings > Scan QR code: this account authenticates a terminal.
        Triple(ConnectKind.Terminal, terminal, Lands.Approved(terminal)),
        Triple(ConnectKind.Terminal, pairing, Lands.Pairs(pairing)),
        Triple(ConnectKind.Terminal, account, Lands.Says(accountElsewhere)),
        Triple(ConnectKind.Terminal, unknownHappy, Lands.Says(notPairing)),
        Triple(ConnectKind.Terminal, notHappy, Lands.Says(notPairing)),
        Triple(ConnectKind.Terminal, server, Lands.SignsIn("https://happy.acme.example/")),
        Triple(ConnectKind.Terminal, serverAtPath, Lands.Says(serverPathUnsupported)),
        Triple(ConnectKind.Terminal, serverMalformed, Lands.Says(serverInvalid)),

        // Settings > Account > Link New Device: this account takes another phone.
        Triple(ConnectKind.Account, account, Lands.Approved(account)),
        Triple(ConnectKind.Account, pairing, Lands.Pairs(pairing)),
        Triple(ConnectKind.Account, terminal, Lands.Says(terminalElsewhere)),
        Triple(ConnectKind.Account, unknownHappy, Lands.Says(notPairing)),
        Triple(ConnectKind.Account, notHappy, Lands.Says(notPairing)),
        Triple(ConnectKind.Account, server, Lands.SignsIn("https://happy.acme.example/")),
        Triple(ConnectKind.Account, serverAtPath, Lands.Says(serverPathUnsupported)),
        Triple(ConnectKind.Account, serverMalformed, Lands.Says(serverInvalid)),
    )

    private val approved = CopyOnWriteArrayList<String>()
    private val paired = CopyOnWriteArrayList<String>()
    private val signedIn = CopyOnWriteArrayList<String>()
    private val recorded = CopyOnWriteArrayList<AnalyticsEvent>()
    private var kind by mutableStateOf(ConnectKind.Add)
    private var code by mutableStateOf("")

    /** Bumped per row, so each lands on a flow of its own. */
    private var row by mutableStateOf(0)
    private lateinit var flow: ConnectFlow

    private val scanner = QrScanner { ScanResult.Scanned(code) }

    /** One composition for the whole table: the rule takes content once. */
    private fun start() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner, LocalAgentPairing provides { code, _ -> paired += code }, LocalServerSignIn provides { invite -> invite.origin != null && signedIn.add(invite.url) }) {
                key(row) {
                    val approve: suspend (String) -> Unit = { url -> approved += url }
                    flow = when (kind) {
                        ConnectKind.Add -> rememberAddConnect(approve = approve)
                        ConnectKind.Terminal -> rememberTerminalConnect(approve = approve)
                        ConnectKind.Account -> rememberAccountLink(approve = approve)
                    }
                    flow.record = { recorded += it }
                }
            }
        }
    }

    /** Takes [code] at [kind]'s way in, scanned or pasted, and says where it landed. */
    private fun land(kind: ConnectKind, code: String, paste: Boolean, hasRelayAccount: Boolean = false): Lands {
        approved.clear()
        paired.clear()
        signedIn.clear()
        recorded.clear()
        rule.runOnIdle {
            this.kind = kind
            this.code = code
            row++
        }
        rule.waitForIdle()
        rule.runOnIdle {
            flow.hasRelayAccount = { hasRelayAccount }
            if (paste) flow.connectWithUrl(code) else flow.scan()
        }
        rule.waitForIdle()

        approved.firstOrNull()?.let { return Lands.Approved(it) }
        paired.firstOrNull()?.let { return Lands.Pairs(it) }
        signedIn.firstOrNull()?.let { return Lands.SignsIn(it) }
        val said = flow.alert?.message ?: error("$kind + $code: nothing happened, and nothing was said")
        rule.onNodeWithText(said).assertExists()
        rule.onNodeWithText("OK").performClick()
        return Lands.Says(said)
    }

    @Test
    fun everyCodeAtEveryWayIn() {
        start()
        val wrong = table.mapNotNull { (kind, code, expected) ->
            val actual = land(kind, code, paste = false)
            if (actual == expected) null else "$kind scanning $code: expected $expected, got $actual"
        }
        assertEquals(emptyList<String>(), wrong)
    }

    /**
     * A pasted link lands where the same code read by the camera lands: a
     * terminal link typed into Link New Device names Settings' terminal
     * scanner, rather than being called invalid. Team server codes are
     * still taken only from the camera.
     */
    @Test
    fun aPastedLinkGoesWhereTheScannedOneGoes() {
        start()
        val wrong = table.mapNotNull { (kind, code, scanned) ->
            val expected = when {
                code in servers -> Lands.Says(serverScanOnly)
                else -> scanned
            }
            val actual = land(kind, code, paste = true)
            if (actual == expected) null else "$kind pasting $code: expected $expected, got $actual"
        }
        assertEquals(emptyList<String>(), wrong)
    }

    @Test
    fun rejectedLinksAreExplainedWithoutStartingPairing() {
        start()
        val cases = listOf(
            "https://link.happy.engineering/download" to downloadLink,
            "https://link.happy.engineering/download/" to notPairing,
            "https://link.happy.engineering/download?source=example" to notPairing,
            "https://happy.engineering/#download" to notPairing,
            "https://apps.apple.com/us/app/happy/id6748571505" to notPairing,
            "https://testflight.apple.com/join/Example1" to notPairing,
            "https://play.google.com/store/apps/details?id=com.ex3ndr.happy" to notPairing,
            "https://happy.engineering/docs/" to notPairing,
            "https://app.happy.engineering/" to notPairing,
            "https://link.happy.engineering.example.com/download" to notPairing,
            "https://happy.engineering@not-happy.example/download" to notPairing,
            "https://apps.apple.com/account/subscriptions" to notPairing,
            "plain text" to notPairing,
        )
        for ((code, message) in cases) {
            for (paste in listOf(false, true)) {
                assertEquals("$code pasted=$paste", Lands.Says(message), land(ConnectKind.Add, code, paste))
                assertPairingFailure(paste, PairingError.InvalidCode)
            }
        }
    }

    private fun assertPairingFailure(paste: Boolean, reason: PairingError) {
        assertEquals(listOf(AnalyticsEvent.MobilePairingFailed(PairingMethod.Relay, if (paste) PairingStart.PasteLink else PairingStart.Scan, reason)), recorded.toList())
    }

    @Test
    fun onlyLocalRelayRejectionsRecordRelayFailures() {
        start()
        for (paste in listOf(false, true)) {
            assertEquals(Lands.Says(accountNeedsPhone), land(ConnectKind.Add, account, paste))
            assertPairingFailure(paste, PairingError.SignInRequired)
            assertEquals(Lands.Says(accountElsewhere), land(ConnectKind.Add, account, paste, hasRelayAccount = true))
            assertPairingFailure(paste, PairingError.Rejected)
            assertEquals(Lands.Says(invalidUrl), land(ConnectKind.Add, "happy:///account?bad", paste))
            assertPairingFailure(paste, PairingError.InvalidCode)
            assertEquals(Lands.Says(terminalElsewhere), land(ConnectKind.Account, terminal, paste))
            assertPairingFailure(paste, PairingError.Rejected)
            assertEquals(Lands.Approved(account), land(ConnectKind.Account, account, paste))
            assertEquals(emptyList<AnalyticsEvent>(), recorded.toList())
            assertEquals(Lands.Pairs(pairing), land(ConnectKind.Add, pairing, paste))
            assertEquals(emptyList<AnalyticsEvent>(), recorded.toList())
            assertEquals(Lands.Says(if (paste) serverScanOnly else serverInvalid), land(ConnectKind.Add, serverMalformed, paste))
            assertEquals(emptyList<AnalyticsEvent>(), recorded.toList())
        }
    }
}
