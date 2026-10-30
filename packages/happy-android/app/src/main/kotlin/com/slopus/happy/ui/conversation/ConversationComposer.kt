package com.slopus.happy.ui.conversation

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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.InlinePictures
import com.slopus.happy.conversation.Mode
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.GlassColors
import com.slopus.happy.ui.components.GlassSource
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.glass
import com.slopus.happy.ui.components.rememberGlassBlur
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import java.io.File

object ConversationComposerTags {
    const val COMPOSER = "conversation.composer"
    /** The glass pill itself, inside [COMPOSER]'s margins. */
    const val PILL = "conversation.composer.pill"
    const val INPUT = "conversation.composer.input"
    const val PRIMARY = "conversation.composer.primary"
    /** The [+] that opens the menu of pictures and permissions. */
    const val MORE = "conversation.composer.more"
    const val MENU = "conversation.composer.menu"
    const val PASTE = "conversation.composer.paste"
    /** The menu's "Add picture". */
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
 * works and nothing is typed. [+] opens a menu: paste an image, Add picture
 * (the system photo picker) and the permission mode. Both menus float above
 * the composer and keyboard, keeping the draft and caret in place. The pill is glass over [backdrop] (the
 * transcript under it), its tint alone where nothing blurs. With Reduce
 * Motion it changes shape at once. Pictures that together pass what one
 * message carries ([InlinePictures]) are refused with an alert, keeping text
 * and pictures.
 */
@Composable
internal fun ConversationComposer(
    state: ConversationState,
    text: String,
    onTextChange: (String) -> Unit,
    onSend: (String, List<File>) -> Boolean,
    onSent: () -> Unit,
    onStop: () -> Unit,
    onModeChange: (Mode) -> Unit,
    modifier: Modifier = Modifier,
    backdrop: GlassSource? = null,
) {
    val colors = HappyTheme.colors
    val pictures = rememberComposerImages(enabled = true)
    var tooLarge by remember { mutableStateOf(false) }
    val attached = pictures?.images.orEmpty()
    val hasContent = text.isNotBlank() || attached.isNotEmpty()
    val primary = primaryActionOf(hasContent, state)
    // The field's own selection; text set from outside puts the cursor at its end, or where focus asks.
    // Saved, so a rotation or a return from process death keeps the caret where it was.
    var field by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue(text, TextRange(text.length))) }
    if (field.text != text) field = TextFieldValue(text, TextRange(text.length))
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var focused by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var picker by rememberSaveable { mutableStateOf<ModePicker?>(null) }
    var moreCenterY by remember { mutableIntStateOf(0) }
    var modelCenterY by remember { mutableIntStateOf(0) }
    LaunchedEffect(state.composerFocus?.serial) {
        val ask = state.composerFocus ?: return@LaunchedEffect
        field = field.copy(selection = TextRange(ask.cursor.coerceIn(0, field.text.length)))
        focus.requestFocus()
        keyboard?.show()
    }
    fun openPicker(which: ModePicker) {
        menu = false
        picker = which
    }

    val open = focused || text.isNotEmpty() || attached.isNotEmpty()
    val reduceMotion = rememberReduceMotion()
    val corner by animateDpAsState(
        if (open) ConversationComposerSpec.openCorner else ConversationComposerSpec.restCorner,
        if (reduceMotion) snap() else spring(stiffness = 700f),
        label = "composer corner",
    )
    val shape = RoundedCornerShape(corner)
    val blurs = rememberGlassBlur()

    Box(modifier.fillMaxWidth().testTag(ConversationComposerTags.COMPOSER).padding(ConversationComposerSpec.margin)) {
        Column(
            Modifier
                .fillMaxWidth()
                .glass(backdrop, shape, GlassColors.of(colors.dark), blurs)
                .clip(shape)
                .animateContentSize(if (reduceMotion) snap() else spring(stiffness = 700f))
                .testTag(ConversationComposerTags.PILL),
        ) {
            if (attached.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 12.dp).testTag(ConversationComposerTags.PICTURES),
                ) {
                    items(attached, key = { it.id }) { picture ->
                        Box(Modifier.size(64.dp)) {
                            RemoteImage(
                                picture.uri,
                                contentDescription = picture.name,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.size(64.dp).clip(MaterialTheme.shapes.medium),
                            )
                            FilledTonalIconButton(
                                onClick = { pictures?.remove(picture.id) },
                                modifier = Modifier.align(Alignment.TopEnd).padding(2.dp).size(24.dp).testTag(ConversationComposerTags.PICTURE_REMOVE),
                            ) {
                                Icon(MaterialSymbols.Close, stringResource(R.string.conversation_remove_picture), Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
            ComposerLayout(open) {
                Box(Modifier.layoutId(Slot.MORE)) {
                    IconButton(onClick = { picker = null; menu = true }, modifier = Modifier.testTag(ConversationComposerTags.MORE)
                        .onGloballyPositioned { moreCenterY = it.boundsInWindow().center.y.toInt() }) {
                        Icon(MaterialSymbols.Add, stringResource(R.string.conversation_composer_more), tint = colors.text)
                    }
                }
                BasicTextField(
                    value = field,
                    onValueChange = {
                        field = it
                        if (it.text != text) onTextChange(it.text)
                    },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.text),
                    cursorBrush = SolidColor(colors.text),
                    maxLines = ConversationComposerSpec.MAX_LINES,
                    decorationBox = { inner ->
                        Box(Modifier.padding(vertical = 12.dp)) {
                            if (field.text.isEmpty()) {
                                Text(
                                    stringResource(R.string.conversation_message_placeholder),
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
                        .testTag(ConversationComposerTags.INPUT),
                )
                if (open) {
                    ConversationModeLabel(
                        catalog = state.catalog,
                        mode = state.mode,
                        onOpen = { openPicker(ModePicker.Model) },
                        modifier = Modifier.layoutId(Slot.LABEL).onGloballyPositioned { modelCenterY = it.boundsInWindow().center.y.toInt() },
                    )
                }
                val sendLabel = stringResource(if (primary == PrimaryAction.Stop) R.string.conversation_stop else R.string.conversation_send)
                val live = primary == PrimaryAction.Send || primary == PrimaryAction.Stop
                Box(Modifier.layoutId(Slot.PRIMARY).padding(end = 6.dp)) {
                    FilledIconButton(
                        onClick = {
                            when (primary) {
                                PrimaryAction.Send -> {
                                    if (!InlinePictures.fit(attached.map { it.size })) {
                                        tooLarge = true
                                    } else if (onSend(text, attached.mapNotNull { Uri.parse(it.uri).path?.let(::File) })) {
                                        pictures?.clear()
                                        onSent()
                                    }
                                }
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
                        if (state.stopping) {
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
        if (menu) {
            ComposerPopup(
                title = stringResource(R.string.conversation_composer_more),
                onDismiss = { menu = false },
                anchorCenterY = moreCenterY,
                alignEnd = false,
                width = 280.dp,
                modifier = Modifier.testTag(ConversationComposerTags.MENU),
            ) {
                LazyColumn {
                    item {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.image_upload_paste_from_clipboard)) },
                            onClick = { menu = false; pictures?.paste() },
                            modifier = Modifier.testTag(ConversationComposerTags.PASTE),
                        )
                    }
                    item {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.conversation_attach_picture)) },
                            leadingIcon = { Icon(MaterialSymbols.Image, contentDescription = null) },
                            onClick = { menu = false; pictures?.pick() },
                            modifier = Modifier.testTag(ConversationComposerTags.ATTACH),
                        )
                    }
                    val current = state.mode ?: state.catalog?.defaults
                    if (current != null) {
                        item {
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.conversation_mode_permission_item, permissionName(current.permissionMode))) },
                                leadingIcon = { Icon(MaterialSymbols.Lock, contentDescription = null) },
                                onClick = { openPicker(ModePicker.Permission) },
                                modifier = Modifier.testTag(ConversationModeTags.PERMISSION),
                            )
                        }
                    }
                }
            }
        }
        ConversationModePicker(picker, onClose = { picker = null }, catalog = state.catalog, mode = state.mode, onModeChange = onModeChange, anchorCenterY = if (picker == ModePicker.Permission) moreCenterY else modelCenterY)
    }
    if (tooLarge) {
        HappyAlert(
            Alert(
                stringResource(R.string.conversation_pictures_too_large_title),
                stringResource(R.string.conversation_pictures_too_large_message),
                listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { tooLarge = false },
        )
    }
}

/**
 * The pill's insides, one field whichever shape, so focus and the caret
 * survive the change. At rest: [+] | field | send, centred on one 48 row.
 * Open: the field across the top, 16 in, and under it a 48 row of [+],
 * then the label and send at the end.
 */
@Composable
private fun ComposerLayout(open: Boolean, content: @Composable () -> Unit) {
    Layout(content) { measurables, constraints ->
        val width = constraints.maxWidth
        val loose = Constraints(maxWidth = width)
        fun slot(id: String) = measurables.firstOrNull { it.layoutId == id }
        val more = slot(Slot.MORE)!!.measure(loose)
        val primary = slot(Slot.PRIMARY)!!.measure(loose)
        val rowHeight = maxOf(ConversationComposerSpec.rest.roundToPx(), more.height, primary.height)
        if (!open) {
            val fieldWidth = (width - more.width - primary.width).coerceAtLeast(0)
            val field = slot(Slot.FIELD)!!.measure(Constraints.fixedWidth(fieldWidth))
            val height = maxOf(rowHeight, field.height)
            layout(width, height) {
                more.place(0, (height - more.height) / 2)
                field.place(more.width, (height - field.height) / 2)
                primary.place(width - primary.width, (height - primary.height) / 2)
            }
        } else {
            val inset = ConversationComposerSpec.fieldPadding.roundToPx()
            val field = slot(Slot.FIELD)!!.measure(Constraints.fixedWidth((width - 2 * inset).coerceAtLeast(0)))
            val label = slot(Slot.LABEL)?.measure(Constraints(maxWidth = (width - more.width - primary.width).coerceAtLeast(0)))
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
