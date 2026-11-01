package com.slopus.happy.connection

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
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
            // As the app makes it: the endpoint over the per-category clients.
            val again = AgentEndpointTransport(AgentEndpoint(credentials) { }) { agentTransport(it.address, it.port, it.publicUrl, it.tailcatAvailable != false) }
            try {
                val agent = AgentIdentity.refresh(again, credentials.deviceToken, fallbackName = link.name)
                out.appendText("connected name=${agent.name} protocol=${agent.protocol} daemon=${agent.daemonVersion}\n")
                // The event stream stays open while a query and a file go,
                // and while the query clients are let go and made again.
                val events = again.stream("/v0/events/stream", credentials.deviceToken)
                val first = events.read()?.decodeToString().orEmpty()
                out.appendText("realtime status=${events.status} first=${first.lineSequence().firstOrNull { it.startsWith("event:") }}\n")
                val bots = again.request("GET", "/v0/bots", credentials.deviceToken)
                val avatar = again.request("GET", "/v0/node/avatar", credentials.deviceToken, headers = mapOf("Accept" to "image/*"), category = RequestCategory.File)
                out.appendText("query status=${bots.status} file status=${avatar.status} bytes=${avatar.body.size}\n")
                again.reset(RequestCategory.Query)
                val health = again.request("GET", "/v0/health", credentials.deviceToken)
                val next = withTimeoutOrNull(5_000) { events.read() ?: ByteArray(0) }
                val realtime = when { next == null -> "open, quiet"; next.isEmpty() -> "ended"; else -> "open, more" }
                out.appendText("after query reset: query status=${health.status} realtime $realtime\n")
                events.close()
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
