package com.slopus.happy.fixture

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.AgentAttention
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.Settings
import com.slopus.happy.model.settings.LocalSettingsValues
import com.slopus.happy.ui.home.HomeListModel
import com.slopus.happy.ui.home.HomeSnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.lang.ref.WeakReference

/** ART ownership check using synthetic metadata only; never opens or changes an account on the phone. */
@RunWith(AndroidJUnit4::class)
class AccountSwitchRetentionDeviceTest {
    @Test fun switchingAwayReleasesMetadataWhileTheHomeModelStaysAlive() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val snapshots = MutableStateFlow<HomeSnapshot?>(null)
            val settings = MutableStateFlow(Settings.Defaults)
            val model = HomeListModel(
                snapshots, settings, MutableStateFlow(LocalSettingsValues.Defaults),
                MutableStateFlow(emptySet()), MutableStateFlow(emptySet()), scope,
            )
            repeat(3) {
                val metadata = loadHappyHome(snapshots)
                withTimeout(10_000) { while (model.state.value == null) delay(20) }
                assertTrue(metadata.get() != null)

                // HomeServices emits this when the Happy account closes, before another home loads.
                snapshots.value = null
                withTimeout(10_000) { while (model.state.value != null) delay(20) }
                settings.value = settings.value.copy(hideInactiveSessions = !settings.value.hideInactiveSessions)
                // GC is asynchronous on ART. Keep the owner running throughout the bounded retries.
                withTimeout(10_000) {
                    while (metadata.get() != null) {
                        Runtime.getRuntime().gc()
                        delay(50)
                    }
                }
                assertNull(model.state.value)
                android.util.Log.i("AccountSwitchRetention", "cycle=${it + 1} metadataCollected=true maxHeap=${Runtime.getRuntime().maxMemory()}")
            }
        } finally { scope.cancel() }
    }

    private fun loadHappyHome(snapshots: MutableStateFlow<HomeSnapshot?>): WeakReference<SessionMetadata> {
        val raw = buildJsonObject {
            put("path", "/synthetic/repo"); put("host", "synthetic")
            put("extra", JsonArray(List(4_096) { index -> buildJsonObject { put("text", "x".repeat(512) + index) } }))
        }
        val metadata = checkNotNull(SessionMetadata.parse(raw))
        val session = Session(
            id = "synthetic", seq = 0, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
            projectId = null, metadata = metadata, metadataVersion = 1,
            attention = AgentAttention.None, agentStateVersion = 0,
        )
        snapshots.value = HomeSnapshot(listOf(session), emptyList())
        return WeakReference(metadata)
    }
}