package com.slopus.happy.ui.conversation

import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.offset
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.foundation.content.MediaType
import androidx.compose.foundation.content.ReceiveContentListener
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.content.hasMediaType
import androidx.compose.ui.graphics.graphicsLayer
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
import androidx.compose.ui.input.key.onPreviewKeyEvent
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
import com.slopus.happy.attachments.PendingPicture
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.conversation.ContextGauge
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.InlinePictures
import com.slopus.happy.conversation.Mode
import com.slopus.happy.attachments.AttachAccepts
import com.slopus.happy.ui.attach.AttachSheet
import com.slopus.happy.ui.attach.AttachedFileTile
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.attachments.PictureStripFrame
import com.slopus.happy.ui.attach.attachButton
import com.slopus.happy.ui.attach.rememberAttachButton
import com.slopus.happy.ui.attachments.PictureStripState
import com.slopus.happy.ui.attachments.PictureStripVisibility
import com.slopus.happy.ui.attachments.pictureMotion
import com.slopus.happy.ui.attachments.rememberPictureStrip
import com.slopus.happy.ui.attachments.ImagePicker
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.PrimaryGlyph
import com.slopus.happy.ui.chat.rememberShake
import com.slopus.happy.ui.chat.shake
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
    /** Past the lines the card shows: the full-screen editor ([ComposerEditor]). */
    const val EXPAND = "conversation.composer.expand"
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
    val expandGlyph = 18.dp
    const val MAX_LINES = 8
    /** The one row shows this many lines, then scrolls (iOS `compactTextCap`). */
    const val COMPACT_LINES = 2
    /** The least transcript the full card may leave between the bar and itself; under it the composer is one row. */
    val transcriptMin = 120.dp
}

private object Slot {
    const val MORE = "more"
    const val FIELD = "field"
    const val LABEL = "label"
    const val PRIMARY = "primary"
    const val EXPAND = "expand"
    const val METER = "meter"
}

/**
 * The conversation's composer, ChatGPT's Work shape on frosted glass. At
 * rest one 48 pill: [+], the placeholder, the send circle at its end. In use
 * (focused, holding words or pictures) the same pill grows into a card: the
 * pictures waiting to go, the words on top (up to eight lines, then it
 * scrolls), and under them [+], the model and effort chips
 * ([ConversationModelChips], each opening its own list) and send, which becomes Stop while the agent
 * works and nothing is typed. [+] opens the attachment sheet ([AttachSheet]):
 * the gallery's recent photos and videos and the File tab; its Send sends the
 * picks with the draft as their caption, pictures inline and the rest through
 * the agent's workspace ([com.slopus.happy.conversation.WorkspaceUploads]).
 * The model menu floats above the composer and keyboard, keeping the draft
 * and caret in place. The pill is glass over [backdrop] (the transcript under
 * it), its tint alone where nothing blurs. With Reduce Motion it changes shape
 * at once. When the open card with one line would leave the transcript under
 * 120 (a phone held sideways with the keyboard up, iOS ac81745ac), or cannot
 * fit at all, it uses one row: [+], the field (two lines, then it scrolls),
 * model/effort and send at the row's foot.
 * Its vertical margins shrink to preserve a 48 dp surface where it fits;
 * picture previews hide while space is short, their count on [+].
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
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
    /** [onSend] with gallery photos still being read; null reads them before they go. */
    onSendPending: ((String, List<AttachmentPreview>, List<PendingPicture>) -> Boolean)? = null,
    backdrop: GlassSource? = null,
    pictures: ImagePicker? = rememberComposerImages(enabled = true),
    /** "+"'s sheet is up as the composer first shows. */
    opensAttach: Boolean = false,
    /** Raised to take the keyboard into the composer (Return in new work's name). */
    focusAsks: Int = 0,
    /** Where a sent message's words fly from ([SendFlight]). */
    flight: SendFlight? = null,
    /** Shares the caret with the command list over the composer; it sees hardware keys first. */
    cursor: com.slopus.happy.ui.autocomplete.ComposerCursor? = null,
    /** The computer's accounts' plan usage by provider id: the model label warns as its account runs low. */
    usage: Map<String, AccountUsage> = emptyMap(),
    /** A list opened: the computer asks again for the readings of the accounts it lists. */
    onRefreshUsage: (List<String>) -> Unit = {},
    /** Past the lines it shows, the words full screen from this caret ([ComposerEditor]); null offers no expand. */
    onExpand: ((TextRange) -> Unit)? = null,
    /** The full-screen editor closed: the caret it left, taken back here. */
    returned: ComposerReturn? = null,
    /**
     * Where the bar over the transcript ends, from the top of the room the composer is given. With it,
     * the composer goes to one row when the full card would leave the transcript less than
     * [ConversationComposerSpec.transcriptMin] (iOS `ChatScreenLayout.compactBelow`).
     */
    barFoot: Dp? = null,
    /** The agent's workspace: the attach sheet's File tab can name one of its files. */
    workspace: com.slopus.happy.ui.files.WorkspaceSource? = null,
) {
    RecomposeProbe.mark(ConversationScreenTags.PROBE_COMPOSER)
    val colors = HappyTheme.colors
    val attached = pictures?.images.orEmpty()
    val strip = rememberPictureStrip(attached)
    val hasContent = text.isNotBlank() || attached.isNotEmpty()
    val primary = primaryActionOf(hasContent, state)
    // A stop that failed shakes the button (desktop Shaker.tsx `shakerRef`, iOS `shakePrimary`).
    val stopShake = rememberShake()
    val wasStopping = remember { booleanArrayOf(false) }
    LaunchedEffect(state.stopping, state.alert) {
        if (wasStopping[0] && !state.stopping && state.alert != null) stopShake.shake()
        wasStopping[0] = state.stopping
    }
    // The field's own words and selection; text set from outside puts the cursor at its end, or where focus asks.
    // Saved, so a rotation or a return from process death keeps the caret where it was.
    val (field, typed) = rememberHoistedTextFieldState(text, onTextChange)
    val focus = remember { FocusRequester() }
    LaunchedEffect(field, cursor) { androidx.compose.runtime.snapshotFlow { field.selection }.collect { cursor?.selection = it } }
    val keyboard = LocalSoftwareKeyboardController.current
    var focused by remember { mutableStateOf(false) }
    var attaching by rememberSaveable { mutableStateOf(opensAttach) }
    val plus = rememberAttachButton { Icon(MaterialSymbols.Add, contentDescription = null, tint = colors.text) }
    var menu by remember { mutableStateOf(false) }
    var picker by rememberSaveable { mutableStateOf<PickerList?>(null) }
    var moreCenterY by remember { mutableIntStateOf(0) }
    // Where + is, read as its popup opens: nothing runs as it moves (the dock rides the keyboard,
    // settles, scrolls with a growing draft). The chips' places, read as their list opens.
    val anchors = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val chips = remember { arrayOfNulls<LayoutCoordinates>(2) }
    fun anchor(i: Int) = anchors[i]?.takeIf { it.isAttached }?.boundsInWindow()?.center?.y?.toInt() ?: 0
    fun chipBounds(list: PickerList) = chips[list.ordinal]?.takeIf { it.isAttached }?.boundsInWindow()?.let {
        androidx.compose.ui.unit.IntRect(it.left.toInt(), it.top.toInt(), it.right.toInt(), it.bottom.toInt())
    }
    fun openPicker(which: PickerList) {
        attaching = false
        menu = false
        picker = which
    }

    val reduceMotion = rememberReduceMotion()
    val density = LocalDensity.current
    // A picture on the clipboard offers Paste in the field's menu and attaches (iOS AgentInputTextView), as
    // one a keyboard inserts does. The picture is what was meant, not the name or address it often carries
    // as text too; copied text alone pastes as words.
    val receivePictures = remember(pictures) {
        ReceiveContentListener { content ->
            if (pictures == null || !content.hasMediaType(MediaType.Image)) return@ReceiveContentListener content
            val clip = content.clipEntry.clipData
            pictures.receive((0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri })
            null
        }
    }
    // The field's width without the expand button, as last laid out: whether the words are past
    // the lines it shows is measured there, so the button taking its room never decides it.
    val fullWidth = remember { mutableIntStateOf(0) }
    // How many lines the one row shows as last laid out: two where they fit, else one.
    val compactLines = remember { mutableIntStateOf(1) }
    val measurer = rememberTextMeasurer(cacheSize = 0)
    val bodyStyle = MaterialTheme.typography.bodyLarge
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
    fun submit(extra: List<AttachmentPreview> = emptyList(), pending: List<PendingPicture> = emptyList()) {
        val sent = text
        val alone = attached.isEmpty() && extra.isEmpty() && pending.isEmpty()
        val went = if (pending.isEmpty() || onSendPending == null) onSend(text, attached + extra) else onSendPending(text, attached + extra, pending)
        if (went) {
            if (alone && !reduceMotion) fly(sent)
            pictures?.clear()
            onSent()
        } else if (extra.isNotEmpty()) {
            pictures?.state?.images?.addAll(extra)
        }
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
    // There is no meter while history is read, nor for new work before its first message: nothing to measure yet.
    val gauge = if (state.loaded && state.created) ContextGauge.derive(state.catalog, state.context, state.mode ?: state.catalog?.defaults) else null
    val warning = state.catalog?.let { catalog -> (state.mode ?: catalog.defaults)?.let { usage[it.providerId]?.warning } }
    ComposerViewport(
        minimumField + minimumActions + if (attached.isEmpty()) 0.dp else 76.dp,
        minimumCompact,
        modifier,
        meter = gauge?.let { { ContextMeter(it) } },
        keep = barFoot?.let { it + ConversationComposerSpec.transcriptMin } ?: 0.dp,
    ) { compact ->
        // Telegram's expand: once the words scroll (past the card's eight lines, or the one row's one).
        val shownLines = if (compact) compactLines.intValue else ConversationComposerSpec.MAX_LINES
        val words = field.text
        val width = fullWidth.intValue
        val expands = onExpand != null && width > 0 && words.isNotEmpty() &&
            remember(words, width, bodyStyle) { measurer.measure(words.toString(), bodyStyle, constraints = Constraints(maxWidth = width)).lineCount } > shownLines
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
            PictureStripVisibility(attached.isNotEmpty() && !compact, immediate = compact) {
                ComposerPictures(attached, strip, onRemove = { pictures?.remove(it) })
            }
            ComposerLayout(open, compact, if (compact || !open) minimumCompact else minimumActions, fullWidth, lineHeight, compactLines) {
                Box(Modifier.layoutId(Slot.MORE)) {
                    IconButton(onClick = { picker = null; moreCenterY = anchor(0); if (showCount) menu = true else attaching = true }, modifier = Modifier.testTag(ConversationComposerTags.MORE)
                        .attachButton(plus)
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
                                    stringResource(R.string.session_input_placeholder),
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
                        .onPreviewKeyEvent { cursor?.onKey?.invoke(it) == true }
                        .then(if (pictures != null) Modifier.contentReceiver(receivePictures) else Modifier)
                        .onPlaced { fieldAt[0] = it }
                        .testTag(ConversationComposerTags.INPUT),
                )
                if (expands) ExpandButton(reduceMotion, Modifier.layoutId(Slot.EXPAND)) { onExpand?.invoke(field.selection) }
                if (open) {
                    ConversationModelChips(
                        catalog = state.catalog,
                        mode = state.mode,
                        warning = warning,
                        onOpen = ::openPicker,
                        anchors = chips,
                        modifier = Modifier.layoutId(Slot.LABEL),
                    )
                }
                val live = primary == PrimaryAction.Send || primary == PrimaryAction.Stop
                Box(Modifier.layoutId(Slot.PRIMARY).padding(end = 6.dp).shake(stopShake)) {
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
                        // Send and Stop are one button changing its glyph (iOS AgentInputPrimaryGlyphMotion).
                        val glyph = when {
                            state.stopping -> PrimaryGlyphKind.Busy
                            primary == PrimaryAction.Stop -> PrimaryGlyphKind.Stop
                            else -> PrimaryGlyphKind.Send
                        }
                        PrimaryGlyph(glyph) { shown ->
                            when (shown) {
                                PrimaryGlyphKind.Busy -> CircularProgressIndicator(Modifier.size(16.dp), color = colors.surface, strokeWidth = 2.dp)
                                PrimaryGlyphKind.Stop -> Icon(MaterialSymbols.Stop, stringResource(R.string.conversation_stop), Modifier.size(20.dp))
                                PrimaryGlyphKind.Send -> Icon(MaterialSymbols.ArrowUpward, stringResource(R.string.conversation_send), Modifier.size(20.dp))
                            }
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
                item { ComposerPictures(attached, strip, onRemove = { pictures?.remove(it) }) }
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
            onSendPending = onSendPending?.let { { staged, pending -> submit(staged, pending) } },
            onClosed = { attaching = false },
            room = AttachAccepts.Agent.maxItems - attached.size,
            button = plus,
            workspace = workspace,
            onPhoto = pictures?.let { picker -> { photo -> if (picker.state.checkRoom()) picker.state.images.add(photo) } },
        )
        ModelPicker(
            open = picker,
            catalog = state.catalog,
            mode = state.mode,
            usage = usage,
            anchor = ::chipBounds,
            onModeChange = onModeChange,
            onClose = { picker = null },
            onOpened = onRefreshUsage,
        )
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
        // Back from the full-screen editor: its caret, and the keyboard taken before it goes, so it stays up.
        LaunchedEffect(returned?.serial) {
            val back = returned ?: return@LaunchedEffect
            field.edit { selection = TextRange(back.selection.start.coerceIn(0, length), back.selection.end.coerceIn(0, length)) }
            if (back.focused) focus.requestFocus()
        }
    }
}

/** The full-screen editor closed with the caret at [selection], the keyboard up if [focused]; [serial] tells one close from the next. */
@androidx.compose.runtime.Immutable
class ComposerReturn(val selection: TextRange, val focused: Boolean, val serial: Int)

/**
 * The full-screen editor's button (iOS `expandButton`): send's size, centred
 * over send, as far in from the card's top as send is from its foot; its
 * glyph 18 in the text colour. It shows where it stands, fading in over 0.1 s.
 */
@Composable
private fun ExpandButton(reduceMotion: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val shown = remember { androidx.compose.animation.core.Animatable(if (reduceMotion) 1f else 0f) }
    LaunchedEffect(Unit) { shown.animateTo(1f, androidx.compose.animation.core.tween(100)) }
    Box(modifier.padding(end = 6.dp).graphicsLayer { alpha = shown.value }) {
        IconButton(
            onClick = onClick,
            modifier = Modifier.size(ConversationComposerSpec.primary).testTag(ConversationComposerTags.EXPAND),
        ) {
            com.slopus.happy.ui.components.Icon(
                com.slopus.happy.ui.components.Ionicon.ExpandOutline,
                ConversationComposerSpec.expandGlyph,
                colors.text,
                contentDescription = stringResource(R.string.conversation_editor_expand),
            )
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
private fun ComposerLayout(
    open: Boolean,
    compact: Boolean,
    minimumRowHeight: Dp,
    fullWidth: androidx.compose.runtime.MutableIntState,
    lineHeight: Dp,
    compactLines: androidx.compose.runtime.MutableIntState,
    content: @Composable () -> Unit,
) {
    Layout(content) { measurables, constraints ->
        val width = constraints.maxWidth
        val loose = Constraints(maxWidth = width, maxHeight = constraints.maxHeight)
        fun slot(id: String) = measurables.firstOrNull { it.layoutId == id }
        val more = slot(Slot.MORE)!!.measure(loose)
        val primary = slot(Slot.PRIMARY)!!.measure(loose)
        val rowHeight = maxOf(minimumRowHeight.roundToPx(), more.height, primary.height).coerceAtMost(constraints.maxHeight)
        val expand = slot(Slot.EXPAND)?.measure(loose)
        // Read by the composer to tell whether the words scroll; written only when it changes.
        fun full(fieldWidth: Int) { if (fullWidth.intValue != fieldWidth) fullWidth.intValue = fieldWidth }
        if (!open || compact) {
            val label = if (open) slot(Slot.LABEL)?.measure(Constraints(maxWidth = ((width - more.width - primary.width) / 2).coerceAtLeast(0), maxHeight = rowHeight)) else null
            val wide = (width - more.width - primary.width - (label?.width ?: 0)).coerceAtLeast(0)
            full(wide)
            // The expand button stands at the field's end, the words clear of it.
            val fieldWidth = (wide - (expand?.width ?: 0)).coerceAtLeast(0)
            // Two lines where the room lets them, then it scrolls (iOS `compactTextCap`).
            val line = lineHeight.roundToPx().coerceAtLeast(1)
            val padding = 2 * ConversationComposerSpec.fieldVertical.roundToPx()
            val cap = (ConversationComposerSpec.COMPACT_LINES * line + padding).coerceAtMost(constraints.maxHeight).coerceAtLeast(rowHeight)
            val lines = ((cap - padding) / line).coerceIn(1, ConversationComposerSpec.COMPACT_LINES)
            if (compactLines.intValue != lines) compactLines.intValue = lines
            val field = slot(Slot.FIELD)!!.measure(Constraints(minWidth = fieldWidth, maxWidth = fieldWidth, maxHeight = cap))
            val height = maxOf(rowHeight, field.height, label?.height ?: 0).coerceAtMost(constraints.maxHeight)
            // The buttons stand where they do beside one line, at the row's foot, however many it grows to.
            val foot = height - rowHeight
            fun row(h: Int) = foot + (rowHeight - h) / 2
            layout(width, height) {
                more.place(0, row(more.height))
                field.place(more.width, if (field.height > rowHeight) 0 else row(field.height))
                expand?.place(more.width + fieldWidth, (if (field.height > rowHeight) 0 else foot) + (rowHeight - expand.height) / 2)
                primary.place(width - primary.width, row(primary.height))
                label?.place(width - primary.width - label.width, row(label.height))
            }
        } else {
            val inset = ConversationComposerSpec.fieldPadding.roundToPx()
            full((width - 2 * inset).coerceAtLeast(0))
            // Over send in its column, as far down from the card's top as send is up from its foot;
            // the words wrap clear of it.
            val fieldWidth = (if (expand != null) width - inset - expand.width else width - 2 * inset).coerceAtLeast(0)
            val field = slot(Slot.FIELD)!!.measure(Constraints(minWidth = fieldWidth, maxWidth = fieldWidth, maxHeight = (constraints.maxHeight - rowHeight).coerceAtLeast(0)))
            val label = slot(Slot.LABEL)?.measure(Constraints(maxWidth = (width - more.width - primary.width).coerceAtLeast(0), maxHeight = rowHeight))
            val row = field.height
            val height = row + rowHeight
            layout(width, height) {
                field.place(inset, 0)
                expand?.place(width - expand.width, (rowHeight - expand.height) / 2)
                more.place(0, row + (rowHeight - more.height) / 2)
                primary.place(width - primary.width, row + (rowHeight - primary.height) / 2)
                label?.place(width - primary.width - label.width, row + (rowHeight - label.height) / 2)
            }
        }
    }
}

/**
 * Keep the full card when it fits and leaves [keep] above it, judged from
 * the card with one line so neither typing nor going to one row flips it;
 * otherwise use one row and spend spare height on margins. With a [meter], its 20 row stands under the full card,
 * the bar's end under send (iOS `ChatScreenLayout.meter`); the one-row
 * composer has none, as the transcript needs every point.
 */
@Composable
private fun ComposerViewport(
    minimumOpen: Dp,
    minimumCompact: Dp,
    modifier: Modifier,
    meter: (@Composable () -> Unit)? = null,
    /** Room the full card must leave above itself, or it is one row: decided from the card with one line, never as it is. */
    keep: Dp = 0.dp,
    content: @Composable (Boolean) -> Unit,
) {
    // The margins are worked out where it measures, so the room round it changing (the keyboard
    // settling) measures the pill again and composes it only when it changes shape.
    SubcomposeLayout(modifier.fillMaxWidth().testTag(ConversationComposerTags.COMPOSER)) { constraints ->
        val below = if (meter != null) ContextMeterSpec.height else 8.dp
        val compact = constraints.hasBoundedHeight && constraints.maxHeight.toDp() < minimumOpen + 8.dp + below + keep
        // Split whole spare pixels so rounding each margin cannot steal
        // one pixel from the minimum touch surface at fractional densities.
        val vertical = if (compact) ((constraints.maxHeight - minimumCompact.roundToPx()).coerceAtLeast(0) / 2).coerceAtMost(8.dp.roundToPx()) else 8.dp.roundToPx()
        val bottom = if (compact || meter == null) vertical else ContextMeterSpec.height.roundToPx()
        val horizontal = 12.dp.roundToPx()
        val inner = constraints.copy(minWidth = 0, minHeight = 0).offset(-2 * horizontal, -vertical - bottom)
        val placeables = subcompose(Unit) { content(compact) }.map { it.measure(inner) }
        val shown = if (compact) null else meter?.let { row -> subcompose(Slot.METER, row).map { it.measure(Constraints()) } }
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else (placeables.maxOfOrNull { it.width } ?: 0) + 2 * horizontal
        val pill = placeables.maxOfOrNull { it.height } ?: 0
        val height = constraints.constrainHeight(pill + vertical + bottom)
        layout(width, height) {
            placeables.forEach { it.place(horizontal, vertical) }
            val end = width - horizontal - ContextMeterSpec.trailingInset.roundToPx()
            shown?.forEach { it.place(end - it.width, vertical + pill) }
        }
    }
}

@Composable
private fun ComposerPictures(images: List<AttachmentPreview>, strip: PictureStripState, onRemove: (String) -> Unit) {
    PictureStripFrame(strip, Modifier.fillMaxWidth().padding(top = 12.dp).testTag(ConversationComposerTags.PICTURES), thumb = { ComposerPicture(it, onRemove = {}) }) {
        // Full width, so a picture sliding into a place freed is never cut at the row's end.
        LazyRow(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(images, key = { it.id }) { picture -> ComposerPicture(picture, onRemove, pictureMotion(picture.id, strip)) }
        }
    }
}

@Composable
private fun ComposerPicture(picture: AttachmentPreview, onRemove: (String) -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.size(64.dp)) {
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

/** What the primary button draws, morphing from one to the next ([PrimaryGlyph]). */
private enum class PrimaryGlyphKind { Send, Stop, Busy }
