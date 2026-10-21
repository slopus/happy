package com.slopus.happy.ui.autocomplete

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isFinite
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.autocomplete.AutocompleteServices
import com.slopus.happy.autocomplete.COMPOSER_PREFIXES
import com.slopus.happy.autocomplete.FileItem
import com.slopus.happy.autocomplete.SessionSuggestions
import com.slopus.happy.autocomplete.Suggestion
import com.slopus.happy.autocomplete.SuggestionList
import com.slopus.happy.autocomplete.SuggestionSource
import com.slopus.happy.autocomplete.TextSelection
import com.slopus.happy.autocomplete.applySuggestion
import com.slopus.happy.autocomplete.findActiveWord
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.files.FileIcon
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object AutocompleteTags {
    const val LIST = "autocomplete.list"
    const val ROW = "autocomplete.row"
    const val ICON = "autocomplete.icon"
    const val LABEL = "autocomplete.label"
}

/** AgentInputAutocomplete.tsx and AgentInputSuggestionView.tsx (Android phone). */
object AutocompleteSpec {
    val maxHeight = 320.dp
    val itemHeight = 48.dp
    val radius = 24.dp
    val shadow = 14.dp
    val marginBottom = 8.dp
    val paddingHorizontal = 8.dp

    /** AgentInput: no side inset when the screen is wider than 700. */
    val widePaddingHorizontal = 0.dp
    val wideScreen = 700.dp
    val rowPaddingHorizontal = 16.dp
    val rowPaddingVertical = 12.dp
    val command = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold)
    val commandGap = 12.dp
    val description = happyTextStyle(fontSize = 13)
    val iconCircle = 32.dp
    val icon = 18.dp
    val iconGap = 12.dp
    val path = happyTextStyle(fontSize = 14)
    val label = happyTextStyle(fontSize = 12)
    val labelGap = 8.dp
    const val ENTER_MS = 190
    const val EXIT_MS = 140
}

/**
 * The composer's cursor, shared with the overlay: the composer reports
 * [selection] as it moves, applies [placement] once its text matches
 * (after a suggestion is inserted), and offers its hardware keys to
 * [onKey] before handling them itself.
 */
@Stable
class ComposerCursor {
    var selection by mutableStateOf(TextRange.Zero)
    var placement by mutableStateOf<Placement?>(null)

    /** True when the key was used; the text field then never sees it. */
    var onKey: (KeyEvent) -> Boolean = { false }

    data class Placement(val text: String, val selection: TextRange)
}

/** The open chat's suggestions; null (no list) outside a session. */
val LocalSuggestionSource = staticCompositionLocalOf<SuggestionSource?> { null }

/** SessionView's `getSuggestions(sessionId, query)`, against the live metadata for commands. */
@Composable
fun rememberSessionSuggestions(graph: AppGraph, sessionId: String, metadata: SessionMetadata?): SuggestionSource {
    val latest by rememberUpdatedState(metadata)
    val files = remember(graph) { AutocompleteServices.of(graph).files }
    return remember(files, sessionId) { SessionSuggestions(sessionId, { latest }, files) }
}

/** useActiveWord + useActiveSuggestions for one composer. */
@Stable
class ComposerAutocomplete internal constructor(val cursor: ComposerCursor) {
    internal var list by mutableStateOf(SuggestionList())
    internal var query by mutableStateOf<String?>(null)

    /** The query Escape hid; its list stays hidden until the active word changes. */
    internal var dismissed by mutableStateOf<String?>(null)
    internal var text = ""
    internal var onTextChange: (String) -> Unit = {}
    internal var onPicked: () -> Unit = {}

    /** The rows on show: none without an active word. */
    val suggestions: List<Suggestion> get() = if (query == null || query == dismissed) emptyList() else list.suggestions
    val selected: Int get() = if (query == null || query == dismissed) -1 else list.selected

    fun moveUp() {
        list = list.movedUp()
    }

    fun moveDown() {
        list = list.movedDown()
    }

    /** AgentInput `handleSuggestionSelect`: swap the active word for the pick and a space, the cursor after it. */
    fun select(index: Int) {
        val suggestion = suggestions.getOrNull(index) ?: return
        val result = applySuggestion(text, cursor.selection.toTextSelection(text), suggestion.text, COMPOSER_PREFIXES, addSpace = true)
        cursor.placement = ComposerCursor.Placement(result.text, TextRange(result.cursorPosition))
        onTextChange(result.text)
        onPicked()
    }

    /**
     * AgentInput `handleKeyPress` while suggestions show: up and down move
     * the selection (wrapping), Enter or Tab (not Shift+Tab) picks the
     * selected row (the first if none), Escape hides the list. Anything
     * else, or any key with no list, goes to the text field.
     */
    fun onKey(event: KeyEvent): Boolean {
        if (suggestions.isEmpty()) return false
        val handled = when (event.key) {
            Key.DirectionUp, Key.DirectionDown, Key.Enter, Key.NumPadEnter, Key.Escape -> true
            Key.Tab -> !event.isShiftPressed
            else -> false
        }
        // The key-up of a key we took is swallowed too, so the field never sees half a press.
        if (!handled || event.type != KeyEventType.KeyDown) return handled
        when (event.key) {
            Key.DirectionUp -> moveUp()
            Key.DirectionDown -> moveDown()
            Key.Escape -> dismissed = query
            else -> select(maxOf(selected, 0))
        }
        return true
    }
}

private fun TextRange.toTextSelection(text: String) = TextSelection(start.coerceIn(0, text.length), end.coerceIn(0, text.length))

/**
 * Suggestions for the composer's [text]: the `@` or `/` word at the cursor
 * is looked up in [LocalSuggestionSource]; later results replace earlier
 * ones, and an abandoned query's results never land.
 */
@Composable
fun rememberComposerAutocomplete(text: String, onTextChange: (String) -> Unit): ComposerAutocomplete {
    val source = LocalSuggestionSource.current
    val haptics = LocalHapticFeedback.current
    val state = remember { ComposerAutocomplete(ComposerCursor()) }
    state.text = text
    state.onTextChange = onTextChange
    state.onPicked = { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
    state.cursor.onKey = state::onKey
    val query = source?.let { findActiveWord(text, state.cursor.selection.toTextSelection(text), COMPOSER_PREFIXES)?.activeWord }
    state.query = query
    if (state.dismissed != null && state.dismissed != query) state.dismissed = null
    LaunchedEffect(source, query) {
        if (source != null && query != null) state.list = state.list.replaced(source.suggestions(query))
    }
    return state
}

private val enterEasing = CubicBezierEasing(0.33f, 1f, 0.68f, 1f)
private val exitEasing = CubicBezierEasing(0.32f, 0f, 0.67f, 0f)

/**
 * AgentInputAutocomplete.tsx on Android: over the chat, 8 above the
 * composer and 8 in from its edges (flush on screens wider than 700),
 * within the composer's width (held to the content max width on
 * tablets), a radius 24 card on
 * glass.backgroundStrong with a hairline glass border and elevation 14,
 * at most 320 high and scrolling. Rows are 48 high, the selected one on
 * surfaceSelected, a pressed one on surfacePressed. It fades in over 190 ms
 * from 0.96 scale and 8 lower, and fades out over 140 ms.
 */
@Composable
fun ComposerSuggestions(state: ComposerAutocomplete, modifier: Modifier = Modifier) {
    val suggestions = state.suggestions
    var shown by remember { mutableStateOf(suggestions) }
    if (suggestions.isNotEmpty()) shown = suggestions
    val density = LocalDensity.current
    AnimatedVisibility(
        visible = suggestions.isNotEmpty(),
        modifier = modifier,
        enter = fadeIn(tween(AutocompleteSpec.ENTER_MS, easing = enterEasing)) +
            scaleIn(tween(AutocompleteSpec.ENTER_MS, easing = enterEasing), initialScale = 0.96f) +
            slideInVertically(tween(AutocompleteSpec.ENTER_MS, easing = enterEasing)) { with(density) { 8.dp.roundToPx() } },
        exit = fadeOut(tween(AutocompleteSpec.EXIT_MS, easing = exitEasing)),
    ) {
        SuggestionCard(shown, state.selected, onSelect = state::select)
    }
}

@Composable
private fun SuggestionCard(suggestions: List<Suggestion>, selected: Int, onSelect: (Int) -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(AutocompleteSpec.radius)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val width = LocalWindowLayout.current.width
    val wide = width.isFinite && width > AutocompleteSpec.wideScreen
    val listState = rememberLazyListState()
    // Keyboard selection keeps the selected row in view, scrolling no further than needed.
    LaunchedEffect(selected) {
        if (selected < 0) return@LaunchedEffect
        val visible = listState.layoutInfo.visibleItemsInfo
        val item = visible.firstOrNull { it.index == selected }
        val viewport = listState.layoutInfo.viewportEndOffset
        when {
            item == null && selected < (visible.firstOrNull()?.index ?: 0) -> listState.scrollToItem(selected)
            item == null -> {
                // Below the window: bring it in, then down to the bottom edge (scrollToItem may have clamped).
                listState.scrollToItem(selected)
                val info = listState.layoutInfo
                info.visibleItemsInfo.firstOrNull { it.index == selected }?.let { listState.scrollBy((it.offset + it.size - info.viewportEndOffset).toFloat()) }
            }
            item.offset < 0 -> listState.scrollToItem(selected)
            item.offset + item.size > viewport -> listState.scrollBy((item.offset + item.size - viewport).toFloat())
        }
    }
    LazyColumn(
        state = listState,
        modifier = Modifier
            .padding(horizontal = if (wide) AutocompleteSpec.widePaddingHorizontal else AutocompleteSpec.paddingHorizontal)
            .padding(bottom = AutocompleteSpec.marginBottom)
            .testTag(AutocompleteTags.LIST)
            .fillMaxWidth()
            .heightIn(max = AutocompleteSpec.maxHeight)
            .shadow(AutocompleteSpec.shadow, shape)
            .clip(shape)
            .background(colors.glass.backgroundStrong)
            .border(hairline, ChatTheme.colors.glassBorder, shape),
    ) {
        itemsIndexed(suggestions, key = { _, it -> it.key }) { index, suggestion ->
            SuggestionRow(selected = index == selected, onClick = { onSelect(index) }) {
                when (suggestion) {
                    is Suggestion.Command -> CommandSuggestion(suggestion)
                    is Suggestion.FileMention -> FileMentionSuggestion(suggestion)
                }
            }
        }
    }
}

@Composable
private fun SuggestionRow(selected: Boolean, onClick: () -> Unit, content: @Composable RowScope.() -> Unit) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val background = when {
        pressed -> colors.surfacePressed
        selected -> colors.surfaceSelected
        else -> Color.Transparent
    }
    Row(
        modifier = Modifier
            .testTag(AutocompleteTags.ROW)
            .semantics { this.selected = selected }
            .fillMaxWidth()
            .height(AutocompleteSpec.itemHeight)
            .background(background)
            // Like keyboardShouldPersistTaps: a tap picks without taking focus from the composer.
            .focusProperties { canFocus = false }
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = AutocompleteSpec.rowPaddingHorizontal, vertical = AutocompleteSpec.rowPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        content()
    }
}

/** `CommandSuggestion`: "/command" 14 semibold, then the description 13 secondary on one line, 12 apart. */
@Composable
private fun RowScope.CommandSuggestion(suggestion: Suggestion.Command) {
    val colors = HappyTheme.colors
    Text(
        suggestion.text,
        style = AutocompleteSpec.command,
        color = colors.text,
        modifier = Modifier.padding(end = if (suggestion.description != null) AutocompleteSpec.commandGap else 0.dp),
    )
    suggestion.description?.let { description ->
        Text(
            description,
            style = AutocompleteSpec.description,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * `FileMentionSuggestion`: a 32 surfaceHigh circle with the icon (18) 12
 * before the path and name (14 secondary, one line), then FILE or FOLDER
 * 12 secondary, 8 after. Folders keep Ionicons folder; files show the
 * file-type icon (happy-app: document-text).
 */
@Composable
private fun RowScope.FileMentionSuggestion(suggestion: Suggestion.FileMention) {
    val colors = HappyTheme.colors
    val folder = suggestion.fileType == FileItem.FileType.Folder
    Box(
        modifier = Modifier
            .padding(end = AutocompleteSpec.iconGap)
            .testTag(AutocompleteTags.ICON)
            // 32 in a row whose padding leaves 24: it overflows evenly, as in RN.
            .requiredSize(AutocompleteSpec.iconCircle)
            .clip(CircleShape)
            .background(colors.surfaceHigh),
        contentAlignment = Alignment.Center,
    ) {
        if (folder) {
            Icon(Ionicon.Folder, AutocompleteSpec.icon, colors.textSecondary)
        } else {
            FileIcon(suggestion.fileName, AutocompleteSpec.icon)
        }
    }
    Text(
        suggestion.filePath + suggestion.fileName,
        style = AutocompleteSpec.path,
        color = colors.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
    )
    Text(
        stringResource(if (folder) R.string.agent_input_suggestion_folder_label else R.string.agent_input_suggestion_file_label),
        style = AutocompleteSpec.label,
        color = colors.textSecondary,
        modifier = Modifier.padding(start = AutocompleteSpec.labelGap).testTag(AutocompleteTags.LABEL),
    )
}
