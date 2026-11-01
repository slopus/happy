package com.slopus.happy

import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.data.DiskThread
import com.slopus.happy.sync.eventually
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import org.junit.runner.RunWith

/**
 * What runs before the first frame (research/cold-start.md). Every content
 * provider in the merged manifest, and every androidx.startup initializer,
 * is created on the main thread in bindApplication, before the activity
 * exists. A library that adds one fails here, so whoever adds it
 * decides whether it belongs there or should start lazily (a
 * `tools:node="remove"` on its provider or initializer and a call where it
 * is first needed).
 */
@RunWith(AndroidJUnit4::class)
class ColdStartTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun onlyTheseProvidersStartWithTheProcess() {
        val providers = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS)
            .providers.orEmpty().map { it.name }.sorted()
        assertEquals(
            listOf(
                // Hands out conversation media; created at start, does nothing until asked.
                "androidx.core.content.FileProvider",
                // androidx.startup: the initializers below.
                "androidx.startup.InitializationProvider",
            ),
            providers,
        )
    }

    @Test
    fun firebaseDoesNotStartWithTheProcess() {
        // FirebaseInitProvider cost ~3 ms on the Fold (8 ms debuggable) before the first frame. Push starts
        // Firebase itself (push/FirebaseStart.kt): registration after the first frame, the messaging service for a push.
        val providers = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS)
            .providers.orEmpty().map { it.name }
        assertEquals(false, "com.google.firebase.provider.FirebaseInitProvider" in providers)
    }

    @Test
    fun onlyTheseInitializersStartWithTheProcess() {
        val startup = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS or PackageManager.GET_META_DATA)
            .providers.orEmpty().single { it.name == "androidx.startup.InitializationProvider" }
        val initializers = startup.metaData.keySet().filter { startup.metaData.getString(it) == "androidx.startup" }.sorted()
        assertEquals(
            listOf(
                // Configures EmojiCompat (0.14 ms on the Fold); its font loads on its own thread after the first frame.
                // Text composed before it is configured would never get its emoji, so it stays.
                "androidx.emoji2.text.EmojiCompatInitializer",
                // lifecycle-process refuses to start lazily, and RevenueCat watches the process's lifecycle.
                "androidx.lifecycle.ProcessLifecycleInitializer",
                // OkHttp's Android platform (its context, for the public suffix list), 0.24 ms.
                "okhttp3.internal.platform.PlatformInitializer",
                // Not ProfileInstallerInitializer: MainActivity writes the Baseline Profile after the start.
            ),
            initializers,
        )
    }

    @Test
    fun theApplicationBuildsNothingOnTheMainThread() {
        val app = ApplicationProvider.getApplicationContext<HappyApplication>()
        // The graph (account registry, Keystore credentials, preferences) waits for its own thread,
        // which MainActivity starts; onCreate never touches it.
        val graph = HappyApplication::class.java.getDeclaredField("graph\$delegate").apply { isAccessible = true }.get(app) as Lazy<*>
        val ready = HappyApplication::class.java.getDeclaredField("graphReady\$delegate").apply { isAccessible = true }.get(app) as Lazy<*>
        assertEquals(false, graph.isInitialized())
        assertEquals(false, ready.isInitialized())
    }

    @Test
    fun theOpenHomeIsReadBeforeHomeAsksForIt() {
        val agent = "agent-connection-cold"
        val keys = SoftwareKeys()
        for (name in listOf(AccountStore.PREFS_NAME, AgentConnections.REGISTRY_PREFS, AgentConnections.SECRETS_PREFS)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
        // An agent connection, open, with its home kept on disk: what a cold start finds.
        ExpoSecureStore(context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE), keys, keychainService = AgentConnections.KEYCHAIN_SERVICE)
            .setItem(agent, Json.encodeToString(AgentConnectionCredentials.serializer(), AgentConnectionCredentials("127.0.0.1", 9, "dv1", "token")))
        context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", """[{"id":"$agent","name":"Studio","addedAt":1}]""").commit()
        context.getSharedPreferences(AccountStore.PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString("registry", """{"entries":[],"activeId":"$agent"}""").commit()
        val bootstrap = Wire.bootstrap(bots = listOf(Wire.bot("b1", "Chief of Staff", Wire.agent("a1"))), cursor = "c1")
        val kept = AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))
        File(context.noBackupFilesDir, "agent-connections").apply { mkdirs() }.resolve("$agent.json")
            .writeText(AgentClient.json.encodeToString(AgentCatalog.serializer(), kept))

        val graph = AppGraph(context, "android/test", "http://127.0.0.1:9", keys, databaseName = null)
        assertEquals(OpenAccount.Agent(agent), graph.openAccount.value)
        DiskThread.strict = true
        try {
            // Called on the main thread here: it only starts the read.
            graph.warmHome()
            val session = checkNotNull(graph.agentSessions.session(agent))
            // Nothing composed home, and its rows are in.
            eventually(message = "the kept home read") { session.feed.value.loaded }
            assertTrue(session.feed.value.conversations.any { it.title == "Chief of Staff" })
        } finally {
            DiskThread.strict = false
        }
    }
}
