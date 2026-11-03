package com.slopus.happy.ui.browser

import androidx.compose.runtime.Composable
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.artifacts.PlaceScaffold

/**
 * A web page on its own screen (iOS's `BrowserViewController` pushed,
 * 34aa464e1): the page's title in the bar with its host under it, and at
 * the bar's end back, forward, reload or stop and share
 * ([BrowserControls]). A close (✕) leaves, while system back walks the
 * page's history first.
 */
@Composable
fun BrowserScreen(
    /** The address it opens, whose host is the title until the page has one. */
    url: String,
    computer: String,
    prepare: suspend () -> BrowserPage,
    onBack: () -> Unit,
    onOpenElsewhere: (String) -> Unit,
    agentStatus: AgentLinkStatus? = null,
    state: BrowserState = rememberBrowserState(),
) {
    val (title, subtitle) = browserHeader(state, BrowserState.hostOf(url).orEmpty())
    PlaceScaffold(title, onBack, "browser.screen", actions = { BrowserControls(state) }, subtitle = subtitle, closes = true) {
        BrowserView(state, prepare = prepare, computer = computer, agentStatus = agentStatus, onOpenElsewhere = onOpenElsewhere)
    }
}
