package com.slopus.happy.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class OpenFlowsTest {
    @Test fun closingOrResettingOneOwnerNeverRemovesAnotherOwnersFlows() {
        val registry = OpenFlows()
        val first = registry.owner()
        val second = registry.owner()
        val closes = AtomicInteger()
        val stream = first.opened { closes.incrementAndGet() }
        second.opened { closes.incrementAndGet() }
        assertEquals(1, first.count)
        assertEquals(1, second.count)
        stream.close()
        stream.close()
        first.close()
        assertEquals(1, closes.get())
        assertEquals(0, first.count)
        assertEquals(1, second.count)
        registry.close()
        registry.close()
        assertEquals(2, closes.get())
        assertEquals(0, second.count)
    }

    @Test fun aLateOpenedStreamIsClosedWhenItsOwnerWasResetOrTheTransportEnded() {
        val registry = OpenFlows()
        val first = registry.owner()
        val second = registry.owner()
        val closes = AtomicInteger()
        first.close()
        assertThrows(AgentConnectionException::class.java) { first.opened { closes.incrementAndGet() } }
        registry.close()
        assertThrows(AgentConnectionException::class.java) { second.opened { closes.incrementAndGet() } }
        assertThrows(AgentConnectionException::class.java) { registry.owner() }
        assertEquals(2, closes.get())
        assertEquals(0, first.count)
        assertEquals(0, second.count)
    }

    @Test fun concurrentDuplicateClosesReleaseEachFlowExactlyOnce() {
        val registry = OpenFlows()
        val owner = registry.owner()
        val closes = AtomicInteger()
        val streams = List(100) { owner.opened { closes.incrementAndGet() } }
        val workers = Executors.newFixedThreadPool(4)
        try {
            streams.forEach { stream -> repeat(3) { workers.submit { stream.close() } } }
            workers.submit { registry.close() }
        } finally {
            workers.shutdown()
            check(workers.awaitTermination(5, TimeUnit.SECONDS))
        }
        assertEquals(100, closes.get())
        assertEquals(0, owner.count)
    }
}