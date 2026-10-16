package com.slopus.happy.ui.home

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.WelcomeRoute
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.session.SessionInfoRoute
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * info.tsx after archive or delete: `router.back()` twice, so the chat that
 * opened session info goes too. When the archive picked a successor tab, the
 * chat is replaced by it instead. From the home menu's Details only session
 * info goes, and a successor opens on top.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class LeaveSessionInfoTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var nav: NavHostController

    private fun host(vararg stack: Any) {
        rule.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = WelcomeRoute) {
                composable<WelcomeRoute> { Text("home") }
                composable<SessionRoute> { Text("chat") }
                composable<SessionInfoRoute> { Text("info") }
            }
        }
        rule.runOnIdle { stack.forEach { nav.navigate(it) } }
    }

    private fun stack(): List<String> = nav.currentBackStack.value.mapNotNull { entry ->
        when {
            entry.destination.hasRoute<WelcomeRoute>() -> "home"
            entry.destination.hasRoute<SessionInfoRoute>() -> "info:" + entry.toRoute<SessionInfoRoute>().id
            entry.destination.hasRoute<SessionRoute>() -> "chat:" + entry.toRoute<SessionRoute>().id
            else -> null
        }
    }

    @Test
    fun deletingFromTheChatGoesBackPastIt() {
        host(SessionRoute("s1"), SessionInfoRoute("s1"))
        rule.runOnIdle { nav.leaveSessionInfo("s1", null) { error("opened $it") } }
        rule.runOnIdle { assertEquals(listOf("home"), stack()) }
    }

    @Test
    fun aSuccessorReplacesTheChat() {
        host(SessionRoute("s1"), SessionInfoRoute("s1"))
        rule.runOnIdle { nav.leaveSessionInfo("s1", "s2") { error("opened $it") } }
        rule.runOnIdle { assertEquals(listOf("home", "chat:s2"), stack()) }
    }

    @Test
    fun fromHomeOnlyInfoGoes() {
        host(SessionInfoRoute("s1"))
        rule.runOnIdle { nav.leaveSessionInfo("s1", null) { error("opened $it") } }
        rule.runOnIdle { assertEquals(listOf("home"), stack()) }
    }

    @Test
    fun fromHomeASuccessorOpensOnTop() {
        host(SessionInfoRoute("s1"))
        val opened = mutableListOf<String>()
        rule.runOnIdle { nav.leaveSessionInfo("s1", "s2") { opened += it } }
        rule.runOnIdle {
            assertEquals(listOf("home"), stack())
            assertEquals(listOf("s2"), opened)
        }
    }

    @Test
    fun anotherSessionsChatStays() {
        host(SessionRoute("s0"), SessionInfoRoute("s1"))
        rule.runOnIdle { nav.leaveSessionInfo("s1", null) { error("opened $it") } }
        rule.runOnIdle { assertEquals(listOf("home", "chat:s0"), stack()) }
    }
}
