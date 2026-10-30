package com.slopus.happy.ui.conversation

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.ui.PHONE
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@Serializable internal data object TestHome

/** Compose from home pushes an empty chat; compose from a chat replaces it; Back goes home. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ConversationNavigationTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var nav: NavHostController

    private fun host() {
        rule.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = TestHome) {
                composable<TestHome> { Text("home") }
                composable<ConversationRoute> { Text("chat ${it.toRoute<ConversationRoute>().agentId}") }
            }
        }
    }

    private fun stack() = nav.currentBackStack.value.mapNotNull { entry ->
        when {
            entry.destination.hasRoute<TestHome>() -> "home"
            entry.destination.hasRoute<ConversationRoute>() -> "chat:${entry.toRoute<ConversationRoute>().agentId}"
            else -> null
        }
    }

    @Test fun `compose from home pushes, compose in a chat replaces it, back is home`() {
        host()
        rule.runOnIdle { nav.composeConversation("c1") }
        rule.runOnIdle { assertEquals(listOf("home", "chat:null"), stack()) }
        val first = rule.runOnIdle { nav.currentBackStackEntry!!.id }
        rule.runOnIdle { nav.composeConversation("c1") }
        rule.runOnIdle {
            assertEquals(listOf("home", "chat:null"), stack())
            // A fresh entry: its own empty conversation, not the old one's.
            assertTrue(nav.currentBackStackEntry!!.id != first)
        }
        rule.runOnIdle { nav.popBackStack() }
        rule.runOnIdle { assertEquals(listOf("home"), stack()) }
    }

    @Test fun `compose from an open chat replaces it too`() {
        host()
        rule.runOnIdle { nav.openConversation("c1", "a1") }
        rule.runOnIdle { nav.composeConversation("c1") }
        rule.runOnIdle { assertEquals(listOf("home", "chat:null"), stack()) }
    }

    @Test fun `a chat hears its own events and a resync on every connect`() = runBlocking {
        fun event(type: String, data: String) = AgentEvent(null, type, Json.parseToJsonElement(data).jsonObject)
        val signals = flowOf(
            event(AgentEvent.HELLO, """{"gap":false}"""),
            event("message.created", """{"agentId":"a1","message":{"id":"m"}}"""),
            event("message.created", """{"agentId":"a2","message":{"id":"n"}}"""),
            event("question.created", """{"question":{"id":"q","agentId":"a1"}}"""),
        ).signalsFor("a1").toList()
        assertEquals(ConversationSignal.Resync, signals[0])
        assertEquals(listOf("message.created", "question.created"), signals.drop(1).map { (it as ConversationSignal.Event).type })
        assertNull(signals.getOrNull(3))
    }
}
