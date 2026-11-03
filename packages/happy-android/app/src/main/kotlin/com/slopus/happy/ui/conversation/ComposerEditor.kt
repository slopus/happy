package com.slopus.happy.ui.conversation

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.rememberHoistedTextFieldState
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme

object ComposerEditorTags {
    const val EDITOR = "conversation.editor"
    const val FIELD = "conversation.editor.field"
    const val COLLAPSE = "conversation.editor.collapse"
}

/** iOS `ComposerEditorLayout.Metrics`. */
object ComposerEditorSpec {
    val textInset = 16.dp
    val textTop = 8.dp
    val textBottom = 8.dp
    val collapse = 44.dp
    val collapseGlyph = 18.dp
    val collapseTop = 4.dp
    val collapseTrailing = 8.dp
    /** UIKit's cross-dissolve. */
    const val FADE_MILLIS = 300
}

/**
 * The composer's words full screen, as Telegram's input expands once it is
 * past the lines the card shows (iOS `ComposerEditorViewController`): the
 * same words with the caret where it was, the keyboard staying up, from the
 * top of the screen to the keyboard, and the button that puts them back in
 * the card at its top end. It crossfades in and out over the chat.
 *
 * It is drawn in the chat's own window, not a dialog, so the keyboard stays
 * bound to one window and never drops as focus moves between the two
 * fields. Compose text has no exclusion paths, so every line keeps clear of
 * the collapse button, not only the first two as on iOS.
 *
 * Every edit goes out through [onTextChange] as the composer's own do; a
 * draft from elsewhere replaces the words, the caret kept where it can be.
 * Collapse or Back hands the caret back through [onClose], and whether the
 * keyboard was up, for the composer to take before this goes.
 */
@Composable
internal fun ComposerEditor(
    opened: TextRange?,
    text: String,
    onTextChange: (String) -> Unit,
    onClose: (selection: TextRange, focused: Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = rememberReduceMotion()
    // As last opened, for the fade out after it is closed.
    val last = remember { arrayOfNulls<TextRange>(1) }
    val shown = opened?.also { last[0] = it } ?: last[0] ?: return
    AnimatedVisibility(
        visible = opened != null,
        enter = if (reduceMotion) EnterTransition.None else fadeIn(tween(ComposerEditorSpec.FADE_MILLIS)),
        exit = if (reduceMotion) ExitTransition.None else fadeOut(tween(ComposerEditorSpec.FADE_MILLIS)),
        modifier = modifier,
    ) {
        // One editor a time it opens: its own words from where the caret was.
        androidx.compose.runtime.key(shown) {
            EditorPage(shown, text, onTextChange, onClose, closing = opened == null)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditorPage(
    opened: TextRange,
    text: String,
    onTextChange: (String) -> Unit,
    onClose: (TextRange, Boolean) -> Unit,
    closing: Boolean,
) {
    val colors = HappyTheme.colors
    val caret = remember { intArrayOf(opened.start) }
    val (field, typed) = rememberHoistedTextFieldState(text, onTextChange, placed = { TextRange(caret[0].coerceAtMost(it.length)) })
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(field) {
        field.edit { selection = TextRange(opened.start.coerceIn(0, length), opened.end.coerceIn(0, length)) }
        // Taken from the composer as it comes in, so the keyboard stays up.
        focus.requestFocus()
        keyboard?.show()
        snapshotFlow { field.selection.start }.collect { caret[0] = it }
    }
    // The keyboard put away (Back, its own button) leaves the words, as the keyboard going leaves the
    // card's on iOS: closed then, the composer doesn't bring it back.
    val focusManager = LocalFocusManager.current
    val imeUp = WindowInsets.isImeVisible
    val wasUp = remember { booleanArrayOf(false) }
    LaunchedEffect(imeUp) {
        if (imeUp) wasUp[0] = true else if (wasUp[0]) focusManager.clearFocus()
    }
    fun close() { if (!closing) onClose(field.selection, focused) }
    BackHandler(enabled = !closing) { close() }
    val title = stringResource(R.string.conversation_editor_expand)
    Box(
        Modifier
            .fillMaxSize()
            .background(colors.surface)
            .semantics { paneTitle = title }
            // Nothing under it takes a touch: one where no line is puts the caret back in the words.
            .pointerInput(Unit) { detectTapGestures { focus.requestFocus() } }
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .testTag(ComposerEditorTags.EDITOR),
    ) {
        BasicTextField(
            state = field,
            inputTransformation = typed,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.text),
            cursorBrush = SolidColor(colors.text),
            lineLimits = TextFieldLineLimits.MultiLine(),
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    start = ComposerEditorSpec.textInset,
                    top = ComposerEditorSpec.textTop,
                    end = ComposerEditorSpec.collapseTrailing + ComposerEditorSpec.collapse,
                    bottom = ComposerEditorSpec.textBottom,
                )
                .focusRequester(focus)
                .onFocusChanged { focused = it.isFocused }
                .testTag(ComposerEditorTags.FIELD),
        )
        IconButton(
            onClick = ::close,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = ComposerEditorSpec.collapseTop, end = ComposerEditorSpec.collapseTrailing)
                .size(ComposerEditorSpec.collapse)
                .testTag(ComposerEditorTags.COLLAPSE),
        ) {
            Icon(Ionicon.ContractOutline, ComposerEditorSpec.collapseGlyph, colors.textSecondary, contentDescription = stringResource(R.string.conversation_editor_collapse))
        }
    }
}
