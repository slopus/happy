package com.slopus.happy.ui.conversation

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.text.plural
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme

object ToolSectionTags {
    const val SECTION = "conversation.section"
    const val SUMMARY = "conversation.section.summary"
    const val KINDS = "conversation.section.kinds"
    const val DURATION = "conversation.section.duration"
    const val ANSWERED = "conversation.answeredLine"
}

/**
 * A tool section's line coming in and going (desktop's ArrivingText, iOS's
 * `StreamingRevealMotion` played on): a character arriving fades in, rises
 * from [rise] below and grows from [SCALE] in [ARRIVE_MILLIS]; one leaving
 * rises [rise] further, shrinks to [SCALE] and fades in [LEAVE_MILLIS]. When
 * a character starts depends on its place in the line alone ([delay]), so
 * the character leaving a place and the one taking it start together.
 */
object ArrivalSpec {
    const val ARRIVE_MILLIS = 200
    const val LEAVE_MILLIS = 160

    /** However long a line is, its last character starts within this long. */
    const val LONGEST_MILLIS = 360f

    /** The place whose character starts halfway through [LONGEST_MILLIS]. */
    const val HALF_PLACE = 18f
    val rise = 6.dp
    const val SCALE = 0.5f

    /** CSS's ease-in-out. */
    val easing = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)

    /** When the character at [place] starts, after its line does: 20 ms apart at first, ever closer. */
    fun delay(place: Int): Float = LONGEST_MILLIS * place / (place + HALF_PLACE)

    /** Everything of a line is at rest this long after it starts. */
    const val TOTAL_MILLIS = 360 + ARRIVE_MILLIS
}

/** One run of the motion: its start in the clock's frame time, -1 until its first frame. */
internal class Motion {
    var start = -1L
}

/** A section line's frames: drawn again while a motion runs, without composing. */
@Stable
internal class SectionClock {
    /** The frame time, read in draw so only drawing follows it. */
    var frame by mutableLongStateOf(0L)
        private set
    private val running = ArrayList<Motion>()
    private var generationState by mutableIntStateOf(0)
    val generation: Int get() = generationState
    val busy: Boolean get() = running.isNotEmpty()

    fun motion(): Motion = Motion().also {
        running += it
        generationState++
    }

    suspend fun run() {
        while (running.isNotEmpty()) {
            withFrameMillis { time ->
                frame = time
                for (motion in running) if (motion.start < 0) motion.start = time
                running.removeAll { time - it.start > ArrivalSpec.TOTAL_MILLIS }
            }
        }
    }

    /** How far [motion] has brought the character at [place], eased: 0 before its turn, 1 once done. */
    fun progress(motion: Motion, place: Int, millis: Int): Float {
        val frame = frame
        if (motion.start < 0) return 0f
        return ArrivalSpec.easing.transform(((frame - motion.start - ArrivalSpec.delay(place)) / millis).coerceIn(0f, 1f))
    }

    fun done(motion: Motion?, places: Int): Boolean {
        val frame = frame
        return motion == null || (motion.start >= 0 && frame - motion.start >= ArrivalSpec.delay(places) + ArrivalSpec.ARRIVE_MILLIS)
    }
}

/** How one thing a line shows moves: [arrival] in (null: drawn at rest), [leave] out (null: staying). */
@Stable
internal class LineMotion(val clock: SectionClock, val arrival: Motion?, val leave: Motion? = null, val animates: Boolean = true)

/**
 * One piece of a line (a word, its glyph): what it showed and how it came.
 * Grown, only what is new arrives; changed to other words, it arrives again.
 */
internal class PieceMotion(var text: String, var arrival: Motion?) {
    var kept = 0
}

@Composable
internal fun rememberPiece(text: String, line: LineMotion): PieceMotion {
    val piece = remember(line) { PieceMotion(text, line.arrival) }
    if (piece.text != text) {
        piece.kept = if (text.startsWith(piece.text)) piece.text.length else 0
        piece.text = text
        piece.arrival = if (line.animates && line.leave == null) line.clock.motion() else null
    }
    return piece
}

/** Where the character at [index] of [piece], [lead] into its line, is now: its alpha, rise and scale into [out]. */
private fun LineMotion.look(piece: PieceMotion, index: Int, lead: Int, rise: Float, out: FloatArray) {
    val arrival = piece.arrival
    val came = when {
        arrival == null || index < piece.kept -> 1f
        else -> clock.progress(arrival, if (piece.kept == 0) lead + index else index - piece.kept, ArrivalSpec.ARRIVE_MILLIS)
    }
    val went = leave?.let { clock.progress(it, lead + index, ArrivalSpec.LEAVE_MILLIS) } ?: 0f
    out[0] = came * (1f - went)
    out[1] = lerp(rise * (1f - came), -rise, went)
    out[2] = lerp(lerp(ArrivalSpec.SCALE, 1f, came), ArrivalSpec.SCALE, went)
}

/** A glyph that arrives and leaves as its line's first character. */
internal fun Modifier.arrivingGlyph(piece: PieceMotion, line: LineMotion): Modifier = graphicsLayer {
    val look = FloatArray(3)
    line.look(piece, 0, 0, ArrivalSpec.rise.toPx(), look)
    alpha = look[0]
    translationY = look[1]
    scaleX = look[2]
    scaleY = look[2]
}

/**
 * Text whose characters arrive and leave one by one, [lead] places into
 * its line; at rest it draws as it is. [layout] is the text's own, given by
 * its `onTextLayout`. Only alpha, rise and scale move: the text keeps its box.
 */
internal fun Modifier.arrivingText(piece: PieceMotion, line: LineMotion, lead: Int, layout: Array<TextLayoutResult?>): Modifier = drawWithContent {
    val text = layout[0]
    val clock = line.clock
    if (text == null || (line.leave == null && clock.done(piece.arrival, lead + piece.text.length))) {
        drawContent()
        return@drawWithContent
    }
    val look = FloatArray(3)
    val rise = ArrivalSpec.rise.toPx()
    val visible = text.getLineEnd(0, visibleEnd = true)
    var right = 0f
    for (index in 0 until minOf(visible, text.layoutInput.text.length)) {
        val box = text.getBoundingBox(index)
        if (box.width <= 0f) continue
        line.look(piece, index, lead, rise, look)
        drawPiece(text, box.left, box.right, look)
        right = box.right
    }
    // The ellipsis is one more character, after the last one shown.
    if (text.isLineEllipsized(0)) {
        line.look(piece, visible, lead, rise, look)
        drawPiece(text, right, size.width, look)
    }
}

private fun ContentDrawScope.drawPiece(text: TextLayoutResult, left: Float, right: Float, look: FloatArray) {
    if (look[0] <= 0f || right <= left) return
    val height = size.height
    withTransform({
        translate(top = look[1])
        scale(look[2], look[2], Offset((left + right) / 2f, height / 2f))
        clipRect(left, 0f, right, height)
    }) { drawText(text, alpha = look[0]) }
}

/** What a section's line shows: a call, by its place in the run, or the run summed up. */
private const val SUMMARY = "summary"

/** The call a section line showed last, going out under the one that replaced it. */
private class Leaving(val tool: ToolUse, val motion: LineMotion)

@Stable
private class SectionLine(var shown: String, var tool: ToolUse, var current: LineMotion) {
    var leaving by mutableStateOf<Leaving?>(null)
}

/**
 * A run of tool calls as one grey line (desktop's `AgentToolSection`), the
 * [ToolLine]'s own 32 in every state, so nothing around it moves as calls
 * come, finish or fail, or the run ends.
 *
 * Live, the line is its latest call ([ToolLine] in textSecondary, a failed
 * call too, its edit counts in the same grey). A new call replaces the one
 * before it letter by letter ([ArrivalSpec]): its glyph first, then each
 * place as its turn comes, the old character rising out as the new one
 * comes in, and what is left past the new line's end going on in the same
 * order. Ended, a run of two or more calls says what it was made of, then
 * how long it took ([SectionSummary]), arriving the same way over the last
 * call when watched; a run of one call stays that call's line. Drawn
 * already ended (history), it is at rest. A tap opens the call shown.
 */
@Composable
internal fun ToolSectionRow(row: ConversationRow.Section, actions: ConversationRowActions, modifier: Modifier = Modifier) {
    val still = rememberReduceMotion()
    val clock = remember { SectionClock() }
    val summary = !row.live && row.calls.size > 1
    val latest = row.latest
    // A turn stopped mid-call: its call no longer spins.
    val tool = if (!row.live && latest.running) latest.copy(status = "completed") else latest
    val showing = if (summary) SUMMARY else "call:${latest.id ?: row.calls.lastIndex}"
    val line = remember { SectionLine(showing, tool, LineMotion(clock, if (row.live && !still) clock.motion() else null, animates = !still)) }
    if (line.shown != showing) {
        // Only a call this line drew leaves; the summary gives way at once.
        line.leaving = if (line.shown != SUMMARY && !still) Leaving(line.tool, LineMotion(clock, line.current.arrival, clock.motion())) else null
        line.shown = showing
        line.current = LineMotion(clock, if (still) null else clock.motion(), animates = !still)
    }
    if (!summary) line.tool = tool
    val generation = clock.generation
    LaunchedEffect(generation) {
        if (!clock.busy) return@LaunchedEffect
        clock.run()
        line.leaving = null
    }
    Box(modifier.fillMaxWidth().testTag(ToolSectionTags.SECTION)) {
        line.leaving?.let { ToolLine(it.tool, Modifier.clearAndSetSemantics {}, motion = it.motion, interactive = false) }
        if (summary) {
            SectionSummary(row, line.current)
        } else {
            ToolLine(tool, motion = line.current, onOpen = actions.opener(tool))
        }
    }
}

/** How many kinds of step a summary names before it counts the rest. */
private const val KINDS_NAMED = 4

/**
 * What a run was made of: each kind of step with its count, the most
 * frequent first and otherwise in the order they first ran; a kind that ran
 * once goes without its number, and past [KINDS_NAMED] kinds the rest are
 * counted together.
 */
internal fun sectionKinds(kinds: List<String>, more: (Int) -> String): List<String> {
    val counts = LinkedHashMap<String, Int>()
    for (kind in kinds) counts[kind] = (counts[kind] ?: 0) + 1
    val sorted = counts.entries.sortedByDescending { it.value }
    val named = if (sorted.size > KINDS_NAMED) sorted.take(KINDS_NAMED - 1) else sorted
    val rest = sorted.drop(named.size).sumOf { it.value }
    return named.map { (name, count) -> if (count > 1) "$name $count" else name } + listOfNotNull(rest.takeIf { it > 0 }?.let(more))
}

/**
 * An ended run summed up: a 12 flash glyph in the 14 lane, 6 apart, then
 * "Read 3 · Explore 2 · Edit" in 14/20 textSecondary, then " · 3m 12s"
 * (none under a second). Too narrow, the kinds end in "…" and the
 * duration stays.
 */
@Composable
private fun SectionSummary(row: ConversationRow.Section, motion: LineMotion) {
    val colors = HappyTheme.colors
    val res = LocalContext.current.resources
    val ink = colors.textSecondary
    val kinds = remember(row.calls, res) {
        sectionKinds(row.calls.map { ToolWords.kind(it, res) }) { res.plural(R.plurals.turn_kinds_more, it, it) }.joinToString(" · ")
    }
    val duration = row.durationMs?.takeIf { it >= 1_000 }?.let { " · " + turnDuration(it) }
    val spoken = kinds + duration.orEmpty()
    Row(
        Modifier
            .fillMaxWidth()
            .testTag(ToolSectionTags.SUMMARY)
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(horizontal = TurnRowSpec.margin, vertical = TurnRowSpec.paddingV)
            .height(TurnRowSpec.lineHeight),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val glyph = rememberPiece("flash", motion)
        Box(Modifier.size(TurnRowSpec.lane).arrivingGlyph(glyph, motion), contentAlignment = Alignment.Center) {
            Icon(Ionicon.FlashOutline, TurnRowSpec.glyph, ink)
        }
        Spacer(Modifier.width(TurnRowSpec.gap))
        ArrivingWords(kinds, 0, motion, Modifier.weight(1f, fill = false).testTag(ToolSectionTags.KINDS)) { text, layout, arriving ->
            Text(text, style = TurnRowSpec.subject, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis, onTextLayout = { layout[0] = it }, modifier = arriving)
        }
        if (duration != null) {
            ArrivingWords(duration, kinds.length, motion, Modifier.testTag(ToolSectionTags.DURATION)) { text, layout, arriving ->
                Text(text, style = TurnRowSpec.subject, color = ink, maxLines = 1, softWrap = false, onTextLayout = { layout[0] = it }, modifier = arriving)
            }
        }
    }
}

/** [text] drawn by [content] with its characters arriving [lead] places into [motion]'s line. */
@Composable
internal fun ArrivingWords(
    text: String,
    lead: Int,
    motion: LineMotion?,
    modifier: Modifier,
    content: @Composable (text: String, layout: Array<TextLayoutResult?>, modifier: Modifier) -> Unit,
) {
    if (motion == null) return content(text, arrayOfNulls(1), modifier)
    val piece = rememberPiece(text, motion)
    val layout = remember { arrayOfNulls<TextLayoutResult>(1) }
    content(text, layout, modifier.arrivingText(piece, motion, lead, layout))
}

/**
 * A question answered before this chat showed it, under Group tool calls
 * (desktop's `AnsweredQuestionLine`): the section's 32 line, a 12 question
 * glyph in the 14 lane, then each prompt's header (14/20 medium; its
 * question where it has none) and what was answered, " · " between
 * prompts, in textSecondary, ending in "…" where it runs out of room.
 */
@Composable
internal fun AnsweredLine(row: ConversationRow.Ask, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val none = stringResource(R.string.conversation_ask_no_answer)
    val text: AnnotatedString = remember(row.question, none) {
        buildAnnotatedString {
            row.question.prompts.forEachIndexed { index, prompt ->
                if (index > 0) append(" · ")
                withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(prompt.header?.takeIf { it.isNotBlank() } ?: prompt.question) }
                append(' ')
                append(row.question.answers?.get(prompt.id)?.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: none)
            }
        }
    }
    Row(
        modifier
            .fillMaxWidth()
            .testTag(ToolSectionTags.ANSWERED)
            .padding(horizontal = TurnRowSpec.margin, vertical = TurnRowSpec.paddingV)
            .height(TurnRowSpec.lineHeight),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(TurnRowSpec.lane), contentAlignment = Alignment.Center) {
            Icon(Ionicon.HelpCircleOutline, TurnRowSpec.glyph, colors.textSecondary)
        }
        Spacer(Modifier.width(TurnRowSpec.gap))
        Text(text, style = TurnRowSpec.subject, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
