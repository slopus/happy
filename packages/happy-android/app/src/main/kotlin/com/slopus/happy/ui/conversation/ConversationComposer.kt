package com.slopus.happy.ui.conversation

import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.offset
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.TextLayoutResult
import com.slopus.happy.ui.components.rememberHoistedTextFieldState
import androidx.compose.foundation.text.input.TextFieldLineLimits
import android.net.Uri
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.InlinePictures
import com.slopus.happy.conversation.Mode
import com.slopus.happy.attachments.AttachAccepts
import com.slopus.happy.ui.attach.AttachSheet
import com.slopus.happy.ui.attach.AttachedFileTile
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.attachments.ImagePicker
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.RecomposeProbe
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.GlassColors
import com.slopus.happy.ui.components.GlassSource
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.glass
import com.slopus.happy.ui.components.rememberGlassBlur
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.text.pluralResource
import java.io.File

object ConversationComposerTags {
    const val COMPOSER = "conversation.composer"
    /** The glass pill itself, inside [COMPOSER]'s margins. */
    const val PILL = "conversation.composer.pill"
    const val INPUT = "conversation.composer.input"
    const val PRIMARY = "conversation.composer.primary"
    /** The [+] that opens the attachment sheet ([AttachSheet]). */
    const val MORE = "conversation.composer.more"
    const val COUNT = "conversation.composer.attachmentCount"
    /** Compact with pictures waiting, [+] opens this menu: them, and Add to open the sheet. */
    const val MENU = "conversation.composer.menu"
    const val ATTACH = "conversation.composer.attach"
    const val PICTURES = "conversation.composer.pictures"
    const val PICTURE_REMOVE = "conversation.composer.pictures.remove"
}

/** ChatGPT's Work composer, measured on a Fold: a 48 pill at rest, a two-row card of 28 corners in use. */
object ConversationComposerSpec {
    val rest = 48.dp
    val restCorner = 24.dp
    val openCorner = 28.dp
    val margin = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
    val fieldPadding = 16.dp
    /** Above and below the field's words. */
    val fieldVertical = 12.dp
    val primary = 36.dp
    const val MAX_LINES = 8
}

private object Slot {
    const val MORE = "more"
    const val FIELD = "field"
    const val LABEL = "label"
    const val PRIMARY = "primary"
}

/**
 * The conversation's composer, ChatGPT's Work shape on frosted glass. At
 * rest one 48 pill: [+], the placeholder, the send circle at its end. In use
 * (focused, holding words or pictures) the same pill grows into a card: the
 * pictures waiting to go, the words on top (up to eight lines, then it
 * scrolls), and under them [+], the model and effort as one label
 * ([ConversationModeLabel]) and send, which becomes Stop while the agent
 * works and nothing is typed. [+] opens the attachment sheet ([AttachSheet]):
 * the gallery's recent photos and videos and the File tab; its Send sends the
 * picks with the draft as their caption, all of them through the agent's
 * workspace ([com.slopus.happy.conversation.WorkspaceUploads]).
 * The model menu floats above the composer and keyboard, keeping the draft
 * and caret in place. The pill is glass over [backdrop] (the transcript under
 * it), its tint alone where nothing blurs. With Reduce Motion it changes shape
 * at once. When the available height cannot fit the open card it uses one
 * row, retaining [+], an internally scrolling field, model/effort and send.
 * Its vertical margins shrink to preserve a 48 dp surface where it fits;
 * picture previews hide while space is short, their count on [+].
 */
@Composable
internal fun ConversationComposer(
    state: ConversationState,
    text: String,
    onTextChange: (String) -> Unit,
    onSend: (String, List<AttachmentPreview>) -> Boolean,
    onSent: () -> Unit,
    onStop: () -> Unit,
    onModeChange: (Mode) -> Unit,
    modifier: Modifier = Modifier,
    backdrop: GlassSource? = null,
    pictures: ImagePicker? = rememberComposerImages(enabled = true),
    /** Raised to take the keyboard into the composer (Return in new work's name). */
    focusAsks: Int = 0,
    /** Where a sent message's words fly from ([SendFlight]). */
    flight: SendFlight? = null,
) {
    RecomposeProbe.mark(ConversationScreenTags.PROBE_COMPOSER)
    val colors = HappyTheme.colors
    val attached = pictures?.images.orEmpty()
    val hasContent = text.isNotBlank() || attached.isNotEmpty()
    val primary = primaryActionOf(hasContent, state)
    // The field's own words and selection; text set from outside puts the cursor at its end, or where focus asks.
    // Saved, so a rotation or a return from process death keeps the caret where it was.
    val (field, typed) = rememberHoistedTextFieldState(text, onTextChange)
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var focused by remember { mutableStateOf(false) }
    var attaching by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var picker by rememberSaveable { mutableStateOf<ModePicker?>(null) }
    var moreCenterY by remember { mutableIntStateOf(0) }
    var modelCenterY by remember { mutableIntStateOf(0) }
    // Where + and the model label are, read as a popup opens: nothing runs as they move (the dock
    // rides the keyboard, settles, scrolls with a growing draft).
    val anchors = remember { arrayOfNulls<LayoutCoordinates>(2) }
    fun anchor(i: Int) = anchors[i]?.takeIf { it.isAttached }?.boundsInWindow()?.center?.y?.toInt() ?: 0
    fun openPicker(which: ModePicker) {
        attaching = false
        menu = false
        modelCenterY = anchor(1)
        picker = which
    }

    val reduceMotion = rememberReduceMotion()
    val density = LocalDensity.current
    // The field's words as last laid out, and where the field is: what a sent message flies from.
    val fieldLayout = remember { arrayOfNulls<() -> TextLayoutResult?>(1) }
    val fieldAt = remember { arrayOfNulls<LayoutCoordinates>(1) }

    /** Sends [sent]'s words flying from the field, as laid out and where they are, if they all show in it. */
    fun fly(sent: String) {
        val layout = fieldLayout[0]?.invoke() ?: return
        val at = fieldAt[0]?.takeIf { it.isAttached } ?: return
        val inset = with(density) { ConversationComposerSpec.fieldVertical.toPx() }
        if (layout.size.height > at.size.height - 2 * inset + 1) return
        flight?.launch(sent, layout, at.positionInRoot() + Offset(0f, inset), density, colors.text)
    }

    // The draft and what waits go together; new work keeps them until it is made.
    fun submit(extra: List<AttachmentPreview> = emptyList()) {
        val sent = text
        val alone = attached.isEmpty() && extra.isEmpty()
        if (onSend(text, attached + extra)) {
            if (alone && !reduceMotion) fly(sent)
            pictures?.clear()
            onSent()
        } else if (extra.isNotEmpty()) {
            pictures?.state?.images?.addAll(extra)
        }
    }

    // New work's first message goes once the task or bot is made: only then does it take the
    // words and pictures, the words unless edited since. Seen once, so a return never clears again.
    var takenSeen by rememberSaveable { mutableIntStateOf(state.taken?.serial ?: 0) }
    LaunchedEffect(state.taken?.serial) {
        val taken = state.taken ?: return@LaunchedEffect
        if (taken.serial <= takenSeen) return@LaunchedEffect
        takenSeen = taken.serial
        pictures?.clear()
        if (text.trim() == taken.text) onSent()
    }

    val open = focused || text.isNotEmpty() || attached.isNotEmpty()
    val corner by animateDpAsState(
        if (open) ConversationComposerSpec.openCorner else ConversationComposerSpec.restCorner,
        if (reduceMotion) snap() else spring(stiffness = 700f),
        label = "composer corner",
    )
    val shape = RoundedCornerShape(corner)
    val blurs = rememberGlassBlur()

    val lineHeight = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.lineHeight.toDp() }
    val labelHeight = with(LocalDensity.current) { MaterialTheme.typography.labelLarge.lineHeight.toDp() }
    val minimumField = lineHeight + 24.dp
    val minimumActions = maxOf(ConversationComposerSpec.rest, labelHeight + 24.dp)
    val minimumCompact = maxOf(minimumField, minimumActions)
    ComposerViewport(minimumField + minimumActions + if (attached.isEmpty()) 0.dp else 76.dp, minimumCompact, modifier) { compact ->
        val showCount = compact && attached.isNotEmpty()
        val moreLabel = stringResource(R.string.conversation_composer_more) + if (showCount) ", " + pluralResource(R.plurals.conversation_attached_picture_count, attached.size, attached.size) else ""
        Column(
            Modifier
                .fillMaxWidth()
                .glass(backdrop, shape, GlassColors.of(colors.dark), blurs)
                .clip(shape)
                .animateContentSize(if (reduceMotion || compact) snap() else spring(stiffness = 700f))
                .testTag(ConversationComposerTags.PILL),
        ) {
            if (attached.isNotEmpty() && !compact) {
                ComposerPictures(attached, onRemove = { pictures?.remove(it) })
            }
            ComposerLayout(open, compact, if (compact || !open) minimumCompact else minimumActions) {
                Box(Modifier.layoutId(Slot.MORE)) {
                    IconButton(onClick = { picker = null; moreCenterY = anchor(0); if (showCount) menu = true else attaching = true }, modifier = Modifier.testTag(ConversationComposerTags.MORE)
                        .semantics { contentDescription = moreLabel }
                        .onPlaced { anchors[0] = it }) {
                        BadgedBox(badge = {
                            if (showCount) Badge(containerColor = colors.text, contentColor = colors.surface) {
                                Text(attached.size.toString(), Modifier.testTag(ConversationComposerTags.COUNT).clearAndSetSemantics {})
                            }
                        }) {
                            Icon(MaterialSymbols.Add, contentDescription = null, tint = colors.text)
                        }
                    }
                }
                BasicTextField(
                    state = field,
                    inputTransformation = typed,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.text),
                    cursorBrush = SolidColor(colors.text),
                    lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = ConversationComposerSpec.MAX_LINES),
                    onTextLayout = { result -> fieldLayout[0] = result },
                    decorator = { inner ->
                        Box(Modifier.padding(vertical = ConversationComposerSpec.fieldVertical)) {
                            if (field.text.isEmpty()) {
                                Text(
                                    stringResource(R.string.common_message),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = colors.textSecondary,
                                    maxLines = 1,
                                )
                            }
                            inner()
                        }
                    },
                    modifier = Modifier
                        .layoutId(Slot.FIELD)
                        .focusRequester(focus)
                        .onFocusChanged { focused = it.isFocused }
                        .onPlaced { fieldAt[0] = it }
                        .testTag(ConversationComposerTags.INPUT),
                )
                if (open) {
                    ConversationModeLabel(
                        catalog = state.catalog,
                        mode = state.mode,
                        onOpen = { openPicker(ModePicker.Model) },
                        modifier = Modifier.layoutId(Slot.LABEL).onPlaced { anchors[1] = it },
                    )
                }
                val sendLabel = stringResource(if (primary == PrimaryAction.Stop) R.string.conversation_stop else R.string.conversation_send)
                val live = primary == PrimaryAction.Send || primary == PrimaryAction.Stop
                Box(Modifier.layoutId(Slot.PRIMARY).padding(end = 6.dp)) {
                    FilledIconButton(
                        onClick = {
                            when (primary) {
                                PrimaryAction.Send -> submit()
                                PrimaryAction.Stop -> if (!state.stopping) onStop()
                                else -> Unit
                            }
                        },
                        enabled = live,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = colors.text,
                            contentColor = colors.surface,
                            disabledContainerColor = colors.textSecondary.copy(alpha = 0.45f),
                            disabledContentColor = colors.surface,
                        ),
                        modifier = Modifier.size(ConversationComposerSpec.primary).testTag(ConversationComposerTags.PRIMARY),
                    ) {
                        if (state.stopping || state.newWork?.making == true) {
                            CircularProgressIndicator(Modifier.size(16.dp), color = colors.surface, strokeWidth = 2.dp)
                        } else {
                            Icon(
                                if (primary == PrimaryAction.Stop) MaterialSymbols.Stop else MaterialSymbols.ArrowUpward,
                                sendLabel,
                                Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
        ConversationPopup(
            expanded = menu,
            title = stringResource(R.string.conversation_composer_more),
            onDismiss = { menu = false },
            anchorCenterY = moreCenterY,
            alignEnd = false,
            width = 280.dp,
            modifier = Modifier.testTag(ConversationComposerTags.MENU),
        ) {
            LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                item { ComposerPictures(attached, onRemove = { pictures?.remove(it) }) }
                item {
                    HappyMenuItem(
                        label = stringResource(R.string.attach_title),
                        leading = { Icon(MaterialSymbols.Add, contentDescription = null, Modifier.size(MenuSpec.icon)) },
                        onClick = { menu = false; attaching = true },
                        modifier = Modifier.testTag(ConversationComposerTags.ATTACH),
                    )
                }
            }
        }
        AttachSheet(
            open = attaching,
            accepts = AttachAccepts.Agent,
            caption = text,
            onCaptionChange = onTextChange,
            onSend = { staged -> submit(staged) },
            onClosed = { attaching = false },
            room = AttachAccepts.Agent.maxItems - attached.size,
        )
        ConversationModePicker(picker, onClose = { picker = null }, catalog = state.catalog, mode = state.mode, onModeChange = onModeChange, anchorCenterY = modelCenterY)
        // The viewport subcomposes its content during measurement. Request
        // focus here, after its editor exists, rather than in the parent.
        LaunchedEffect(state.composerFocus?.serial) {
            val ask = state.composerFocus ?: return@LaunchedEffect
            field.edit { selection = TextRange(ask.cursor.coerceIn(0, length)) }
            focus.requestFocus()
            keyboard?.show()
        }
        LaunchedEffect(focusAsks) {
            if (focusAsks == 0) return@LaunchedEffect
            focus.requestFocus()
            keyboard?.show()
        }
    }
}

/**
 * The pill's insides, one field whichever shape, so focus and the caret
 * survive the change. At rest: [+] | field | send, centred on one 48 row.
 * Open: the field across the top, 16 in, and under it a 48 row of [+],
 * then the label and send at the end.
 */
@Composable
private fun ComposerLayout(open: Boolean, compact: Boolean, minimumRowHeight: Dp, content: @Composable () -> Unit) {
    Layout(content) { measurables, constraints ->
        val width = constraints.maxWidth
        val loose = Constraints(maxWidth = width, maxHeight = constraints.maxHeight)
        fun slot(id: String) = measurables.firstOrNull { it.layoutId == id }
        val more = slot(Slot.MORE)!!.measure(loose)
        val primary = slot(Slot.PRIMARY)!!.measure(loose)
        val rowHeight = maxOf(minimumRowHeight.roundToPx(), more.height, primary.height).coerceAtMost(constraints.maxHeight)
        if (!open || compact) {
            val label = if (open) slot(Slot.LABEL)?.measure(Constraints(maxWidth = ((width - more.width - primary.width) / 2).coerceAtLeast(0), maxHeight = rowHeight)) else null
            val fieldWidth = (width - more.width - primary.width - (label?.width ?: 0)).coerceAtLeast(0)
            val field = slot(Slot.FIELD)!!.measure(Constraints(minWidth = fieldWidth, maxWidth = fieldWidth, maxHeight = rowHeight))
            val height = maxOf(rowHeight, field.height, label?.height ?: 0).coerceAtMost(constraints.maxHeight)
            layout(width, height) {
                more.place(0, (height - more.height) / 2)
                field.place(more.width, (height - field.height) / 2)
                primary.place(width - primary.width, (height - primary.height) / 2)
                label?.place(width - primary.width - label.width, (height - label.height) / 2)
            }
        } else {
            val inset = ConversationComposerSpec.fieldPadding.roundToPx()
            val fieldWidth = (width - 2 * inset).coerceAtLeast(0)
            val field = slot(Slot.FIELD)!!.measure(Constraints(minWidth = fieldWidth, maxWidth = fieldWidth, maxHeight = (constraints.maxHeight - rowHeight).coerceAtLeast(0)))
            val label = slot(Slot.LABEL)?.measure(Constraints(maxWidth = (width - more.width - primary.width).coerceAtLeast(0), maxHeight = rowHeight))
            val row = field.height
            val height = row + rowHeight
            layout(width, height) {
                field.place(inset, 0)
                more.place(0, row + (rowHeight - more.height) / 2)
                primary.place(width - primary.width, row + (rowHeight - primary.height) / 2)
                label?.place(width - primary.width - label.width, row + (rowHeight - label.height) / 2)
            }
        }
    }
}

/** Keep the full card when it fits; otherwise use one row and spend spare height on margins. */
@Composable
private fun ComposerViewport(minimumOpen: Dp, minimumCompact: Dp, modifier: Modifier, content: @Composable (Boolean) -> Unit) {
    // The margins are worked out where it measures, so the room round it changing (the keyboard
    // settling) measures the pill again and composes it only when it changes shape.
    SubcomposeLayout(modifier.fillMaxWidth().testTag(ConversationComposerTags.COMPOSER)) { constraints ->
        val compact = constraints.hasBoundedHeight && constraints.maxHeight.toDp() < minimumOpen + 16.dp
        // Split whole spare pixels so rounding each margin cannot steal
        // one pixel from the minimum touch surface at fractional densities.
        val vertical = if (compact) ((constraints.maxHeight - minimumCompact.roundToPx()).coerceAtLeast(0) / 2).coerceAtMost(8.dp.roundToPx()) else 8.dp.roundToPx()
        val horizontal = 12.dp.roundToPx()
        val inner = constraints.copy(minWidth = 0, minHeight = 0).offset(-2 * horizontal, -2 * vertical)
        val placeables = subcompose(Unit) { content(compact) }.map { it.measure(inner) }
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else (placeables.maxOfOrNull { it.width } ?: 0) + 2 * horizontal
        val height = constraints.constrainHeight((placeables.maxOfOrNull { it.height } ?: 0) + 2 * vertical)
        layout(width, height) { placeables.forEach { it.place(horizontal, vertical) } }
    }
}

@Composable
private fun ComposerPictures(images: List<AttachmentPreview>, onRemove: (String) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(top = 12.dp).testTag(ConversationComposerTags.PICTURES),
    ) {
        items(images, key = { it.id }) { picture ->
            Box(Modifier.size(64.dp)) {
                if (picture.mimeType.startsWith("image/")) {
                    RemoteImage(picture.uri, contentDescription = picture.name, contentScale = ContentScale.Crop, modifier = Modifier.size(64.dp).clip(MaterialTheme.shapes.medium))
                } else {
                    AttachedFileTile(picture.name, Modifier.size(64.dp).clip(MaterialTheme.shapes.medium))
                }
                FilledTonalIconButton(
                    onClick = { onRemove(picture.id) },
                    modifier = Modifier.align(Alignment.TopEnd).padding(2.dp).size(24.dp).testTag(ConversationComposerTags.PICTURE_REMOVE),
                ) {
                    Icon(MaterialSymbols.Close, stringResource(R.string.conversation_remove_picture), Modifier.size(16.dp))
                }
            }
        }
    }
}
