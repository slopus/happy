package com.slopus.happy.ui.chat

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.NewWork
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.conversation.WorkKind
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StateAnimation
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.segmentThumb
import com.slopus.happy.ui.home.BotKindSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object NewWorkTags {
    const val PANEL = "newWork"
    const val KIND = "newWork.kind"
    fun kind(kind: WorkKind) = "newWork.kind.${kind.name}"
    const val NAME = "newWork.name"
    /** The name's capsule. */
    const val NAME_FIELD = "newWork.nameField"
    const val NOTE = "newWork.note"
    const val MACHINE = "newWork.machine"
    const val MACHINE_STATUS = "newWork.machineStatus"
    const val FOLDER = "newWork.folder"
    const val HARNESS = "newWork.harness"
    /** The kind's picture over the block. */
    fun art(art: StateArt) = "newWork.art.${art.name}"
}

/** happy-ios NewWorkLayout's metrics and NewWorkPanel's type. */
object NewWorkSpec {
    val side = 24.dp
    val maxWidth = 320.dp
    val kindWidth = 220.dp
    val kindToRows = 16.dp
    val rowHeight = 44.dp
    val rowGap = 8.dp
    val rowsToNote = 10.dp
    /** The gaps once the room is short; under the kind the computer's chip still clears it. */
    val tightKindToRows = NewWorkStatusSpec.overhang + 5.dp
    val tightRowGap = 6.dp
    /** A kind no computer makes yet. */
    const val DISABLED_ALPHA = 0.4f
    /** The least room kept over and under the block; with less it doesn't show. */
    val margin = 12.dp
    /** The name's and the rows' text, in from the capsule's ends. */
    val rowInset = 16.dp
    val rowIcon = 16.dp
    val rowIconGap = 8.dp
    const val FADE_MILLIS = 200
    val field = happyTextStyle(fontSize = 16)
    val note = happyTextStyle(fontSize = 13, lineHeight = 18)
    /**
     * The kind's picture over the block, an empty state's 128
     * ([StateAnimation]'s), 16 over the kind. Its size never changes with the
     * room: short of it, the block shifts up and the picture with it
     * (happy-ios NewWorkLayout).
     */
    val art = 128.dp
    val artToKind = 16.dp

    /** The block's width in a room [width] wide: 24 in from either side, at most 320. */
    fun blockWidth(width: Dp): Dp = minOf(maxWidth, width - side * 2).coerceAtLeast(0.dp)
}

/** Room kept for what another kind shows: laid out, but neither drawn nor read out. */
fun Modifier.reserved(): Modifier = alpha(0f).clearAndSetSemantics {}

/** The picture new work of this kind stands under: the robot for a bot, the clapper board for a task. */
val WorkKind.art: StateArt
    get() = when (this) {
        WorkKind.Bot -> StateArt.Ready
        WorkKind.Task -> StateArt.Action
    }

/**
 * [art] as new work wears it: still, at rest, as its kind is picked, and
 * played once only when tapped. The other kind's picture stays loaded under
 * it, unseen and out of reach, so switching shows the next at once rather
 * than a blank frame while it is read.
 */
@Composable
fun NewWorkArt(art: StateArt, modifier: Modifier = Modifier) {
    Box(modifier) {
        for (each in listOf(StateArt.Action, StateArt.Ready).sortedBy { it == art }) {
            // The one shown is drawn last, over the other, and takes the taps.
            val shown = each == art
            key(each) {
                Box(if (shown) Modifier.testTag(NewWorkTags.art(each)) else Modifier.reserved()) {
                    StateAnimation(each, size = NewWorkSpec.art, autoplay = false, immediate = true)
                }
            }
        }
    }
}

/**
 * [art] at the foot of the room this fills, [NewWorkSpec.artToKind] over
 * what follows, always at [NewWorkSpec.art]: short of room it runs up out
 * of it rather than shrink.
 */
@Composable
fun NewWorkArtAbove(art: StateArt, modifier: Modifier = Modifier) {
    Layout({ NewWorkArt(art) }, modifier.fillMaxWidth()) { measurables, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val side = NewWorkSpec.art.roundToPx()
        val picture = measurables.single().measure(Constraints.fixed(side, side))
        layout(width, height) {
            picture.place((width - picture.width) / 2, height - NewWorkSpec.artToKind.roundToPx() - picture.height)
        }
    }
}

/**
 * New work's block, centred in the room between the bar and the composer
 * that this fills (happy-ios NewWorkLayout): [NewWorkSpec.blockWidth] wide,
 * with at least 12 left over and under it, under the kind's [art]. The
 * composer rides the keyboard and the room ends at it, so the block moves
 * with it, in the same frame. Short of room it stands 12 over the composer
 * and runs up under the bar, picture and all; it is never hidden for it.
 * Going ([shown] false) it fades out over 0.2 s, ease-out, and is gone.
 */
@Composable
fun NewWorkRoom(shown: Boolean, modifier: Modifier = Modifier, art: StateArt? = null, content: @Composable () -> Unit) {
    val reduceMotion = rememberReduceMotion()
    val alpha by animateFloatAsState(
        if (shown) 1f else 0f,
        if (reduceMotion) snap() else tween(NewWorkSpec.FADE_MILLIS, easing = FastOutSlowInEasing),
        label = "new work",
    )
    if (!shown && alpha == 0f) return
    Layout({
        Box { content() }
        if (art != null) NewWorkArt(art)
    }, modifier.fillMaxSize()) { measurables, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val blockWidth = NewWorkSpec.blockWidth(width.toDp()).roundToPx()
        val block = measurables[0].measure(Constraints(minWidth = blockWidth, maxWidth = blockWidth))
        val margin = NewWorkSpec.margin.roundToPx()
        val side = NewWorkSpec.art.roundToPx()
        val picture = if (measurables.size > 1) measurables[1].measure(Constraints.fixed(side, side)) else null
        val above = picture?.let { it.height + NewWorkSpec.artToKind.roundToPx() } ?: 0
        val total = above + block.height
        val fits = height >= total + 2 * margin
        layout(width, height) {
            val top = if (fits) (height - total) / 2 else height - margin - total
            picture?.placeWithLayer((width - picture.width) / 2, top) { this.alpha = alpha }
            block.placeWithLayer((width - blockWidth) / 2, top + above) { this.alpha = alpha }
        }
    }
}

/**
 * Happy Agent's new work (happy-ios NewWorkPanel `.work`): Task or Bot, a
 * segmented control 220 wide (Home's Session | Bot look: 32 high, 2 in,
 * radius 9; the picked segment surfaceHighest, radius 7; 13 semibold). A
 * task asks nothing more: it goes with a blank name, and 16 under the
 * kind says what a task is (13/18 secondary, centred, wrapping). A bot
 * asks, 16 under it, its name, a 44 capsule on the input ground with its
 * 16 text centred, "Name (optional)" until typed, and 10 under that says
 * what a bot is, alike. A task keeps a bot's room, so switching moves nothing.
 * Every change goes to [onChange] as it is made, a kind change with a tick.
 * Return in the name goes on to the composer ([onReturn]). Fixed once its
 * first message is in.
 */
@Composable
fun NewWorkChoicePanel(work: NewWork, onChange: (WorkChoice) -> Unit, onReturn: () -> Unit) {
    val colors = HappyTheme.colors
    val enabled = !work.locked
    // Typed here and handed on, so the field never waits on the chat to echo it.
    var name by rememberSaveable { mutableStateOf(work.choice.name) }
    Column(Modifier.fillMaxWidth().testTag(NewWorkTags.PANEL), horizontalAlignment = Alignment.CenterHorizontally) {
        NewWorkSegments(
            labels = listOf(stringResource(R.string.new_work_task), stringResource(R.string.new_work_bot)),
            selected = if (work.choice.kind == WorkKind.Bot) 1 else 0,
            enabled = enabled,
            tag = { NewWorkTags.kind(if (it == 1) WorkKind.Bot else WorkKind.Task) },
            // A task is never named here: it goes as a blank name does.
            onPick = { onChange(if (it == 1) WorkChoice(WorkKind.Bot, name) else WorkChoice(WorkKind.Task, "")) },
        )
        // A task asks no name, but keeps a bot's room, so Task | Bot moves nothing.
        val bot = work.choice.kind == WorkKind.Bot
        Spacer(Modifier.height(NewWorkSpec.kindToRows))
        val note: @Composable (Int, Modifier) -> Unit = { text, modifier ->
            Text(
                stringResource(text),
                style = NewWorkSpec.note,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = modifier.fillMaxWidth(),
            )
        }
        if (bot) {
            NewWorkNameField(
                value = name,
                onValueChange = {
                    name = it
                    onChange(WorkChoice(work.choice.kind, it))
                },
                placeholder = stringResource(R.string.new_work_name),
                enabled = enabled,
                onReturn = onReturn,
                capitalization = KeyboardCapitalization.Sentences,
            )
            Spacer(Modifier.height(NewWorkSpec.rowsToNote))
            note(R.string.new_work_bot_note, Modifier.testTag(NewWorkTags.NOTE))
        } else {
            // A task's note stands in the name's place, over a bot's room.
            Box {
                Column(Modifier.reserved()) {
                    Spacer(Modifier.height(NewWorkSpec.rowHeight + NewWorkSpec.rowsToNote))
                    note(R.string.new_work_bot_note, Modifier)
                }
                note(R.string.new_work_task_note, Modifier.testTag(NewWorkTags.NOTE))
            }
        }
    }
}

/**
 * One of a Happy account's rows (happy-ios NewWorkMenuRow): a 44 capsule on
 * the input ground, 16 in, a 16 glyph 8 before what is chosen (16, the
 * middle truncated), opening [menu] under it. Dimmed while fixed. The
 * computer's row wears its [status] as a chip on its top-right corner.
 */
@Composable
fun NewWorkMenuRow(
    icon: Ionicon,
    title: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    status: NewWorkStatus? = null,
    menu: @Composable () -> Unit = {},
) {
    val colors = HappyTheme.colors
    Box(modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = NewWorkSpec.rowHeight)
                .clip(CircleShape)
                .background(colors.input.background)
                .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                .alpha(if (enabled) 1f else 0.5f)
                .padding(horizontal = NewWorkSpec.rowInset),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(NewWorkSpec.rowIconGap, Alignment.CenterHorizontally),
        ) {
            Icon(icon, NewWorkSpec.rowIcon, colors.input.text)
            Text(title, style = NewWorkSpec.field, color = colors.input.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        }
        status?.let {
            NewWorkStatusChip(
                it,
                Modifier
                    .align(Alignment.TopEnd)
                    .offset(x = -NewWorkStatusSpec.trailing, y = -NewWorkStatusSpec.overhang),
            )
        }
        menu()
    }
}

/**
 * New work's kind control: Home's Session | Bot look (32 high, 2 in,
 * radius 9; the picked segment [segmentThumb], radius 7; 13 semibold),
 * [NewWorkSpec.kindWidth] wide. A pick other than [selected] ticks and goes
 * to [onPick]; a segment off in [segmentEnabled] shows dimmed and takes no
 * press. [enabled] false fixes the whole control.
 */
@Composable
fun NewWorkSegments(
    labels: List<String>,
    selected: Int,
    enabled: Boolean,
    tag: (Int) -> String,
    onPick: (Int) -> Unit,
    modifier: Modifier = Modifier,
    segmentEnabled: (Int) -> Boolean = { true },
) {
    val colors = HappyTheme.colors
    val haptics = LocalHapticFeedback.current
    Row(
        modifier = modifier
            .testTag(NewWorkTags.KIND)
            .width(NewWorkSpec.kindWidth)
            .heightIn(min = BotKindSpec.segmentHeight)
            .clip(RoundedCornerShape(BotKindSpec.segmentRadius))
            .background(colors.glass.backgroundSubtle)
            .padding(BotKindSpec.segmentPadding),
    ) {
        labels.forEachIndexed { index, label ->
            val picked = index == selected
            val pickable = enabled && segmentEnabled(index)
            Box(
                modifier = Modifier
                    .testTag(tag(index))
                    .weight(1f)
                    .heightIn(min = BotKindSpec.segmentHeight - BotKindSpec.segmentPadding * 2)
                    .clip(RoundedCornerShape(BotKindSpec.segmentItemRadius))
                    .background(if (picked) colors.segmentThumb() else Color.Transparent)
                    .clickable(enabled = pickable, role = Role.RadioButton) {
                        if (!picked) {
                            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                            onPick(index)
                        }
                    }
                    .semantics { this.selected = picked },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    style = BotKindSpec.segmentLabel,
                    color = when {
                        picked -> colors.text
                        pickable || !enabled -> colors.textSecondary
                        else -> colors.textSecondary.copy(alpha = NewWorkSpec.DISABLED_ALPHA)
                    },
                    maxLines = 1,
                )
            }
        }
    }
}

/** What the computer row's chip says, and in which colour. */
@Immutable
data class NewWorkStatus(val text: String, val color: Color)

/**
 * The computer row's status (happy-ios NewWorkStatusLayout): a chip pinned to
 * the row's top-right corner, straddling its top edge like a badge, as wide
 * as what it says. It is drawn over the row and takes no part in its layout,
 * so the icon and the name stay centred and the chip changing moves nothing.
 */
object NewWorkStatusSpec {
    val text = happyTextStyle(fontSize = 11, weight = FontWeight.Medium)
    val height = 18.dp
    val padding = 7.dp
    /** From the row's end to the chip's, as the icon is from the start. */
    val trailing = 16.dp
    val maxWidth = 150.dp
    /** How far the chip rises over the row's top. */
    val overhang = height / 2
}

@Composable
private fun NewWorkStatusChip(status: NewWorkStatus, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Box(
        modifier = modifier
            .testTag(NewWorkTags.MACHINE_STATUS)
            .widthIn(max = NewWorkStatusSpec.maxWidth)
            .height(NewWorkStatusSpec.height)
            .clip(CircleShape)
            .background(colors.surface)
            .border(1.dp, colors.divider, CircleShape)
            .padding(horizontal = NewWorkStatusSpec.padding),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            status.text,
            style = NewWorkStatusSpec.text,
            color = status.color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.wrapContentHeight(unbounded = true),
        )
    }
}

/**
 * A field-high capsule for a name (the Happy account's bot name): 16 text
 * centred on the input ground, [placeholder] until typed. With a [problem]
 * the capsule takes a 1 px red edge and the problem, in red, stands in the
 * placeholder's place (happy-ios 7f6007fe0): nothing is added around it, so
 * nothing moves. Return goes on to the composer ([onReturn]).
 */
@Composable
fun NewWorkNameField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    onReturn: () -> Unit,
    modifier: Modifier = Modifier,
    problem: String? = null,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.Words,
) {
    val colors = HappyTheme.colors
    Box(
        modifier = modifier
            .testTag(NewWorkTags.NAME_FIELD)
            .fillMaxWidth()
            .heightIn(min = NewWorkSpec.rowHeight)
            .clip(CircleShape)
            .background(colors.input.background)
            .then(if (problem != null) Modifier.border(1.dp, colors.textDestructive, CircleShape) else Modifier)
            .padding(horizontal = NewWorkSpec.rowInset),
        contentAlignment = Alignment.Center,
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            textStyle = NewWorkSpec.field.copy(color = colors.input.text, textAlign = TextAlign.Center),
            cursorBrush = SolidColor(colors.input.text),
            keyboardOptions = KeyboardOptions(capitalization = capitalization, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { onReturn() }),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.Center) {
                    if (value.isEmpty()) {
                        Text(
                            problem ?: placeholder,
                            style = NewWorkSpec.field,
                            color = if (problem != null) colors.textDestructive else colors.input.placeholder,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    inner()
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .testTag(NewWorkTags.NAME)
                .semantics { if (problem != null) error(problem) },
        )
    }
}

/**
 * A Happy account's new work, centred between the bar and the composer
 * (happy-ios NewWorkLayout(givingWay:)): the kind's optional [art] over the
 * optional [kind] control, field-high [rows] and an optional [note]. What it
 * asks is what the first send makes, so short of room it gives way instead
 * of going: the note goes, then the gaps close (16 → 14 under the kind, which the computer's
 * chip still clears; 8 → 6 between rows); the picture keeps its size. With
 * no room even then it stands 12 over the composer and runs up under the
 * bar. Going ([shown] false) it fades out over 0.2 s, ease-out, as [NewWorkRoom].
 */
@Composable
fun NewWorkGivingWay(
    shown: Boolean,
    kind: (@Composable () -> Unit)?,
    rows: List<@Composable () -> Unit>,
    note: (@Composable () -> Unit)?,
    modifier: Modifier = Modifier,
    art: StateArt? = null,
) {
    val reduceMotion = rememberReduceMotion()
    val alpha by animateFloatAsState(
        if (shown) 1f else 0f,
        if (reduceMotion) snap() else tween(NewWorkSpec.FADE_MILLIS, easing = FastOutSlowInEasing),
        label = "new work",
    )
    if (!shown && alpha == 0f) return
    val slots = listOfNotNull(kind) + rows + listOfNotNull(note)
    Layout({
        slots.forEach { slot -> Box { slot() } }
        if (art != null) NewWorkArt(art)
    }, modifier.fillMaxSize().testTag(NewWorkTags.PANEL)) { measurables, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val blockWidth = NewWorkSpec.blockWidth(width.toDp()).roundToPx()
        val kindWidth = minOf(NewWorkSpec.kindWidth.roundToPx(), blockWidth)
        var index = 0
        val kindPlaceable = kind?.let { measurables[index++].measure(Constraints(maxWidth = kindWidth)) }
        val rowPlaceables = rows.map { measurables[index++].measure(Constraints(minWidth = blockWidth, maxWidth = blockWidth)) }
        val notePlaceable = note?.let { measurables[index].measure(Constraints(minWidth = blockWidth, maxWidth = blockWidth)) }
        fun stackHeight(kindGap: Int, rowGap: Int, withNote: Boolean): Int {
            var y = kindPlaceable?.let { it.height + kindGap } ?: 0
            rowPlaceables.forEachIndexed { i, row -> y += row.height + if (i > 0) rowGap else 0 }
            if (withNote && notePlaceable != null) y += NewWorkSpec.rowsToNote.roundToPx() + notePlaceable.height
            return y
        }
        val margin = NewWorkSpec.margin.roundToPx()
        val artGap = NewWorkSpec.artToKind.roundToPx()
        val kindToRows = NewWorkSpec.kindToRows.roundToPx()
        val rowGapPx = NewWorkSpec.rowGap.roundToPx()
        // (picture, kind gap, row gap, note): the note goes, then the gaps close; the picture stays at its size.
        val side = if (art != null) NewWorkSpec.art.roundToPx() else null
        val attempts = listOf(
            GivingWay(side, kindToRows, rowGapPx, true),
            GivingWay(side, kindToRows, rowGapPx, false),
            GivingWay(side, NewWorkSpec.tightKindToRows.roundToPx(), NewWorkSpec.tightRowGap.roundToPx(), false),
        )
        fun total(attempt: GivingWay) = (attempt.art?.let { it + artGap } ?: 0) + stackHeight(attempt.kindGap, attempt.rowGap, attempt.withNote)
        val chosen = attempts.firstOrNull { height >= total(it) + 2 * margin } ?: attempts.last()
        val (_, kindGap, rowGap, withNote) = chosen
        val picture = side?.let { measurables.last().measure(Constraints.fixed(it, it)) }
        val total = total(chosen)
        val fits = height >= total + 2 * margin
        val left = (width - blockWidth) / 2
        layout(width, height) {
            // Short of room it stands on the composer and runs up under the bar.
            var y = if (fits) (height - total) / 2 else height - margin - total
            picture?.let {
                it.placeWithLayer(left + (blockWidth - it.width) / 2, y) { this.alpha = alpha }
                y += it.height + artGap
            }
            kindPlaceable?.let {
                it.placeWithLayer(left + (blockWidth - it.width) / 2, y) { this.alpha = alpha }
                y += it.height + kindGap
            }
            rowPlaceables.forEachIndexed { i, row ->
                if (i > 0) y += rowGap
                row.placeWithLayer(left, y) { this.alpha = alpha }
                y += row.height
            }
            notePlaceable?.let {
                it.placeWithLayer(left, y + NewWorkSpec.rowsToNote.roundToPx()) { this.alpha = if (withNote) alpha else 0f }
            }
        }
    }
}

/** One way [NewWorkGivingWay] may stand: the picture's side (null, none), the gaps, and whether the note shows. */
private data class GivingWay(val art: Int?, val kindGap: Int, val rowGap: Int, val withNote: Boolean)
