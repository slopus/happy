package com.slopus.happy.ui.attach

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.attachments.GalleryItem
import com.slopus.happy.attachments.RecentFile
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.rememberGlassSource
import com.slopus.happy.ui.components.glassSource
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.layout.ContentTokens
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.min
import kotlin.math.roundToInt

object AttachTags {
    const val SHEET = "attach.sheet"
    const val SCRIM = "attach.scrim"
    const val GRABBER = "attach.grabber"
    const val HEADER = "attach.header"
    const val TOP_BAR = "attach.topBar"
    const val GALLERY = "attach.gallery"
    const val CELL = "attach.gallery.cell"
    const val CHECK = "attach.gallery.check"
    const val VIDEO_BADGE = "attach.gallery.video"
    const val ASK = "attach.gallery.ask"
    const val ALLOW = "attach.gallery.allow"
    const val PARTIAL = "attach.gallery.partial"
    const val MANAGE = "attach.gallery.manage"
    const val EMPTY = "attach.gallery.empty"
    const val FILES = "attach.files"
    const val BROWSE = "attach.files.browse"
    const val FILES_GALLERY = "attach.files.gallery"
    const val PASTE = "attach.files.paste"
    const val RECENT = "attach.files.recent"
    const val FILE_ROW = "attach.files.row"
    const val TAB_BAR = "attach.tabs"
    const val CAPTION_BAR = "attach.captionBar"
    const val CAPTION = "attach.caption"
    const val SEND = "attach.send"
    const val COUNTER = "attach.counter"

    fun tab(kind: AttachTabKind) = "attach.tab." + kind.name.lowercase()
}

/**
 * The sheet's motion (research/attachment-menu.md): it comes up on
 * Telegram's spring as the scrim comes in on its own 400 ms clock, which
 * the tabs pop on; it goes down by its height and 10 in 250 ms. [drag] is
 * how far a pull at the list's top (or a predictive back) has moved it.
 */
@Stable
class AttachSheetMotion(settled: Boolean = false) {
    internal val enter = Animatable(if (settled) 1f else 0f)
    internal val scrim = Animatable(if (settled) 1f else 0f)
    internal val clock = Animatable(if (settled) AttachMotion.TABS_MS * 2f else 0f)
    internal val away = Animatable(0f)
    internal var drag by mutableFloatStateOf(0f)
    var closing by mutableStateOf(false)
        private set

    /** Set by the layout: the window's height and where the sheet's top is now, in px. */
    internal var height = 0f
    internal var top: () -> Float = { 0f }

    /** The sheet's offset down from where it rests. */
    internal fun translation(): Float = (1 - enter.value) * height + drag + away.value

    suspend fun open(reduceMotion: Boolean) = coroutineScope {
        if (reduceMotion) {
            enter.snapTo(1f)
            scrim.snapTo(1f)
            clock.snapTo(AttachMotion.TABS_MS * 2f)
            return@coroutineScope
        }
        launch { enter.animateTo(1f, spring(AttachMotion.OPEN_DAMPING, AttachMotion.OPEN_STIFFNESS, visibilityThreshold = 0.0005f)) }
        launch {
            delay(AttachMotion.SCRIM_DELAY_MS.toLong())
            scrim.animateTo(1f, tween(AttachMotion.SCRIM_MS, easing = AttachMotion.scrim))
        }
        launch {
            delay(AttachMotion.SCRIM_DELAY_MS.toLong())
            clock.animateTo(AttachMotion.TABS_MS.toFloat(), tween(AttachMotion.TABS_MS, easing = LinearEasing))
        }
    }

    /** Down past the window's foot, the scrim out with it. */
    suspend fun close(extra: Float, reduceMotion: Boolean) = coroutineScope {
        closing = true
        val distance = (height - (top() + drag)) + extra
        val spec = if (reduceMotion) snap() else tween<Float>(AttachMotion.CLOSE_MS, easing = AttachMotion.easeOut)
        launch { away.animateTo(distance.coerceAtLeast(0f), spec) }
        launch { scrim.animateTo(0f, spec) }
    }

    /** Let go short of [threshold]: back home in 250 ms for a full one, less for less. */
    internal suspend fun springBack(threshold: Float) {
        val ms = AttachMotion.springBackMs(drag, threshold)
        animate(drag, 0f, animationSpec = tween(ms, easing = AttachMotion.default)) { value, _ -> drag = value }
    }
}

/**
 * Telegram's attachment sheet as one window-filling layout (the Dialog
 * is [AttachSheet]'s): the 0.2 scrim, and the sheet, at most
 * [ContentTokens.sheetMaxWidth] wide and centred. The sheet is its list:
 * the grid (or the file list) fills it, its top padding the empty space
 * above, so its first row rests at 2/5 of the height and scrolling it up
 * raises the sheet's top until it meets the top bar, where the corners go
 * square. A pull down at the list's top moves the sheet, and it goes once
 * pulled 0.8 cm. The tab bar floats at its foot on glass, and gives way to
 * the caption bar once something is picked.
 */
@Composable
internal fun AttachSheetLayout(
    tabs: List<AttachTabKind>,
    tab: AttachTabKind,
    onTab: (AttachTabKind) -> Unit,
    gallery: GalleryContent,
    sources: FileSources,
    recent: List<RecentFile>,
    selection: AttachSelection,
    caption: String,
    onCaptionChange: (String) -> Unit,
    motion: AttachSheetMotion,
    onClose: () -> Unit,
    onSend: () -> Unit,
    onToggleGallery: (GalleryItem) -> Unit,
    onOpenGallery: (GalleryItem) -> Unit,
    onToggleFile: (RecentFile) -> Unit,
    onAllow: () -> Unit,
    onManage: () -> Unit,
    onBrowse: () -> Unit,
    onFilesGallery: () -> Unit,
    onPaste: () -> Unit,
    modifier: Modifier = Modifier,
    sending: Boolean = false,
    galleryState: LazyGridState = rememberLazyGridState(),
    filesState: LazyListState = rememberLazyListState(),
) {
    val theme = HappyTheme.colors
    val colors = remember(theme.dark) { AttachColors.of(theme.dark) }
    val sheetColor = theme.surface
    val density = LocalDensity.current
    val reduceMotion = rememberReduceMotion()
    val statusBar = WindowInsets.statusBars.getTop(density).toFloat()
    val bottomInsets = WindowInsets.ime.union(WindowInsets.navigationBars)
    val bottom = bottomInsets.asPaddingValues().calculateBottomPadding()
    val dismissAt = LocalContext.current.resources.displayMetrics.xdpi / 2.54f * AttachSpec.DISMISS_CM

    BoxWithConstraints(modifier.fillMaxSize()) {
        val height = constraints.maxHeight.toFloat()
        val sheetWidth = min(maxWidth, ContentTokens.sheetMaxWidth)
        val landscape = maxWidth > maxHeight
        val columns = AttachSpec.columns(sheetWidth)
        val rest = with(density) {
            statusBar + (height - statusBar) * (if (landscape) AttachSpec.RESTING_LANDSCAPE else AttachSpec.RESTING) + AttachSpec.restingNudge.toPx()
        }
        val restDp = with(density) { rest.toDp() }
        val listPadding = PaddingValues(
            start = AttachSpec.gridPadding,
            end = AttachSpec.gridPadding,
            top = restDp,
            bottom = AttachSpec.tabBar + bottom,
        )

        // Picked: the header comes in and the sheet grows 26 at its top.
        val picked = selection.count > 0
        val headerProgress by animateFloatAsState(
            if (picked) 1f else 0f,
            if (reduceMotion) snap() else tween(AttachMotion.HEADER_MS, easing = AttachMotion.decelerate),
            label = "header",
        )
        val captionProgress = remember { Animatable(if (picked) 1f else 0f) }
        LaunchedEffect(picked) {
            captionProgress.animateTo(if (picked) 1f else 0f, if (reduceMotion) snap() else tween(AttachMotion.CAPTION_MS, easing = AttachMotion.decelerate))
        }

        // Tabs: the old page goes down 78 and out, the new one comes in and springs home.
        var current by remember { mutableStateOf(tab) }
        var leaving by remember { mutableStateOf<AttachTabKind?>(null) }
        val phase = remember { Animatable(1f) }
        val settle = remember { Animatable(0f) }
        val switchShift = with(density) { AttachSpec.switchShift.toPx() }
        LaunchedEffect(tab) {
            if (tab == current) return@LaunchedEffect
            if (reduceMotion) {
                current = tab
                return@LaunchedEffect
            }
            leaving = current
            current = tab
            settle.snapTo(0f)
            phase.snapTo(0f)
            phase.animateTo(1f, tween(AttachMotion.SWITCH_MS, easing = AttachMotion.default))
            leaving = null
            settle.snapTo(switchShift)
            settle.animateTo(0f, spring(AttachMotion.SWITCH_DAMPING, AttachMotion.SWITCH_STIFFNESS))
        }

        fun firstRow(kind: AttachTabKind): Float {
            val (index, offset) = when (kind) {
                AttachTabKind.Gallery -> galleryState.layoutInfo.visibleItemsInfo.firstOrNull()?.let { it.index to it.offset.y }
                AttachTabKind.Files -> filesState.layoutInfo.visibleItemsInfo.firstOrNull()?.let { it.index to it.offset }
            } ?: (0 to 0)
            return if (index == 0) rest + offset else Float.NEGATIVE_INFINITY
        }
        val over = with(density) { AttachSpec.sheetOverRow.toPx() }
        val headerPx = with(density) { AttachSpec.header.toPx() }
        val reach = with(density) { (AttachSpec.topBar + AttachSpec.topBarReach).toPx() }
        fun rawTop(): Float {
            val now = firstRow(current) - over - headerPx * headerProgress
            val old = leaving ?: return now
            val before = firstRow(old) - over - headerPx * headerProgress
            val p = phase.value
            return before.coerceAtLeast(0f) + (now.coerceAtLeast(0f) - before.coerceAtLeast(0f)) * p
        }
        val expanded by remember { derivedStateOf { firstRow(current) <= statusBar + reach } }
        val topBar by animateFloatAsState(
            if (expanded) 1f else 0f,
            if (reduceMotion) snap() else tween(AttachMotion.TOP_BAR_MS),
            label = "top bar",
        )
        fun sheetTop(): Float {
            val raw = rawTop()
            val floor = raw.coerceAtLeast(0f)
            return min(raw, floor * (1 - topBar)).coerceAtLeast(0f)
        }
        SideEffect {
            motion.height = height
            motion.top = ::sheetTop
        }

        val connection = remember(dismissAt) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    if (available.y < 0 && motion.drag > 0) {
                        val take = min(motion.drag, -available.y)
                        motion.drag -= take
                        return Offset(0f, -take)
                    }
                    return Offset.Zero
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    if (source == NestedScrollSource.UserInput && available.y > 0 && !motion.closing) {
                        motion.drag += available.y
                        return Offset(0f, available.y)
                    }
                    return Offset.Zero
                }

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (motion.drag <= 0f) return Velocity.Zero
                    if (motion.drag >= dismissAt) onClose() else motion.springBack(dismissAt)
                    return available
                }
            }
        }

        // The scrim: a tap on it closes.
        Box(
            Modifier
                .fillMaxSize()
                .drawBehind { drawRect(Color.Black.copy(alpha = (AttachSpec.SCRIM_ALPHA * motion.scrim.value).coerceIn(0f, 1f))) }
                .pointerInput(Unit) { detectTapGestures { onClose() } }
                .testTag(AttachTags.SCRIM),
        )

        val corner = with(density) { AttachSpec.corner.toPx() }
        val source = rememberGlassSource(sheetColor)
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .width(sheetWidth)
                .fillMaxHeight()
                .graphicsLayer { translationY = motion.translation() }
                .pointerInput(Unit) {
                    // Over the sheet's top, where the list is empty, a tap closes too.
                    detectTapGestures { if (it.y < sheetTop() && topBar == 0f) onClose() }
                }
                .drawBehind {
                    val top = sheetTop()
                    val radius = corner * (1 - topBar)
                    val path = Path().apply {
                        addRoundRect(
                            RoundRect(
                                left = 0f,
                                top = top,
                                right = size.width,
                                // Past the foot, so the spring's overshoot shows sheet, not window.
                                bottom = size.height * 2,
                                topLeftCornerRadius = CornerRadius(radius),
                                topRightCornerRadius = CornerRadius(radius),
                            ),
                        )
                    }
                    drawPath(path, sheetColor)
                }
                .nestedScroll(connection)
                .testTag(AttachTags.SHEET),
        ) {
            Box(Modifier.fillMaxSize().glassSource(source)) {
                @Composable
                fun Page(kind: AttachTabKind, pageModifier: Modifier) {
                    when (kind) {
                        AttachTabKind.Gallery -> AttachGalleryPage(
                            gallery, selection, columns, listPadding, galleryState, sheetColor, colors,
                            onToggle = onToggleGallery, onOpen = onOpenGallery, onAllow = onAllow, onManage = onManage, modifier = pageModifier,
                        )
                        AttachTabKind.Files -> AttachFilesPage(
                            sources, recent, selection,
                            PaddingValues(top = restDp, bottom = AttachSpec.tabBar + bottom),
                            filesState, sheetColor, colors,
                            onBrowse = onBrowse, onGallery = onFilesGallery, onPaste = onPaste, onToggle = onToggleFile, modifier = pageModifier,
                        )
                    }
                }
                leaving?.let { old ->
                    Page(old, Modifier.graphicsLayer {
                        translationY = switchShift * phase.value
                        alpha = 1 - (phase.value / AttachMotion.SWITCH_FADE).coerceAtMost(1f)
                    })
                }
                Page(current, Modifier.graphicsLayer {
                    translationY = if (leaving != null) switchShift * phase.value else settle.value
                    alpha = if (leaving != null) phase.value else 1f
                })
            }

            // The grabber, giving way to the header as something is picked.
            Box(
                Modifier
                    .align(Alignment.TopCenter)
                    .offset { IntOffset(0, (sheetTop() + AttachSpec.grabberTop.toPx()).roundToInt()) }
                    .size(AttachSpec.grabberWidth, AttachSpec.grabberHeight)
                    .graphicsLayer { alpha = (1 - headerProgress) * (1 - topBar) }
                    .background(colors.grabber, RoundedCornerShape(AttachSpec.grabberHeight / 2))
                    .testTag(AttachTags.GRABBER),
            )
            if (selection.count > 0 || headerProgress > 0f) {
                SelectedHeader(
                    selection.count.coerceAtLeast(1),
                    Modifier
                        .offset { IntOffset(23.dp.roundToPx(), (sheetTop() + 15.dp.toPx()).roundToInt()) }
                        .graphicsLayer { alpha = headerProgress * (1 - topBar) },
                )
            }

            // At the top: the bar over the status bar, Back and the tab's name.
            if (topBar > 0f) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .graphicsLayer { alpha = topBar }
                        .background(sheetColor)
                        .padding(top = with(density) { statusBar.toDp() })
                        .height(AttachSpec.topBar)
                        .testTag(AttachTags.TOP_BAR),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onClose) {
                        Icon(MaterialSymbols.ArrowBack, stringResource(R.string.common_back), tint = theme.text)
                    }
                    Text(
                        if (selection.count > 0) pluralSelected(selection.count) else stringResource(tabTitle(current)),
                        style = happyTextStyle(20, weight = FontWeight.SemiBold),
                        color = theme.text,
                        maxLines = 1,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }

            // The foot: the list fades under the bars.
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(AttachSpec.bottomFade + bottom)
                    .background(Brush.verticalGradient(0f to sheetColor.copy(alpha = 0f), 0.6f to sheetColor.copy(alpha = 0.85f), 1f to sheetColor)),
            )
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(bottom = bottom)) {
                if (captionProgress.value < 1f) {
                    AttachTabBar(
                        tabs,
                        current,
                        onTab,
                        openElapsed = { motion.clock.value },
                        backdrop = source,
                        colors = colors,
                        modifier = Modifier.graphicsLayer {
                            val p = captionProgress.value
                            translationY = AttachSpec.captionShift.toPx() * p
                            alpha = 1 - p
                        },
                    )
                }
                if (captionProgress.value > 0f) {
                    AttachCaptionBar(
                        caption,
                        onCaptionChange,
                        selection.count,
                        onSend,
                        sending = sending,
                        shown = { captionProgress.value },
                        backdrop = source,
                        sheet = sheetColor,
                        colors = colors,
                        modifier = Modifier.align(Alignment.BottomCenter),
                    )
                }
            }
        }
    }
}

@Composable
private fun pluralSelected(count: Int): String =
    androidx.compose.ui.res.pluralStringResource(R.plurals.attach_selected, count, count)

internal fun tabTitle(kind: AttachTabKind): Int = when (kind) {
    AttachTabKind.Gallery -> R.string.attach_tab_gallery
    AttachTabKind.Files -> R.string.attach_tab_files
}
