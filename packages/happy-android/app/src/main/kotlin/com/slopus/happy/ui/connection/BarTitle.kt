package com.slopus.happy.ui.connection

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.connection.LinkState
import com.slopus.happy.connection.networkPath
import com.slopus.happy.ui.chat.LinkSpinner
import com.slopus.happy.ui.chat.linkStatusWords
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme

/** Home's title while the link is on its way (iOS 7aee3a9b8 `AccountSwitcherLayout.Metrics`, `AccountSwitcher.setStatus`). */
object BarTitleSpec {
    val spinner = 16.dp
    val spinnerGap = 6.dp

    /** How far the one coming rises into place, and the one going lifts away. */
    val slide = 6.dp
    const val DURATION_MILLIS = 250
}

/**
 * A home's bar title: the agent's or account's [name], 18 semibold. While
 * the link is on its way somewhere ([com.slopus.happy.connection.spins])
 * its status stands in the name's place, as Telegram's title does: a 16
 * spinner, 6, then the words begun with a capital ("Connecting…"). The one
 * going lifts 6 and fades as the one coming rises 6 into place, 250 ms
 * ease-in-out, a crossfade alone with reduced motion; one status for
 * another keeps the spinner and swaps only the words. [link] is what shows,
 * already debounced ([com.slopus.happy.ui.chat.rememberShownLinkState]).
 */
@Composable
internal fun BarTitle(name: String, link: LinkState, titleTag: String, statusTag: String) {
    val locale = LocalConfiguration.current.locales[0]
    // iOS's `Strings.HeaderStatus.title`: the header's words begun with a capital, as a title is.
    val words = linkStatusWords(link)?.replaceFirstChar { it.titlecase(locale) }
    val transition = barTitleTransition()
    AnimatedContent(
        targetState = words,
        transitionSpec = { transition },
        contentAlignment = Alignment.CenterStart,
        // Name or status: a status giving way to the next stays put, its words changing below.
        contentKey = { it != null },
        label = "barTitle",
    ) { status ->
        if (status == null) {
            Text(
                name,
                style = AgentHomeSpec.barTitle,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag(titleTag),
            )
        } else {
            Row(
                modifier = Modifier.testTag(statusTag).semantics { liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                LinkSpinner(HappyTheme.colors.textSecondary, size = BarTitleSpec.spinner)
                Spacer(Modifier.width(BarTitleSpec.spinnerGap))
                AnimatedContent(status, transitionSpec = { transition }, label = "barTitleWords") { shown ->
                    Text(shown, style = AgentHomeSpec.barTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** The swap: rising from 6 below as the other lifts 6 away, both fading; a crossfade alone with reduced motion. */
@Composable
private fun barTitleTransition(): ContentTransform {
    val slide = if (rememberReduceMotion()) 0 else with(LocalDensity.current) { BarTitleSpec.slide.roundToPx() }
    val spec = tween<Float>(BarTitleSpec.DURATION_MILLIS, easing = EaseInOut)
    val move = tween<IntOffset>(BarTitleSpec.DURATION_MILLIS, easing = EaseInOut)
    // No size animation: the title is laid out once for the wider of the two, and only moves and fades.
    return ContentTransform(
        targetContentEnter = fadeIn(spec) + slideInVertically(move) { slide },
        initialContentExit = fadeOut(spec) + slideOutVertically(move) { -slide },
        sizeTransform = null,
    )
}

/** Whether the device has a way out to the network at all ([networkPath]); true until it says. */
@Composable
internal fun rememberNetworkPath(): Boolean {
    val context = LocalContext.current
    val network by remember(context) { context.networkPath() }.collectAsStateWithLifecycle(initialValue = true)
    return network
}
