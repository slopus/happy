package com.slopus.happy.ui.attach

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.slopus.happy.R
import com.slopus.happy.artifacts.formatDuration
import com.slopus.happy.attachments.GalleryAccess
import com.slopus.happy.attachments.GalleryItem
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.rememberImageLoader
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.conversation.viewerOrigin
import com.slopus.happy.ui.camera.PhotoTags

/** The gallery as the sheet shows it: how far the app may read, and what it read. */
@Immutable
data class GalleryContent(
    val access: GalleryAccess,
    val items: List<GalleryItem> = emptyList(),
    val loaded: Boolean = false,
    /** Asked and refused for good: only Settings can give access now. */
    val blocked: Boolean = false,
)

/**
 * Telegram's photo layout: the phone's photos and videos newest first, in
 * [columns] square cells 2 apart and 2 in. A cell's picture opens the
 * preview ([onOpen]); its check, the 42 corner, picks it ([onToggle]).
 * Without access the grid's place holds the ask; with some (Android 14's
 * partial access), a line above it offers to choose more.
 */
@Composable
internal fun AttachGalleryPage(
    content: GalleryContent,
    selection: AttachSelection,
    columns: Int,
    padding: PaddingValues,
    state: LazyGridState,
    sheet: Color,
    colors: AttachColors,
    onToggle: (GalleryItem) -> Unit,
    onOpen: (GalleryItem) -> Unit,
    onAllow: () -> Unit,
    onManage: () -> Unit,
    modifier: Modifier = Modifier,
    camera: AttachCameraState? = null,
) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(columns),
        state = state,
        contentPadding = padding,
        horizontalArrangement = Arrangement.spacedBy(AttachSpec.gridGap),
        verticalArrangement = Arrangement.spacedBy(AttachSpec.gridGap),
        modifier = modifier.fillMaxSize().testTag(AttachTags.GALLERY),
    ) {
        when {
            content.access == GalleryAccess.None -> item(key = "access", span = { GridItemSpan(maxLineSpan) }) {
                GalleryAsk(content.blocked, onAllow, camera?.let { { it.open() } })
            }
            else -> {
                if (content.access == GalleryAccess.Partial) {
                    item(key = "partial", span = { GridItemSpan(maxLineSpan) }) { PartialAccess(onManage) }
                }
                if (content.loaded && content.items.isEmpty() && camera == null) {
                    item(key = "empty", span = { GridItemSpan(maxLineSpan) }) { GalleryEmpty() }
                }
                val first = if (camera == null) 0 else 2 * (columns - 1)
                if (camera != null) {
                    item(key = "camera", span = { GridItemSpan(maxLineSpan) }) {
                        CameraRows(camera, columns, content.items.take(first), selection, sheet, colors, onToggle, onOpen)
                    }
                }
                items(content.items.drop(first), key = { it.uri }, contentType = { "cell" }) { item ->
                    GalleryCell(item, selection.number(item.uri), sheet, colors, onToggle = { onToggle(item) }, onOpen = { onOpen(item) })
                }
            }
        }
    }
}

/**
 * One cell (`PhotoAttachPhotoCell`): the thumbnail filling it, a video's
 * length bottom left, the check top right. Picked, the picture shrinks to
 * 0.787 in 200 ms so a ring of the sheet shows round it.
 */
@Composable
internal fun GalleryCell(item: GalleryItem, number: Int, sheet: Color, colors: AttachColors, onToggle: () -> Unit, onOpen: () -> Unit) {
    val reduceMotion = rememberReduceMotion()
    val scale by animateFloatAsState(
        if (number > 0) AttachSpec.PICKED_SCALE else 1f,
        if (reduceMotion) snap() else tween(AttachMotion.PICK_SCALE_MS, easing = AttachMotion.accelerateDecelerate),
        label = "picked scale",
    )
    val label = if (item.isVideo) {
        stringResource(R.string.attach_video_label, formatDuration(item.durationMs / 1000.0))
    } else {
        stringResource(R.string.attach_photo_label)
    }
    val pickLabel = stringResource(if (number > 0) R.string.attach_unpick else R.string.attach_pick)
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .viewerOrigin(item.uri)
            .testTag(AttachTags.CELL),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .background(colors.cell)
                .clickable(onClick = onOpen)
                .semantics {
                    contentDescription = label
                    selected = number > 0
                },
        ) {
            AsyncImage(
                model = GalleryThumb(item.uri, item.isVideo),
                imageLoader = rememberImageLoader(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            if (item.isVideo) VideoBadge(item.durationMs, colors, Modifier.align(Alignment.BottomStart))
        }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .size(AttachSpec.checkTouch)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onToggle)
                .semantics {
                    contentDescription = pickLabel
                    role = Role.Checkbox
                    selected = number > 0
                }
                .testTag(AttachTags.CHECK),
        ) {
            val inset = AttachSpec.checkInset + (AttachSpec.checkBox - AttachSpec.check) / 2
            AttachCheck(number, sheet, colors, Modifier.align(Alignment.TopEnd).padding(top = inset, end = inset))
        }
    }
}

/** A video's length on the cell, bottom left: 17 tall, black 40%, a play glyph and 12 bold white. */
@Composable
private fun VideoBadge(durationMs: Long, colors: AttachColors, modifier: Modifier) {
    Row(
        modifier
            .padding(AttachSpec.badgeInset)
            .height(AttachSpec.badgeHeight)
            .clip(RoundedCornerShape(AttachSpec.badgeCorner))
            .background(colors.badge)
            .padding(horizontal = AttachSpec.badgePadding)
            .testTag(AttachTags.VIDEO_BADGE),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(MaterialSymbols.PlayArrow, contentDescription = null, tint = Color.White, modifier = Modifier.size(11.dp))
        Spacer(Modifier.size(2.dp))
        Text(
            formatDuration(durationMs / 1000.0),
            style = happyTextStyle(12, weight = FontWeight.Bold).copy(fontSize = AttachSpec.badgeText, lineHeight = 14.sp),
            color = Color.White,
            maxLines = 1,
        )
    }
}

/** No access yet: why, and the button that asks (or opens Settings once refused for good). */
@Composable
private fun GalleryAsk(blocked: Boolean, onAllow: () -> Unit, onCamera: (() -> Unit)? = null) {
    val colors = HappyTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 260.dp)
            .padding(horizontal = 32.dp, vertical = 24.dp)
            .testTag(AttachTags.ASK),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(MaterialSymbols.PhotoLibrary, contentDescription = null, tint = colors.textSecondary, modifier = Modifier.size(48.dp))
        Spacer(Modifier.height(16.dp))
        Text(
            stringResource(R.string.attach_access_title),
            style = happyTextStyle(17, weight = FontWeight.SemiBold),
            color = colors.text,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            stringResource(if (blocked) R.string.attach_access_blocked else R.string.attach_access_message),
            style = happyTextStyle(15, lineHeight = 20),
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(16.dp))
        TextButton(onClick = onAllow, modifier = Modifier.testTag(AttachTags.ALLOW)) {
            Text(
                stringResource(if (blocked) R.string.attach_access_settings else R.string.attach_access_allow),
                style = happyTextStyle(15, weight = FontWeight.SemiBold),
                color = AttachColors.of(colors.dark).accent,
            )
        }
        if (onCamera != null) TextButton(onClick = onCamera) {
            Text(stringResource(R.string.components_empty_main_screen_open_camera), color = AttachColors.of(colors.dark).accent)
        }
    }
}

/** iOS AttachGridCollectionLayout: first column is a camera two photo cells tall. */
@Composable
private fun CameraRows(
    camera: AttachCameraState,
    columns: Int,
    items: List<GalleryItem>,
    selection: AttachSelection,
    sheet: Color,
    colors: AttachColors,
    onToggle: (GalleryItem) -> Unit,
    onOpen: (GalleryItem) -> Unit,
) {
    DisposableEffect(camera) { onDispose { camera.tile = null; camera.tilePosition = null } }
    val label = stringResource(R.string.components_empty_main_screen_open_camera)
    Layout(
        content = {
            Box(Modifier.fillMaxSize().background(Color.Black)
                .clickable(role = Role.Button, onClickLabel = label) { camera.open() }
                .semantics { contentDescription = label }
                .onGloballyPositioned {
                    camera.tile = it
                    camera.tilePosition = Rect(it.positionInWindow(), Size(it.size.width.toFloat(), it.size.height.toFloat()))
                }.testTag(PhotoTags.TILE))
            items.forEach { item ->
                GalleryCell(item, selection.number(item.uri), sheet, colors, { onToggle(item) }, { onOpen(item) })
            }
        },
        modifier = Modifier.fillMaxWidth(),
    ) { measurables, constraints ->
        val gap = AttachSpec.gridGap.roundToPx()
        val cell = (constraints.maxWidth - gap * (columns - 1)) / columns
        val height = 2 * cell + gap
        val tile = measurables.first().measure(Constraints.fixed(cell, height))
        val photos = measurables.drop(1).map { it.measure(Constraints.fixed(cell, cell)) }
        layout(constraints.maxWidth, height) {
            tile.placeRelative(0, 0)
            photos.forEachIndexed { index, placeable -> placeable.placeRelative((index % (columns - 1) + 1) * (cell + gap), (index / (columns - 1)) * (cell + gap)) }
        }
    }
}

/** Android 14's partial access: a line over the grid, and Manage to choose more. */
@Composable
private fun PartialAccess(onManage: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(start = 14.dp, end = 4.dp)
            .testTag(AttachTags.PARTIAL),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.attach_partial_message),
            style = happyTextStyle(13, lineHeight = 17),
            color = colors.textSecondary,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onManage, modifier = Modifier.testTag(AttachTags.MANAGE)) {
            Text(
                stringResource(R.string.attach_partial_manage),
                style = happyTextStyle(14, weight = FontWeight.SemiBold),
                color = AttachColors.of(colors.dark).accent,
            )
        }
    }
}

@Composable
private fun GalleryEmpty() {
    val colors = HappyTheme.colors
    Box(Modifier.fillMaxWidth().heightIn(min = 200.dp).testTag(AttachTags.EMPTY), contentAlignment = Alignment.Center) {
        Text(stringResource(R.string.attach_gallery_empty), style = happyTextStyle(15), color = colors.textSecondary)
    }
}
