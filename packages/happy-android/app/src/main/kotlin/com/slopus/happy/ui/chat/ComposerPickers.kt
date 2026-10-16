package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import com.slopus.happy.R
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRig
import com.slopus.happy.model.providerIconKind
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ProviderIcon
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
    const val SHEET = "pickerSheet"
    const val SHEET_TITLE = "pickerSheet.title"
    const val SHEET_CLOSE = "pickerSheet.close"
    const val SHEET_EMPTY = "pickerSheet.empty"
    fun section(key: String) = "pickerSheet.section.$key"
    fun option(key: String) = "pickerSheet.option.$key"
}

/** agentInputLayout.ts's chip geometry and PickerSheet.tsx's stylesheet. */
object ComposerPickerSpec {
    val chipHeight = 40.dp
    val chipGap = 2.dp
    val chipText = happyTextStyle(fontSize = 14)
    val permissionPaddingStart = 4.dp
    val permissionPaddingEnd = 8.dp
    val permissionIcon = 18.dp
    val modelPaddingStart = 8.dp
    val effortWidth = 64.dp
    val effortPaddingStart = 2.dp
    const val lockedAlpha = 0.58f

    val sheetMaxWidth = 640.dp
    const val sheetMaxHeightFraction = 0.7f
    val sheetRadius = 28.dp
    val sheetElevation = 6.dp
    val scrim = Color(0x52000000)
    val touchTarget = 48.dp
    val rowInset = 24.dp
    val headerPaddingEnd = 4.dp
    val headerPaddingTop = 4.dp
    val headerMinHeight = 56.dp
    val title = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
    val closeIcon = 22.dp
    val listPaddingBottom = 8.dp
    val sectionGap = 8.dp
    val sectionPaddingTop = 12.dp
    val sectionPaddingBottom = 4.dp
    val sectionSeparatorMarginTop = 8.dp
    val sectionTitle = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)
    val sectionIcon = 16.dp
    val optionMinHeight = 56.dp
    val optionGap = 16.dp
    val optionPaddingVertical = 8.dp
    const val disabledAlpha = 0.45f
    val radio = 20.dp
    val radioBorder = 2.dp
    val radioDot = 10.dp
    val labelIconGap = 6.dp
    val labelIcon = 14.dp
    val label = happyTextStyle(fontSize = 16)
    val descriptionMarginTop = 2.dp
    val description = happyTextStyle(fontSize = 13)
    val empty = happyTextStyle(fontSize = 14)
    val emptyPaddingVertical = 12.dp
}

private enum class ComposerPicker { Permission, Model, Effort }

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
private fun permissionKindIcon(kind: String): Ionicon = when (kind) {
    "read-only" -> Ionicon.LockClosedOutline
    "safe-yolo" -> Ionicon.ShieldCheckmarkOutline
    "yolo" -> Ionicon.WarningOutline
    else -> Ionicon.FolderOpenOutline
}

/**
 * The compact composer's permission, model and effort chips (AgentInput.tsx
 * `mobileActionMiddle`, Android's popup pickers), filling the action row's
 * middle. Spec: 2 apart. The permission chip at the start, one word (the
 * mode name's first) in 14 text, or shield-outline 18 when the mode is
 * unknown; 40 high, padded 4/8; shown only when it can change and there are
 * modes. Model and effort sit against the send button: the model name 14,
 * one line, padded 8 at the start, shrinking first and ellipsised; a "·"
 * 14 textSecondary; then the effort level (or "EFFORT") in a 64 chip padded
 * 2 at the start; effort only when the model has levels and it can change.
 * A chip with nothing to pick is drawn at 0.58. Each chip opens its
 * [PickerSheet], after dropping the keyboard.
 */
@Composable
fun ComposerModeChips(
    modes: ComposerModes,
    metadata: SessionMetadata?,
    onSelect: (AgentModeField, ModeOption) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val keyboard = LocalSoftwareKeyboardController.current
    var open by rememberSaveable { mutableStateOf<ComposerPicker?>(null) }
    val rig = metadata.isRig()
    val codex = !rig && metadata?.flavor == "codex"
    val gemini = metadata?.flavor == "gemini"
    val permissionTitle = stringResource(
        when {
            codex -> R.string.agent_input_codex_permission_mode_title
            gemini -> R.string.agent_input_gemini_permission_mode_title
            else -> R.string.agent_input_permission_mode_title
        },
    )
    val permissionChipLabel = stringResource(
        if (codex) R.string.agent_input_codex_permission_mode_title else R.string.agent_input_permission_mode_title,
    )
    val showPermission = modes.canChangePermission && modes.availableModes.isNotEmpty()
    val canOpenModel = modes.canChangeModel && modes.availableModels.isNotEmpty()
    val showEffort = modes.canChangeEffort && modes.availableEffortLevels.isNotEmpty()
    fun toggle(picker: ComposerPicker) {
        open = if (open == picker) {
            null
        } else {
            keyboard?.hide()
            picker
        }
    }

    Row(
        modifier = modifier.testTag(ComposerPickerTags.ROW).fillMaxWidth().clipToBounds(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ComposerPickerSpec.chipGap),
    ) {
        if (showPermission) {
            val label = ModeOptions.permissionModeShortLabel(modes.permissionMode?.let(ModeOptions::hackMode))
            Box(
                modifier = Modifier
                    .testTag(ComposerPickerTags.PERMISSION)
                    .height(ComposerPickerSpec.chipHeight)
                    .clip(RoundedCornerShape(ComposerPickerSpec.chipHeight / 2))
                    .clickable(role = Role.Button) { toggle(ComposerPicker.Permission) }
                    .semantics { contentDescription = permissionChipLabel }
                    .padding(start = ComposerPickerSpec.permissionPaddingStart, end = ComposerPickerSpec.permissionPaddingEnd),
                contentAlignment = Alignment.Center,
            ) {
                if (label != null) {
                    Text(label, style = ComposerPickerSpec.chipText, color = colors.text, maxLines = 1)
                } else {
                    Icon(Ionicon.ShieldOutline, ComposerPickerSpec.permissionIcon, colors.text)
                }
            }
        }
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

    val picker = open ?: return
    val close = { open = null }
    PickerSheet(
        title = when (picker) {
            ComposerPicker.Permission -> permissionTitle
            ComposerPicker.Model -> stringResource(R.string.agent_input_model_title)
            ComposerPicker.Effort -> stringResource(R.string.agent_input_effort_title)
        },
        onClose = close,
    ) {
        ComposerPickerOptions(picker, modes, metadata) { field, option ->
            close()
            onSelect(field, option)
        }
    }
}

@Composable
private fun ComposerPickerOptions(
    picker: ComposerPicker,
    modes: ComposerModes,
    metadata: SessionMetadata?,
    onSelect: (AgentModeField, ModeOption) -> Unit,
) {
    val colors = HappyTheme.colors
    when (picker) {
        ComposerPicker.Permission -> {
            val sandboxed = metadata.sandboxEnabled()
            val selectedKey = modes.permissionMode?.let(ModeOptions::hackMode)?.key ?: "default"
            for (mode in modes.availableModes) {
                // Literal in happy-app.
                val suffix = if (sandboxed && (mode.key == "bypassPermissions" || mode.key == "yolo")) " (sandboxed)" else ""
                PickerSheetOption(
                    label = mode.name + suffix,
                    description = mode.description,
                    selected = selectedKey == mode.key,
                    disabled = !modes.canChangePermission || mode.disabled,
                    labelIcon = mode.semanticKind?.let(::permissionKindIcon),
                    tag = ComposerPickerTags.option(mode.key),
                    onClick = { onSelect(AgentModeField.PERMISSION_MODE, mode) },
                )
            }
        }
        ComposerPicker.Model -> {
            if (modes.availableModels.isEmpty()) {
                Text(
                    stringResource(R.string.agent_input_model_configure_in_cli),
                    style = ComposerPickerSpec.empty,
                    color = colors.textSecondary,
                    modifier = Modifier
                        .testTag(ComposerPickerTags.SHEET_EMPTY)
                        .padding(horizontal = ComposerPickerSpec.rowInset, vertical = ComposerPickerSpec.emptyPaddingVertical),
                )
            }
            ModeOptions.groupModelsByProvider(modes.availableModels).forEachIndexed { index, group ->
                PickerSheetSection(
                    title = group.title,
                    separated = index > 0,
                    tag = ComposerPickerTags.section(group.key),
                    icon = { ProviderIcon(providerIconKind(group.models.firstOrNull()?.providerKind), size = ComposerPickerSpec.sectionIcon) },
                )
                for (model in group.models) {
                    PickerSheetOption(
                        label = model.name,
                        // A description that only repeats the heading's provider is dropped.
                        description = model.description.takeUnless { group.title != null && it == model.providerName },
                        selected = modes.modelMode?.key == model.key,
                        disabled = !modes.canChangeModel || model.disabled,
                        tag = ComposerPickerTags.option(model.key),
                        onClick = { onSelect(AgentModeField.MODEL_MODE, model) },
                    )
                }
            }
        }
        ComposerPicker.Effort -> for (level in modes.availableEffortLevels) {
            PickerSheetOption(
                label = level.name,
                description = level.description,
                selected = modes.effortLevel?.key == level.key,
                disabled = level.disabled,
                tag = ComposerPickerTags.option(level.key),
                onClick = { onSelect(AgentModeField.EFFORT_LEVEL, level) },
            )
        }
    }
}

/**
 * PickerSheet.tsx: a full-window modal with a 0.32 black scrim and a
 * [PickerSheetPanel] at the bottom, at most 70% of the window high and
 * above the navigation bar. The scrim, Back and the close button dismiss
 * without choosing.
 */
@Composable
fun PickerSheet(title: String, onClose: () -> Unit, content: @Composable () -> Unit) {
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        // The scrim is drawn here; the window's own dim would double it.
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { window?.setDimAmount(0f) }
        val cancel = stringResource(R.string.common_cancel)
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(ComposerPickerSpec.scrim)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClose)
                    .semantics { contentDescription = cancel },
            )
            PickerSheetPanel(
                title = title,
                onClose = onClose,
                attached = true,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .heightIn(max = maxHeight * ComposerPickerSpec.sheetMaxHeightFraction),
                content = content,
            )
        }
    }
}

/**
 * PickerSheet.tsx `PickerSheetPanel`. Spec: up to 640 wide, centred, the
 * opaque surface with radius 28 (square at the bottom when [attached]), a
 * hairline divider border and elevation 6. The header: 24 in at the start,
 * 4 at the end and top, at least 56 high, the title 17 semibold on one
 * line, then a 48 round close button with close 22 in text. The list
 * scrolls within what is left, 8 below its last row.
 */
@Composable
fun PickerSheetPanel(
    title: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    attached: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = HappyTheme.colors
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val radius = ComposerPickerSpec.sheetRadius
    val shape = if (attached) RoundedCornerShape(topStart = radius, topEnd = radius) else RoundedCornerShape(radius)
    Column(
        modifier = modifier
            .testTag(ComposerPickerTags.SHEET)
            .widthIn(max = ComposerPickerSpec.sheetMaxWidth)
            .fillMaxWidth()
            .shadow(ComposerPickerSpec.sheetElevation, shape)
            .clip(shape)
            .background(colors.surface)
            .border(hairline, colors.divider, shape)
            .then(if (attached) Modifier.windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom)) else Modifier),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = ComposerPickerSpec.headerMinHeight)
                .padding(start = ComposerPickerSpec.rowInset, end = ComposerPickerSpec.headerPaddingEnd, top = ComposerPickerSpec.headerPaddingTop),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title,
                style = ComposerPickerSpec.title,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).testTag(ComposerPickerTags.SHEET_TITLE).semantics { heading() },
            )
            val cancel = stringResource(R.string.common_cancel)
            Box(
                modifier = Modifier
                    .testTag(ComposerPickerTags.SHEET_CLOSE)
                    .size(ComposerPickerSpec.touchTarget)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onClose)
                    .semantics { contentDescription = cancel },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.Close, ComposerPickerSpec.closeIcon, colors.text)
            }
        }
        Column(
            modifier = Modifier
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .padding(bottom = ComposerPickerSpec.listPaddingBottom),
        ) {
            content()
        }
    }
}

/**
 * PickerSheet.tsx `PickerSheetSection`: a hairline divider 24 in and 8
 * above when [separated]; then, with a title, the [icon] and the title in
 * 13 semibold textSecondary, 8 apart, 24 in, 12 above and 4 below.
 */
@Composable
fun PickerSheetSection(
    title: String?,
    separated: Boolean,
    modifier: Modifier = Modifier,
    tag: String? = null,
    icon: (@Composable () -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    if (separated) {
        Box(
            Modifier
                .padding(horizontal = ComposerPickerSpec.rowInset)
                .padding(top = ComposerPickerSpec.sectionSeparatorMarginTop)
                .fillMaxWidth()
                .height(hairline)
                .background(colors.divider),
        )
    }
    if (title != null) {
        Row(
            modifier = modifier
                .then(if (tag != null) Modifier.testTag(tag) else Modifier)
                .fillMaxWidth()
                .semantics { heading() }
                .padding(horizontal = ComposerPickerSpec.rowInset)
                .padding(top = ComposerPickerSpec.sectionPaddingTop, bottom = ComposerPickerSpec.sectionPaddingBottom),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ComposerPickerSpec.sectionGap),
        ) {
            icon?.invoke()
            Text(title, style = ComposerPickerSpec.sectionTitle, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * PickerSheet.tsx `PickerSheetOption`: the whole row picks. Spec: at least
 * 56 high, 24 in, 8 above and below; a 20 radio with a 2 border
 * (radio.active when selected, with a 10 dot, else radio.inactive), 16
 * before the label 16 text on one line (after a 14 textSecondary
 * [labelIcon], 6 apart) and the description 13 textSecondary, 2 below, up
 * to two lines. Disabled rows are at 0.45.
 */
@Composable
fun PickerSheetOption(
    label: String,
    description: String?,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    disabled: Boolean = false,
    labelIcon: Ionicon? = null,
    tag: String? = null,
) {
    val colors = HappyTheme.colors
    val chat = ChatTheme.colors
    Row(
        modifier = modifier
            .then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .fillMaxWidth()
            .defaultMinSize(minHeight = ComposerPickerSpec.optionMinHeight)
            .clickable(enabled = !disabled, role = Role.RadioButton, onClick = onClick)
            .alpha(if (disabled) ComposerPickerSpec.disabledAlpha else 1f)
            .padding(horizontal = ComposerPickerSpec.rowInset, vertical = ComposerPickerSpec.optionPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ComposerPickerSpec.optionGap),
    ) {
        Box(
            modifier = Modifier
                .size(ComposerPickerSpec.radio)
                .border(ComposerPickerSpec.radioBorder, if (selected) chat.radioActive else chat.radioInactive, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Box(Modifier.size(ComposerPickerSpec.radioDot).clip(CircleShape).background(chat.radioActive))
        }
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ComposerPickerSpec.labelIconGap)) {
                if (labelIcon != null) Icon(labelIcon, ComposerPickerSpec.labelIcon, colors.textSecondary)
                Text(label, style = ComposerPickerSpec.label, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (!description.isNullOrEmpty()) {
                Spacer(Modifier.height(ComposerPickerSpec.descriptionMarginTop))
                Text(description, style = ComposerPickerSpec.description, color = colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
