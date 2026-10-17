package io.elevenlabs

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.elevenlabs.audio.AudioManager
import io.elevenlabs.audio.NoOpAudioManager
import io.elevenlabs.models.ConversationStatus
import io.elevenlabs.models.DisconnectionDetails
import io.elevenlabs.network.BaseConnection
import io.elevenlabs.network.ConnectionState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Regressions for the local 0.12.2 patch: teardown must finish even when its caller is cancelled. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [36])
class ConversationLifecycleTest {
    private class Fixture {
        val calls = mutableListOf<String>()
        var connect: suspend () -> Unit = {}
        var release: suspend () -> Unit = {}
        var failRecording = false
        var failStopRecording = false
        val connection = object : BaseConnection() {
            override val connectionState = ConnectionState.IDLE
            override suspend fun connect(serverUrl: String, config: ConversationConfig) { calls += "connect"; this@Fixture.connect() }
            override fun disconnect(details: DisconnectionDetails?) { calls += "disconnect" }
            override suspend fun close() { calls += "release-start"; release(); calls += "released" }
            override fun sendMessage(message: Any) {}
            override fun setOnMessageListener(listener: (String) -> Unit) {}
            override fun setOnConnectionStateListener(listener: (ConnectionState) -> Unit) {}
        }
        val audio = object : AudioManager by NoOpAudioManager() {
            override suspend fun startRecording() { calls += "record"; if (failRecording) error("mic failed") }
            override suspend fun startPlayback() { calls += "play" }
            override suspend fun stopRecording() { calls += "stop-record"; if (failStopRecording) error("mic stop failed") }
            override suspend fun stopPlayback() { calls += "stop-play" }
            override fun cleanup() { calls += "audio-cleanup" }
        }
        val session = ConversationSessionImpl(
            ApplicationProvider.getApplicationContext<Context>(),
            ConversationConfig(conversationToken = "jwt"),
            connection = connection, audioManager = audio, toolRegistry = ClientToolRegistry(),
        )
    }

    @Test fun endAwaitsReleaseAndConcurrentEndRunsCleanupOnlyOnce() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val f = Fixture(); f.session.start()
            val gate = CompletableDeferred<Unit>()
            f.release = { gate.await() }
            val end = async { f.session.endSession() }; runCurrent()
            val second = async { f.session.endSession() }; runCurrent()
            assertFalse(end.isCompleted); assertFalse(second.isCompleted)
            assertEquals(ConversationStatus.DISCONNECTING, f.session.status.value)
            assertFalse(f.calls.contains("audio-cleanup"))
            gate.complete(Unit); end.await(); second.await()
            assertEquals(listOf("connect", "record", "play", "stop-record", "stop-play", "release-start", "released", "audio-cleanup"), f.calls)
            assertEquals(ConversationStatus.DISCONNECTED, f.session.status.value)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun cancelledStartWaitsForReleaseAndPreservesCancellation() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val f = Fixture()
            val connecting = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            f.connect = { connecting.await() }; f.release = { release.await() }
            val start = launch { f.session.start() }; runCurrent()
            start.cancel(); runCurrent()
            assertFalse(start.isCompleted)
            assertTrue(f.calls.contains("release-start")); assertFalse(f.calls.contains("released"))
            release.complete(Unit); start.join()
            assertTrue(start.isCancelled)
            assertEquals(listOf("connect", "stop-record", "stop-play", "release-start", "released", "audio-cleanup"), f.calls)
            f.session.endSession()
            assertEquals(1, f.calls.count { it == "released" })
        } finally { Dispatchers.resetMain() }
    }

    @Test fun failedMicrophoneStartStillReleasesRoomAndCleansAudio() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val f = Fixture(); f.failRecording = true; f.failStopRecording = true
            try { f.session.start(); fail("start must fail") } catch (_: RuntimeException) {}
            assertEquals(listOf("connect", "record", "stop-record", "stop-play", "release-start", "released", "audio-cleanup"), f.calls)
            assertEquals(ConversationStatus.ERROR, f.session.status.value)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun cancellationDuringEndCannotSkipRemainingCleanup() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val f = Fixture(); f.session.start()
            val gate = CompletableDeferred<Unit>(); f.release = { gate.await() }
            val end = launch { f.session.endSession() }; runCurrent()
            end.cancel(); runCurrent(); assertFalse(end.isCompleted)
            gate.complete(Unit); end.join()
            assertTrue(end.isCancelled)
            assertTrue(f.calls.indexOf("released") < f.calls.indexOf("audio-cleanup"))
            assertEquals(ConversationStatus.DISCONNECTED, f.session.status.value)
        } finally { Dispatchers.resetMain() }
    }
}