package com.slopus.happy.ui.pipelines

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.LocalPageDims
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.RetainedPagesState
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.backStackEntries
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Pipelines turned off for the account, live: every pipeline page leaves, with what was opened over them, back to the page under the first. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class PipelinesOffTest {
    @get:Rule val rule = createComposeRule()

    private val off = MutableStateFlow(false)
    private lateinit var nav: NavHostController

    private fun show() = rule.setHappyContent {
        nav = rememberNavController()
        val motion = rememberNavMotion()
        CompositionLocalProvider(LocalPageDims provides motion.dims) {
            RetainedNavHost(nav, HomeRoute, motion, retention = remember { RetainedPagesState() }) {
                page<HomeRoute> { Box(Modifier.fillMaxSize()) }
                page<ConversationRoute> { Box(Modifier.fillMaxSize()) }
                page<SettingsRoute> { Box(Modifier.fillMaxSize()) }
                page<PipelinesRoute> { Box(Modifier.fillMaxSize()) }
                page<PipelineRunRoute> { Box(Modifier.fillMaxSize()) }
                page<PipelineNodeRoute> { Box(Modifier.fillMaxSize()) }
            }
            PipelinesOffEffect(off, nav)
        }
    }

    private fun go(vararg routes: Any) {
        for (route in routes) rule.runOnUiThread { nav.navigate(route) }
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
    }

    private fun top() = rule.runOnIdle { nav.currentBackStackEntry!!.destination }

    @Test
    fun turnedOffTheOpenPipelinePagesLeaveToHome() {
        show()
        go(PipelinesRoute("c1"), PipelineRunRoute("c1", "r1"), PipelineNodeRoute("c1", "r1", "build"), SettingsRoute())
        rule.runOnIdle { off.value = true }
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        assertTrue(top().hasRoute<HomeRoute>())
        assertEquals("the pages are gone, not under home", 0, rule.runOnIdle { nav.backStackEntries.value.count { it.destination.isPipelinePage() } })
    }

    @Test
    fun aRunOpenedFromAChatLeavesToTheChat() {
        show()
        go(ConversationRoute("c1", "a1"), PipelineRunRoute("c1", "r1"))
        rule.runOnIdle { off.value = true }
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        assertTrue(top().hasRoute<ConversationRoute>())
    }

    @Test
    fun whileOnNothingLeavesAndWhileOffNoPipelinePageStays() {
        show()
        go(PipelinesRoute("c1"))
        assertTrue("on: stays", top().hasRoute<PipelinesRoute>())
        rule.runOnIdle { off.value = true }
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        // One opened while off (a link, a restored stack) leaves too.
        go(SettingsRoute(), PipelineRunRoute("c1", "r1"))
        assertTrue(top().hasRoute<SettingsRoute>())
    }
}
