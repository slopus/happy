package com.slopus.happy.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpReuseTest {
    @Test fun exactLengthAndChunkedFramesAreReusableAcrossEveryBoundary() {
        for (body in listOf("Content-Length: 2\r\n\r\n{}", "Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n", "Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\nX-End: yes\r\n\r\n")) {
            val bytes = "HTTP/1.1 200 OK\r\n$body".toByteArray()
            for (split in bytes.indices) {
                val parser = HttpResponseParser()
                assertEquals(null, parser.append(bytes.copyOf(split), false))
                assertFalse(parser.reusable)
                assertEquals("{}", parser.append(bytes.copyOfRange(split, bytes.size), false)!!.text)
                assertTrue(parser.reusable)
            }
        }
    }

    @Test fun closeOldVersionEofAndExtraBytesAreNeverReusable() {
        for (response in listOf(
            "HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nConnection: keep-alive, CLOSE\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}extra",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\nextra",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\nX: y\r\n\r\nextra",
            "HTTP/1.1 204 No Content\r\n\r\nextra",
        )) {
            val parser = HttpResponseParser()
            parser.append(response.toByteArray(), true)!!
            assertFalse(response, parser.reusable)
        }
        for (status in listOf(204, 304)) {
            val parser = HttpResponseParser()
            parser.append("HTTP/1.1 $status Empty\r\n\r\n".toByteArray(), false)!!
            assertTrue(parser.reusable)
        }
    }
}