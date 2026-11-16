package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.pipelines.PipelineRunNotice
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.pipelines.StateGlyph
import com.slopus.happy.ui.pipelines.stateColor
import com.slopus.happy.ui.pipelines.stateWords
import com.slopus.happy.ui.theme.HappyTheme

object SelfNoteTags {
    const val NOTE = "conversation.self"
    const val NOTE_TEXT = "conversation.self.text"
    const val PIPELINE = "conversation.self.pipeline"
    const val PIPELINE_STATE = "conversation.self.pipeline.state"
    const val PIPELINE_SUMMARY = "conversation.self.pipeline.summary"
}

/** A message the agent sent itself: a pipeline run's result as its card, anything else as one quiet line. */
@Composable
internal fun SelfNoteRow(row: ConversationRow.SelfNote, actions: ConversationRowActions, modifier: Modifier) {
    val pipeline = row.pipeline
    if (pipeline != null) PipelineNoticeCard(pipeline, actions.onOpenPipelineRun, modifier) else SelfNoteLine(row, modifier)
}

/**
 * The plain form, as the thinking line: why it was written (or "Message to
 * itself") 13/18 in the secondary colour, a chevron after it; a tap opens
 * what it says under it, 14/20, and closes it again.
 */
@Composable
private fun SelfNoteLine(row: ConversationRow.SelfNote, modifier: Modifier) {
    val colors = HappyTheme.colors
    var open by rememberSaveable(row.key) { mutableStateOf(false) }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
            .testTag(SelfNoteTags.NOTE),
    ) {
        Row(
            Modifier.then(if (row.text.isNotEmpty()) Modifier.clickable(role = Role.Button) { open = !open } else Modifier),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SelfNoteSpec.gap),
        ) {
            Icon(Ionicon.ReturnDownForwardOutline, ConversationRowSpec.icon, colors.textSecondary)
            Text(
                row.label ?: stringResource(R.string.conversation_self_message),
                style = ConversationRowSpec.label,
                color = colors.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (row.text.isNotEmpty()) Icon(if (open) Ionicon.ChevronUp else Ionicon.ChevronDown, ConversationRowSpec.icon, colors.textSecondary)
        }
        if (open) {
            SelectionContainer(Modifier.padding(top = SelfNoteSpec.textGap, start = ConversationRowSpec.icon + SelfNoteSpec.gap)) {
                Text(row.text, style = ConversationRowSpec.body, color = colors.textSecondary, modifier = Modifier.testTag(SelfNoteTags.NOTE_TEXT))
            }
        }
    }
}

/**
 * A pipeline run's result, from what the notice says alone: a card as an
 * artifact's, the run's state glyph in the run row's colour, the pipeline's
 * name over its version and how the run ended (that word in its colour),
 * then the failed nodes the cluster summed up, as sent. A tap opens the run
 * ([onOpen]), which is when the run is read.
 */
@Composable
private fun PipelineNoticeCard(notice: PipelineRunNotice, onOpen: ((PipelineRunNotice) -> Unit)?, modifier: Modifier) {
    val colors = HappyTheme.colors
    val state = stateWords(notice.state)
    val color = stateColor(notice.state)
    val version = notice.version?.let { stringResource(R.string.pipelines_version, it) }
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
            .clip(RoundedCornerShape(ConversationRowSpec.cardRadius))
            .background(colors.surfaceHigh)
            .then(if (onOpen != null) Modifier.clickable(role = Role.Button) { onOpen(notice) } else Modifier)
            .padding(ConversationRowSpec.cardPadding)
            .testTag(SelfNoteTags.PIPELINE),
        horizontalArrangement = Arrangement.spacedBy(SelfNoteSpec.cardGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StateGlyph(notice.state, box = SelfNoteSpec.glyph)
        Column(Modifier.weight(1f)) {
            Text(notice.pipelineName, style = ConversationRowSpec.label, color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                buildAnnotatedString {
                    if (version != null) append("$version · ")
                    withStyle(androidx.compose.ui.text.SpanStyle(color = color)) { append(state) }
                },
                style = ConversationRowSpec.notice,
                color = colors.textSecondary,
                maxLines = 1,
                modifier = Modifier.testTag(SelfNoteTags.PIPELINE_STATE),
            )
            notice.summary?.let {
                Text(it, style = ConversationRowSpec.notice, color = colors.textSecondary, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(SelfNoteTags.PIPELINE_SUMMARY))
            }
        }
        if (onOpen != null) Icon(Ionicon.ChevronForward, ConversationRowSpec.icon, colors.textSecondary)
    }
}

/** The self note's own measures, on [ConversationRowSpec]'s. */
object SelfNoteSpec {
    /** Between the line's glyph, its words and the chevron. */
    val gap = 6.dp
    /** Above what the note says, opened. */
    val textGap = 4.dp
    /** The run's state glyph in the card: an artifact card's icon slot, 22. */
    val glyph = 22.dp
    val cardGap = 10.dp
}
