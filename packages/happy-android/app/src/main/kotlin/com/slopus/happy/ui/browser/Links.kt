package com.slopus.happy.ui.browser

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.call.SheetStatusIcons
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch

object LinkTags {
    const val MENU = "links.menu"
    const val URL = "links.menu.url"
    const val IN_APP = "links.menu.inApp"
    const val EXTERNAL = "links.menu.external"
    const val COPY = "links.menu.copy"
    const val SHARE = "links.menu.share"
}

/**
 * Where a web link goes. Tapping one opens it the default way ([open]); a
 * long press offers the in-app browser, the phone's own browser, copying
 * and sharing ([LinkMenu]).
 *
 * With an agent connection open (Happy Protocol V2) the default and the
 * in-app choice are both the in-app browser through the agent ([proxied]),
 * as iOS's `openBrowser`; the outside browser is only ever asked for. On a
 * Happy (relay) account the default stays what it always was, the phone's
 * browser, and "in the app" is a Custom Tab on the phone's network: there is
 * no agent whose network a page could use.
 */
@Stable
class LinkOpener internal constructor(
    /** In-app pages go through an agent ("via [computer]"), never the phone's network. */
    val proxied: Boolean,
    val computer: String?,
    private val tap: (String) -> Unit,
    private val inApp: (String) -> Unit,
    private val external: (String) -> Unit,
    private val opensUrl: (String) -> Boolean = { true },
) {
    fun open(url: String) = tap(url)

    /** Whether a tap on [url] opens anything; false for an app's own link that goes nowhere here (a Happy link shown as a button is its words then). */
    fun opens(url: String): Boolean = opensUrl(url)
    fun openInApp(url: String) = inApp(url)
    fun openExternal(url: String) = external(url)

    /** The link whose menu is up. */
    var menu: String? by mutableStateOf(null)
        internal set

    fun showMenu(url: String) {
        menu = url
    }

    companion object {
        /**
         * Agent mode: what the app opens itself ([app]: a reference, a Happy
         * URL) there, web links in the in-app browser through [connectionId]
         * ([navigateBrowser] pushes it), anything else (`mailto:`, `tel:`) to
         * the system, as `BrowserPolicy.route` sorts them.
         */
        fun agent(
            context: Context,
            computer: String,
            app: (String) -> Boolean = { false },
            /** Whether one of the app's own links opens anything ([com.slopus.happy.ui.connection.HappyLinks.opens]); a screen that opens none, none. */
            opens: (String) -> Boolean = { url -> !com.slopus.happy.agent.HappyUrls.owns(url) && !HappyReferences.owns(url) },
            navigateBrowser: (String) -> Unit,
        ): LinkOpener {
            val browse = { url: String ->
                when {
                    app(url) -> Unit
                    BrowserPolicy.route(url) == BrowserPolicy.Route.Web -> navigateBrowser(url)
                    else -> openOutside(context, url).let {}
                }
            }
            return LinkOpener(proxied = true, computer = computer, tap = browse, inApp = browse, external = { openOutside(context, it) }, opensUrl = opens)
        }

        /**
         * Legacy mode: a tap does what [system] always did; "in the app" is a Custom Tab, [dark] or light as the app is.
         * [app] takes what the app opens itself first: a share link, on its agent connection.
         */
        fun legacy(context: Context, system: UriHandler, dark: Boolean = false, app: (String) -> Boolean = { false }): LinkOpener = LinkOpener(
            proxied = false,
            computer = null,
            // The app's own links are an agent connection's; the system has nothing to open them with.
            tap = { url -> if (!app(url) && !com.slopus.happy.agent.HappyUrls.owns(url) && !HappyReferences.owns(url)) system.openUri(url) },
            inApp = { url -> if (BrowserPolicy.route(url) == BrowserPolicy.Route.Web) openCustomTab(context, url, dark) else openOutside(context, url) },
            external = { openOutside(context, it) },
            opensUrl = { url -> !com.slopus.happy.agent.HappyUrls.owns(url) && !HappyReferences.owns(url) },
        )
    }
}

/** The screen's [LinkOpener]; null where links keep Compose's default (the system's [UriHandler]). */
val LocalLinkOpener = staticCompositionLocalOf<LinkOpener?> { null }

/**
 * Sends every link under [content] through [opener]: a [LinkAnnotation.Url]
 * and any `uriHandler.openUri` alike. Hosts [opener]'s long-press menu.
 */
@Composable
fun ProvideLinks(opener: LinkOpener, content: @Composable () -> Unit) {
    val handler = remember(opener) { object : UriHandler { override fun openUri(uri: String) = opener.open(uri) } }
    CompositionLocalProvider(LocalLinkOpener provides opener, LocalUriHandler provides handler) {
        content()
        LinkMenu(opener)
    }
}

/** A Custom Tab for [url] in the app's theme, not the system's, else whatever opens it. */
internal fun openCustomTab(context: Context, url: String, dark: Boolean) {
    try {
        CustomTabsIntent.Builder().setShowTitle(true)
            .setColorScheme(if (dark) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT)
            .build().apply { intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }.launchUrl(context, Uri.parse(url))
    } catch (_: ActivityNotFoundException) {
        openOutside(context, url)
    } catch (_: SecurityException) {
    }
}

/**
 * Taps and long presses on [text]'s web links, for a Text whose layout is
 * [layout]. The touch is taken in the initial pass, before the link's own
 * handler, the message's long-press copy menu or text selection see it: a
 * tap opens the link as its annotation would, a long press (with a haptic)
 * opens [LocalLinkOpener]'s menu and nothing else. Moving past the touch
 * slop lets go, so a drag that starts on a link still scrolls. The app's
 * own links ([HappyReferences.opensInApp]) only open, on a tap. Other links
 * that aren't web addresses, and screens without a [LinkOpener], are untouched.
 */
@Composable
fun Modifier.webLinkGestures(text: AnnotatedString, layout: State<TextLayoutResult?>): Modifier {
    if (!text.hasLinkAnnotations(0, text.length)) return this
    return webLinkGestures(text) { position -> layout.value?.let { linkAt(text, it, position) } }
}

/**
 * [webLinkGestures] for a node that draws its texts itself (a transcript
 * row): [find] gives the link under a point in the node, if any. [key]
 * changes when what the node draws does.
 */
@Composable
internal fun Modifier.webLinkGestures(key: Any, find: (Offset) -> Link?): Modifier {
    val opener = LocalLinkOpener.current ?: return this
    val haptics = LocalHapticFeedback.current
    val handler by rememberUpdatedState(LocalUriHandler.current)
    val linkAt by rememberUpdatedState(find)
    return this.pointerInput(key, opener) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val link = linkAt(down.position) ?: return@awaitEachGesture
            // The app's own links (a reference, a Happy URL) open on a tap and have no menu.
            val url = link.url
            if (url == null && link.target?.let(HappyReferences::opensInApp) != true) return@awaitEachGesture
            down.consume()
            val slop = viewConfiguration.touchSlop
            val ended = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id } ?: return@withTimeoutOrNull false
                    if (!change.pressed) {
                        change.consume()
                        return@withTimeoutOrNull true
                    }
                    if ((change.position - down.position).getDistance() > slop || event.changes.size > 1) return@withTimeoutOrNull false
                }
                @Suppress("UNREACHABLE_CODE") false
            }
            when (ended) {
                true -> link.activate(handler)
                false -> Unit
                null -> if (url != null) {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    opener.showMenu(url)
                    // The rest of this touch is the menu's: no click, copy menu or selection under it.
                    do {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        event.changes.forEach { it.consume() }
                    } while (event.changes.any { it.pressed })
                }
            }
        }
    }
}

/**
 * A long press on a control that opens [url] (a settings row): the same
 * menu as a link in text, [LocalLinkOpener]'s. Null where there is no
 * opener or [url] isn't a web address, so the control keeps no long press.
 * Pass it as the control's `onLongClick`; `combinedClickable` gives the
 * haptic.
 */
@Composable
fun rememberLinkMenu(url: String?): (() -> Unit)? {
    val opener = LocalLinkOpener.current ?: return null
    if (url == null || BrowserPolicy.route(url) != BrowserPolicy.Route.Web) return null
    return remember(opener, url) { { opener.showMenu(url) } }
}

/** A Text's layout for [webLinkGestures]: give the Text `onTextLayout = { layout.value = it }`. */
@Composable
fun rememberTextLayout(): MutableState<TextLayoutResult?> = remember { mutableStateOf(null) }

/** The link annotation under [position], if the point is on its text. */
internal fun linkAt(text: AnnotatedString, layout: TextLayoutResult, position: Offset): Link? {
    val offset = layout.getOffsetForPosition(position)
    for (index in listOf(offset, offset - 1)) {
        if (index !in text.indices) continue
        if (!layout.getBoundingBox(index).inflate(4f).contains(position)) continue
        val item = text.getLinkAnnotations(index, index + 1).firstOrNull()?.item ?: continue
        return Link(item)
    }
    return null
}

/** A link in text: where it goes ([target]), its web address if that is one ([url]), and what tapping it does. */
internal class Link(private val annotation: LinkAnnotation) {
    val target: String? = when (annotation) {
        is LinkAnnotation.Url -> annotation.url
        is LinkAnnotation.Clickable -> annotation.tag
        else -> null
    }
    // A share link is the app's own to open, not a page: it has no browser menu (desktop 5a4c075c).
    val url: String? = target?.takeIf { BrowserPolicy.route(it) == BrowserPolicy.Route.Web && com.slopus.happy.agent.HappyShareLinks.parse(it) == null }

    fun activate(handler: UriHandler) {
        val listener = annotation.linkInteractionListener
        when {
            listener != null -> listener.onClick(annotation)
            annotation is LinkAnnotation.Url -> handler.openUri(annotation.url)
        }
    }
}

/**
 * A link's long-press menu: a Material bottom sheet (it slides up and back
 * down) with the address, then Open in Happy browser ("via <computer>" in
 * agent mode, a Custom Tab on the phone's network otherwise), Open in
 * external browser, Copy link and Share. A choice closes the sheet first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LinkMenu(opener: LinkOpener) {
    val url = opener.menu ?: return
    val colors = HappyTheme.colors
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    fun choose(action: suspend () -> Unit) {
        scope.launch {
            sheet.hide()
            opener.menu = null
            action()
        }
    }
    TrackOverlay(true) { opener.menu = null }
    if (!com.slopus.happy.ui.components.LocalPageActive.current) return
    ModalBottomSheet(
        onDismissRequest = { opener.menu = null },
        sheetState = sheet,
        containerColor = colors.surface,
        modifier = Modifier.testTag(LinkTags.MENU),
    ) {
        SheetStatusIcons()
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            Text(
                url,
                style = happyTextStyle(fontSize = 13, lineHeight = 18),
                color = colors.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 12.dp).testTag(LinkTags.URL),
            )
            HorizontalDivider(thickness = 0.5.dp, color = colors.divider)
            MenuRow(
                MaterialSymbols.Public,
                stringResource(R.string.link_menu_open_in_app),
                opener.computer?.let { stringResource(R.string.browser_via, it) } ?: stringResource(R.string.link_menu_open_in_app_direct),
                LinkTags.IN_APP,
            ) { choose { opener.openInApp(url) } }
            MenuRow(
                MaterialSymbols.OpenInNew,
                stringResource(R.string.link_menu_open_external),
                if (opener.proxied) stringResource(R.string.link_menu_open_external_proxied) else null,
                LinkTags.EXTERNAL,
            ) { choose { opener.openExternal(url) } }
            MenuRow(MaterialSymbols.ContentCopy, stringResource(R.string.link_menu_copy), null, LinkTags.COPY) {
                choose { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(url, url))) }
            }
            MenuRow(MaterialSymbols.Share, stringResource(R.string.link_menu_share), null, LinkTags.SHARE) {
                choose {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
                    runCatching { context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
            }
        }
    }
}

@Composable
private fun MenuRow(icon: ImageVector, title: String, subtitle: String?, tag: String, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 8.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = colors.textSecondary)
        Spacer(Modifier.width(20.dp))
        Column {
            Text(title, style = happyTextStyle(fontSize = 16, lineHeight = 22), color = colors.text)
            if (subtitle != null) Text(subtitle, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary)
        }
    }
}
