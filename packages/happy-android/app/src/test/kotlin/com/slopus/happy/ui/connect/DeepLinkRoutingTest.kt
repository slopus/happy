package com.slopus.happy.ui.connect

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.onNodeWithText
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
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.LocalOverlays
import com.slopus.happy.ui.components.Overlays
import com.slopus.happy.ui.surfaces.SurfaceRoute
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
                composable<SurfaceRoute> { Text("surface") }
                composable<com.slopus.happy.ui.files.WorkspaceFileRoute> { Text("file") }
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
        fun open(link: HappyLink) {
            rule.runOnUiThread { nav.openHappyLink("c1", link) }
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
        // A file opens in the viewer at its first line, by its agent or its workspace.
        open(HappyLink.File(HappyLink.Target.Agent("a2"), "src/a.ts", 3..9))
        assertEquals(com.slopus.happy.ui.files.WorkspaceFileRoute("c1", "src/a.ts", agentId = "a2", line = 3), nav.currentBackStackEntry!!.toRoute<com.slopus.happy.ui.files.WorkspaceFileRoute>())
        open(HappyLink.File(HappyLink.Target.Workspace("w1"), "README.md"))
        assertEquals(com.slopus.happy.ui.files.WorkspaceFileRoute("c1", "README.md", workspaceId = "w1"), nav.currentBackStackEntry!!.toRoute<com.slopus.happy.ui.files.WorkspaceFileRoute>())
        open(HappyLink.Reference(HappyReferenceKind.Surface, "s1"))
        assertEquals(SurfaceRoute("c1", "s1"), nav.currentBackStackEntry!!.toRoute<SurfaceRoute>())
        // An unjoined or unknown Surface opens too; its screen joins or explains that it is unavailable.
        open(HappyLink.Reference(HappyReferenceKind.Surface, "s9"))
        assertEquals(SurfaceRoute("c1", "s9"), nav.currentBackStackEntry!!.toRoute<SurfaceRoute>())
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

    /** iOS 78fa78cf9: a link from outside waits for an open menu to go, and the menu doesn't come back with its page. */
    @Test
    fun aLinkPutsAwayAnOpenMenuFirstAndBackDoesNotReopenIt() {
        val overlays = Overlays()
        rule.mainClock.autoAdvance = false
        rule.setContent {
            nav = rememberNavController()
            CompositionLocalProvider(LocalOverlays provides overlays) {
                NavHost(nav, startDestination = HomeRoute) {
                    composable<HomeRoute> {
                        var open by rememberSaveable { mutableStateOf(true) }
                        Box {
                            Text("home")
                            HappyDropdownMenu(open, { open = false }) { Text("menu item") }
                        }
                    }
                    composable<SessionInfoRoute> { Text("info") }
                }
                DeepLinkEffect(nav, signedIn = true, onOpenSession = { opened += it })
            }
        }
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithText("menu item").assertExists()
        assertTrue(!overlays.isEmpty)

        DeepLinks.offer(parseDeepLink("happy://session/s1/info")!!)
        rule.mainClock.advanceTimeBy(80)
        // The menu is going, and the link waits for it.
        assertTrue(overlays.isEmpty)
        assertTrue("still home while the menu goes", nav.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true)
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithText("menu item").assertDoesNotExist()
        assertTrue(nav.currentBackStackEntry?.destination?.hasRoute<SessionInfoRoute>() == true)

        rule.runOnIdle { nav.popBackStack() }
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithText("home").assertExists()
        rule.onNodeWithText("menu item").assertDoesNotExist()
    }

    /** Nothing up: the link opens at once. */
    @Test
    fun withNothingUpALinkOpensAtOnce() {
        val overlays = Overlays()
        rule.setContent {
            nav = rememberNavController()
            CompositionLocalProvider(LocalOverlays provides overlays) {
                NavHost(nav, startDestination = HomeRoute) {
                    composable<HomeRoute> { Text("home") }
                    composable<SessionInfoRoute> { Text("info") }
                }
                DeepLinkEffect(nav, signedIn = true)
            }
        }
        rule.waitForIdle()
        DeepLinks.offer(parseDeepLink("happy://session/s1/info")!!)
        assertAt<SessionInfoRoute>()
    }

    private companion object {
        const val INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2"
    }
}
