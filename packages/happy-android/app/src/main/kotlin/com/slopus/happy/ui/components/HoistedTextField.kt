package com.slopus.happy.ui.components

import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.text.TextRange

/**
 * A text field's own [TextFieldState] for words its owner keeps as a String
 * ([text], told of each edit through [onTextChange]). The state field moves
 * with its window without measuring anything for the keyboard; the old
 * value field rebuilt an empty paragraph on every frame it moved, to tell the
 * keyboard where its caret was (about a fifth of the main thread while the
 * keyboard slid in, on the conversation's dock).
 *
 * A [text] the field didn't write (a send's clear, a draft read back, an
 * insert) replaces the words, the caret at its end or where [placed] says
 * for that text. Saved with the screen, so a rotation keeps the caret.
 * Give the field the pair's [InputTransformation]: the owner hears of what
 * is typed as it is typed, before the field draws it, as onValueChange did.
 */
/** A field's state, and the transformation that tells its owner of each edit. */
typealias HoistedTextField = Pair<TextFieldState, InputTransformation>

@Composable
fun rememberHoistedTextFieldState(
    text: String,
    onTextChange: (String) -> Unit,
    placed: (String) -> TextRange? = { null },
): HoistedTextField {
    val state = rememberTextFieldState(text)
    // The words both sides last agreed on, so one from outside is told from the field's own running ahead.
    val agreed = remember { arrayOf(state.text.toString()) }
    if (text != agreed[0]) {
        agreed[0] = text
        val at = placed(text)
        when {
            at != null -> state.edit {
                if (!asCharSequence().contentEquals(text)) replace(0, length, text)
                selection = TextRange(at.start.coerceIn(0, text.length), at.end.coerceIn(0, text.length))
            }
            !state.text.contentEquals(text) -> state.setTextAndPlaceCursorAtEnd(text)
        }
    }
    val changed by rememberUpdatedState(onTextChange)
    fun seen(now: String) {
        if (now == agreed[0]) return
        agreed[0] = now
        changed(now)
    }
    // Every edit the field makes goes by its owner too: an undo, say, isn't typed.
    LaunchedEffect(state) { snapshotFlow { state.text.toString() }.collect(::seen) }
    return state to remember { InputTransformation { seen(asCharSequence().toString()) } }
}
