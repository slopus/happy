package com.slopus.happy.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.components.TitleWithStatus
import com.slopus.happy.ui.connection.AgentTopBar
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * A bar whose status line changed while another page covered it, shown again
 * with Back. The bench build crashed here ("LayoutNode not found in
 * RectList"): Material's TopAppBar read its title's baseline while measuring,
 * and on Compose UI 1.12 that places the status line's new nodes under
 * parents never placed while the page was covered (b/549552303).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class RetainedHeaderStatusTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `a covered page's bar status changes, then Back shows it`() {
        lateinit var nav: NavHostController
        var status by mutableIntStateOf(0)
        rule.setHappyContent {
            nav = rememberNavController()
            val motion = rememberNavMotion()
            CompositionLocalProvider(LocalPageDims provides motion.dims) {
                RetainedNavHost(nav, HomeRoute, motion, retention = remember { RetainedPagesState() }) {
                    page<HomeRoute> {
                        AgentTopBar(tag = "bar", container = Color.Transparent, navigationIcon = {}, title = {
                            TitleWithStatus(status, MaterialTheme.typography.bodySmall, title = { Text("Isolate happy-accounts") }) { shown ->
                                Text("status $shown", style = MaterialTheme.typography.bodySmall)
                            }
                        })
                    }
                    page<SettingsRoute> { Box(Modifier.fillMaxSize()) }
                }
            }
        }
        rule.waitForIdle()
        rule.runOnUiThread { nav.navigate(SettingsRoute()) }
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        rule.runOnIdle { status++ }
        rule.waitForIdle()
        rule.runOnUiThread { nav.popBackStack() }
        rule.runOnIdle { status++ }
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        rule.onNodeWithText("status 2").assertExists()
    }
}
