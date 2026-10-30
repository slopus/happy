package com.slopus.happy.ui.tablet

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performScrollToIndex
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The window crossing 768 swaps the phone's home for the tablet sidebar's,
 * which throws the list away and used to rebuild it at the top. Home's place
 * now lives above that swap, in [HomeServices.homeListOffsets], keyed by
 * account, and a rebuilt list is created from it. These cover the recording
 * and the keying at both widths; the resize itself is an emulator capture,
 * as this rule cannot re-measure a window mid-test.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeListAcrossTheBreakpointTest {
    @get:Rule
    val rule = createComposeRule()

    private val server = FakeHappyServer().start()
    private lateinit var graph: AppGraph

    @After
    fun tearDown() = server.close()

    private fun signIn(sessions: Int) {
        server.addMachine("m1")
        repeat(sessions) { index ->
            server.addSession(
                "s$index",
                updatedAt = (sessions - index).toLong(),
                metadata = buildJsonObject {
                    put("path", "/repo/s$index")
                    put("host", "devbox")
                    put("machineId", "m1")
                    put("summary", buildJsonObject { put("text", "Chat $index"); put("updatedAt", 1) })
                },
            )
        }
        graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = server.url,
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        runBlocking { graph.auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))) }
        rule.setContent { HappyApp(graph) }
    }

    private fun scrollAndReadPlace(): Pair<Int, Int>? {
        rule.waitUntilAtLeastOneExists(hasTestTag(FlatRowTags.ROW), 5_000)
        rule.node(HomeTags.LIST).performScrollToIndex(25)
        rule.waitForIdle()
        val key = graph.accountStore.registry.value.activeId.orEmpty()
        assertTrue("the account is known", key.isNotEmpty())
        val services = HomeServices.of(graph)
        // The place belongs to this account alone; another's is never written.
        assertEquals("no other account carries this place", null, services.homeListOffsets["another-account"])
        return services.homeListOffsets[key]
    }

    @Test
    @Config(qualifiers = PHONE)
    fun thePhonesHomeRemembersWhereItWasForThisAccount() {
        signIn(sessions = 40)
        val place = scrollAndReadPlace()
        assertTrue("home remembered where it was scrolled to: $place", (place?.first ?: 0) > 0)
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun theSidebarsListRemembersTheSamePlaceTheSameWay() {
        signIn(sessions = 40)
        rule.waitUntilAtLeastOneExists(hasTestTag(TabletSidebarTags.SIDEBAR), 5_000)
        val place = scrollAndReadPlace()
        assertTrue("the sidebar remembered where it was scrolled to: $place", (place?.first ?: 0) > 0)
    }
}
