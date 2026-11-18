package com.slopus.happy.fixture

import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.backStackEntries
import com.slopus.happy.ui.connection.AgentAppearanceRoute
import com.slopus.happy.ui.connection.AgentConnectionSettingsScreen
import com.slopus.happy.ui.connection.AgentSettingsActions
import com.slopus.happy.ui.conversation.ChiefOfStaffEntry
import com.slopus.happy.ui.conversation.ChiefOfStaffRoute
import com.slopus.happy.ui.conversation.ChiefOfStaffTags
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.conversation.openChiefOfStaff
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsPageTags
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The real Settings action, lookup page and retained host, with a local bot response and no account or send. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class AccountTitleNavigationDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private lateinit var nav: NavHostController
    private var reply = CompletableDeferred<Unit>()
    private var lookups = 0
    private val api = ConversationApi(request = { method, path, _, _ ->
        assertEquals("GET /v0/bots", "$method $path")
        lookups++
        reply.await()
        TransportResponse(200, body = """{"bots":[{"systemKey":"chief_of_staff","status":"active","agent":{"id":"fixture-chief"}}]}""".toByteArray())
    })

    private fun show() {
        rule.setContent {
            nav = rememberNavController()
            HappyTheme {
                RetainedNavHost(nav, HomeRoute, rememberNavMotion()) {
                    page<HomeRoute> { Text("Home") }
                    page<SettingsRoute> {
                        AgentConnectionSettingsScreen(
                            profile = SettingsProfile(CONNECTION, "Fixture agent", "Connected"),
                            accounts = AccountMenu(emptyList()),
                            about = AboutInfo("fixture"),
                            actions = AgentSettingsActions(onAskChief = { nav.openChiefOfStaff(CONNECTION, it) }),
                        )
                    }
                    page<ChiefOfStaffRoute> { ChiefOfStaffEntry(nav, it, api) }
                    page<AgentAppearanceRoute> { Text("Appearance", Modifier.testTag("fixture.appearance")) }
                    page<ConversationRoute> { Text(it.toRoute<ConversationRoute>().prefill.orEmpty()) }
                }
            }
        }
        rule.runOnIdle { nav.navigate(SettingsRoute()) }
    }

    private fun edit(tag: String = SettingsPageTags.EDIT_NAME) {
        rule.onNodeWithTag(SettingsPageTags.PICTURE, useUnmergedTree = true).performClick()
        rule.onNodeWithTag(tag, useUnmergedTree = true).performClick()
        rule.onNodeWithTag(ChiefOfStaffTags.LOADING, useUnmergedTree = true).assertIsDisplayed()
    }

    private fun assertDepth(depth: Int) {
        rule.runOnIdle { assertEquals(depth, nav.backStackEntries.value.count { it.destination !is NavGraph }) }
    }

    @Test fun editNameOpensOnceAndCanBeOpenedAgainAfterBack() {
        show()
        edit()
        rule.runOnIdle {
            val request = nav.currentBackStackEntry!!
            nav.openChiefOfStaff(CONNECTION, request.toRoute<ChiefOfStaffRoute>().prefix)
            nav.openChiefOfStaff(CONNECTION, "Change your avatar to ")
            assertEquals(request.id, nav.currentBackStackEntry!!.id)
            reply.complete(Unit)
        }
        rule.onNodeWithText("Change your name to ").assertIsDisplayed()
        assertDepth(3)
        rule.runOnIdle { nav.popBackStack() }
        assertDepth(2)
        reply = CompletableDeferred()
        edit()
        rule.runOnIdle { reply.complete(Unit) }
        rule.onNodeWithText("Change your name to ").assertIsDisplayed()
        assertDepth(3)
        rule.runOnIdle { nav.popBackStack() }
        assertDepth(2)
        reply = CompletableDeferred()
        edit(SettingsPageTags.EDIT_AVATAR)
        rule.runOnIdle { reply.complete(Unit) }
        rule.onNodeWithText("Change your avatar to ").assertIsDisplayed()
        assertDepth(3)
        rule.runOnIdle { nav.popBackStack() }
        assertDepth(2)
        rule.runOnIdle { assertEquals(3, lookups) }
    }

    @Test fun completingDuringBackDoesNotOpenAChat() {
        show()
        edit()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag(ConversationScreenTags.BACK, useUnmergedTree = true).performClick()
        rule.runOnUiThread { reply.complete(Unit) }
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.autoAdvance = true
        rule.onNodeWithTag(SettingsPageTags.PICTURE, useUnmergedTree = true).assertIsDisplayed()
        assertDepth(2)
    }

    @Test fun completingWhileCoveredWaitsUntilTheLookupIsBackOnTop() {
        show()
        edit()
        rule.runOnIdle { nav.navigate(AgentAppearanceRoute(CONNECTION)) }
        rule.onNodeWithTag("fixture.appearance").assertIsDisplayed()
        rule.runOnIdle { reply.complete(Unit) }
        rule.onNodeWithTag("fixture.appearance").assertIsDisplayed()
        assertDepth(4)
        rule.runOnIdle { nav.popBackStack() }
        rule.onNodeWithText("Change your name to ").assertIsDisplayed()
        assertDepth(3)
        rule.runOnIdle { assertEquals(1, lookups) }
    }

    private companion object {
        const val CONNECTION = "fixture-connection"
    }
}