package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.str
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.UiAnswer
import com.slopus.happy.conversation.ui.UiAction
import com.slopus.happy.conversation.ui.UiComponent
import com.slopus.happy.conversation.ui.UiFileTree
import com.slopus.happy.conversation.ui.UiCatalog
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.chat.MessageSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object UiTags {
    const val CHOICE = "conversation.ui.choice"
    const val CHOICE_OPTION = "conversation.ui.choice.option"
    const val CHECKLIST = "conversation.ui.checklist"
    const val CHECKLIST_OPTION = "conversation.ui.checklist.option"
    const val TEXT_FIELD = "conversation.ui.text_field"
    const val TEXT_INPUT = "conversation.ui.text_field.input"
    const val SUBMIT = "conversation.ui.submit"
    const val FILE_TREE = "conversation.ui.file_tree"
    const val FILE_TREE_MORE = "conversation.ui.file_tree.more"
    const val FALLBACK = "conversation.ui.fallback"
    const val NOT_ALLOWED = "conversation.ui.not_allowed"
    const val UNSENT = "conversation.ui.unsent"
    const val UNSENT_REASON = "conversation.ui.unsent.reason"
}

/** Chat UI's measures, on the transcript's 16 column; boxes and ticks as a question's ([AskSpec]). */
object UiSpec {
    val gap = 8.dp
    val pillHeight = 36.dp
    val pillPaddingH = 14.dp
    val pillGlyph = 16.dp
    val pillGlyphGap = 6.dp
    val fieldMinHeight = 40.dp
    val fieldPaddingH = 12.dp
    val fieldPaddingV = 10.dp
    val fieldRadius = 10.dp
    val treeIndent = 16.dp
    val treeGlyph = 14.dp
    val treeGlyphGap = 6.dp
    /** Lines a file tree shows before "Show all". */
    const val TREE_LINES = 12
    /** Options not taken once an offer is answered, and every control the person may not use. */
    const val DIMMED_ALPHA = 0.48f
    /** A refused press's bubble. */
    const val UNSENT_ALPHA = 0.55f

    val pill = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.Medium)
    val label = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val field = happyTextStyle(fontSize = 15, lineHeight = 20)
    val line = happyTextStyle(fontSize = 14, lineHeight = 20)
    val note = happyTextStyle(fontSize = 12, lineHeight = 16)
    val tree = happyTextStyle(fontSize = 13, lineHeight = 20, family = AppMono)
}

/**
 * One component of chat UI, drawn natively where this build knows it
 * (`choice`, `checklist`, `text_field`, `file_tree`; `images` is a media
 * row), else its fallback line. Spec: 16 in from the sides and 6 above and
 * below, as every row. A choice is its options as 36 high pills, 8 apart
 * and wrapping, 14 in (14/20 medium): a primary one in the primary button's
 * colours, the rest surfaceHigh with a divider hairline. A checklist is a
 * question's options (an 18 box, 9 to the label over its detail), then its
 * Submit pill at the end. A text field is its label (13/18 semibold,
 * textSecondary), 8, a 40 field (input fill, radius 10, 15/20), then
 * Submit. Answered, the offer shows what was sent (a check in the pill
 * taken, the rest at 0.48) and takes nothing more; while a press from here
 * is on its way the same, without the check. Controls the person may not
 * use are at 0.48, with "Your role can't answer here." under them. A file
 * tree is a surfaceHigh card (radius 12, padding 12) of 13/20 mono lines,
 * 16 in a level, a folder or document glyph 6 before each name, at most
 * twelve lines until "Show all". Any other type is its fallback line,
 * 14/20 textSecondary, in the same card.
 */
@Composable
fun UiComponentRow(row: ConversationRow.Ui, actions: ConversationRowActions, modifier: Modifier = Modifier) {
    // Tagged outside the row's own inset, so a tag measures the whole row.
    val inset = { tag: String ->
        modifier
            .testTag(tag)
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
    }
    val press = actions.onUiAction
    val component = row.component
    // The ones drawn here send one action each: what it needs against these props (`uiActionAllowed`).
    val allowed = pressType(component)?.let { type -> UiCatalog.allowed(type, component.props, actions.uiAllowed) } ?: true
    val open = row.answer == UiAnswer.Open && press != null && allowed && actions.uiPresses()
    val send: (UiAction) -> Unit = { action -> if (open) press?.invoke(row, action) }
    when (component) {
        is UiComponent.Choice -> Gated(allowed, inset(UiTags.CHOICE)) { ChoiceView(component, row.answer, open, send) }
        is UiComponent.Checklist -> Gated(allowed, inset(UiTags.CHECKLIST)) { ChecklistView(row.key, component, row.answer, open, send) }
        is UiComponent.TextField -> Gated(allowed, inset(UiTags.TEXT_FIELD)) { TextFieldView(row.key, component, row.answer, open, send) }
        is UiComponent.FileTree -> FileTreeView(row.key, component, inset(UiTags.FILE_TREE))
        is UiComponent.Images, is UiComponent.Other -> if (component.fallback.isNotBlank()) Fallback(component.fallback, inset(UiTags.FALLBACK))
    }
}

/** [content], and a line saying why it takes nothing where the person's role may not answer. */
@Composable
private fun Gated(allowed: Boolean, modifier: Modifier, content: @Composable () -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(UiSpec.gap)) {
        content()
        if (!allowed) {
            Text(
                stringResource(R.string.conversation_ui_not_allowed),
                style = UiSpec.note,
                color = HappyTheme.colors.textSecondary,
                modifier = Modifier.testTag(UiTags.NOT_ALLOWED),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChoiceView(choice: UiComponent.Choice, answer: UiAnswer, open: Boolean, send: (UiAction) -> Unit) {
    val taken = answer.action?.payload?.get("optionId").str
    FlowRow(horizontalArrangement = Arrangement.spacedBy(UiSpec.gap), verticalArrangement = Arrangement.spacedBy(UiSpec.gap)) {
        for (option in choice.options) {
            val chosen = option.id == taken
            Pill(
                label = option.label,
                primary = option.primary,
                enabled = open,
                alpha = if (open || chosen) 1f else UiSpec.DIMMED_ALPHA,
                checked = chosen && answer is UiAnswer.Answered,
                modifier = Modifier.testTag(UiTags.CHOICE_OPTION).semantics { selected = chosen },
                onClick = { send(UiAction.choose(option.id)) },
            )
        }
    }
}

@Composable
private fun ChecklistView(key: String, checklist: UiComponent.Checklist, answer: UiAnswer, open: Boolean, send: (UiAction) -> Unit) {
    var picked by rememberSaveable(key) { mutableStateOf(checklist.options.filter { it.checked }.map { it.id }) }
    val sent = answer.action?.payload?.get("selected").arr?.mapNotNull { it.str }
    val shown = sent ?: picked
    Column(verticalArrangement = Arrangement.spacedBy(AskSpec.optionGap)) {
        for (option in checklist.options) {
            CheckOption(option.label, option.detail, ticked = option.id in shown, enabled = open, alpha = if (open || sent != null) 1f else UiSpec.DIMMED_ALPHA) {
                picked = if (option.id in picked) picked - option.id else checklist.options.map { it.id }.filter { it in picked || it == option.id }
            }
        }
    }
    val label = if (shown.isEmpty() && checklist.emptyLabel != null) checklist.emptyLabel else checklist.submitLabel
    val ready = open && (picked.isNotEmpty() || checklist.emptyLabel != null)
    SubmitRow(label, ready, sent != null) { send(UiAction.submitChecklist(picked)) }
}

@Composable
private fun TextFieldView(key: String, field: UiComponent.TextField, answer: UiAnswer, open: Boolean, send: (UiAction) -> Unit) {
    val colors = HappyTheme.colors
    var typed by rememberSaveable(key) { mutableStateOf("") }
    val sent = answer.action?.payload?.get("text").str
    Text(field.label, style = UiSpec.label, color = colors.textSecondary)
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = UiSpec.fieldMinHeight)
            .alpha(if (open || sent != null) 1f else UiSpec.DIMMED_ALPHA)
            .background(colors.input.background, RoundedCornerShape(UiSpec.fieldRadius))
            .padding(horizontal = UiSpec.fieldPaddingH, vertical = UiSpec.fieldPaddingV),
        contentAlignment = Alignment.CenterStart,
    ) {
        val value = sent ?: typed
        if (value.isEmpty()) field.placeholder?.let { Text(it, style = UiSpec.field, color = colors.input.placeholder) }
        BasicTextField(
            value = value,
            onValueChange = { typed = it.take(UiComponent.TextField.MAX_LENGTH) },
            enabled = open,
            textStyle = UiSpec.field.copy(color = colors.input.text),
            cursorBrush = SolidColor(colors.input.text),
            modifier = Modifier.fillMaxWidth().testTag(UiTags.TEXT_INPUT),
        )
    }
    SubmitRow(field.submitLabel, open && typed.isNotBlank(), sent != null) { send(UiAction.submitText(typed.trim())) }
}

@Composable
private fun SubmitRow(label: String, ready: Boolean, sent: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Pill(label, primary = true, enabled = ready, alpha = if (ready || sent) 1f else UiSpec.DIMMED_ALPHA, checked = sent, modifier = Modifier.testTag(UiTags.SUBMIT), onClick = onClick)
    }
}

@Composable
private fun Pill(label: String, primary: Boolean, enabled: Boolean, alpha: Float, checked: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(UiSpec.pillHeight / 2)
    val fill = if (primary) colors.button.primaryBackground else colors.surfaceHigh
    val ink = if (primary) colors.button.primaryTint else colors.text
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Row(
        modifier
            .alpha(alpha)
            .heightIn(min = UiSpec.pillHeight)
            .background(fill, shape)
            .then(if (primary) Modifier else Modifier.border(hairline, colors.divider, shape))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = UiSpec.pillPaddingH),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (checked) {
            Icon(Ionicon.Checkmark, UiSpec.pillGlyph, ink)
            Spacer(Modifier.width(UiSpec.pillGlyphGap))
        }
        Text(label, style = UiSpec.pill, color = ink, textAlign = TextAlign.Center)
    }
}

/** A question's option ([AskRow]) for a checklist: the box, its label over its detail. */
@Composable
private fun CheckOption(label: String, detail: String?, ticked: Boolean, enabled: Boolean, alpha: Float, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val chat = ChatTheme.colors
    val shape = RoundedCornerShape(AskSpec.radius)
    Row(
        Modifier
            .fillMaxWidth()
            .testTag(UiTags.CHECKLIST_OPTION)
            .defaultMinSize(minHeight = AskSpec.optionMinHeight)
            .alpha(alpha)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, enabled = enabled, role = Role.Checkbox, onClick = onClick)
            .semantics { selected = ticked }
            .padding(vertical = AskSpec.optionPaddingV),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(AskSpec.box)
                .background(if (ticked) chat.radioActive else colors.input.background, shape)
                .border(1.dp, if (ticked) chat.radioActive else chat.radioInactive, shape),
            contentAlignment = Alignment.Center,
        ) {
            if (ticked) Icon(Ionicon.Checkmark, AskSpec.check, Color.White)
        }
        Spacer(Modifier.width(AskSpec.boxGap))
        Column(Modifier.weight(1f)) {
            Text(label, style = AskSpec.option, color = colors.text)
            detail?.takeIf { it.isNotEmpty() }?.let { Text(it, style = AskSpec.description, color = colors.textSecondary) }
        }
    }
}

@Composable
private fun FileTreeView(key: String, tree: UiComponent.FileTree, modifier: Modifier) {
    val colors = HappyTheme.colors
    val lines = remember(tree.paths) { UiFileTree.lines(tree.paths) }
    var all by rememberSaveable(key) { mutableStateOf(false) }
    val shown = if (all) lines else lines.take(UiSpec.TREE_LINES)
    Column(
        modifier
            .background(colors.surfaceHigh, RoundedCornerShape(ConversationRowSpec.cardRadius))
            .padding(ConversationRowSpec.cardPadding),
    ) {
        for (line in shown) {
            Row(Modifier.padding(start = UiSpec.treeIndent * line.depth), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (line.folder) Ionicon.FolderOutline else Ionicon.DocumentOutline, UiSpec.treeGlyph, colors.textSecondary)
                Spacer(Modifier.width(UiSpec.treeGlyphGap))
                Text(line.name, style = UiSpec.tree, color = colors.text, maxLines = 1)
            }
        }
        if (lines.size > shown.size) {
            Text(
                stringResource(R.string.conversation_ui_tree_show_all, lines.size),
                style = UiSpec.label,
                color = colors.textLink,
                modifier = Modifier
                    .padding(top = 4.dp)
                    .testTag(UiTags.FILE_TREE_MORE)
                    .clickable(role = Role.Button) { all = true }
                    .padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun Fallback(text: String, modifier: Modifier) {
    val colors = HappyTheme.colors
    Row(
        modifier
            .background(colors.surfaceHigh, RoundedCornerShape(ConversationRowSpec.cardRadius))
            .padding(ConversationRowSpec.cardPadding),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.InformationCircleOutline, 18.dp, colors.textSecondary)
        Text(text, style = UiSpec.line, color = colors.textSecondary, modifier = Modifier.weight(1f))
    }
}

/**
 * A press the computer refused, from its attempt record: the person's
 * bubble as it was drawn, at 0.55, then "Not sent: why" (12/16
 * textSecondary) 2 under it against the right edge. Without its words
 * (the offer isn't read), the line alone.
 */
@Composable
fun UnsentRow(row: ConversationRow.Unsent, bubble: BubblePalette, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(MessageSpec.bubbleRadius)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Column(
        modifier
            .testTag(UiTags.UNSENT)
            .fillMaxWidth()
            .padding(horizontal = MessageSpec.userPaddingHorizontal)
            .padding(top = MessageSpec.userPaddingTop, bottom = MessageSpec.bubbleMarginBottom),
        horizontalAlignment = Alignment.End,
    ) {
        row.text?.takeIf { it.isNotEmpty() }?.let { text ->
            Box(
                Modifier
                    .alpha(UiSpec.UNSENT_ALPHA)
                    .background(bubble.background, shape)
                    .border(hairline, bubble.border, shape)
                    .padding(horizontal = MessageSpec.bubblePaddingHorizontal, vertical = MessageSpec.bubblePaddingVertical),
            ) {
                Text(text, style = com.slopus.happy.ui.chat.MarkdownSpec.text, color = colors.textSecondary)
            }
            Spacer(Modifier.height(2.dp))
        }
        val outcome = row.record.outcome
        val reason = outcome.reason?.takeIf { it.isNotBlank() }
        Text(
            if (reason != null) stringResource(R.string.conversation_ui_not_sent, reason) else stringResource(R.string.conversation_ui_not_sent_plain),
            style = UiSpec.note,
            color = colors.textSecondary,
            textAlign = TextAlign.End,
            modifier = Modifier.testTag(UiTags.UNSENT_REASON),
        )
    }
}

private val UiAnswer.action: UiAction?
    get() = when (this) {
        is UiAnswer.Answered -> action
        is UiAnswer.Sending -> action
        UiAnswer.Open, UiAnswer.Closed -> null
    }

/** The action a component drawn here sends; null for one that sends none. */
private fun pressType(component: UiComponent): String? = when (component) {
    is UiComponent.Choice -> "choice.choose"
    is UiComponent.Checklist -> "checklist.submit"
    is UiComponent.TextField -> "text_field.submit"
    else -> null
}
