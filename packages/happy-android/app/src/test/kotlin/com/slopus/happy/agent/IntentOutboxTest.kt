package com.slopus.happy.agent

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/** iOS's IntentOutboxTests: kept, one per slot, sent oldest first while up, backed off, refused for good. */
class IntentOutboxTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clock = AtomicLong(1_000)
    private val sent = CopyOnWriteArrayList<String>()

    @After
    fun tearDown() = scope.cancel()

    private fun outbox(storage: IntentStorage = MemoryIntentStorage()) = IntentOutbox(scope, storage, now = clock::get)

    private suspend fun <T> eventually(read: suspend () -> T, check: (T) -> Boolean) {
        withTimeout(5_000) { while (!check(read())) delay(10) }
    }

    @Test
    fun aLaterIntentReplacesOneWaitingInItsSlotAndUnarchiveSharesArchives(): Unit = runBlocking {
        val box = outbox()
        val first = box.enqueue(Intent.RENAME, "t1", buildJsonObject { put("title", "One") })
        box.enqueue(Intent.RENAME, "t2", buildJsonObject { put("title", "Other") })
        box.enqueue(Intent.RENAME, "t1", buildJsonObject { put("title", "Two") })
        assertEquals(listOf("t2", "t1"), box.pending.value.map { it.target })
        assertEquals(mapOf("t1" to "Two", "t2" to "Other"), IntentOverlay.of(box.pending.value).titles)
        assertEquals("the replaced one is done with", IntentOutbox.Verdict.Taken, box.verdict(first.id))
        box.enqueue(Intent.ARCHIVE, "t1")
        box.enqueue(Intent.UNARCHIVE, "t1")
        assertEquals(listOf(Intent.UNARCHIVE), box.pending.value.filter { it.target == "t1" && it.kind != Intent.RENAME }.map { it.kind })
    }

    @Test
    fun nothingGoesWhileOfflineThenAllGoOldestFirst(): Unit = runBlocking {
        val box = outbox()
        box.handle(setOf(Intent.READ, Intent.ARCHIVE)) { sent += "${it.kind} ${it.target}" }
        box.enqueue(Intent.READ, "a")
        clock.addAndGet(5)
        box.enqueue(Intent.ARCHIVE, "b")
        delay(100)
        assertEquals(emptyList<String>(), sent.toList())
        box.setOnline(true)
        eventually({ box.pending.value }) { it.isEmpty() }
        assertEquals(listOf("read a", "archive b"), sent.toList())
    }

    @Test
    fun aKindNothingHandlesWaitsForItsDeliverer(): Unit = runBlocking {
        val box = outbox()
        box.setOnline(true)
        box.handle(setOf(Intent.READ)) { sent += it.kind }
        box.enqueue("todo.text", "todo1", buildJsonObject { put("text", "milk") })
        box.enqueue(Intent.READ, "a")
        eventually({ sent.toList() }) { it == listOf(Intent.READ) }
        assertEquals(listOf("todo.text"), box.pending.value.map { it.kind })
        // Another library plugs its kinds in later; what waited goes.
        box.handle(setOf("todo.text")) { sent += it.kind }
        eventually({ box.pending.value }) { it.isEmpty() }
        assertEquals(listOf(Intent.READ, "todo.text"), sent.toList())
    }

    @Test
    fun aFailureWaitsOneTwoFourUpToThirtySecondsAndLetsTheRestGo(): Unit = runBlocking {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), (1..7).map(IntentOutbox::backoff))
        val box = outbox()
        val failing = java.util.concurrent.atomic.AtomicBoolean(true)
        box.handle(setOf(Intent.READ)) {
            if (failing.get() && it.target == "a") error("unreachable")
            sent += it.target
        }
        box.setOnline(true)
        val a = box.enqueue(Intent.READ, "a")
        eventually({ box.pending.value.firstOrNull { it.id == a.id }?.attempts }) { it == 1 }
        assertEquals(clock.get() + 1_000, box.pending.value.single { it.id == a.id }.nextAttemptAt)
        box.enqueue(Intent.READ, "b")
        eventually({ sent.toList() }) { it == listOf("b") }
        // Due again only once its wait is over.
        failing.set(false)
        clock.addAndGet(1_000)
        box.kick()
        eventually({ box.pending.value }) { it.isEmpty() }
        assertEquals(listOf("b", "a"), sent.toList())
    }

    @Test
    fun aRefusalDropsTheIntentAndSaysWhy(): Unit = runBlocking {
        val box = outbox()
        box.handle(setOf(Intent.ARCHIVE)) { throw IntentRefusal("Only the owner can archive this task.") }
        val rejections = CopyOnWriteArrayList<IntentOutbox.Rejection>()
        scope.launch { box.rejections.collect { rejections += it } }
        delay(50)
        val intent = box.enqueue(Intent.ARCHIVE, "t1")
        assertEquals(setOf("t1"), IntentOverlay.of(box.pending.value).removed)
        // A person waiting on it hears the reason; the notice is told it was heard.
        assertEquals(IntentOutbox.Verdict.Refused("Only the owner can archive this task."), box.attempt(intent.id))
        assertEquals(emptyList<Intent>(), box.pending.value)
        eventually({ rejections.toList() }) { it.size == 1 }
        assertTrue(rejections.single().heard)
    }

    @Test
    fun aBackgroundRefusalBeforeTheCallerWaitsKeepsItsVerdict(): Unit = runBlocking {
        val box = outbox()
        box.handle(setOf(Intent.ARCHIVE)) { throw IntentRefusal("No") }
        val intent = box.enqueue(Intent.ARCHIVE, "task")
        box.setOnline(true)
        eventually({ box.pending.value }) { it.isEmpty() }

        assertEquals(IntentOutbox.Verdict.Refused("No"), box.attempt(intent.id))
        assertEquals(IntentOutbox.Verdict.Refused("No"), box.verdict(intent.id))
    }

    @Test
    fun completedVerdictsAreBoundedAndDoNotReplaceTheNextIntentsAnswer(): Unit = runBlocking {
        val box = outbox()
        box.handle(setOf(Intent.ARCHIVE)) { throw IntentRefusal(it.target) }
        val first = box.enqueue(Intent.ARCHIVE, "first")
        assertEquals(IntentOutbox.Verdict.Refused("first"), box.attempt(first.id))
        repeat(IntentOutbox.COMPLETED_LIMIT) { index ->
            val intent = box.enqueue(Intent.ARCHIVE, "task$index")
            assertEquals(IntentOutbox.Verdict.Refused("task$index"), box.attempt(intent.id))
        }
        assertEquals(IntentOutbox.Verdict.Taken, box.verdict(first.id))
    }

    @Test
    fun whatIsKeptOnTheDiskComesBackAfterARelaunch(): Unit = runBlocking {
        val file = File(Files.createTempDirectory("intents").toFile(), "c1.intents.json")
        val before = outbox(FileIntentStorage(file))
        before.enqueue(Intent.READ, "a")
        before.enqueue(Intent.LEAVE, "s1", buildJsonObject { put("kind", "surface") })
        assertTrue(file.exists())
        val after = outbox(FileIntentStorage(file))
        eventually({ after.pending.value.map { it.kind to it.target } }) { it == listOf(Intent.READ to "a", Intent.LEAVE to "s1") }
        assertEquals("surface", after.pending.value.last().of)
        after.handle(setOf(Intent.READ, Intent.LEAVE)) { sent += it.target }
        after.setOnline(true)
        eventually({ after.pending.value }) { it.isEmpty() }
        assertTrue("nothing left to keep", !file.exists())
    }
}
