package com.slopus.happy.calendar

import com.slopus.happy.agent.AgentClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

class CalendarFeedTest {
    private val first = CalendarRange("team", 1, 2, "UTC")
    private val next = CalendarRange("team", 2, 3, "UTC")
    private fun answer(cursor: String) = AgentClient.json.parseToJsonElement("""{"events":[],"occurrences":[],"truncated":false,"cursor":"$cursor"}""") as JsonObject

    @Test fun anOfflineRangeOpensOnItsOwnKeptPage() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val feed = CalendarFeed(scope, fetch = { throw IOException("offline") }, kept = { if (it == first.key) answer("kept") else null })
            feed.show(first).join()
            feed.resume().join()
            val state = withTimeout(10_000) { feed.state.first { it.error != null } }
            assertEquals("kept", state.page?.cursor)
            assertEquals(CalendarFeed.Status.Ready, state.status)
            assertNotNull(state.error)
        } finally { scope.cancel() }
    }

    @Test fun anEventDuringAnOlderReadCannotPublishTheOldOccurrences() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val started = CompletableDeferred<Unit>()
        val old = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        try {
            val feed = CalendarFeed(scope, fetch = {
                if (calls.incrementAndGet() == 1) withContext(NonCancellable) {
                    started.complete(Unit)
                    old.await()
                    finished.complete(Unit)
                    answer("old")
                } else answer("new")
            })
            feed.show(first).join()
            feed.resume().join()
            withTimeout(10_000) { started.await() }
            feed.invalidate("team").join()
            withTimeout(10_000) { feed.state.first { it.page?.cursor == "new" } }
            old.complete(Unit)
            withTimeout(10_000) { finished.await() }
            feed.pause().join()
            assertEquals("new", feed.state.value.page?.cursor)
        } finally { old.complete(Unit); scope.cancel() }
    }

    @Test fun anotherMonthNeverShowsThePreviousRangesLateAnswer() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val started = CompletableDeferred<Unit>()
        val old = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<Unit>()
        try {
            val feed = CalendarFeed(scope, fetch = { range ->
                if (range == first) withContext(NonCancellable) {
                    started.complete(Unit)
                    old.await()
                    finished.complete(Unit)
                    answer("first")
                } else answer("next")
            })
            feed.show(first).join()
            feed.resume().join()
            withTimeout(10_000) { started.await() }
            feed.show(next).join()
            withTimeout(10_000) { feed.state.first { it.page?.cursor == "next" } }
            old.complete(Unit)
            withTimeout(10_000) { finished.await() }
            feed.pause().join()
            assertEquals(next, feed.state.value.range)
            assertEquals("next", feed.state.value.page?.cursor)
        } finally { old.complete(Unit); scope.cancel() }
    }

    @Test fun hiddenCalendarsStayQuietAndABurstRereadsOnce() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = AtomicInteger()
        try {
            val feed = CalendarFeed(scope, fetch = { answer(calls.incrementAndGet().toString()) })
            feed.show(first).join()
            feed.resume().join()
            withTimeout(10_000) { feed.state.first { it.page?.cursor == "1" } }
            List(10) { feed.invalidate("team") }.joinAll()
            withTimeout(10_000) { feed.state.first { it.page?.cursor == "2" } }
            feed.pause().join()
            feed.invalidate("team").join()
            feed.show(next).join()
            assertEquals(2, calls.get())
            feed.resume().join()
            withTimeout(10_000) { feed.state.first { it.page?.cursor == "3" } }
            assertEquals(next, feed.state.value.range)
        } finally { scope.cancel() }
    }
}