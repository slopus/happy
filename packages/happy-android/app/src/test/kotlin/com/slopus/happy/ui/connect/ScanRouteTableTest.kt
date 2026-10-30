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
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Every kind of code against every way in, as one table. A code either is
 * approved here, pairs an agent, or says exactly where it belongs; nothing
 * is ever ignored. The ways in differ only by [ConnectKind]:
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

        /** It was refused, with exactly this message. */
        data class Says(val message: String) : Lands
    }

    private val terminal = "happy://terminal?abc"
    private val account = "happy:///account?abc"
    private val pairing = "happy://direct?eyJ2IjoxfQ"
    private val unknownHappy = "happy://something?else"
    private val notHappy = "https://example.com"

    private val notHappyHere = "This QR code isn't a Happy code."
    private val terminalElsewhere = "This code connects a terminal. Scan it from Settings › Scan QR code to authenticate."
    private val accountElsewhere = "This code links a new device. Scan it from Settings › Account › Link New Device."
    private val accountNeedsPhone = "This code adds a phone to an account. Scan it with a phone that's signed in."
    private val invalidUrl = "Invalid authentication URL"

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
        Triple(ConnectKind.Add, unknownHappy, Lands.Says(notHappyHere)),
        Triple(ConnectKind.Add, notHappy, Lands.Says(notHappyHere)),

        // Settings > Scan QR code: this account authenticates a terminal.
        Triple(ConnectKind.Terminal, terminal, Lands.Approved(terminal)),
        Triple(ConnectKind.Terminal, pairing, Lands.Pairs(pairing)),
        Triple(ConnectKind.Terminal, account, Lands.Says(accountElsewhere)),
        Triple(ConnectKind.Terminal, unknownHappy, Lands.Says(notHappyHere)),
        Triple(ConnectKind.Terminal, notHappy, Lands.Says(notHappyHere)),

        // Settings > Account > Link New Device: this account takes another phone.
        Triple(ConnectKind.Account, account, Lands.Approved(account)),
        Triple(ConnectKind.Account, pairing, Lands.Pairs(pairing)),
        Triple(ConnectKind.Account, terminal, Lands.Says(terminalElsewhere)),
        Triple(ConnectKind.Account, unknownHappy, Lands.Says(notHappyHere)),
        Triple(ConnectKind.Account, notHappy, Lands.Says(notHappyHere)),
    )

    private val approved = CopyOnWriteArrayList<String>()
    private val paired = CopyOnWriteArrayList<String>()
    private var kind by mutableStateOf(ConnectKind.Add)
    private var code by mutableStateOf("")

    /** Bumped per row, so each lands on a flow of its own. */
    private var row by mutableStateOf(0)
    private lateinit var flow: ConnectFlow

    private val scanner = QrScanner { ScanResult.Scanned(code) }

    /** One composition for the whole table: the rule takes content once. */
    private fun start() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner, LocalAgentPairing provides { paired += it }) {
                key(row) {
                    val approve: suspend (String) -> Unit = { url -> approved += url }
                    flow = when (kind) {
                        ConnectKind.Add -> rememberAddConnect(approve = approve)
                        ConnectKind.Terminal -> rememberTerminalConnect(approve = approve)
                        ConnectKind.Account -> rememberAccountLink(approve = approve)
                    }
                }
            }
        }
    }

    /** Takes [code] at [kind]'s way in, scanned or pasted, and says where it landed. */
    private fun land(kind: ConnectKind, code: String, paste: Boolean): Lands {
        approved.clear()
        paired.clear()
        rule.runOnIdle {
            this.kind = kind
            this.code = code
            row++
        }
        rule.waitForIdle()
        rule.runOnIdle { if (paste) flow.connectWithUrl(code) else flow.scan() }
        rule.waitForIdle()

        approved.firstOrNull()?.let { return Lands.Approved(it) }
        paired.firstOrNull()?.let { return Lands.Pairs(it) }
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
     * scanner, rather than being called invalid. The one difference is a
     * link of no kind this app knows, which says "Invalid authentication
     * URL" instead of talking about a QR code that nobody scanned.
     */
    @Test
    fun aPastedLinkGoesWhereTheScannedOneGoes() {
        start()
        val wrong = table.mapNotNull { (kind, code, scanned) ->
            val expected = if (scanned == Lands.Says(notHappyHere)) Lands.Says(invalidUrl) else scanned
            val actual = land(kind, code, paste = true)
            if (actual == expected) null else "$kind pasting $code: expected $expected, got $actual"
        }
        assertEquals(emptyList<String>(), wrong)
    }
}
