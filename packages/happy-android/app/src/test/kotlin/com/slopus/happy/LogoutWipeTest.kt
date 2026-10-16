package com.slopus.happy

import android.content.Context
import coil3.ColorImage
import coil3.memory.MemoryCache
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.AuthState
import com.slopus.happy.config.LocalSettings
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.sync.eventually
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.attachments.attachmentCacheDir
import com.slopus.happy.ui.changelog.ChangelogReadMarker
import com.slopus.happy.ui.components.HappyImageLoader
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.home.NewSessionDraftStore
import com.slopus.happy.ui.home.PrefsReviewStamps
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

/**
 * AuthContext.tsx logout: the beforeLogout hooks run first, while signed
 * in; then the database, this account's preferences (clearPersistence's
 * default MMKV), the picked-image copies and the image caches go; the
 * server choice stays.
 */
@RunWith(AndroidJUnit4::class)
class LogoutWipeTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val server = FakeHappyServer().start()
    private lateinit var graph: AppGraph

    @After
    fun tearDown() = server.close()

    @Test
    fun logoutWipesTheAccountsDataAfterTheHooks() {
        server.addMachine("m1")
        server.addSession("s1", updatedAt = 100)
        server.appendMessage("s1", kotlinx.serialization.json.buildJsonObject { put("role", kotlinx.serialization.json.JsonPrimitive("user")) })
        graph = AppGraph(context, "android/test", server.url, SoftwareKeys(), databaseName = null)
        runBlocking { graph.auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))) }
        eventually(message = "account") { graph.account.value != null }
        runBlocking { graph.account.value!!.syncNow() }
        val account = graph.account.value!!
        runBlocking { account.messages.invalidateAndAwait("s1") }
        graph.store.enqueueOutbox(listOf(OutboxRecord("l1", "s1", OutboxKind.USER, "{}", "c", 1, OutboxState.FAILED, 0, "x", null, null)))
        graph.store.saveComposer("s1", """{"draft":"hi"}""")

        // This account's preferences and files.
        graph.serverConfig.url.value.let { assertTrue(it.isNotEmpty()) }
        graph.localSettings.change { it.copy(devModeEnabled = true) }
        graph.changelog.markViewed("1.0")
        val newSession = HomeServices.of(graph).newSession(context)
        newSession.setInput("draft for a new session")
        PrefsReviewStamps(context.getSharedPreferences(PrefsReviewStamps.PREFS_NAME, Context.MODE_PRIVATE)).declinedAt = 1
        val picked = attachmentCacheDir(context).resolve("picked.jpg").apply { writeText("pixels") }
        // Through the app's one loader: it is process-wide, so an earlier test may have built it on another context.
        val images = HappyImageLoader.get(context)
        images.diskCache!!.openEditor("cached")!!.apply {
            images.diskCache!!.fileSystem.write(data) { writeUtf8("png") }
            images.diskCache!!.fileSystem.write(metadata) { writeUtf8("{}") }
            commit()
        }
        images.memoryCache!![MemoryCache.Key("cached")] = MemoryCache.Value(ColorImage())

        val order = Collections.synchronizedList(mutableListOf<String>())
        graph.beforeLogout { token ->
            // Still signed in, nothing cleared yet.
            assertEquals(server.token, token)
            assertTrue(graph.store.sessions().isNotEmpty())
            order += "hook"
        }
        graph.afterLogoutWipe { order += "wiped:${graph.store.sessions().size}" }

        runBlocking { graph.logout().join() }

        assertEquals(listOf("hook", "wiped:0"), order)
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        assertTrue(graph.store.sessions().isEmpty())
        assertTrue(graph.store.machines().isEmpty())
        assertTrue(graph.store.messages("s1").isEmpty())
        assertTrue(graph.store.outbox().isEmpty())
        assertTrue(graph.store.composers().isEmpty())
        assertNull(graph.store.cursor("sessions"))
        assertFalse(graph.localSettings.values.value.devModeEnabled)
        assertTrue(context.getSharedPreferences(LocalSettings.PREFS_NAME, Context.MODE_PRIVATE).all.isEmpty())
        assertEquals("", graph.changelog.lastViewedTitle.value)
        assertTrue(context.getSharedPreferences(ChangelogReadMarker.PREFS_NAME, Context.MODE_PRIVATE).all.isEmpty())
        assertTrue(context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE).all.isEmpty())
        assertTrue(context.getSharedPreferences(PrefsReviewStamps.PREFS_NAME, Context.MODE_PRIVATE).all.isEmpty())
        assertEquals("", newSession.draft.value.input)
        assertFalse(picked.exists())
        assertNull(images.diskCache!!.openSnapshot("cached"))
        assertNull(images.memoryCache!![MemoryCache.Key("cached")])
        // The server choice is the device's, not the account's.
        assertEquals(server.url, graph.serverConfig.url.value)
    }
}
