package com.slopus.happy.ui.connection

import android.content.Context
import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.conversation.ConversationRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A link.happy.page share link tapped in the app opens as the instance link
 * it carries (desktop 5a4c075c): on the connection whose installation it
 * names and no other, and "not connected" where none is.
 */
@RunWith(AndroidJUnit4::class)
class HappyShareLinkRoutingTest {
    @get:Rule val rule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var graph: AppGraph
    private lateinit var nav: NavHostController
    private lateinit var links: HappyLinks

    @Before
    fun setUp() {
        context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", """[{"id":"c1","name":"Studio","addedAt":1,"instanceId":"$INSTANCE"}]""").commit()
        graph = AppGraph(context, "android/test", "http://127.0.0.1:9", SoftwareKeys(), databaseName = null)
        rule.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = HomeRoute) {
                composable<HomeRoute> { Text("home") }
                composable<ArtifactRoute> { Text("artifact") }
                composable<ConversationRoute> { Text("conversation") }
            }
        }
        rule.waitForIdle()
        links = HappyLinks(graph, nav, "c1")
    }

    @Test
    fun aShareLinkOpensWhatItNamesOnItsOwnConnection() {
        rule.runOnUiThread { assertTrue(links.open("https://link.happy.page/#1/$INSTANCE/artifacts/r1?version=2", "c1")) }
        rule.waitForIdle()
        assertEquals(ArtifactRoute("c1", "r1", version = 2, followsLatest = false, pinned = true), nav.currentBackStackEntry!!.toRoute<ArtifactRoute>())
        assertFalse(links.unknownServer)
        assertTrue(links.opens("https://link.happy.page/#1/$INSTANCE/agents/t1?as=task", "c1"))
    }

    @Test
    fun anotherServersShareLinkSaysItIsNotConnected() {
        rule.runOnUiThread { assertTrue(links.open("https://link.happy.page/#1/$OTHER/agents/t1?as=task", "c1")) }
        rule.waitForIdle()
        assertTrue(links.unknownServer)
        assertTrue(nav.currentBackStackEntry!!.destination.route!!.contains("HomeRoute"))
    }

    @Test
    fun anythingElseOnThePagesHostIsTheWebs() {
        for (url in listOf("https://link.happy.page/", "https://link.happy.page/#1/agents/t1", "https://example.com/")) {
            assertFalse(url, links.open(url, "c1"))
        }
        assertFalse(links.unknownServer)
    }

    private companion object {
        const val INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2"
        const val OTHER = "m1n2b3v4c5x6z7l8k9j0h1g2"
    }
}
