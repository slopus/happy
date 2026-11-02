package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.connection.LinkState
import com.slopus.happy.connection.shownLinkState
import com.slopus.happy.ui.components.PageProgressIndicator
import kotlinx.coroutines.flow.MutableStateFlow

/** A chat header's link status (iOS 7aee3a9b8 `ChatHeaderLayout`): a 14 spinner, 5 before the words. */
object LinkStatusSpec {
    val spinner = 14.dp
    val gap = 5.dp
    val stroke = 1.5.dp
}

object LinkStatusTags {
    const val SPINNER = "link.status.spinner"
}

/** What a header says of the link with the spinner ("connecting…"); null while it says nothing of it. */
@Composable
fun linkStatusWords(state: LinkState): String? = when (state) {
    LinkState.Syncing -> stringResource(R.string.link_status_updating)
    LinkState.Connecting -> stringResource(R.string.link_status_connecting)
    LinkState.WaitingForNetwork -> stringResource(R.string.link_status_waiting_for_network)
    LinkState.Online, LinkState.Offline -> null
}

/** The spinner turning before a link status's words. */
@Composable
fun LinkSpinner(color: Color, modifier: Modifier = Modifier) {
    PageProgressIndicator(modifier.size(LinkStatusSpec.spinner).testTag(LinkStatusTags.SPINNER), color = color, strokeWidth = LinkStatusSpec.stroke)
}

/** [wanted] as a header shows it, debounced ([com.slopus.happy.connection.LinkStateDebounce]): a short wobble never shows. */
@Composable
fun rememberShownLinkState(wanted: LinkState): LinkState {
    val wants = remember { MutableStateFlow(wanted) }
    SideEffect { wants.value = wanted }
    var shown by remember { mutableStateOf(LinkState.Online) }
    LaunchedEffect(wants) { wants.shownLinkState().collect { shown = it } }
    return shown
}
