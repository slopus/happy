package com.slopus.happy.connection

import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Pairs with a real Happy Agent over Tailcat. Skipped unless
 * `HAPPY_PAIRING_LINK` holds a fresh `happy://direct?…` code (run with
 * `--tests '*LivePairing*' --rerun`). The phone's emoji go to
 * `HAPPY_PAIRING_OUT` as they are known, so whoever confirms on the
 * agent can compare them; the result follows once paired. Never logs
 * the address or the tokens.
 */
class LivePairingTest {
    @Test
    fun pairsAndReadsTheAgent() = runBlocking {
        val text = System.getenv("HAPPY_PAIRING_LINK")
        assumeTrue("no live pairing link", !text.isNullOrBlank())
        val out = File(System.getenv("HAPPY_PAIRING_OUT") ?: "build/pairing-live.txt")
        val link = PairingLink.parse(text!!)
        val transport = TailcatTransport(link.address, link.port)
        try {
            val pairing = PairingService(link, transport)
            val emoji = pairing.start("Happy Android (JVM interop test)")
            out.writeText("emoji ${emoji.joinToString(" ")}\n")
            val credentials = pairing.confirm()
            out.appendText("paired deviceId=${credentials.deviceId}\n")
            // The device token on a fresh tunnel, as the app reconnects later.
            transport.close()
            val again = TailcatTransport(credentials.address, credentials.port)
            try {
                val agent = AgentIdentity.refresh(again, credentials.deviceToken, fallbackName = link.name)
                out.appendText("connected name=${agent.name} protocol=${agent.protocol} daemon=${agent.daemonVersion}\n")
            } finally {
                again.close()
            }
        } catch (e: Throwable) {
            out.appendText("failed ${e::class.simpleName}: ${e.message}\n")
            throw e
        } finally {
            transport.close()
        }
    }
}
