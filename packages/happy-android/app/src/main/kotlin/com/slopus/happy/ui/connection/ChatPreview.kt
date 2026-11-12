package com.slopus.happy.ui.connection

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.MessageLiftSpec
import com.slopus.happy.ui.components.GlassColors
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.PageBackHandler
import com.slopus.happy.ui.components.glass
import com.slopus.happy.ui.components.glassBlurs
import com.slopus.happy.ui.components.glassSource
import com.slopus.happy.ui.components.rememberGlassBlur
import com.slopus.happy.ui.components.rememberGlassSource
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.conversation.ConversationRowView
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.WidthClass
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * A home row's conversation previewed by a hold (iOS bf177c134, HoldView,
 * PreviewLayout and HoldLayout; Telegram's chat list preview,
 * `ContextControllerExtractedPresentationNode`): its numbers.
 */
object ChatPreviewSpec {
    /** The card keeps this far from the screen's sides, and from its top and foot before the insets. */
    val inset = 12.dp
    /** At most this wide on a medium or expanded window. */
    val maxWidth = 400.dp
    val maxHeight = 460.dp
    /** HoldLayout: the card stays 8 under the status bar and 10 over the navigation bar. */
    val topInset = 8.dp
    val bottomInset = 10.dp
    /** HoldLayout keeps this under the card for its menu, kept with none. */
    val spacing = 10.dp
    val corner = 30.dp

    /** The name's capsule: 10 from the card's top, 44 tall, 16 either side of the name, 16 clear of the card's sides. */
    val pillTop = 10.dp
    val pillHeight = 44.dp
    val pillPadding = 16.dp
    val pillMargin = 16.dp
    /** Under the capsule and under the newest message. */
    val listGap = 8.dp
    /** How far under the capsule older messages take to come in whole. */
    val fade = 24.dp
    val title = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)

    /** The menu under the card, where the held row may be archived: one 48 row in a 14-cornered capsule. */
    val menuHeight = 48.dp
    val menuCorner = 14.dp
    val menuWidth = 220.dp
    val menuPadding = 16.dp
    val menuText = TextStyle(fontSize = 17.sp, lineHeight = 22.sp)

    /** The card grows out of the row in this long while it fades in (iOS 0.15 s). */
    const val CARD_FADE_MS = 150
    /** The blur and dim come in, and everything goes back into the row, over 0.2 s. */
    const val BACKDROP_MS = 200
    const val DISMISS_MS = 200

    /** iOS's `.easeInEaseOut`. */
    val easeInOut = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)

    /** The card out of the row: Telegram's `makeSpringBounceAnimation` (mass 5, stiffness 900, damping 104), the message lift's. */
    val grow: AnimationSpec<Float> = spring(MessageLiftSpec.dampingRatio, MessageLiftSpec.stiffness)

    /** Back into the row. */
    val shrink: AnimationSpec<Float> = tween(DISMISS_MS, easing = easeInOut)

    /**
     * Where the card goes, in pixels: the screen less [inset] a side (at
     * most [maxWidth] when [regular]), [maxHeight] tall or the room between
     * the insets, centred, then kept [topInset] under the status bar and
     * [bottomInset] over the navigation bar, with [menu] (pixels) kept
     * free under it for its menu.
     */
    fun card(screen: Size, top: Float, bottom: Float, regular: Boolean, px: (Dp) -> Float, menu: Float = 0f): Rect {
        var width = max(0f, screen.width - px(inset) * 2)
        if (regular) width = min(width, px(maxWidth))
        val wanted = min(px(maxHeight), max(0f, screen.height - px(inset) * 2 - top - bottom))
        val ceiling = top + px(topInset)
        val floorY = screen.height - bottom - px(bottomInset)
        val height = min(wanted, max(0f, floorY - ceiling - px(spacing) - menu))
        var y = floor((screen.height - height) / 2)
        val overrun = y + height + px(spacing) + menu - floorY
        if (overrun > 0) y -= overrun
        y = max(ceiling, y)
        val x = floor((screen.width - width) / 2)
        return Rect(x, y, x + width, y + height)
    }
}

object ChatPreviewTags {
    const val SCRIM = "chatPreview.scrim"
    const val ARCHIVE = "chatPreview.archive"
    const val CARD = "chatPreview.card"
    const val TITLE = "chatPreview.title"
    const val LIST = "chatPreview.list"
    const val LOADING = "chatPreview.loading"
}

/** The held row, while its preview shows: [source] is where the row was, in the window. */
@Stable
class ChatPreview {
    class Held internal constructor(val row: AgentFeedRow.Conversation, internal val source: Rect)

    var held by mutableStateOf<Held?>(null)
        private set

    internal var closing by mutableStateOf(false)
        private set

    /** The card was tapped: the row opens under it, which then fades. */
    internal var opening by mutableStateOf(false)
        private set

    /** How far home behind has blurred and dimmed, 0 to 1. */
    internal val backdrop = Animatable(0f)

    fun open(row: AgentFeedRow.Conversation, source: Rect) {
        if (held != null) return
        held = Held(row, source)
        closing = false
        opening = false
    }

    /** Back into the row. */
    fun close() {
        if (held != null && !opening) closing = true
    }

    internal fun opened() {
        if (held != null && !closing) opening = true
    }

    internal fun done(held: Held) {
        if (this.held === held) {
            this.held = null
            closing = false
            opening = false
        }
    }
}

/** Home behind a preview, blurred as it dims ([ChatPreview.backdrop]). */
fun Modifier.chatPreviewBackdrop(preview: ChatPreview, blur: Float): Modifier = graphicsLayer {
    val p = preview.backdrop.value
    renderEffect = if (p > 0f && glassBlurs()) BlurEffect(blur * p, blur * p, TileMode.Decal) else null
}

/**
 * The held row's preview over home, which this box fills: the dim, and
 * the card grown out of the row on Telegram's spring (mass 5, stiffness
 * 900, damping 104) while it fades in over 0.15 s. A tap on the card opens
 * the chat under it and everything fades over 0.2 s; a tap beside it or
 * Back puts it back into the row over 0.2 s. [content] is the card's
 * inside: the conversation's newest messages, read only.
 */
@Composable
fun BoxScope.ChatPreviewOverlay(
    preview: ChatPreview,
    onOpen: (agentId: String) -> Unit,
    /** Archive under the card, for a row that names what it archives ([AgentFeedRow.Conversation.archive]); null offers none. */
    onArchive: ((AgentFeedRow.Conversation) -> Unit)? = null,
    content: @Composable (AgentFeedRow.Conversation) -> Unit,
) {
    val held = preview.held ?: return
    val density = LocalDensity.current
    val colors = HappyTheme.colors
    val place = remember(held) { Animatable(0f) }
    val shown = remember(held) { Animatable(0f) }
    val closing = preview.closing
    val opening = preview.opening
    LaunchedEffect(held, closing, opening) {
        when {
            opening -> {
                coroutineScope {
                    launch { preview.backdrop.animateTo(0f, tween(ChatPreviewSpec.DISMISS_MS, easing = ChatPreviewSpec.easeInOut)) }
                    launch { shown.animateTo(0f, tween(ChatPreviewSpec.DISMISS_MS, easing = ChatPreviewSpec.easeInOut)) }
                }
                preview.done(held)
            }
            closing -> {
                coroutineScope {
                    launch { preview.backdrop.animateTo(0f, tween(ChatPreviewSpec.DISMISS_MS, easing = ChatPreviewSpec.easeInOut)) }
                    launch { shown.animateTo(0f, tween((ChatPreviewSpec.DISMISS_MS * 0.8f).toInt(), easing = ChatPreviewSpec.easeInOut)) }
                    launch { place.animateTo(0f, ChatPreviewSpec.shrink) }
                }
                preview.done(held)
            }
            else -> coroutineScope {
                launch { preview.backdrop.animateTo(1f, tween(ChatPreviewSpec.BACKDROP_MS, easing = ChatPreviewSpec.easeInOut)) }
                launch { shown.animateTo(1f, tween(ChatPreviewSpec.CARD_FADE_MS, easing = ChatPreviewSpec.easeInOut)) }
                launch { place.animateTo(1f, ChatPreviewSpec.grow) }
            }
        }
    }
    PageBackHandler { preview.close() }
    var screen by remember { mutableStateOf(Size.Zero) }
    val top = WindowInsets.statusBars.getTop(density).toFloat()
    val bottom = WindowInsets.navigationBars.getBottom(density).toFloat()
    val regular = LocalWindowLayout.current.widthClass != WidthClass.Compact
    val archive = onArchive?.takeIf { held.row.archive != null }
    val menu = if (archive != null) with(density) { (ChatPreviewSpec.menuHeight + ChatPreviewSpec.spacing).toPx() } else 0f
    val card = remember(screen, top, bottom, regular, menu) { ChatPreviewSpec.card(screen, top, bottom, regular, { with(density) { it.toPx() } }, menu) }
    val dim = if (colors.dark) MessageLiftSpec.dimDark else MessageLiftSpec.dimLight
    val close = stringResource(R.string.conversation_close)
    Box(
        Modifier
            .matchParentSize()
            .onSizeChanged { screen = Size(it.width.toFloat(), it.height.toFloat()) }
            .graphicsLayer { alpha = preview.backdrop.value }
            .background(dim)
            .clickable(interactionSource = null, indication = null, role = Role.Button) { preview.close() }
            .semantics { contentDescription = close }
            .testTag(ChatPreviewTags.SCRIM),
    )
    if (screen == Size.Zero) return
    // The card grows from the row: its centre from the row's, its scale from nothing.
    val distance = card.center.y - held.source.center.y
    val title = held.row.title ?: stringResource(R.string.session_new_chat)
    Box(
        Modifier
            .offset { IntOffset(card.left.toInt(), card.top.toInt()) }
            .size(with(density) { card.width.toDp() }, with(density) { card.height.toDp() })
            .graphicsLayer {
                val p = place.value
                translationY = -distance * (1 - p)
                val scale = lerp(0.01f, 1f, p)
                scaleX = scale
                scaleY = scale
                alpha = shown.value
            }
            .clip(RoundedCornerShape(ChatPreviewSpec.corner))
            .background(colors.surface)
            .testTag(ChatPreviewTags.CARD),
    ) {
        content(held.row)
        // Read only: a tap anywhere on it opens the chat, as iOS's card does.
        Box(
            Modifier
                .matchParentSize()
                .semantics { contentDescription = title }
                .clickable(interactionSource = null, indication = null, role = Role.Button) {
                    if (preview.opening || preview.closing) return@clickable
                    preview.opened()
                    onOpen(held.row.agentId)
                },
        )
    }
    // HoldLayout's menu, [ChatPreviewSpec.spacing] under the card, coming and going with it.
    if (archive != null) {
        val label = stringResource(R.string.session_archive_action)
        Row(
            Modifier
                .offset { IntOffset(card.left.toInt(), (card.bottom + with(density) { ChatPreviewSpec.spacing.toPx() }).toInt()) }
                .width(minOf(with(density) { card.width.toDp() }, ChatPreviewSpec.menuWidth))
                .height(ChatPreviewSpec.menuHeight)
                .graphicsLayer {
                    translationY = -distance * (1 - place.value)
                    alpha = shown.value
                }
                .clip(RoundedCornerShape(ChatPreviewSpec.menuCorner))
                .background(colors.surface)
                .clickable(role = Role.Button) {
                    if (preview.opening || preview.closing) return@clickable
                    preview.close()
                    archive(held.row)
                }
                .padding(horizontal = ChatPreviewSpec.menuPadding)
                .testTag(ChatPreviewTags.ARCHIVE),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = ChatPreviewSpec.menuText, color = colors.status.error, modifier = Modifier.weight(1f))
            Icon(Ionicon.ArchiveOutline, size = 20.dp, color = colors.status.error)
        }
    }
}

/**
 * A preview card's inside (iOS ChatViewController `previewing`): the
 * conversation's newest messages resting at the card's foot, the newest
 * read from its start, under the name in a glass capsule; older messages
 * go in under the card's own ground above the capsule's foot. Nothing in
 * it is touched, and nothing it shows is marked read.
 */
@Composable
fun ChatPreviewTranscript(title: String, state: ConversationState, bubble: BubblePalette, actions: ConversationRowActions) {
    val colors = HappyTheme.colors
    val density = LocalDensity.current
    val listState = rememberLazyListState()
    val glass = rememberGlassSource(colors.surface)
    val blurs = rememberGlassBlur()
    val listTop = ChatPreviewSpec.pillTop + ChatPreviewSpec.pillHeight + ChatPreviewSpec.listGap
    // The card rests on the newest message, also once the computer's come after the kept ones (the list would
    // otherwise hold its old first row in place); one taller than the card shows from its start (iOS `showsNewestFromItsStart`).
    LaunchedEffect(listState, state.rows.firstOrNull()?.key) {
        if (state.rows.isEmpty()) return@LaunchedEffect
        listState.requestScrollToItem(0)
        val info = snapshotFlow { listState.layoutInfo }.first { info -> info.visibleItemsInfo.firstOrNull()?.let { it.index == 0 && it.offset <= 0 } == true }
        val newest = info.visibleItemsInfo.first()
        val room = info.viewportEndOffset - info.viewportStartOffset - info.beforeContentPadding - info.afterContentPadding
        if (newest.size > room) listState.requestScrollToItem(0, newest.size - room)
    }
    Box(Modifier.fillMaxSize()) {
        if (!state.loaded && state.rows.isEmpty()) {
            CircularProgressIndicator(
                Modifier.align(Alignment.Center).size(16.dp).testTag(ChatPreviewTags.LOADING),
                color = colors.textSecondary,
                strokeWidth = 2.dp,
            )
        }
        LazyColumn(
            state = listState,
            reverseLayout = true,
            userScrollEnabled = false,
            contentPadding = PaddingValues(top = listTop, bottom = ChatPreviewSpec.listGap),
            modifier = Modifier.fillMaxSize().glassSource(glass).testTag(ChatPreviewTags.LIST),
        ) {
            items(state.rows, key = ConversationRow::key, contentType = { it::class }) { row ->
                ConversationRowView(row, bubble, actions)
            }
        }
        // The ground over what scrolled under the name: whole to the capsule's foot, gone 24 under it.
        val under by remember(listState) { derivedStateOf { listState.canScrollForward } }
        if (under) {
            val clear = ChatPreviewSpec.pillTop + ChatPreviewSpec.pillHeight
            val opaque = clear + ChatPreviewSpec.fade
            val stop = with(density) { clear.toPx() / opaque.toPx() }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(opaque)
                    .background(Brush.verticalGradient(0f to colors.surface, stop to colors.surface, 1f to colors.surface.copy(alpha = 0f))),
            )
        }
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .padding(top = ChatPreviewSpec.pillTop, start = ChatPreviewSpec.pillMargin, end = ChatPreviewSpec.pillMargin)
                .height(ChatPreviewSpec.pillHeight)
                .glass(glass, CircleShape, GlassColors.of(colors.dark), blurs)
                .padding(horizontal = ChatPreviewSpec.pillPadding)
                .semantics { heading() }
                .testTag(ChatPreviewTags.TITLE),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                title,
                style = ChatPreviewSpec.title,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
