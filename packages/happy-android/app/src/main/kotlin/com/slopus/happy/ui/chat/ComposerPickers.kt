package com.slopus.happy.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRig
import com.slopus.happy.model.providerIconKind
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.PickerSheetOption
import com.slopus.happy.ui.components.PickerSheetSection
import com.slopus.happy.ui.components.ProviderIcon
import com.slopus.happy.ui.components.PickerSheetTags
import com.slopus.happy.ui.conversation.ConversationPopup
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

object ComposerPickerTags {
    const val ROW = "composer.modes"
    const val PERMISSION = "composer.modes.permission"
    const val MODEL = "composer.modes.model"
    const val SEPARATOR = "composer.modes.separator"
    const val EFFORT = "composer.modes.effort"
    const val SHEET_EMPTY = "composer.modes.empty"
}

/** agentInputLayout.ts's chip geometry and the existing option row typography. */
object ComposerPickerSpec {
    val chipHeight = 40.dp
    val chipGap = 2.dp
    val chipText = happyTextStyle(fontSize = 14)
    val modelPaddingStart = 8.dp
    val effortWidth = 64.dp
    val effortPaddingStart = 2.dp
    const val lockedAlpha = 0.58f

    val sectionIcon = 16.dp
    val empty = happyTextStyle(fontSize = 14)
    val emptyPaddingHorizontal = 24.dp
    val emptyPaddingVertical = 12.dp
}

private enum class ComposerPicker { Model, Effort }

/** AgentInput.tsx `isSandboxEnabled`: an object says so in `enabled`; any other value means on. */
internal fun SessionMetadata?.sandboxEnabled(): Boolean = when (val sandbox = this?.sandbox) {
    null, JsonNull -> false
    is JsonObject -> when (val enabled = sandbox["enabled"]) {
        null, JsonNull -> false
        is JsonPrimitive -> enabled.booleanOrNull
            ?: enabled.doubleOrNull?.let { it != 0.0 && !it.isNaN() }
            ?: enabled.content.isNotEmpty()
        else -> true
    }
    is JsonPrimitive -> sandbox.booleanOrNull ?: sandbox.doubleOrNull?.let { it != 0.0 && !it.isNaN() } ?: sandbox.content.isNotEmpty()
    else -> true
}

/** AgentInput.tsx `permissionKindIcon` */
internal fun permissionKindIcon(kind: String): Ionicon = when (kind) {
    "read-only" -> Ionicon.LockClosedOutline
    "safe-yolo" -> Ionicon.ShieldCheckmarkOutline
    "yolo" -> Ionicon.WarningOutline
    else -> Ionicon.FolderOpenOutline
}

/**
 * The compact composer's model and effort chips (AgentInput.tsx
 * `mobileActionMiddle`, Android's popup pickers), filling the action row's
 * middle. Spec: 2 apart. Permissions live in the chat header overflow.
 * Model and effort sit against the send button: the model name 14,
 * one line, padded 8 at the start, shrinking first and ellipsised; a "·"
 * 14 textSecondary; then the effort level (or "EFFORT") in a 64 chip padded
 * 2 at the start; effort only when the model has levels and it can change.
 * A chip with nothing to pick is drawn at 0.58. Each chip opens an anchored
 * popup while the editor keeps its focus and keyboard; tapping it again closes it.
 * Permission rows carry their kind's glyph, model groups their provider's
 * icon. A light haptic on each chip press and each pick.
 */
@Composable
fun ComposerModeChips(
    modes: ComposerModes,
    metadata: SessionMetadata?,
    onSelect: (AgentModeField, ModeOption) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val haptics = LocalHapticFeedback.current
    var open by rememberSaveable { mutableStateOf<ComposerPicker?>(null) }
    var anchorCenterY by remember { mutableIntStateOf(0) }
    val canOpenModel = modes.canChangeModel && modes.availableModels.isNotEmpty()
    val showEffort = modes.canChangeEffort && modes.availableEffortLevels.isNotEmpty()
    fun toggle(picker: ComposerPicker) {
        haptics.light()
        open = if (open == picker) null else picker
    }

    Box(modifier.onGloballyPositioned { anchorCenterY = it.boundsInWindow().center.y.toInt() }) {
        Row(
            modifier = Modifier.testTag(ComposerPickerTags.ROW).fillMaxWidth().clipToBounds(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ComposerPickerSpec.chipGap),
        ) {
            // The model takes what is left and gives way first; its chip hugs its label at the end.
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                val modelTitle = stringResource(R.string.agent_input_model_title)
                Box(
                    modifier = Modifier
                        .testTag(ComposerPickerTags.MODEL)
                        .height(ComposerPickerSpec.chipHeight)
                        .clip(RoundedCornerShape(ComposerPickerSpec.chipHeight / 2))
                        .clickable(enabled = canOpenModel, role = Role.Button) { toggle(ComposerPicker.Model) }
                        .semantics { contentDescription = modelTitle }
                        .alpha(if (canOpenModel) 1f else ComposerPickerSpec.lockedAlpha)
                        .padding(start = ComposerPickerSpec.modelPaddingStart),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    Text(
                        (modes.modelMode?.name ?: modelTitle).trim(),
                        style = ComposerPickerSpec.chipText,
                        color = colors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (showEffort) {
                val effortTitle = stringResource(R.string.agent_input_effort_title)
                Text("·", style = ComposerPickerSpec.chipText, color = colors.textSecondary, modifier = Modifier.testTag(ComposerPickerTags.SEPARATOR))
                Box(
                    modifier = Modifier
                        .testTag(ComposerPickerTags.EFFORT)
                        .width(ComposerPickerSpec.effortWidth)
                        .height(ComposerPickerSpec.chipHeight)
                        .clip(RoundedCornerShape(ComposerPickerSpec.chipHeight / 2))
                        .clickable(role = Role.Button) { toggle(ComposerPicker.Effort) }
                        .semantics { contentDescription = effortTitle }
                        .padding(start = ComposerPickerSpec.effortPaddingStart),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text(
                        modes.effortLevel?.name ?: effortTitle,
                        style = ComposerPickerSpec.chipText,
                        color = colors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        val picker = open ?: return@Box
        val close = { open = null }
        val title = when (picker) {
            ComposerPicker.Model -> stringResource(R.string.agent_input_model_title)
            ComposerPicker.Effort -> stringResource(R.string.agent_input_effort_title)
        }
        ConversationPopup(
            title = title,
            onDismiss = close,
            anchorCenterY = anchorCenterY,
            alignEnd = true,
            width = 320.dp,
        ) {
            Column(Modifier.testTag(PickerSheetTags.PANEL).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
                PickerSheetSection("title", title, separated = false)
                ComposerPickerOptions(picker, modes) { field, option ->
                    haptics.light()
                    close()
                    onSelect(field, option)
                }
            }
        }
    }
}

@Composable
private fun ComposerPickerOptions(
    picker: ComposerPicker,
    modes: ComposerModes,
    onSelect: (AgentModeField, ModeOption) -> Unit,
) {
    val colors = HappyTheme.colors
    when (picker) {
        ComposerPicker.Model -> {
            if (modes.availableModels.isEmpty()) {
                Text(
                    stringResource(R.string.agent_input_model_configure_in_cli),
                    style = ComposerPickerSpec.empty,
                    color = colors.textSecondary,
                    modifier = Modifier
                        .testTag(ComposerPickerTags.SHEET_EMPTY)
                        .padding(horizontal = ComposerPickerSpec.emptyPaddingHorizontal, vertical = ComposerPickerSpec.emptyPaddingVertical),
                )
            }
            ModeOptions.groupModelsByProvider(modes.availableModels).forEachIndexed { index, group ->
                PickerSheetSection(group.key, group.title, separated = index > 0) {
                    ProviderIcon(providerIconKind(group.models.firstOrNull()?.providerKind), size = ComposerPickerSpec.sectionIcon)
                }
                for (model in group.models) {
                    PickerSheetOption(
                        key = model.key,
                        label = model.name,
                        // A description that only repeats the heading's provider is dropped.
                        description = model.description.takeUnless { group.title != null && it == model.providerName },
                        selected = modes.modelMode?.key == model.key,
                        disabled = !modes.canChangeModel || model.disabled,
                        onClick = { onSelect(AgentModeField.MODEL_MODE, model) },
                    )
                }
            }
        }
        ComposerPicker.Effort -> for (level in modes.availableEffortLevels) {
            PickerSheetOption(
                key = level.key,
                label = level.name,
                description = level.description,
                selected = modes.effortLevel?.key == level.key,
                disabled = level.disabled,
                onClick = { onSelect(AgentModeField.EFFORT_LEVEL, level) },
            )
        }
    }
}

/** The relay provider's existing permission title, also used for dynamic rigs. */
@Composable
internal fun composerPermissionTitle(metadata: SessionMetadata?): String = stringResource(
    when {
        !metadata.isRig() && metadata?.flavor == "codex" -> R.string.agent_input_codex_permission_mode_title
        metadata?.flavor == "gemini" -> R.string.agent_input_gemini_permission_mode_title
        else -> R.string.agent_input_permission_mode_title
    },
)

/** The same supported/disabled permission choices, moved from the dock to the header. */
@Composable
internal fun ComposerPermissionOptions(
    modes: ComposerModes,
    metadata: SessionMetadata?,
    onSelect: (AgentModeField, ModeOption) -> Unit,
) {
    val sandboxed = metadata.sandboxEnabled()
    val selectedKey = modes.permissionMode?.let(ModeOptions::hackMode)?.key ?: "default"
    for (mode in modes.availableModes) {
        // Literal in happy-app.
        val suffix = if (sandboxed && (mode.key == "bypassPermissions" || mode.key == "yolo")) " (sandboxed)" else ""
        PickerSheetOption(
            key = mode.key,
            label = mode.name + suffix,
            description = mode.description,
            selected = selectedKey == mode.key,
            disabled = !modes.canChangePermission || mode.disabled,
            labelIcon = mode.semanticKind?.let(::permissionKindIcon),
            onClick = { onSelect(AgentModeField.PERMISSION_MODE, mode) },
        )
    }
}
