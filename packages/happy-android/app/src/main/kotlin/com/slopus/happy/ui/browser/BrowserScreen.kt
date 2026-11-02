package com.slopus.happy.ui.browser

import androidx.compose.runtime.Composable
import com.slopus.happy.ui.artifacts.PlaceScaffold

/**
 * A web page on its own screen (iOS's `BrowserViewController` pushed): its
 * host, then its title, in the bar, the address under it; a close (✕) leaves,
 * while system back walks the page's history first.
 */
@Composable
fun BrowserScreen(
    title: String,
    computer: String,
    prepare: suspend () -> BrowserPage,
    onBack: () -> Unit,
    onTitle: (String) -> Unit,
    onOpenElsewhere: (String) -> Unit,
    /** The page's address as it moves, under the title. */
    url: String? = null,
    onUrl: (String) -> Unit = {},
) {
    PlaceScaffold(title, onBack, "browser.screen", subtitle = url?.let(::displayUrl), closes = true) {
        BrowserView(prepare = prepare, computer = computer, onTitle = onTitle, onOpenElsewhere = onOpenElsewhere, onUrl = onUrl)
    }
}
