package com.slopus.happy.ui.browser

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.browser.BrowserProblem
import com.slopus.happy.browser.BrowserProgress
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LocalPageActive
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import com.slopus.happy.ui.components.Icon as Glyph

/**
 * iOS's `BrowserMetrics` and `Palette.browser*` (HappyLayout
 * Tokens/BrowserTokens.swift, 34aa464e1): Safari's thin loading bar under
 * the bar, and the page that says why a page didn't open.
 */
object BrowserSpec {
    /** The loading bar's thickness. */
    val progressHeight = 2.5.dp
    /** The loading bar, Safari's blue. */
    val progressLight = Color(0xFF007AFF)
    val progressDark = Color(0xFF0A84FF)
    /** The error page's glyph and its colour. */
    val failureIcon = 52.dp
    val failureIconColor = Color(0xFF8E8E93)
    /** The widest the error page's words run, on a tablet or in landscape. */
    val failureTextWidth = 320.dp
    /** The least space between the words and the screen's sides. */
    val failureMargin = 32.dp
    val failureIconToTitle = 16.dp
    val failureTitleToMessage = 8.dp
    val failureMessageToButton = 24.dp
    /** How far above the middle of the free area the block sits: centred exactly, it reads as low. */
    val failureLift = 24.dp
    /** The error page fades in (iOS `UIView.animate(withDuration: 0.2)`). */
    const val FAILURE_FADE_MILLIS = 200
    /** A load's value glides there (0.3 s, ease-out), the bar fills (0.2 s, ease-out), waits 0.1 s and fades (0.25 s); a stop fades it (0.2 s). */
    const val PROGRESS_GLIDE_MILLIS = 300
    const val PROGRESS_FILL_MILLIS = 200
    const val PROGRESS_FADE_DELAY_MILLIS = 100L
    const val PROGRESS_FADE_MILLIS = 250
    const val PROGRESS_HIDE_MILLIS = 200
}

/**
 * The loading bar on the bar's bottom edge (iOS's `BrowserProgressView`):
 * draws a [BrowserProgress], gliding to each new value, filling and then
 * fading when the load ends; [onFaded] says the fade is over. The fill and
 * fade are drawn in the draw phase only, so a frame of it costs no layout.
 */
@Composable
fun BrowserProgressBar(progress: BrowserProgress, onFaded: () -> Unit, modifier: Modifier = Modifier) {
    val fraction = remember { Animatable(0f) }
    val alpha = remember { Animatable(0f) }
    val shown = remember { arrayOf(BrowserProgress()) }
    val color = if (HappyTheme.colors.dark) BrowserSpec.progressDark else BrowserSpec.progressLight
    LaunchedEffect(progress) {
        val before = shown[0]
        shown[0] = progress
        when (progress.phase) {
            BrowserProgress.Phase.Hidden -> {
                alpha.animateTo(0f, tween(BrowserSpec.PROGRESS_HIDE_MILLIS, easing = EaseInOut))
                fraction.snapTo(0f)
            }
            BrowserProgress.Phase.Loading -> {
                if (before.phase != BrowserProgress.Phase.Loading) {
                    // A new load: the old one's fade is dropped, and the bar grows from nothing.
                    alpha.snapTo(1f)
                    fraction.snapTo(0f)
                }
                fraction.animateTo(progress.value, tween(BrowserSpec.PROGRESS_GLIDE_MILLIS, easing = EaseOut))
            }
            BrowserProgress.Phase.Finishing -> {
                alpha.snapTo(1f)
                fraction.animateTo(1f, tween(BrowserSpec.PROGRESS_FILL_MILLIS, easing = EaseOut))
                delay(BrowserSpec.PROGRESS_FADE_DELAY_MILLIS)
                alpha.animateTo(0f, tween(BrowserSpec.PROGRESS_FADE_MILLIS, easing = EaseInOut))
                onFaded()
            }
        }
    }
    Box(
        modifier
            .fillMaxWidth()
            .height(BrowserSpec.progressHeight)
            .testTag(BrowserTags.PROGRESS)
            .semantics { if (progress.phase == BrowserProgress.Phase.Loading) progressBarRangeInfo = ProgressBarRangeInfo(progress.value, 0f..1f) }
            .graphicsLayer { this.alpha = alpha.value }
            .drawBehind {
                val width = size.width * fraction.value
                if (width <= 0f) return@drawBehind
                val radius = size.height / 2
                // Square at the leading edge, round at the end that moves.
                drawRect(color, size = Size((width - radius).coerceAtLeast(0f), size.height))
                drawRoundRect(color, size = Size(width, size.height), cornerRadius = CornerRadius(radius))
            },
    )
}

/** The error page's title and the sentence under it (iOS's `Strings.Browser.failure`). [host] names the server; [computer] the agent connection. */
@Composable
fun browserProblemWords(problem: BrowserProblem, computer: String, host: String?): Pair<String, String> = when (problem) {
    BrowserProblem.NoNetwork -> stringResource(R.string.browser_problem_offline_title) to stringResource(R.string.browser_problem_offline_message)
    BrowserProblem.ComputerUnreachable ->
        stringResource(R.string.browser_problem_unreachable_title, computer) to stringResource(R.string.browser_problem_unreachable_message, computer)
    BrowserProblem.Unavailable -> stringResource(R.string.browser_problem_unavailable_title) to stringResource(R.string.browser_problem_unavailable_message)
    BrowserProblem.LiveUnavailable -> stringResource(R.string.browser_problem_live_unavailable_title) to stringResource(R.string.browser_problem_live_unavailable_message)
    BrowserProblem.HostNotFound -> stringResource(R.string.browser_problem_host_not_found_title) to
        (if (host != null) stringResource(R.string.browser_problem_host_not_found_message, computer, host) else stringResource(R.string.browser_problem_host_not_found_message_no_host, computer))
    BrowserProblem.ServerNotResponding -> stringResource(R.string.browser_problem_server_title) to
        (if (host != null) stringResource(R.string.browser_problem_server_message, host) else stringResource(R.string.browser_problem_server_message_no_host))
    BrowserProblem.TimedOut -> stringResource(R.string.browser_problem_timed_out_title) to
        (if (host != null) stringResource(R.string.browser_problem_timed_out_message, host) else stringResource(R.string.browser_problem_timed_out_message_no_host))
    BrowserProblem.Insecure -> stringResource(R.string.browser_problem_insecure_title) to
        (if (host != null) stringResource(R.string.browser_problem_insecure_message, host) else stringResource(R.string.browser_problem_insecure_message_no_host))
    BrowserProblem.Cleartext -> stringResource(R.string.browser_problem_unavailable_title) to
        (if (host != null) stringResource(R.string.browser_problem_cleartext_message, host) else stringResource(R.string.browser_problem_cleartext_message_no_host))
    is BrowserProblem.Http -> stringResource(R.string.browser_problem_http_title, problem.status) to
        (problem.reason?.let { stringResource(R.string.browser_problem_http_message, it) } ?: stringResource(R.string.browser_problem_http_message_no_reason))
    BrowserProblem.Crashed -> stringResource(R.string.browser_problem_crashed_title) to stringResource(R.string.browser_problem_crashed_message)
    is BrowserProblem.Unsupported -> stringResource(R.string.browser_problem_unsupported_title) to
        (if (problem.scheme.isNotEmpty()) stringResource(R.string.browser_problem_unsupported_message, problem.scheme) else stringResource(R.string.browser_problem_unsupported_message_no_scheme))
    is BrowserProblem.Other -> stringResource(R.string.browser_problem_unavailable_title) to problem.description
}

/** The error page's glyph for [problem] (iOS's `BrowserFailureView.glyph`). */
fun browserProblemGlyph(problem: BrowserProblem): Ionicon = when (problem) {
    BrowserProblem.NoNetwork, BrowserProblem.ComputerUnreachable -> Ionicon.CloudOfflineOutline
    BrowserProblem.Unavailable, BrowserProblem.LiveUnavailable -> Ionicon.LaptopOutline
    BrowserProblem.HostNotFound -> Ionicon.GlobeOutline
    BrowserProblem.ServerNotResponding -> Ionicon.ServerOutline
    BrowserProblem.TimedOut -> Ionicon.TimeOutline
    BrowserProblem.Insecure, BrowserProblem.Cleartext -> Ionicon.LockClosedOutline
    BrowserProblem.Crashed -> Ionicon.BugOutline
    is BrowserProblem.Unsupported -> Ionicon.LinkOutline
    is BrowserProblem.Http, is BrowserProblem.Other -> Ionicon.WarningOutline
}

/**
 * The page the browser shows instead of one that didn't open (iOS's
 * `BrowserFailureView` and `BrowserFailureLayout`): a 52 glyph, a 20/25
 * semibold title, a 15/20 sentence in the secondary colour and Try Again,
 * one under another (16, 8 and 24 apart), centred across in at most 320
 * with 32 to the sides, and 24 above the middle of the area it covers; a
 * block taller than that starts at its top. It covers the page whole, on
 * the screen's own surface.
 */
@Composable
fun BrowserFailurePage(problem: BrowserProblem, computer: String, host: String?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val (title, message) = browserProblemWords(problem, computer, host)
    Layout(
        content = {
            Box(Modifier.size(BrowserSpec.failureIcon), contentAlignment = Alignment.Center) {
                Glyph(browserProblemGlyph(problem), BrowserSpec.failureIcon, BrowserSpec.failureIconColor)
            }
            Text(
                title,
                style = happyTextStyle(fontSize = 20, lineHeight = 25, weight = FontWeight.SemiBold),
                color = colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag(BrowserTags.ERROR_TITLE).semantics { heading() },
            )
            Text(
                message,
                style = happyTextStyle(fontSize = 15, lineHeight = 20),
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag(BrowserTags.ERROR_MESSAGE),
            )
            Box(
                Modifier
                    .heightIn(min = 48.dp)
                    .clip(CircleShape)
                    .background(colors.surfaceHigh)
                    .combinedClickable(role = Role.Button, onClick = onRetry)
                    .padding(horizontal = 24.dp, vertical = 12.dp)
                    .testTag(BrowserTags.RETRY),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.browser_try_again),
                    style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold),
                    color = colors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        modifier = modifier.background(colors.surface).testTag(BrowserTags.ERROR),
    ) { measurables, constraints ->
        val width = (constraints.maxWidth - BrowserSpec.failureMargin.roundToPx() * 2).coerceIn(0, BrowserSpec.failureTextWidth.roundToPx())
        val icon = measurables[0].measure(Constraints.fixed(BrowserSpec.failureIcon.roundToPx(), BrowserSpec.failureIcon.roundToPx()))
        val text = Constraints(minWidth = width, maxWidth = width)
        val titlePlaceable = measurables[1].measure(text)
        val messagePlaceable = measurables[2].measure(text)
        val button = measurables[3].measure(Constraints(maxWidth = width))
        val messageGap = if (messagePlaceable.height > 0) BrowserSpec.failureTitleToMessage.roundToPx() else 0
        val height = icon.height + BrowserSpec.failureIconToTitle.roundToPx() + titlePlaceable.height + messageGap + messagePlaceable.height +
            BrowserSpec.failureMessageToButton.roundToPx() + button.height
        val layoutWidth = constraints.maxWidth
        val layoutHeight = if (constraints.hasBoundedHeight) constraints.maxHeight else height
        layout(layoutWidth, layoutHeight) {
            var y = ((layoutHeight - height) / 2 - BrowserSpec.failureLift.roundToPx()).coerceAtLeast(0)
            val middle = layoutWidth / 2
            icon.place(middle - icon.width / 2, y)
            y += icon.height + BrowserSpec.failureIconToTitle.roundToPx()
            titlePlaceable.place(middle - width / 2, y)
            y += titlePlaceable.height + messageGap
            messagePlaceable.place(middle - width / 2, y)
            y += messagePlaceable.height + BrowserSpec.failureMessageToButton.roundToPx()
            button.place(middle - button.width / 2, y)
        }
    }
}

/**
 * The browser's buttons for a bar (iOS 34aa464e1's two header groups):
 * back and forward, whose long press lists that way's history, then
 * reload (stop while loading) and share. On a browser screen they are its
 * bar's actions; embedded in an artifact, the artifact's.
 */
@Composable
fun RowScope.BrowserControls(state: BrowserState) {
    HistoryButton(state, forward = false)
    HistoryButton(state, forward = true)
    val stops = state.problem == null && state.loading
    IconButton(onClick = state::reloadOrStop, enabled = state.hasPage || state.problem != null, modifier = Modifier.testTag(BrowserTags.RELOAD)) {
        Icon(if (stops) MaterialSymbols.Close else MaterialSymbols.Refresh, stringResource(if (stops) R.string.browser_stop else R.string.files_reload))
    }
    ShareButton(state)
}

/** Back or forward: a tap goes one page, a long press lists the history that way, nearest first. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HistoryButton(state: BrowserState, forward: Boolean) {
    val haptics = LocalHapticFeedback.current
    val enabled = if (forward) state.canGoForward && state.problem == null else state.canGoBack
    var items by remember { mutableStateOf<List<BrowserHistoryItem>?>(null) }
    val label = stringResource(if (forward) R.string.browser_forward else R.string.common_back)
    Box {
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .combinedClickable(
                    enabled = enabled,
                    role = Role.Button,
                    indication = ripple(bounded = false, radius = 20.dp),
                    interactionSource = null,
                    onLongClick = {
                        val list = state.history(forward)
                        if (list.isNotEmpty()) {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            items = list
                        }
                    },
                    onClick = { if (forward) state.goForward() else state.goBack() },
                )
                .semantics { contentDescription = label }
                .testTag(if (forward) BrowserTags.FORWARD else BrowserTags.BACK),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (forward) MaterialSymbols.ChevronRight else MaterialSymbols.ChevronLeft,
                contentDescription = null,
                modifier = Modifier.alpha(if (enabled) 1f else 0.38f),
            )
        }
        TrackOverlay(items != null) { items = null }
        DropdownMenu(expanded = items != null && LocalPageActive.current, onDismissRequest = { items = null }) {
            items.orEmpty().forEach { item ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (item.host != null && item.host != item.title) {
                                Text(item.host, style = happyTextStyle(fontSize = 12, lineHeight = 16), color = HappyTheme.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    },
                    onClick = {
                        items = null
                        state.go(item)
                    },
                    modifier = Modifier.testTag(BrowserTags.HISTORY_ITEM),
                )
            }
        }
    }
}

/**
 * Share…, Copy Link, and Open in browser (outside proxy) (iOS's
 * `shareActions`). A bundled artifact's origin exists only in this app: its
 * share link is what is shared and copied (Copy link to artifact), and it
 * is never opened outside.
 */
@Composable
private fun ShareButton(state: BrowserState) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    val page = state.page
    val synthetic = page?.synthetic == true
    // A bundled artifact's origin exists only here: its share link is what can be shared, if its server has one.
    val shareUrl = if (synthetic) page.artifactId?.let(state.artifactLink) else if (page?.artifactId == null) state.currentUrl else page.url
    Box {
        IconButton(onClick = { open = true }, enabled = page != null && shareUrl != null, modifier = Modifier.testTag(BrowserTags.SHARE)) {
            Icon(MaterialSymbols.Share, stringResource(R.string.artifact_share))
        }
        TrackOverlay(open) { open = false }
        DropdownMenu(expanded = open && LocalPageActive.current, onDismissRequest = { open = false }) {
            if (shareUrl != null) {
                ShareItem(stringResource(R.string.browser_share_link), MaterialSymbols.Share) {
                    open = false
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, shareUrl)
                    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                ShareItem(stringResource(if (synthetic) R.string.share_link_copy_artifact else R.string.link_menu_copy), MaterialSymbols.ContentCopy) {
                    open = false
                    copy(context, shareUrl)
                }
            }
            if (!synthetic && shareUrl != null) {
                ShareItem(stringResource(R.string.browser_open_outside), MaterialSymbols.OpenInNew) {
                    open = false
                    openOutside(context, shareUrl)
                }
            }
        }
    }
}

@Composable
private fun ShareItem(text: String, icon: ImageVector, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(text) }, leadingIcon = { Icon(icon, null) }, onClick = onClick)
}

private fun copy(context: Context, url: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(url, url))
}

/**
 * The bar's words for the browser screen (iOS's `updateHeader`): the page's
 * title with its host under it; the host alone while the page has no title
 * or an error shows; [fallback] before anything is known.
 */
fun browserHeader(state: BrowserState, fallback: String): Pair<String, String?> {
    val address = if (state.problem != null) state.failedUrl else state.url ?: state.start
    val host = BrowserState.hostOf(address)?.takeUnless { it.endsWith(".invalid") }
    val title = if (state.problem == null) state.pageTitle else null
    return (title ?: host ?: fallback) to (if (title != null && host != title) host else null)
}
