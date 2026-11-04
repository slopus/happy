package com.slopus.happy.ui.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ApplicationProvider
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.AppGraph
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.LocalLinkOpener
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SupportSettingsTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun anAgentConnectionOpensThePhonesStoreInsteadOfItsProxiedBrowser() {
        val urls = mutableListOf<String>()
        val links = LinkOpener(
            proxied = true, computer = "Studio",
            tap = { error("must not use the agent's browser") },
            inApp = { error("must not use the agent's browser") },
            external = { urls += it },
        )
        val graph = AppGraph(ApplicationProvider.getApplicationContext(), "android/test", "http://localhost:1", SoftwareKeys(), databaseName = null)
        rule.setHappyContent {
            CompositionLocalProvider(LocalLinkOpener provides links) {
                val actions = rememberAboutActions(graph, rememberNavController())
                SupportCard(AboutInfo("1", isPro = true), actions)
            }
        }
        rule.node(SettingsTags.MANAGE_SUBSCRIPTIONS).performClick()
        assertEquals(listOf("https://play.google.com/store/account/subscriptions"), urls)
    }

    @Test
    fun subscriptionsOpenTheStoresAccountPageWithOrWithoutPro() {
        var pro by mutableStateOf(true)
        val urls = mutableListOf<String>()
        var paywalls = 0
        rule.setHappyContent {
            SupportCard(AboutInfo("1", isPro = pro), AboutActions(onOpenUrl = { urls += it }, onSupport = { paywalls++ }))
        }
        val row = rule.node(SettingsTags.MANAGE_SUBSCRIPTIONS)
        assertDp("left inset", 16, row.bounds.left)
        assertDp("right inset", PHONE_WIDTH - 16, row.bounds.right)
        assertDp("manage subscriptions height", 64, row.bounds.height)
        rule.onNodeWithText("Thank you for your support!").assertIsDisplayed()
        assertEquals(emptyList<String>(), urls)
        row.performClick()
        assertEquals(listOf("https://play.google.com/store/account/subscriptions"), urls)
        assertEquals(0, paywalls)
        pro = false
        rule.onNodeWithText("Support project development").assertIsDisplayed()
        row.performClick()
        assertEquals(2, urls.size)
        assertEquals(0, paywalls)
        rule.node(SettingsTags.SUPPORT).performClick()
        assertEquals(1, paywalls)
    }
}