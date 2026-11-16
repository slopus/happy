package com.slopus.happy.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream

/** A daemon gzips a large JSON answer when asked (happy-agent jsonResponseBody.ts); the parser decodes it. */
class HttpGzipTest {
    private fun gzip(bytes: ByteArray): ByteArray = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(bytes) } }.toByteArray()

    private fun sized(coding: String?, body: ByteArray): ByteArray =
        ("HTTP/1.1 200 OK\r\n" + (coding?.let { "Content-Encoding: $it\r\n" } ?: "") + "Content-Length: ${body.size}\r\n\r\n").toByteArray() + body

    private fun reason(block: () -> Unit): AgentConnectionException.Reason? = try {
        block(); null
    } catch (e: AgentConnectionException) {
        e.reason
    }

    private val json = "{\"tasks\":[" + (1..2000).joinToString(",") { "{\"id\":$it}" } + "]}"

    @Test fun gzipAndXGzipBodiesAreDecodedAsIfSentPlain() {
        for (coding in listOf("gzip", "x-gzip", " GZip ")) {
            val response = HttpResponseParser().append(sized(coding, gzip(json.toByteArray())), eof = false)!!
            assertEquals(json, response.text)
            assertFalse("content-encoding" in response.headers)
            assertEquals(json.length.toString(), response.headers["content-length"])
        }
    }

    @Test fun identityAndAbsentAreUnchanged() {
        val identity = HttpResponseParser().append(sized("identity", json.toByteArray()), eof = false)!!
        assertEquals(json, identity.text)
        assertEquals("identity", identity.headers["content-encoding"])
        assertEquals(json, HttpResponseParser().append(sized(null, json.toByteArray()), eof = false)!!.text)
    }

    @Test fun chunkedGzipIsDecodedAfterItsFramingAcrossAnyBoundaries() {
        val packed = gzip(json.toByteArray())
        val chunks = packed.toList().chunked(100).joinToString("") { "${it.size.toString(16)}\r\n" + String(it.toByteArray(), Charsets.ISO_8859_1) + "\r\n" }
        val whole = ("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n").toByteArray() +
            (chunks + "0\r\n\r\n").toByteArray(Charsets.ISO_8859_1)
        for (split in listOf(10, 80, whole.size / 2, whole.size - 3)) {
            val parser = HttpResponseParser()
            assertEquals(null, parser.append(whole.copyOf(split), eof = false))
            val response = parser.append(whole.copyOfRange(split, whole.size), eof = false)!!
            assertEquals(json, response.text)
            assertFalse("content-encoding" in response.headers)
            assertFalse("content-length" in response.headers)
            assertTrue(parser.reusable)
        }
    }

    @Test fun closeDelimitedGzipIsDecoded() {
        val whole = "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n".toByteArray() + gzip(json.toByteArray())
        assertEquals(json, HttpResponseParser().append(whole, eof = true)!!.text)
    }

    @Test fun truncatedCorruptOrUnaskedCodingsFail() {
        val invalid = AgentConnectionException.Reason.InvalidResponse
        val packed = gzip(json.toByteArray())
        assertEquals(invalid, reason { HttpResponseParser().append(sized("gzip", packed.copyOf(packed.size - 10)), eof = false) })
        assertEquals(invalid, reason { HttpResponseParser().append(sized("gzip", packed.copyOf().also { it[it.size - 6] = (it[it.size - 6] + 1).toByte() }), eof = false) })
        assertEquals(invalid, reason { HttpResponseParser().append(sized("gzip", json.toByteArray()), eof = false) })
        assertEquals(invalid, reason { HttpResponseParser().append(sized("gzip", ByteArray(0)), eof = false) })
        assertEquals(invalid, reason { HttpResponseParser().append(sized("br", json.toByteArray()), eof = false) })
        assertEquals(invalid, reason { HttpResponseParser().append(sized("deflate", json.toByteArray()), eof = false) })
    }

    @Test fun theDecodedBodyIsBounded() {
        val bomb = gzip(ByteArray(8 * 1024 * 1024 + 1))
        assertTrue(bomb.size < 65536)
        assertEquals(AgentConnectionException.Reason.InvalidResponse, reason { HttpResponseParser().append(sized("gzip", bomb), eof = false) })
        val limit = ByteArray(8 * 1024 * 1024) { 'a'.code.toByte() }
        assertEquals(limit.size, HttpResponseParser().append(sized("gzip", gzip(limit)), eof = false)!!.body.size)
    }

    @Test fun requestsAskForGzipUnlessTheCallerChose() {
        fun head(headers: Map<String, String>, gzip: Boolean) = TailcatHttp.requestHead("GET", "/v0/x", 1, "t", null, headers, gzip = gzip).decodeToString()
        assertTrue(head(emptyMap(), gzip = true).contains("\r\nAccept-Encoding: gzip\r\n"))
        val chosen = head(mapOf("accept-encoding" to "identity"), gzip = true)
        assertFalse(chosen.contains("Accept-Encoding: gzip"))
        assertTrue(chosen.contains("\r\naccept-encoding: identity\r\n"))
        assertFalse(head(emptyMap(), gzip = false).contains("Accept-Encoding", ignoreCase = true))
    }
}
