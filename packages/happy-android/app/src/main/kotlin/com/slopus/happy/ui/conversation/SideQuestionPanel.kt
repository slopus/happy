package com.slopus.happy.ui.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.KeyboardActionHandler
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.SideAnswer
import com.slopus.happy.conversation.SideExchange
import com.slopus.happy.conversation.SideThread
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.CodeCopy
import com.slopus.happy.ui.chat.LocalCodeCopy
import com.slopus.happy.ui.chat.LocalMessageLift
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.PageProgressIndicator
import com.slopus.happy.ui.components.rememberHoistedTextFieldState
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.flow.collectLatest
import kotlin.math.roundToInt

object SideQuestionTags {
    const val PANEL = "conversation.side"
    const val TITLE = "conversation.side.title"
    const val SUBTITLE = "conversation.side.subtitle"
    const val CLOSE = "conversation.side.close"
    /** The exchanges, which scroll inside the panel. */
    const val THREAD = "conversation.side.thread"
    const val QUESTION = "conversation.side.question"
    const val ANSWER = "conversation.side.answer"
    const val COPY = "conversation.side.copy"
    /** A quiet line in an answer's place: answering, waiting its turn, no answer, a canned reply, or why there is none. */
    const val LINE = "conversation.side.line"
    const val FAILURE = "conversation.side.failure"
    const val FIELD = "conversation.side.field"
    const val ASK = "conversation.side.ask"
    /** A bare `/btw`'s line over the composer. */
    const val USAGE = "conversation.side.usage"
}

object SideQuestionSpec {
    /** In from the content column's edges, as the composer's pill is. */
    val marginHorizontal = 12.dp
    val radius = 16.dp
    val shadow = 12.dp
    /** The share of the room under its top it takes at most: the navigation bar and the keyboard are not room. */
    const val MAX_SHARE = 0.6f
    /** Its height cap never goes under this, so the header and the field stay usable over a tall keyboard. */
    val minHeight = 160.dp
    val headerStart = 16.dp
    val headerTop = 14.dp
    val headerBottom = 10.dp
    val subtitleGap = 2.dp
    val close = 48.dp
    val closeGlyph = 22.dp
    val closeInset = 4.dp
    val title = happyTextStyle(fontSize = 16, lineHeight = 22, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 13, lineHeight = 18)
    val threadHorizontal = 16.dp
    val threadVertical = 12.dp
    val exchangeGap = 16.dp
    val answerGap = 8.dp
    val bubbleRadius = 12.dp
    val bubbleHorizontal = 12.dp
    val bubbleVertical = 8.dp
    /** A question's bubble takes at most this share of the thread's width, at its end. */
    const val BUBBLE_SHARE = 0.85f
    val question = happyTextStyle(fontSize = 15, lineHeight = 20)
    val line = happyTextStyle(fontSize = 14, lineHeight = 19)
    val spinner = 14.dp
    val spinnerGap = 8.dp
    val copyGap = 4.dp
    val fieldRow = 12.dp
    val fieldGap = 8.dp
    val fieldMin = 40.dp
    val fieldRadius = 20.dp
    val fieldInset = 14.dp
    val fieldVertical = 10.dp
    const val FIELD_LINES = 4
    val field = happyTextStyle(fontSize = 15, lineHeight = 20)
    val ask = 36.dp
    val askGlyph = 18.dp
    /** Ask's glyph sits on the field's one line: its 40 less the button's 36, halved. */
    val askBottom = 2.dp
    /** Ask with nothing typed: textSecondary at this alpha, as the composer's send. */
    const val ASK_DISABLED_ALPHA = 0.45f
    const val FADE_MILLIS = 200
}

/**
 * What a chat's side questions do ([com.slopus.happy.conversation.SideThreads]);
 * a chat that can't ask them has none.
 */
class SideQuestionActions(
    /** Health's `capabilities.sideQuestions` as the link last read it, asked each time the person types or sends. */
    val served: () -> Boolean = { false },
    /** `/btw <question>` from the composer: asked in the chat's thread, which shows. */
    val onAsk: (String) -> Unit = {},
    /** The follow-up being typed in the panel, kept with the thread. */
    val onDraftChange: (String) -> Unit = {},
    /** Ask: the follow-up typed is asked in turn, and the field cleared. */
    val onAskDraft: () -> Unit = {},
    /** The panel's close, the only thing that ends a thread: the question being answered is dropped. */
    val onClose: () -> Unit = {},
)

/**
 * A chat's `/btw` thread ([com.slopus.happy.conversation.SideThreads]) over
 * the top of the chat, Claude Code's side panel: the questions asked on the
 * side, their answers, and a field for follow-ups. It draws the thread it
 * is given, which the connection keeps: leaving the chat and coming back
 * shows it again, at its latest answer. Not modal: the transcript, the bar
 * and the composer stay usable around it, and Back leaves the chat as
 * always; only its close ends the thread. It fades in and out over 0.2 s
 * (at once with Reduce Motion).
 *
 * Spec: its top rests at [top], where the transcript's first row rests
 * (under the bar and its feather, so the bar is never covered); 12 in from
 * the content column's edges, as the composer's pill; a surfaceHigh card,
 * radius 16, a 12 shadow, and touches on it stop at it, as on the bar. It
 * takes at most 60% of the room under its top that the navigation bar and
 * the keyboard leave (read where it lays out, as the keyboard rests), never
 * capped under 160, and wraps a short thread; but it always ends above the
 * composer and what sits on it ([dock]), the 160 giving way. Short of room,
 * the follow-up field stays in view; a header that doesn't fit whole above
 * it steps aside, never cut through its words, and the thread takes its
 * place until there is room again.
 * Header: "Side question" 16/22 semibold and the subtitle 13/18
 * textSecondary 2 under it, 16 in and 14 from the top, 10 above a hairline;
 * close, a 48 button with a 22 glyph, 4 in from the top end. The thread
 * scrolls inside, padded 16/12, exchanges 16 apart: the question at the
 * end in the person's bubble colour (radius 12, padding 12/8, 15/20, at
 * most 85% wide), then 8 under it the answer as Markdown with the chat's
 * copy button 4 under it, which copies the answer alone. A quiet line
 * (14/19 textSecondary) stands in its place while Claude answers (behind a
 * 14 spinner, 8 before it), while it waits for the answer above, for no
 * answer, for a canned reply (which has no copy button) and for why there
 * is none; a failure reads "Couldn't get an answer: …" in textDestructive.
 * Under a hairline the follow-up field: 12 padding, a surfaceHighest pill
 * at least 40 high (radius 20, 14/10 in, 15/20, up to four lines, then it
 * scrolls), and 8 after it Ask, a 36 circle with an 18 arrow, 2 above the
 * row's foot, in the composer send's colours: the text colour with the
 * surface's arrow, textSecondary at 0.45 while nothing is typed.
 */
@Composable
internal fun SideQuestionPanel(
    thread: SideThread?,
    actions: SideQuestionActions,
    /** Where its top rests: the transcript's, the bar's height and its feather down. */
    top: Dp,
    keyboard: KeyboardLift,
    /** The person's bubble colours in this chat, which the questions wear. */
    bubble: BubblePalette,
    /** The height of the chat's dock (the composer and what sits on it) over the keyboard, read where it lays out. */
    dock: () -> Int,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = rememberReduceMotion()
    // As last shown, for the fade after it closes.
    val last = remember { arrayOfNulls<SideThread>(1) }
    val shown = thread?.also { last[0] = it } ?: last[0] ?: return
    val navigation = WindowInsets.navigationBars
    AnimatedVisibility(
        visible = thread != null,
        enter = if (reduceMotion) EnterTransition.None else fadeIn(tween(SideQuestionSpec.FADE_MILLIS)),
        exit = if (reduceMotion) ExitTransition.None else fadeOut(tween(SideQuestionSpec.FADE_MILLIS)),
        modifier = modifier.underBar(top, keyboard, navigation, dock),
    ) {
        // Its words are its own: a long press lifts nothing of the chat's.
        CompositionLocalProvider(LocalMessageLift provides null, LocalCodeCopy provides CodeCopy.Icon) {
            SideQuestionCard(shown, actions, bubble)
        }
    }
}

/**
 * At [top], in at most [SideQuestionSpec.MAX_SHARE] of the room under it
 * that the navigation bar and the resting keyboard leave
 * ([KeyboardLift.rest], read where it lays out: the keyboard settling
 * measures it again and composes nothing), never capped under
 * [SideQuestionSpec.minHeight], and never reaching under the [dock] over
 * the keyboard, which the floor gives way to.
 */
private fun Modifier.underBar(top: Dp, keyboard: KeyboardLift, navigation: WindowInsets, dock: () -> Int): Modifier = layout { measurable, constraints ->
    val at = top.roundToPx()
    val max = if (!constraints.hasBoundedHeight) Constraints.Infinity else {
        val room = (constraints.maxHeight - at - navigation.getBottom(this) - keyboard.rest).coerceAtLeast(0)
        val share = maxOf(SideQuestionSpec.minHeight.roundToPx(), (room * SideQuestionSpec.MAX_SHARE).roundToInt())
        // What the keyboard and the dock leave: a phone on its side with the keyboard up has little more.
        minOf(share, (constraints.maxHeight - at - keyboard.rest - dock()).coerceAtLeast(0))
    }
    val placeable = measurable.measure(constraints.copy(minHeight = 0, maxHeight = max))
    layout(placeable.width, at + placeable.height) { placeable.place(0, at) }
}

@Composable
private fun SideQuestionCard(thread: SideThread, actions: SideQuestionActions, bubble: BubblePalette) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(SideQuestionSpec.radius)
    val title = stringResource(R.string.side_question_title)
    Layout(
        content = {
            Column {
                SideQuestionHeader(title, actions.onClose)
                Hairline(colors.divider)
            }
            SideThreadView(thread, bubble, Modifier)
            Column {
                Hairline(colors.divider)
                FollowUp(thread.draft, actions)
            }
        },
        modifier = Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .padding(horizontal = SideQuestionSpec.marginHorizontal)
            .testTag(SideQuestionTags.PANEL)
            // Touches on it stop at it, as on the bar, rather than reaching the chat under it.
            .pointerInput(Unit) {}
            .shadow(SideQuestionSpec.shadow, shape)
            .clip(shape)
            .background(colors.surfaceHigh)
            .semantics { paneTitle = title },
    ) { (header, exchanges, field), constraints ->
        val width = constraints.maxWidth
        val whole = Constraints(minWidth = width, maxWidth = width)
        val headerPlaceable = header.measure(whole)
        val fieldPlaceable = field.measure(whole)
        val bounded = constraints.hasBoundedHeight
        // A header that doesn't fit whole above the field steps aside, rather than be cut through its words.
        val withHeader = !bounded || headerPlaceable.height + fieldPlaceable.height <= constraints.maxHeight
        val fixed = fieldPlaceable.height + if (withHeader) headerPlaceable.height else 0
        val room = if (bounded) (constraints.maxHeight - fixed).coerceAtLeast(0) else Constraints.Infinity
        val exchangesPlaceable = exchanges.measure(whole.copy(maxHeight = room))
        val height = (fixed + exchangesPlaceable.height).let { if (bounded) it.coerceAtMost(constraints.maxHeight) else it }
        layout(width, height) {
            // From the foot up: short of room, the field stays in view.
            val fieldAt = height - fieldPlaceable.height
            fieldPlaceable.place(0, fieldAt)
            exchangesPlaceable.place(0, fieldAt - exchangesPlaceable.height)
            if (withHeader) headerPlaceable.place(0, fieldAt - exchangesPlaceable.height - headerPlaceable.height)
        }
    }
}

/** The title, the subtitle under it, and close at the top end. */
@Composable
private fun SideQuestionHeader(title: String, onClose: () -> Unit) {
    val colors = HappyTheme.colors
    Row(Modifier.fillMaxWidth()) {
        Column(
            Modifier
                .weight(1f)
                .padding(start = SideQuestionSpec.headerStart, top = SideQuestionSpec.headerTop, bottom = SideQuestionSpec.headerBottom),
        ) {
            Text(title, style = SideQuestionSpec.title, color = colors.text, modifier = Modifier.testTag(SideQuestionTags.TITLE))
            Text(
                stringResource(R.string.side_question_subtitle),
                style = SideQuestionSpec.subtitle,
                color = colors.textSecondary,
                modifier = Modifier.padding(top = SideQuestionSpec.subtitleGap).testTag(SideQuestionTags.SUBTITLE),
            )
        }
        IconButton(
            onClick = onClose,
            modifier = Modifier
                .padding(top = SideQuestionSpec.closeInset, end = SideQuestionSpec.closeInset)
                .testTag(SideQuestionTags.CLOSE)
                .size(SideQuestionSpec.close),
        ) {
            Icon(Ionicon.Close, SideQuestionSpec.closeGlyph, colors.textSecondary, contentDescription = stringResource(R.string.conversation_close))
        }
    }
}

@Composable
private fun Hairline(color: Color) {
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Box(Modifier.fillMaxWidth().height(hairline).background(color))
}

/** The exchanges, scrolling inside the panel; it opens at the latest, and follows each that grows the thread. */
@Composable
private fun SideThreadView(thread: SideThread, bubble: BubblePalette, modifier: Modifier) {
    val scroll = rememberScrollState()
    LaunchedEffect(scroll) {
        var opened = false
        snapshotFlow { scroll.maxValue }.collectLatest { end ->
            if (opened) scroll.animateScrollTo(end) else scroll.scrollTo(end)
            opened = true
        }
    }
    Column(
        modifier
            .testTag(SideQuestionTags.THREAD)
            .fillMaxWidth()
            .verticalScroll(scroll)
            .padding(horizontal = SideQuestionSpec.threadHorizontal, vertical = SideQuestionSpec.threadVertical),
        verticalArrangement = Arrangement.spacedBy(SideQuestionSpec.exchangeGap),
    ) {
        thread.exchanges.forEachIndexed { index, exchange -> key(index) { Exchange(exchange, bubble) } }
    }
}

@Composable
private fun Exchange(exchange: SideExchange, bubble: BubblePalette) {
    val colors = HappyTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(SideQuestionSpec.answerGap)) {
        Text(
            exchange.question,
            style = SideQuestionSpec.question,
            color = colors.text,
            modifier = Modifier
                .atEnd(SideQuestionSpec.BUBBLE_SHARE)
                .testTag(SideQuestionTags.QUESTION)
                .clip(RoundedCornerShape(SideQuestionSpec.bubbleRadius))
                .background(bubble.background)
                .padding(horizontal = SideQuestionSpec.bubbleHorizontal, vertical = SideQuestionSpec.bubbleVertical),
        )
        // Read out as it lands, as the answer's words come in place of "Claude is answering…".
        Box(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
            Answer(exchange.answer)
        }
    }
}

@Composable
private fun Answer(answer: SideAnswer) {
    val colors = HappyTheme.colors
    when (answer) {
        SideAnswer.Queued -> Line(stringResource(R.string.side_question_queued))
        SideAnswer.Asking -> Row(verticalAlignment = Alignment.CenterVertically) {
            PageProgressIndicator(Modifier.size(SideQuestionSpec.spinner), color = colors.textSecondary, strokeWidth = 2.dp)
            Line(stringResource(R.string.side_question_answering), Modifier.padding(start = SideQuestionSpec.spinnerGap))
        }
        is SideAnswer.Answered -> {
            val response = answer.response
            when {
                response.isNullOrBlank() -> Line(stringResource(R.string.side_question_no_answer))
                // Claude Code's stand-in for an answer the model could not give: nothing to copy.
                answer.synthetic -> Line(response)
                else -> Column(Modifier.fillMaxWidth()) {
                    MarkdownView(answer.blocks, Modifier.fillMaxWidth().testTag(SideQuestionTags.ANSWER))
                    // The answer alone, as Claude Code's panel copies it, to paste into the chat.
                    Box(Modifier.padding(top = SideQuestionSpec.copyGap).testTag(SideQuestionTags.COPY)) { ProseCopyButton(response) }
                }
            }
        }
        is SideAnswer.Notice -> Line(problemText(answer.problem))
        is SideAnswer.Failed -> Line(
            stringResource(R.string.side_question_failed, problemText(answer.reason)),
            color = colors.textDestructive,
            tag = SideQuestionTags.FAILURE,
        )
    }
}

@Composable
private fun Line(text: String, modifier: Modifier = Modifier, color: Color = HappyTheme.colors.textSecondary, tag: String = SideQuestionTags.LINE) {
    Text(text, style = SideQuestionSpec.line, color = color, modifier = modifier.testTag(tag))
}

/** At most [share] of the width it is given, wrapping its content, at the end (the start, right to left). */
private fun Modifier.atEnd(share: Float): Modifier = layout { measurable, constraints ->
    val width = if (constraints.hasBoundedWidth) constraints.maxWidth else 0
    val placeable = measurable.measure(constraints.copy(minWidth = 0, maxWidth = if (constraints.hasBoundedWidth) (width * share).roundToInt() else Constraints.Infinity))
    val shown = maxOf(width, placeable.width)
    layout(shown, placeable.height) { placeable.placeRelative(shown - placeable.width, 0) }
}

@Composable
private fun FollowUp(draft: String, actions: SideQuestionActions) {
    val colors = HappyTheme.colors
    val (field, typed) = rememberHoistedTextFieldState(draft, actions.onDraftChange)
    val ask = stringResource(R.string.side_question_ask)
    val canAsk = draft.isNotBlank()
    Row(
        Modifier.fillMaxWidth().padding(SideQuestionSpec.fieldRow),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(SideQuestionSpec.fieldGap),
    ) {
        BasicTextField(
            state = field,
            inputTransformation = typed,
            textStyle = SideQuestionSpec.field.copy(color = colors.input.text),
            cursorBrush = SolidColor(colors.input.text),
            lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = SideQuestionSpec.FIELD_LINES),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
            onKeyboardAction = KeyboardActionHandler { actions.onAskDraft() },
            decorator = { inner ->
                Box(Modifier.padding(horizontal = SideQuestionSpec.fieldInset, vertical = SideQuestionSpec.fieldVertical)) {
                    if (field.text.isEmpty()) {
                        Text(stringResource(R.string.side_question_follow_up), style = SideQuestionSpec.field, color = colors.input.placeholder, maxLines = 1)
                    }
                    inner()
                }
            },
            modifier = Modifier
                .weight(1f)
                .testTag(SideQuestionTags.FIELD)
                .heightIn(min = SideQuestionSpec.fieldMin)
                .clip(RoundedCornerShape(SideQuestionSpec.fieldRadius))
                // The card's code blocks' ground: on surfaceHigh in both themes, where input's dark ground is the card's own.
                .background(colors.surfaceHighest),
        )
        // The composer's send, in its colours.
        Box(
            Modifier
                .padding(bottom = SideQuestionSpec.askBottom)
                .testTag(SideQuestionTags.ASK)
                .size(SideQuestionSpec.ask)
                .clip(CircleShape)
                .background(if (canAsk) colors.text else colors.textSecondary.copy(alpha = SideQuestionSpec.ASK_DISABLED_ALPHA))
                .clickable(enabled = canAsk, role = Role.Button, onClickLabel = ask, onClick = actions.onAskDraft)
                .semantics { contentDescription = ask },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Ionicon.ArrowUp, SideQuestionSpec.askGlyph, colors.surface)
        }
    }
}

/**
 * A bare `/btw`'s one line over the composer, on this phone only and never
 * sent, as Claude Code answers it: "Usage: /btw <your question>". Spec:
 * bodySmall, textSecondary, centred, 16 in and 4 above and below.
 */
@Composable
internal fun SideQuestionUsage(modifier: Modifier = Modifier) {
    Text(
        stringResource(R.string.side_question_usage),
        style = MaterialTheme.typography.bodySmall,
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.Center,
        modifier = modifier
            .testTag(SideQuestionTags.USAGE)
            .contentMaxWidth(LocalWindowLayout.current)
            .padding(horizontal = 16.dp, vertical = 4.dp),
    )
}
