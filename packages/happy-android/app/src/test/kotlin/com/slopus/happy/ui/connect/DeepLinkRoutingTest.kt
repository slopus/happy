package com.slopus.happy.ui.connect

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.navigation.toRoute
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.connection.AgentSurfaceRoute
import com.slopus.happy.ui.connection.HappyLinks
import com.slopus.happy.ui.connection.openHappyLink
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.StartRoute
import com.slopus.happy.ui.files.SessionChangesRoute
import com.slopus.happy.ui.session.SessionInfoRoute
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** DeepLinkEffect: links open their screen signed in; signed out only the ones that need no account. */
@RunWith(AndroidJUnit4::class)
class DeepLinkRoutingTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var nav: NavHostController
    private val opened = mutableListOf<String>()
    private val happy = mutableListOf<DeepLink>()

    @After
    fun tearDown() {
        DeepLinks.pending.value?.let(DeepLinks::consume)
    }

    private fun setHost(signedIn: Boolean, openConnection: String? = null) {
        rule.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = if (signedIn) HomeRoute else StartRoute) {
                composable<StartRoute> { Text("start") }
                composable<HomeRoute> { Text("home") }
                composable<ServerRoute> { Text("server") }
                composable<SessionInfoRoute> { Text("info") }
                composable<SessionChangesRoute> { Text("changes") }
                composable<ArtifactRoute> { Text("artifact") }
                composable<ConversationRoute> { Text("conversation") }
                composable<AgentSurfaceRoute> { Text("surface") }
            }
            DeepLinkEffect(nav, signedIn, onOpenSession = { opened += it }, openConnection = openConnection, onHappyLink = { happy += it })
        }
        rule.waitForIdle()
    }

    private inline fun <reified T : Any> assertAt() {
        rule.waitForIdle()
        assertTrue("at ${T::class.simpleName}", nav.currentBackStackEntry?.destination?.hasRoute<T>() == true)
    }

    @Test
    fun signedInLinksOpenTheirScreenAndHomeGoesBack() {
        setHost(signedIn = true)
        DeepLinks.offer(parseDeepLink("happy://session/s1/info")!!)
        assertAt<SessionInfoRoute>()
        DeepLinks.offer(parseDeepLink("https://app.happy.engineering/session/s1/changes?file=a.kt")!!)
        assertAt<SessionChangesRoute>()
        assertEquals("a.kt", nav.currentBackStackEntry?.arguments?.getString("file"))
        DeepLinks.offer(parseDeepLink("happy://session/s2")!!)
        rule.waitForIdle()
        assertEquals(listOf("s2"), opened)
        DeepLinks.offer(parseDeepLink("happy://inbox")!!)
        assertAt<HomeRoute>()
        assertNull(nav.previousBackStackEntry)
        assertNull(DeepLinks.pending.value)
    }

    @Test
    fun signedOutOnlyAccountFreeScreensOpen() {
        setHost(signedIn = false)
        DeepLinks.offer(parseDeepLink("happy://session/s1/info")!!)
        assertAt<StartRoute>()
        DeepLinks.offer(parseDeepLink("happy://session/s1")!!)
        assertAt<StartRoute>()
        assertEquals(emptyList<String>(), opened)
        DeepLinks.offer(parseDeepLink("happy://server")!!)
        assertAt<ServerRoute>()
        assertNull(DeepLinks.pending.value)
    }

    @Test
    fun instanceLinksGoToHappyLinksSignedInOrOut() {
        setHost(signedIn = false, openConnection = "c1")
        val link = parseDeepLink("happy://$INSTANCE/artifacts/abc123")!!
        DeepLinks.offer(link)
        rule.waitForIdle()
        assertEquals(listOf(link), happy)
        assertNull(DeepLinks.pending.value)
        // A link waiting for another connection's stack stays for it; this connection's is taken.
        val elsewhere = DeepLink.OnConnection("c2", HappyLink.Reference(HappyReferenceKind.Agent, "a1"))
        DeepLinks.offer(elsewhere)
        rule.waitForIdle()
        assertEquals(elsewhere, DeepLinks.pending.value)
        val here = DeepLink.OnConnection("c1", HappyLink.Reference(HappyReferenceKind.Agent, "a1"))
        DeepLinks.offer(here)
        rule.waitForIdle()
        assertEquals(listOf(link, here), happy)
        assertNull(DeepLinks.pending.value)
    }

    @Test
    fun aHappyLinkOpensItsScreenOnItsConnection() {
        setHost(signedIn = true)
        val joined = AgentFeedRow.Surface("s1", "Groceries", "todo")
        fun open(link: HappyLink) {
            rule.runOnUiThread { nav.openHappyLink("c1", link) { id -> joined.takeIf { it.id == id } } }
            rule.waitForIdle()
        }
        open(HappyLink.Reference(HappyReferenceKind.Artifact, "abc", version = 2))
        assertAt<ArtifactRoute>()
        nav.currentBackStackEntry!!.toRoute<ArtifactRoute>().let {
            assertEquals(ArtifactRoute("c1", "abc", version = 2, followsLatest = false, pinned = true), it)
        }
        open(HappyLink.Reference(HappyReferenceKind.Artifact, "abc"))
        assertEquals(ArtifactRoute("c1", "abc"), nav.currentBackStackEntry!!.toRoute<ArtifactRoute>())
        open(HappyLink.Reference(HappyReferenceKind.Agent, "a1"))
        assertEquals(ConversationRoute("c1", "a1"), nav.currentBackStackEntry!!.toRoute<ConversationRoute>())
        open(HappyLink.File(HappyLink.Target.Agent("a2"), "src/a.ts", 3..3))
        assertEquals(ConversationRoute("c1", "a2"), nav.currentBackStackEntry!!.toRoute<ConversationRoute>())
        open(HappyLink.Reference(HappyReferenceKind.Surface, "s1"))
        assertEquals(AgentSurfaceRoute("c1", "s1", "todo", "Groceries"), nav.currentBackStackEntry!!.toRoute<AgentSurfaceRoute>())
        // Nothing to show on the phone: the connection's home.
        open(HappyLink.Reference(HappyReferenceKind.Surface, "s9"))
        assertAt<HomeRoute>()
        open(HappyLink.Reference(HappyReferenceKind.Agent, "a1"))
        open(HappyLink.Reference(HappyReferenceKind.Service, "web", workspaceId = "w1"))
        assertAt<HomeRoute>()
        assertNull(nav.previousBackStackEntry)
    }

    @Test
    fun anExternalLinkMatchesOnlyItsOwnInstance() {
        fun connection(id: String, instance: String?) = AgentConnection(id, id, addedAt = 0, instanceId = instance)
        val connections = listOf(connection("c1", INSTANCE), connection("c2", null), connection("c3", INSTANCE))
        assertEquals("c1", HappyLinks.connectionFor(connections, INSTANCE, open = "c2"))
        assertEquals("c3", HappyLinks.connectionFor(connections, INSTANCE, open = "c3"))
        assertNull(HappyLinks.connectionFor(connections, "zzzzzzzzzzzzzzzzzzzzzzzz", open = "c1"))
        assertNull(HappyLinks.connectionFor(emptyList(), INSTANCE, open = null))
    }

    private companion object {
        const val INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2"
    }
}
