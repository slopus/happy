package com.slopus.happy.ui.connect

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.WelcomeRoute
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

    @After
    fun tearDown() {
        DeepLinks.pending.value?.let(DeepLinks::consume)
    }

    private fun setHost(signedIn: Boolean) {
        rule.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = if (signedIn) HomeRoute else WelcomeRoute) {
                composable<WelcomeRoute> { Text("welcome") }
                composable<HomeRoute> { Text("home") }
                composable<ServerRoute> { Text("server") }
                composable<SessionInfoRoute> { Text("info") }
                composable<SessionChangesRoute> { Text("changes") }
            }
            DeepLinkEffect(nav, signedIn, onOpenSession = { opened += it })
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
        assertAt<WelcomeRoute>()
        DeepLinks.offer(parseDeepLink("happy://session/s1")!!)
        assertAt<WelcomeRoute>()
        assertEquals(emptyList<String>(), opened)
        DeepLinks.offer(parseDeepLink("happy://server")!!)
        assertAt<ServerRoute>()
        assertNull(DeepLinks.pending.value)
    }
}
