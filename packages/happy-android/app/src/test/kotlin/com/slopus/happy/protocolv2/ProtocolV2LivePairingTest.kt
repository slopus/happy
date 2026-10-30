package com.slopus.happy.protocolv2

import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Pairs with a real Happy Agent over Tailcat. Skipped unless
 * `HAPPY_PROTOCOL_V2_LINK` holds a fresh `happy://direct?…` code (run with
 * `--tests '*LivePairing*' --rerun`). The phone's emoji go to
 * `HAPPY_PROTOCOL_V2_OUT` as they are known, so whoever confirms on the
 * computer can compare them; the result follows once paired. Never logs
 * the address or the tokens.
 */
class ProtocolV2LivePairingTest {
    @Test
    fun pairsAndReadsTheComputer() = runBlocking {
        val text = System.getenv("HAPPY_PROTOCOL_V2_LINK")
        assumeTrue("no live pairing link", !text.isNullOrBlank())
        val out = File(System.getenv("HAPPY_PROTOCOL_V2_OUT") ?: "build/protocol-v2-live.txt")
        val link = ProtocolV2PairingLink.parse(text!!)
        val transport = TailcatProtocolV2Transport(link.address, link.port)
        try {
            val pairing = ProtocolV2PairingService(link, transport)
            val emoji = pairing.start("Happy Android (JVM interop test)")
            out.writeText("emoji ${emoji.joinToString(" ")}\n")
            val credentials = pairing.confirm()
            out.appendText("paired deviceId=${credentials.deviceId}\n")
            // The device token on a fresh tunnel, as the app reconnects later.
            transport.close()
            val again = TailcatProtocolV2Transport(credentials.address, credentials.port)
            try {
                val computer = ProtocolV2Identity.refresh(again, credentials.deviceToken, fallbackName = link.name)
                out.appendText("connected name=${computer.name} protocol=${computer.protocol} daemon=${computer.daemonVersion}\n")
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
