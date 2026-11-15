package com.slopus.happy.connection

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger

class IdleFlowsTest {
    internal class Flow : HttpFlow {
        val input = LinkedBlockingQueue<ByteArray>()
        val writes = mutableListOf<Long>()
        val reads = AtomicInteger()
        @Volatile var closed = false
        @Volatile var aborted = false
        var failWrite = false
        var eofAfterAnswer = false
        var answer = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
        override fun read(maximumBytes: Int, timeoutMillis: Long): ByteArray {
            reads.incrementAndGet()
            return input.take()
        }
        override fun write(bytes: ByteArray, timeoutMillis: Long) {
            writes += timeoutMillis
            if (failWrite) throw IOException("stale")
            input.put(answer.toByteArray())
            if (eofAfterAnswer) input.put(ByteArray(0))
        }
        override fun close() { closed = true; input.offer(ByteArray(0)) }
        override fun abort() { aborted = true; close() }
    }
    private suspend fun until(condition: () -> Boolean) = withTimeout(2_000) { while (!condition()) delay(1) }

    @Test fun warmKeepsTwoAndRealExchangesReuseThem() = runBlocking {
        val pool = IdleFlows()
        val opened = mutableListOf<Flow>()
        pool.warm(2) { Flow().also { synchronized(opened) { opened += it } } }
        assertEquals(2, pool.count)
        repeat(2) {
            assertEquals("{}", exchangeHttp(pool, "GET", byteArrayOf(1), null, 35_000) { error("must reuse") }.text)
        }
        assertEquals(2, opened.size)
        assertEquals(2, opened.sumOf { it.writes.size })
        assertTrue(opened.flatMap { it.writes }.all { it == 5_000L })
        pool.shut()
        assertTrue(opened.all { it.closed })
    }

    @Test fun newestFourExpireOnPeerDataEofOrTimeout() = runBlocking {
        val pool = IdleFlows(100)
        val flows = List(5) { Flow().also { pool.put(it, pool.epoch) } }
        assertTrue(flows.first().closed)
        assertEquals(4, pool.count)
        flows[1].input.put(byteArrayOf(7))
        flows[2].input.put(ByteArray(0))
        until { flows[1].closed && flows[2].closed }
        until { pool.count == 0 }
        assertTrue(flows.all { it.closed })
        pool.shut()
    }

    @Test fun dropAndShutRejectInflightReturns() = runBlocking {
        val pool = IdleFlows()
        val epoch = pool.epoch
        val first = Flow()
        pool.put(first, epoch)
        val taken = pool.take()!!
        pool.drop()
        pool.put(taken, epoch)
        assertTrue(first.closed)
        assertEquals(0, pool.count)
        pool.shut()
        val late = Flow()
        pool.put(late, pool.epoch)
        assertTrue(late.closed)
    }

    @Test fun staleKeptGetRetriesFreshOnceButPostAndPartialAnswersNeverRetry() = runBlocking {
        val pool = IdleFlows()
        val stale = Flow().apply { failWrite = true }
        pool.put(stale, pool.epoch)
        var opens = 0
        val fresh = Flow()
        exchangeHttp(pool, "GET", byteArrayOf(1), null, 35_000) { opens++; fresh }
        assertEquals(1, opens)
        assertTrue(stale.aborted)
        assertEquals(listOf(35_000L), fresh.writes)
        pool.drop()
        for ((method, flow) in listOf("POST" to Flow().apply { failWrite = true }, "GET" to Flow().apply { answer = "bad"; eofAfterAnswer = true })) {
            pool.put(flow, pool.epoch)
            try {
                exchangeHttp(pool, method, byteArrayOf(1), null, 35_000) { error("must not retry") }
                fail("expected failure")
            } catch (_: IOException) {} catch (_: AgentConnectionException) {}
            assertTrue(flow.aborted)
        }
        pool.shut()
    }

    @Test fun cancellationMidBodyAbortsAndNeverParks() = runBlocking {
        val pool = IdleFlows()
        val flow = Flow().apply { answer = "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\na" }
        val job = launch { exchangeHttp(pool, "GET", byteArrayOf(1), null, 35_000) { flow } }
        until { flow.reads.get() >= 2 }
        job.cancelAndJoin()
        assertTrue(flow.aborted)
        assertEquals(0, pool.count)
        pool.shut()
    }
}