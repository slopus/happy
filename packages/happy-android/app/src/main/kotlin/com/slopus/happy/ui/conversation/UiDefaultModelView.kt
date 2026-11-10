package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.str
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.conversation.ui.UiActions
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object UiDefaultModelTags {
    const val CARD = "conversation.ui.default_model"
    const val MODEL = "conversation.ui.default_model.model"
    const val EFFORT = "conversation.ui.default_model.effort"
    const val LINE = "conversation.ui.default_model.line"
    const val SPINNER = "conversation.ui.default_model.spinner"
}

object UiDefaultModelSpec {
    val gap = 8.dp
    val selectHeight = 36.dp
    val selectPadding = 14.dp
    val chevron = 14.dp
    val chevronGap = 6.dp
    val mark = 16.dp
    val markGap = 8.dp
    val spinner = 14.dp
    /** A control the person may not use now. */
    const val DIMMED_ALPHA = 0.48f

    val title = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold)
    val select = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.Medium)
    val line = happyTextStyle(fontSize = 13, lineHeight = 18)
}

/**
 * `default_model`: the model new conversations start on, drawn from the
 * computer's configuration as the conversation last read it, never from
 * the component's own props, with the controls that change it. Spec: 16 in
 * from the sides and 6 above and below, as every row; a surfaceHigh card,
 * radius 12, padding 12; "Default model" (15/20 semibold); 8 under it the
 * model and, where the model has efforts, its effort, each a 36 pill (14 in
 * either side, surface with a divider hairline, 14/20 medium, a 14 chevron
 * 6 after the words) that opens a menu of the choices, the current one
 * checked, 8 apart and wrapping; 8 under them one 13/18 line, a 16 mark 8
 * before it. The line says what the control does, textSecondary under an
 * info mark; why the last attempt was refused, in textDestructive under an
 * alert mark, while that is news; that the person's role may not change
 * it, where it may not. While a press is on its way or an attempt is
 * pending the mark is a spinner that reads "Saving…", the pills show what
 * was picked, and the line stays as it was, so nothing moves. Until the
 * models are read there are no pills, and the line says they are being
 * read, under a spinner. The pills are at 0.48 and take no tap while busy,
 * without the permission, or in a chat that takes no presses.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun UiDefaultModel(row: ConversationRow.Ui, actions: UiRowActions, modifier: Modifier) {
    val colors = HappyTheme.colors
    val catalog = actions.catalog()
    val work = row.work
    // On its way, what was picked shows; then what the computer says.
    val picked = work.sending?.payload
    val providerId = picked?.get("providerId").str ?: catalog?.defaults?.providerId
    val modelId = picked?.get("modelId").str ?: catalog?.defaults?.modelId
    val effort = picked?.get("effort").str ?: catalog?.defaults?.effort
    val current = if (providerId != null && modelId != null) catalog?.model(providerId, modelId) else null
    val allowed = UiActions.permission(UiActions.SET_DEFAULT_MODEL)?.let(actions.allowed) == true
    val enabled = allowed && !work.busy && actions.presses()
    val set = { choice: ModelChoice, level: String -> actions.press(row.offer, UiActions.setDefaultModel(choice.providerId, choice.modelId, level)) }
    Column(
        modifier
            .background(colors.surfaceHigh, RoundedCornerShape(ConversationRowSpec.cardRadius))
            .padding(ConversationRowSpec.cardPadding),
        verticalArrangement = Arrangement.spacedBy(UiDefaultModelSpec.gap),
    ) {
        Text(stringResource(R.string.conversation_ui_model_title), style = UiDefaultModelSpec.title, color = colors.text)
        if (catalog != null) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(UiDefaultModelSpec.gap), verticalArrangement = Arrangement.spacedBy(UiDefaultModelSpec.gap)) {
                Select(
                    tag = UiDefaultModelTags.MODEL,
                    label = current?.name ?: modelId ?: stringResource(R.string.conversation_details_model),
                    says = stringResource(R.string.conversation_details_model),
                    options = catalog.models.map { Option(it.name, it.providerName, it.providerId == providerId && it.modelId == modelId) },
                    enabled = enabled,
                ) { index ->
                    val choice = catalog.models[index]
                    // Its effort stays where the model runs it; else the model's own.
                    val level = effort?.takeIf { it in choice.efforts || choice.efforts.isEmpty() } ?: choice.defaultEffort ?: choice.efforts.firstOrNull() ?: effort
                    if (level != null) set(choice, level)
                }
                if (current != null && current.efforts.isNotEmpty()) {
                    Select(
                        tag = UiDefaultModelTags.EFFORT,
                        label = effort?.let(ModeOptions::effortDisplayName) ?: stringResource(R.string.conversation_details_effort),
                        says = stringResource(R.string.conversation_details_effort),
                        options = current.efforts.map { Option(ModeOptions.effortDisplayName(it), null, it == effort) },
                        enabled = enabled,
                    ) { index -> set(current, current.efforts[index]) }
                }
            }
        }
        val problem = work.problem?.takeIf { !work.busy }
        val saving = stringResource(R.string.conversation_ui_model_saving)
        Row(Modifier.testTag(UiDefaultModelTags.LINE), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(UiDefaultModelSpec.mark).padding(top = 1.dp), contentAlignment = Alignment.Center) {
                val spinner = Modifier.testTag(UiDefaultModelTags.SPINNER).size(UiDefaultModelSpec.spinner)
                when {
                    work.busy -> CircularProgressIndicator(spinner.semantics { contentDescription = saving }, color = colors.textSecondary, strokeWidth = 1.5.dp)
                    catalog == null -> CircularProgressIndicator(spinner, color = colors.textSecondary, strokeWidth = 1.5.dp)
                    problem != null -> Icon(Ionicon.AlertCircleOutline, UiDefaultModelSpec.mark, colors.textDestructive)
                    else -> Icon(Ionicon.InformationCircleOutline, UiDefaultModelSpec.mark, colors.textSecondary)
                }
            }
            Spacer(Modifier.width(UiDefaultModelSpec.markGap))
            Text(
                when {
                    catalog == null -> stringResource(R.string.conversation_ui_model_reading)
                    problem != null -> problemText(problem)
                    !allowed -> stringResource(R.string.problem_forbidden)
                    else -> stringResource(R.string.conversation_ui_model_line)
                },
                style = UiDefaultModelSpec.line,
                color = if (problem != null) colors.textDestructive else colors.textSecondary,
            )
        }
    }
}

private class Option(val name: String, val supporting: String?, val selected: Boolean)

/** A pill showing [label] that opens a menu of [options], the selected one checked; [says] names what it picks. */
@Composable
private fun Select(tag: String, label: String, says: String, options: List<Option>, enabled: Boolean, onPick: (index: Int) -> Unit) {
    val colors = HappyTheme.colors
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(UiDefaultModelSpec.selectHeight / 2)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Box {
        Row(
            Modifier
                .testTag(tag)
                .alpha(if (enabled) 1f else UiDefaultModelSpec.DIMMED_ALPHA)
                .height(UiDefaultModelSpec.selectHeight)
                .clip(shape)
                .background(colors.surface)
                .border(hairline, colors.divider, shape)
                .clickable(enabled = enabled, role = Role.DropdownList, onClickLabel = says) { open = true }
                .padding(horizontal = UiDefaultModelSpec.selectPadding),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = UiDefaultModelSpec.select, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.width(UiDefaultModelSpec.chevronGap))
            Icon(Ionicon.ChevronDown, UiDefaultModelSpec.chevron, colors.textSecondary)
        }
        HappyDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEachIndexed { index, option ->
                HappyMenuItem(
                    option.name,
                    onClick = {
                        open = false
                        if (!option.selected) onPick(index)
                    },
                    supporting = option.supporting,
                    selected = option.selected,
                )
            }
        }
    }
}
